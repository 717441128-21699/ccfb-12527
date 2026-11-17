/**
 * 齐音（unison）拍频检测。
 *
 * 同音三根弦若未调齐，合成信号的幅度会以各弦频率之差周期性起伏，
 * 即“拍”。处理链：
 *   1. 以目标基频为中心做窄带带通（RBJ 双二阶，Q≈18），只留基频簇；
 *   2. 检波：取绝对值 + 低通平滑，得到瞬时幅度包络（含衰减趋势 + 拍）；
 *   3. 滑动平均去除指数衰减慢趋势，得到去趋势包络并算调制深度；
 *   4. 对去趋势包络做零填充 FFT，在拍频范围内找谱峰并抛物插值。
 */

import { fftInPlace } from './fft';

export interface BeatResult {
  /** 拍频 Hz（每秒拍数）；找不到显著拍时返回 0 */
  beatHz: number;
  /** 调制深度 0~1，越大说明三根弦越不齐 */
  modulationDepth: number;
  /** 包络平均幅度（信号存在性判断用） */
  meanLevel: number;
  /** 判定为“已齐”的建议 */
  isUnison: boolean;
}

export interface BeatOptions {
  targetF0: number;
  minBeatHz?: number;
  maxBeatHz?: number;
  /** 载波带通 Q 值，默认 18 */
  q?: number;
  /** 判齐阈值（默认 0.5Hz） */
  unisonBeatThreshold?: number;
  unisonDepthThreshold?: number;
}

/** RBJ 双二阶带通（constant 0 dB peak gain），带宽 ≈ fc/Q */
function bandpass(x: Float64Array, fc: number, q: number, sampleRate: number): Float64Array {
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * q);
  const b0 = alpha;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;

  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    y[i] = (b0 / a0) * xi + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
    x2 = x1; x1 = xi;
    y2 = y1; y1 = y[i];
  }
  return y;
}

/** 一阶 RC 低通 */
function lowpassOnePole(x: Float64Array, fc: number, sampleRate: number): Float64Array {
  const rc = 1 / (2 * Math.PI * fc);
  const dt = 1 / sampleRate;
  const alpha = dt / (rc + dt);
  const y = new Float64Array(x.length);
  let prev = 0;
  for (let i = 0; i < x.length; i++) {
    prev += alpha * (x[i] - prev);
    y[i] = prev;
  }
  return y;
}

/** 中心化滑动平均（边缘用可用样本归一化），用于估计包络慢趋势 */
function movingAverage(x: Float64Array, window: number): Float64Array {
  const half = Math.floor(window / 2);
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(x.length - 1, i + half);
    let s = 0;
    for (let j = lo; j <= hi; j++) s += x[j];
    out[i] = s / (hi - lo + 1);
  }
  return out;
}

export function detectBeats(samples: Float64Array | Float32Array, sampleRate: number, opts: BeatOptions): BeatResult {
  const minBeat = opts.minBeatHz ?? 0.3;
  const maxBeat = opts.maxBeatHz ?? 12;
  const q = opts.q ?? 18;
  const beatThreshold = opts.unisonBeatThreshold ?? 0.5;
  const depthThreshold = opts.unisonDepthThreshold ?? 0.06;

  const x = samples instanceof Float64Array ? samples : Float64Array.from(samples);

  // 1) 载波带通
  const filtered = bandpass(x, opts.targetF0, q, sampleRate);
  const skip = Math.min(filtered.length - 1, Math.ceil((q * sampleRate) / opts.targetF0));
  const steady = filtered.subarray(skip) as Float64Array;
  // 自相关至少需要 ~4 个最慢拍周期；信号不够时自动提高可测下限。
  // 例如 4 秒窗只能可靠测到 ~1Hz 以上的拍。
  const effectiveMinBeat = Math.max(minBeat, (4 * sampleRate) / steady.length);
  if (effectiveMinBeat >= maxBeat) {
    return { beatHz: 0, modulationDepth: 0, meanLevel: 0, isUnison: true };
  }

  // 2) 检波包络：绝对值 + 低通（截止 ~40Hz，远高于拍频上限）
  const abs = new Float64Array(steady.length);
  for (let i = 0; i < steady.length; i++) abs[i] = Math.abs(steady[i]);
  const env = lowpassOnePole(abs, 40, sampleRate);

  // 平均幅度（信号存在性 + 调制深度归一化）
  let mean = 0;
  for (const v of env) mean += v;
  mean /= env.length;
  if (mean < 1e-6) return { beatHz: 0, modulationDepth: 0, meanLevel: 0, isUnison: true };

  // 慢趋势（指数衰减）估计：窗长取最慢可测拍周期的 1.5 倍
  const trendWindow = Math.max(8, Math.round((sampleRate / effectiveMinBeat) * 1.5));
  const trend = movingAverage(env, Math.min(trendWindow, Math.floor(env.length / 3)));
  // 调制深度 = 去趋势后包络的 RMS / 包络均值，只反映周期性拍起伏
  const detrended = new Float64Array(env.length);
  let detrendEnergy = 0;
  for (let i = 0; i < env.length; i++) {
    detrended[i] = env[i] - trend[i];
    detrendEnergy += detrended[i] ** 2;
  }
  const modulationDepth = Math.sqrt(detrendEnergy / env.length) / mean;

  // 4) 拍频估计：对去趋势包络做零填充 FFT，在拍频范围内找谱峰。
  //    比自相关更抗边界假峰，频率分辨率由零填充 + 抛物插值保证。

  // 零填充到 2 的幂（≥2× 原长），提高频域采样密度
  let fftN = 1;
  while (fftN < detrended.length * 2) fftN <<= 1;
  const re = new Float64Array(fftN);
  re.set(detrended);
  const im = new Float64Array(fftN);
  fftInPlace(re, im);
  const binHz = sampleRate / fftN;
  const loBin = Math.max(1, Math.floor(effectiveMinBeat / binHz));
  const hiBin = Math.min(fftN >> 1, Math.ceil(maxBeat / binHz));

  let peakBin = -1;
  let peakPower = -Infinity;
  for (let k = loBin; k <= hiBin; k++) {
    const power = re[k] * re[k] + im[k] * im[k];
    if (power > peakPower) {
      peakPower = power;
      peakBin = k;
    }
  }
  // 总能量用于判断拍信号是否显著
  let bandEnergy = 0;
  for (let k = loBin; k <= hiBin; k++) bandEnergy += re[k] * re[k] + im[k] * im[k];
  if (peakBin <= 0 || bandEnergy < 1e-9 || modulationDepth < depthThreshold) {
    return { beatHz: 0, modulationDepth, meanLevel: mean, isUnison: true };
  }

  // 抛物插值细化
  const pPrev = re[peakBin - 1] ** 2 + im[peakBin - 1] ** 2;
  const pNext = re[peakBin + 1] ** 2 + im[peakBin + 1] ** 2;
  const denom2 = pPrev - 2 * peakPower + pNext;
  const off = denom2 !== 0 ? 0.5 * (pPrev - pNext) / denom2 : 0;
  const beatHz = (peakBin + Math.max(-1, Math.min(1, off))) * binHz;

  return {
    beatHz,
    modulationDepth,
    meanLevel: mean,
    // 齐音：拍频低于门限，或调制深度太浅（拍起伏不可闻）
    isUnison: beatHz < beatThreshold || modulationDepth < depthThreshold * 1.5,
  };
}
