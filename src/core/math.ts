/**
 * 音分 / 频率基础换算。
 * 1 个半音 = 100 音分；1200 音分 = 一个八度（频率 ×2）。
 */

export const CENTS_PER_OCTAVE = 1200;

/** 频率比转音分 */
export function ratioToCents(ratio: number): number {
  return (CENTS_PER_OCTAVE / Math.LN2) * Math.log(ratio);
}

/** 实测频率相对参考频率的音分偏差（正 = 偏高） */
export function centsOff(measured: number, reference: number): number {
  return ratioToCents(measured / reference);
}

/** 由音分偏差求频率倍数，2^(cents/1200) */
export function centsToRatio(cents: number): number {
  return Math.pow(2, cents / CENTS_PER_OCTAVE);
}

/** 线性插值（用于包络/平滑） */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 一维指数平滑滤波（时间常数法），alpha ∈ (0,1]，越小越稳但反应越慢 */
export function smoothAlphaFromTimeConstant(tauSeconds: number, sampleRate: number, hopSeconds: number): number {
  const alpha = 1 - Math.exp(-hopSeconds / tauSeconds);
  void sampleRate;
  return Math.min(1, Math.max(0, alpha));
}

/** 中位数（用于抗野点） */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return NaN;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
