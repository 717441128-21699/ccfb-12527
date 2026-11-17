/**
 * 带标签的合成电机声信号（仅测试/评估使用，不进生产包）。
 *
 * 信号构成：
 *   - 宽带背景噪声（电机空气噪声 + 麦克风本底）
 *   - 轴频及其谐波（电磁/机械振动声，合格电机也有）
 *   - 故障通道：在共振带注入周期冲击串，冲击经带通共振成形，
 *     重复频率严格等于该故障特征频率（或 BSF 的 2 倍），
 *     这与真实轴承“冲击激发共振、被故障频率调制”的机理一致。
 *
 * 用固定种子的 PRNG（mulberry32），评估结果可复现。
 */

import {
  bearingFrequencies,
  type BearingGeometry,
  type FaultKind,
} from "../src/dsp/bearing.js";

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 高斯白噪声（Box–Muller）。 */
function gaussian(rng: Rng): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface SynthOptions {
  sampleRate?: number;
  durationSec?: number;
  rpm: number;
  bearing: BearingGeometry;
  /** 背景噪声 RMS，默认 0.02 */
  noiseRms?: number;
  /** 轴频线谱强度（相对噪声），默认 0.6 */
  shaftToneLevel?: number;
  /** 注入的故障；null/缺省 = 合格电机 */
  fault?: FaultKind | null;
  /** 故障冲击强度，默认 1.0；越大越好检出 */
  faultLevel?: number;
  /** 冲击共振中心频率，默认 3500Hz */
  resonanceHz?: number;
  /** 共振带宽（Hz），默认 400 */
  resonanceBandwidthHz?: number;
  seed?: number;
}

/**
 * 简单 IIR 带通（单谐振器），把脉冲变成衰减共振波形。
 * 离散二阶谐振：y[n] = r^? 形式，用极点半径 r 与中心角 θ 参数化。
 */
function resonantImpulseResponse(
  fs: number,
  centerHz: number,
  bandwidthHz: number,
  length: number,
): Float64Array {
  const theta = (2 * Math.PI * centerHz) / fs;
  // 由 -3dB 带宽估极点半径
  const r = Math.exp(-Math.PI * bandwidthHz / fs);
  const h = new Float64Array(length);
  for (let n = 0; n < length; n++) {
    h[n] = (r ** n) * Math.sin((n + 1) * theta);
  }
  // 归一化能量
  let norm = 0;
  for (const v of h) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let n = 0; n < length; n++) h[n] /= norm;
  return h;
}

export function synthMotorSignal(opts: SynthOptions): Float64Array {
  const fs = opts.sampleRate ?? 48000;
  const dur = opts.durationSec ?? 5;
  const n = Math.floor(fs * dur);
  const rng = mulberry32(opts.seed ?? 1);
  const noiseRms = opts.noiseRms ?? 0.02;
  const shaftLevel = opts.shaftToneLevel ?? 0.6;

  const out = new Float64Array(n);

  // 1) 背景高斯噪声
  for (let i = 0; i < n; i++) out[i] = noiseRms * gaussian(rng);

  // 2) 轴频与谐波（1×、2×、3×，轻微随机抖动模拟转速不稳）
  const fr = opts.rpm / 60;
  const jitter = () => 1 + (rng() - 0.5) * 0.001;
  for (const [harm, level] of [
    [1, shaftLevel * noiseRms * 3],
    [2, shaftLevel * noiseRms * 1.5],
    [3, shaftLevel * noiseRms * 0.7],
  ] as const) {
    const f = fr * harm * jitter();
    for (let i = 0; i < n; i++) {
      out[i] += level * Math.sin(2 * Math.PI * f * (i / fs));
    }
  }

  // 3) 故障冲击串
  if (opts.fault) {
    const bf = bearingFrequencies(opts.rpm, opts.bearing);
    let repeatHz = bf[opts.fault];
    // 滚动体冲击通常表现为 2×BSF
    if (opts.fault === "bsf") repeatHz *= 2;

    // 各故障物理特性修正：
    // - FTF（保持架）：单次冲击能量最弱，但重复周期稳定，用窄带共振提高重复性
    // - BSF：滚动体冲击中等，2× 频率
    // - BPFI 受载调制，BPFO 最稳定
    const kindGain: Record<FaultKind, number> = {
      bpfo: 1.0,
      bpfi: 1.0,
      bsf: 0.9,
      ftf: 1.4,
    };
    const kindBw: Record<FaultKind, number> = {
      bpfo: 400,
      bpfi: 400,
      bsf: 400,
      ftf: 200, // 窄带 → 共振尾更长更整齐，包络谱峰更尖锐
    };
    const level = (opts.faultLevel ?? 1.0) * kindGain[opts.fault] * noiseRms * 6;
    const center = opts.resonanceHz ?? 3500;
    const bw = opts.resonanceBandwidthHz ?? kindBw[opts.fault];
    const impulseLen = Math.min(n, Math.floor(fs * 0.05)); // 50ms 衰减尾
    const h = resonantImpulseResponse(fs, center, bw, impulseLen);

    const period = Math.round(fs / repeatHz);
    // 每个周期在相位上撒 ±2% 抖动，模拟滑移
    for (let p = 0; p * period < n; p++) {
      const jitterSamples = Math.round((rng() - 0.5) * period * 0.02);
      const start = p * period + jitterSamples;
      const sign = rng() > 0.5 ? 1 : -1;
      for (let k = 0; k < impulseLen && start + k < n; k++) {
        out[start + k] += sign * level * h[k];
      }
    }
  }

  // 4) 限幅保护（模拟 ADC 余量）
  for (let i = 0; i < n; i++) {
    if (out[i] > 1) out[i] = 1;
    else if (out[i] < -1) out[i] = -1;
  }
  return out;
}
