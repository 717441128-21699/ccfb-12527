/**
 * 检测台界面主逻辑。
 * 职责仅限 UI 编排与参数收集，所有信号处理走 src/dsp + src/core。
 */

import { MicRecorder } from "../audio/recorder.js";
import {
  saveBaselineLocal,
  loadBaselineLocal,
  clearBaselineLocal,
  exportBaselineFile,
  importBaselineFile,
} from "../audio/baselineStore.js";
import { BaselineBuilder, parseBaseline, type BaselineData } from "../core/baseline.js";
import { analyze, type AnalyzeInput } from "../core/detector.js";
import { welch, psdToDb } from "../dsp/welch.js";
import { envelopeSpectrum } from "../dsp/envelope.js";
import { bearingFrequencies, FAULT_LABELS, type FaultKind } from "../dsp/bearing.js";
import { drawSpectrum, type Marker } from "./plot.js";
import type { DetectorConfig, DetectorResult } from "../core/config.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const FAULT_COLORS: Record<FaultKind, string> = {
  bpfo: "#dc2626",
  bpfi: "#ea580c",
  bsf: "#7c3aed",
  ftf: "#0891b2",
};

let baseline: BaselineData | null = null;
let baselineBuilder: BaselineBuilder | null = null;
let lastPsd: { freqs: Float64Array; db: Float64Array } | null = null;
let lastEnv: { freqs: Float64Array; db: Float64Array } | null = null;
let activeTab: "psd" | "env" = "psd";

