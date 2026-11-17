/**
 * 频谱峰检测。
 *
 * - nearestBin / interpolatedBin：目标频率 → bin 索引，后者做三点抛物线插值，
 *   把频率估计精度从 ±bin/2 提升到亚 bin 级（对 5.9Hz 分辨率很关键）。
 * - localProminence：峰相对两侧邻域噪声地板的突起度（dB 差），对宽带背景不敏感。
 * - findPeaks：通用局部极大值搜索，供包络谱使用。
 */

export interface PeakInfo {
  index: number;
  hz: number;
  /** 线性幅度/功率值 */
  value: number;
  /** 相对邻域中位数地板的突起度（dB） */
  prominenceDb: number;
}

function toDb(v: number, floor: number): number {
  return 10 * Math.log10(Math.max(v, floor));
}

/** 最接近目标频率的 bin 索引。 */
export function nearestBin(freqs: Float64Array, targetHz: number): number {
  const binHz = freqs[1] - freqs[0];
  const k = Math.round(targetHz / binHz);
  return Math.max(0, Math.min(freqs.length - 1, k));
}

/**
 * 三点抛物线插值估计目标频率处的真实峰值。
 * 返回插值后的频率与线性值；越界时退化为最近 bin。
 */
export function interpolatedBin(
  freqs: Float64Array,
  values: Float64Array,
  targetHz: number,
): { index: number; hz: number; value: number } {
  const k = nearestBin(freqs, targetHz);
  if (k <= 0 || k >= values.length - 1) {
    return { index: k, hz: freqs[k], value: values[k] };
  }
  const y0 = values[k - 1];
  const y1 = values[k];
  const y2 = values[k + 1];
  // 对 dB 域做抛物线插值更稳（峰在对数域更对称）
  const floor = 1e-20;
  const a = toDb(y0, floor);
  const b = toDb(y1, floor);
  const c = toDb(y2, floor);
  const denom = a - 2 * b + c;
  const shift = denom === 0 ? 0 : 0.5 * (a - c) / denom; // -0.5~0.5
  const clamped = Math.max(-0.5, Math.min(0.5, shift));
  const binHz = freqs[1] - freqs[0];
  const hz = freqs[k] + clamped * binHz;
  // 值用线性域最近 bin 保持保守，避免外推放大
  return { index: k, hz, value: y1 };
}

/**
 * 目标频率处相对局部噪声地板的突起度（dB）。
 * 地板取 [k-halfWindow, k+halfWindow] 内排除中心 3 点后的中位数。
 */
export function localProminence(
  values: Float64Array,
  index: number,
  halfWindow = 8,
): number {
  const lo = Math.max(1, index - halfWindow);
  const hi = Math.min(values.length - 1, index + halfWindow);
  const neighbors: number[] = [];
  for (let i = lo; i <= hi; i++) {
    if (Math.abs(i - index) > 1) neighbors.push(values[i]);
  }
  neighbors.sort((a, b) => a - b);
  const median = neighbors[Math.floor(neighbors.length / 2)];
  const floor = 1e-20;
  return toDb(values[index], floor) - toDb(median, floor);
}

/**
 * 通用局部极大值搜索。
 * @param minProminenceDb 峰相对滑动邻域中位数地板的最小突起度
 * @param minHz 只报告高于该频率的峰（包络谱要避开直流/极低频）
 */
export function findPeaks(
  freqs: Float64Array,
  values: Float64Array,
  options: { minProminenceDb?: number; minHz?: number; halfWindow?: number; maxPeaks?: number } = {},
): PeakInfo[] {
  const minProm = options.minProminenceDb ?? 6;
  const minHz = options.minHz ?? 0;
  const halfWindow = options.halfWindow ?? 8;
  const maxPeaks = options.maxPeaks ?? 32;

  const peaks: PeakInfo[] = [];
  for (let k = 2; k < values.length - 2; k++) {
    if (freqs[k] < minHz) continue;
    if (values[k] <= values[k - 1] || values[k] < values[k + 1]) continue;
    const prom = localProminence(values, k, halfWindow);
    if (prom >= minProm) {
      peaks.push({ index: k, hz: freqs[k], value: values[k], prominenceDb: prom });
    }
  }
  peaks.sort((a, b) => b.prominenceDb - a.prominenceDb);
  return peaks.slice(0, maxPeaks);
}

/**
 * 低频专用突起度：邻域下界钳制到 bin 2，彻底避开直流与 bin1 的泄漏。
 * 用于 FTF 等基频可低至 ~10Hz 的通道（16384 点 FFT 时仅 k≈3）。
 */
export function lowFrequencyProminence(
  values: Float64Array,
  index: number,
  halfWindow = 10,
): number {
  const lo = Math.max(2, index - halfWindow);
  const hi = Math.min(values.length - 1, index + halfWindow);
  const neighbors: number[] = [];
  for (let i = lo; i <= hi; i++) {
    if (Math.abs(i - index) > 1) neighbors.push(values[i]);
  }
  neighbors.sort((a, b) => a - b);
  const median = neighbors[Math.floor(neighbors.length / 2)];
  const floor = 1e-20;
  return toDb(values[index], floor) - toDb(median, floor);
}
