/**
 * 整机异响判决主流程。
 *
 * 对四个故障通道（BPFO/BPFI/BSF/FTF）的基频与各次谐波分别采集证据：
 *   1) baselineDb  —— 相对合格基线的 dB 超差（绝对能量异常，共振带故障靠它）
 *   2) baselineZ   —— 相对基线离散度的 z-score（统计异常，稳态线谱靠它）
 *   3) envelope    —— 包络谱同频率处的冲击突起度（周期性冲击的决定性证据）
 * 无基线时退化为 Welch PSD 局部突起度。
 *
 * 打分 = 各谐波命中数 × 证据权重之和；包络权重最高，因为轴承故障的
 * 物理本质就是周期性冲击。最强通道超门限即判不合格并报故障类型。
 */

import {
  bearingFrequencies,
  faultHarmonics,
  FAULT_LABELS,
  type BearingGeometry,
  type FaultKind,
} from "../dsp/bearing.js";
import { welch } from "../dsp/welch.js";
import { envelopeSpectrum } from "../dsp/envelope.js";
import { interpolatedBin, localProminence, lowFrequencyProminence } from "../dsp/peaks.js";
import { zScoreVsBaseline, type BaselineData } from "./baseline.js";
import {
  DEFAULT_CONFIG,
  type DetectorConfig,
  type DetectorResult,
  type ChannelVerdict,
  type HarmonicEvidence,
} from "./config.js";

const KINDS: FaultKind[] = ["bpfo", "bpfi", "bsf", "ftf"];

export interface AnalyzeInput {
  samples: Float64Array | Float32Array;
  rpm: number;
  bearing: BearingGeometry;
  config?: Partial<DetectorConfig>;
  baseline?: BaselineData | null;
}

function rms(x: Float64Array | Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

export function analyze(input: AnalyzeInput): DetectorResult {
  const t0 = performance.now();
  const cfg: DetectorConfig = { ...DEFAULT_CONFIG, ...input.config };
  const { samples, rpm, bearing } = input;
  const sr = cfg.sampleRate;

  // 1) Welch PSD
  const { psd, freqs } = welch(samples, sr, {
    nfft: cfg.nfft,
    overlap: cfg.welchOverlap,
  });
  const binHz = freqs[1] - freqs[0];

  // 2) 包络谱（共振解调）
  const env = envelopeSpectrum(samples, sr, {
    bandLowHz: cfg.resonanceBand.lowHz,
    bandHighHz: cfg.resonanceBand.highHz,
    nfft: cfg.envelopeFft,
  });

  // 3) 基线证据（可选）
  const zAll = input.baseline ? zScoreVsBaseline(psd, input.baseline) : null;

  // 4) 轴承特征频率
  const bf = bearingFrequencies(rpm, bearing);
  const channels: ChannelVerdict[] = [];
  const tolBins = Math.max(1, Math.round(cfg.freqToleranceHz / binHz));

  for (const kind of KINDS) {
    const harmonics = faultHarmonics(kind, bf);
    const evidence: HarmonicEvidence[] = [];
    const hits = { baseline: 0, prominence: 0, envelope: 0 };

    for (const h of harmonics) {
      if (h.hz >= freqs[freqs.length - 1]) continue;

      // --- Welch PSD 上的特征峰 ---
      const peak = interpolatedBin(freqs, psd, h.hz);
      const prom = localProminence(psd, peak.index);

      let z: number | null = null;
      let dbExcess: number | null = null;

      if (input.baseline && zAll) {
        let zMax = -Infinity;
        let dbMax = -Infinity;
        for (let d = -tolBins; d <= tolBins; d++) {
          const idx = peak.index + d;
          if (idx < 0 || idx >= zAll.length) continue;
          zMax = Math.max(zMax, zAll[idx]);
          const db = 10 * Math.log10(Math.max(psd[idx], 1e-20));
          dbMax = Math.max(dbMax, db - input.baseline.meanDb[idx]);
        }
        z = Number.isFinite(zMax) ? zMax : null;
        dbExcess = Number.isFinite(dbMax) ? dbMax : null;
        // 两路统计证据独立计数：z 超差 或 dB 绝对超差
        if (z !== null && z >= cfg.zHitThreshold) hits.baseline++;
        else if (dbExcess !== null && dbExcess >= cfg.dbExcessThreshold) hits.baseline++;
      } else if (prom >= cfg.prominenceHitDb) {
        hits.prominence++;
      }

      // --- 包络谱上的同频冲击 ---
      let envProm = 0;
      if (h.hz >= cfg.envelopeMinHz && h.hz < env.freqs[env.freqs.length - 1]) {
        const eBin = Math.round(h.hz / env.binHz);
        if (eBin > 1 && eBin < env.magnitude.length - 1) {
          const isLowFreq = h.hz < 30;
          // 低频（FTF 等）邻域会撞直流区，用钳制下界 + 更宽窗口的专用函数
          envProm = isLowFreq
            ? lowFrequencyProminence(env.magnitude, eBin, 12)
            : localProminence(env.magnitude, eBin, 6);
          const gate = isLowFreq
            ? cfg.envelopeProminenceLowDb
            : cfg.envelopeProminenceDb;
          if (envProm >= gate) hits.envelope++;
        }
      }

      evidence.push({
        kind,
        order: h.order,
        expectedHz: h.hz,
        measuredHz: peak.hz,
        z,
        dbExcess,
        prominenceDb: prom,
        envelopeProminenceDb: envProm,
      });
    }

    // 5) 通道融合打分（命中数加权和，不按谐波数稀释——弱故障通道谐波少是物理事实）
    const score =
      cfg.weights.baselineZ * hits.baseline +
      cfg.weights.prominence * hits.prominence +
      cfg.weights.envelope * hits.envelope;

    // 置信度：score 相对门限的 sigmoid，超门限越多越接近 1
    const confidence = 1 / (1 + Math.exp(-(score - cfg.channelScoreThreshold) * 1.4));

    channels.push({
      kind,
      label: FAULT_LABELS[kind],
      baseHz: bf[kind],
      score,
      confidence,
      hits,
      evidence,
    });
  }

  // 6) 整机判决
  channels.sort((a, b) => b.score - a.score);
  const top = channels[0];
  const fail = top.score >= cfg.machineFailThreshold;

  return {
    verdict: fail ? "fail" : "pass",
    rpm,
    sampleRate: sr,
    rms: rms(samples),
    confidence: fail ? top.confidence : Math.min(0.5, 0.15 + top.score * 0.08),
    channels,
    primaryFault: fail ? { kind: top.kind, label: top.label } : null,
    processingMs: performance.now() - t0,
  };
}