function log(msg: string): void {
  const el = $("log");
  const line = document.createElement("div");
  const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  line.textContent = `[${t}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function readBearing(): AnalyzeInput["bearing"] {
  return {
    ballCount: Number($<HTMLInputElement>("ballCount").value),
    pitchD: Number($<HTMLInputElement>("pitchD").value),
    ballD: Number($<HTMLInputElement>("ballD").value),
    contactAngleRad: (Number($<HTMLInputElement>("contactAngle").value) * Math.PI) / 180,
  };
}

function readConfig(): Partial<DetectorConfig> {
  return {}; // 全部走 DEFAULT_CONFIG；现场校准后可在此覆盖
}

function refreshBaselineStatus(): void {
  const el = $("baselineStatus");
  const exportBtn = $<HTMLButtonElement>("exportBtn");
  const clearBtn = $<HTMLButtonElement>("clearBaselineBtn");
  if (baseline) {
    el.className = "baseline-status ok";
    el.textContent = `已建立基线：${baseline.count} 台合格电机（${baseline.sampleRate}Hz, nfft=${baseline.nfft}）`;
    exportBtn.disabled = false;
    clearBtn.disabled = false;
  } else if (baselineBuilder && baselineBuilder.count > 0) {
    el.className = "baseline-status empty";
    el.textContent = `采集中：已录入 ${baselineBuilder.count} 台（未最终生成基线）`;
    exportBtn.disabled = true;
    clearBtn.disabled = false;
  } else {
    el.className = "baseline-status empty";
    el.textContent = "尚未建立基线（无基线时仅用突起度+包络判决，建议先录 100 台合格机）";
    exportBtn.disabled = true;
    clearBtn.disabled = true;
  }
}

function buildMarkers(): Marker[] {
  const rpm = Number($<HTMLInputElement>("rpm").value);
  const bf = bearingFrequencies(rpm, readBearing());
  const markers: Marker[] = [];
  (Object.keys(FAULT_LABELS) as FaultKind[]).forEach((kind) => {
    const orders = kind === "bsf" ? [2, 4] : kind === "ftf" ? [1, 2] : [1, 2, 3];
    for (const h of orders) {
      markers.push({
        hz: bf[kind] * h,
        label: `${kind.toUpperCase()}${h > 1 ? "×" + h : ""}`,
        color: FAULT_COLORS[kind],
      });
    }
  });
  return markers;
}

function renderResult(r: DetectorResult): void {
  const verdictEl = $("verdict");
  if (r.verdict === "pass") {
    verdictEl.className = "verdict pass";
    verdictEl.innerHTML = `合格<div class="detail">置信度 ${(r.confidence * 100).toFixed(0)}% · 处理耗时 ${r.processingMs.toFixed(0)}ms · RMS ${r.rms.toFixed(4)}</div>`;
  } else {
    verdictEl.className = "verdict fail";
    verdictEl.innerHTML = `不合格 · 疑似${r.primaryFault?.label ?? "异常"}<div class="detail">置信度 ${(r.confidence * 100).toFixed(0)}% · 处理耗时 ${r.processingMs.toFixed(0)}ms · RMS ${r.rms.toFixed(4)}</div>`;
  }

  const host = $("channels");
  host.innerHTML = "";
  for (const ch of r.channels) {
    const div = document.createElement("div");
    div.className = "channel" + (ch.score >= 2.4 ? " alarm" : "");
    const pct = Math.min(100, (ch.score / 6) * 100);
    const hitText = `基线${ch.hits.baseline} 突起${ch.hits.prominence} 包络${ch.hits.envelope}`;
    div.innerHTML = `
      <div>
        <strong>${ch.label}</strong>
        <div class="meta">${ch.baseHz.toFixed(1)}Hz · 命中 ${hitText}</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <div class="score-bar"><div style="width:${pct}%"></div></div>
        <span style="width:36px;text-align:right;font-variant-numeric:tabular-nums">${ch.score.toFixed(1)}</span>
      </div>`;
    host.appendChild(div);
  }
}

function renderPlot(): void {
  const canvas = $<HTMLCanvasElement>("spectrumCanvas");
  const markers = buildMarkers();
  if (activeTab === "psd" && lastPsd) {
    drawSpectrum(canvas, lastPsd.freqs, lastPsd.db, {
      title: "Welch 功率谱密度（dB）",
      xMaxHz: 12000,
      markers,
      baselineDb: baseline?.meanDb,
      baselineFreqs: baseline?.freqs,
      yLabel: "dB",
    });
  } else if (activeTab === "env" && lastEnv) {
    drawSpectrum(canvas, lastEnv.freqs, lastEnv.db, {
      title: "共振解调包络谱（dB，特征频率处的峰 = 周期冲击）",
      xMaxHz: 1000,
      markers,
      yLabel: "dB",
    });
  }
}

async function runDetection(): Promise<void> {
  const btn = $<HTMLButtonElement>("recordBtn");
  btn.disabled = true;
  try {
    const duration = Number($<HTMLInputElement>("duration").value);
    const recorder = new MicRecorder();
    log(`开始录音 ${duration}s（请确认电机已稳定空载运转）`);
    const rec = await recorder.record({
      durationSec: duration,
      sampleRate: 48000,
      onLevel: (rms, peak) => {
        $("levelBar").style.width = `${Math.min(100, rms * 300)}%`;
        if (peak > 0.98) log("⚠ 信号削波！请降低麦克风增益或拉远距离");
      },
    });
    $("sampleRatePill").textContent = `采样率 ${rec.sampleRate}Hz`;
    log(`录音结束：${rec.samples.length} 样本，RMS=${rec.rms.toFixed(4)}，峰值=${rec.peak.toFixed(3)}`);

    const samples = Float64Array.from(rec.samples);
    const rpm = Number($<HTMLInputElement>("rpm").value);

    // 谱图数据
    const psd = welch(samples, rec.sampleRate, { nfft: 8192 });
    lastPsd = { freqs: psd.freqs, db: psdToDb(psd.psd) };
    const env = envelopeSpectrum(samples, rec.sampleRate, { nfft: 65536 });
    const envDb = new Float64Array(env.magnitude.length);
    for (let i = 0; i < envDb.length; i++) envDb[i] = 20 * Math.log10(Math.max(env.magnitude[i], 1e-12));
    lastEnv = { freqs: env.freqs, db: envDb };

    const result = analyze({
      samples,
      rpm,
      bearing: readBearing(),
      config: { ...readConfig(), sampleRate: rec.sampleRate },
      baseline,
    });
    renderResult(result);
    renderPlot();
    log(`判决：${result.verdict === "pass" ? "合格" : `不合格（${result.primaryFault?.label}）`}`);
  } catch (e) {
    log(`检测失败：${(e as Error).message}`);
  } finally {
    btn.disabled = false;
  }
}

async function addBaselineSample(): Promise<void> {
  const btn = $<HTMLButtonElement>("addBaselineBtn");
  btn.disabled = true;
  try {
    const duration = Number($<HTMLInputElement>("duration").value);
    const recorder = new MicRecorder();
    log("基线录入：开始录制合格电机…");
    const rec = await recorder.record({ durationSec: duration, sampleRate: 48000 });
    const samples = Float64Array.from(rec.samples);
    const { psd, freqs, nfft } = welch(samples, rec.sampleRate, { nfft: 8192 });
    if (!baselineBuilder) {
      baselineBuilder = new BaselineBuilder(rec.sampleRate, nfft, freqs);
    }
    if (baselineBuilder.sampleRate !== rec.sampleRate) {
      throw new Error("采样率与已有基线不一致，请使用同一麦克风设置");
    }
    baselineBuilder.add(psd);
    log(`已录入第 ${baselineBuilder.count} 台合格电机`);
    if (baselineBuilder.count >= 100) log("已达 100 台建议数量，可继续录入以提升稳健性");
    refreshBaselineStatus();
  } catch (e) {
    log(`基线录入失败：${(e as Error).message}`);
  } finally {
    btn.disabled = false;
  }
}

function finalizeBaseline(): void {
  if (baselineBuilder && baselineBuilder.count > 0) {
    baseline = baselineBuilder.build();
    saveBaselineLocal(baseline);
    log(`基线已生成并保存：${baseline.count} 台`);
    refreshBaselineStatus();
    if (lastPsd) renderPlot();
  }
}

// ---- 事件绑定 ----
$("recordBtn").addEventListener("click", runDetection);
$("addBaselineBtn").addEventListener("click", addBaselineSample);
$("finalizeBaselineBtn").addEventListener("click", finalizeBaseline);
$("exportBtn").addEventListener("click", () => {
  if (baseline) exportBaselineFile(baseline, `motor-baseline-${baseline.count}.json`);
});
$("importBtn").addEventListener("click", () => $<HTMLInputElement>("importFile").click());
$("importFile").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const data = parseBaseline(JSON.stringify(await importBaselineFile(file)));
    baseline = data;
    baselineBuilder = null;
    saveBaselineLocal(baseline);
    log(`已导入基线：${data.count} 台`);
    refreshBaselineStatus();
    renderPlot();
  } catch (err) {
    log(`导入失败：${(err as Error).message}`);
  }
});
$("clearBaselineBtn").addEventListener("click", () => {
  baseline = null;
  baselineBuilder = null;
  clearBaselineLocal();
  refreshBaselineStatus();
  renderPlot();
  log("基线已清空");
});
$("tabPsd").addEventListener("click", () => {
  activeTab = "psd";
  $("tabPsd").classList.add("active");
  $("tabEnv").classList.remove("active");
  renderPlot();
});
$("tabEnv").addEventListener("click", () => {
  activeTab = "env";
  $("tabEnv").classList.add("active");
  $("tabPsd").classList.remove("active");
  renderPlot();
});
window.addEventListener("resize", () => lastPsd && renderPlot());

// ---- 启动：恢复本地基线 ----
try {
  const saved = loadBaselineLocal();
  if (saved) {
    baseline = saved;
    log(`恢复本地基线：${saved.count} 台`);
  }
} catch {
  /* 忽略损坏的本地数据 */
}
refreshBaselineStatus();
