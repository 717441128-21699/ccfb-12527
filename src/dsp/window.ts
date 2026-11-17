/**
 * 窗函数。
 *
 * Welch PSD 用 Hann（主瓣宽但旁瓣衰减 -31.5dB，适合压制泄漏、做统计平均）。
 * 提供窗的相干增益（coherent gain）与能量增益，供 PSD 幅度归一化使用。
 */

export type WindowType = "hann" | "hamming" | "rect";

export function makeWindow(type: WindowType, size: number): Float64Array {
  const w = new Float64Array(size);
  switch (type) {
    case "rect":
      w.fill(1);
      return w;
    case "hamming":
      for (let n = 0; n < size; n++) {
        w[n] = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (size - 1));
      }
      return w;
    case "hann":
    default:
      // 周期 Hann（periodic）：分母用 size 而非 size-1，与 Welch 分段拼接习惯一致
      for (let n = 0; n < size; n++) {
        w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / size);
      }
      return w;
  }
}

/** 相干增益 = mean(w)，加窗后正弦幅度的折算系数。 */
export function coherentGain(w: Float64Array): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i];
  return s / w.length;
}

/** 能量增益 = sum(w^2)，PSD 归一化分母 U = sum(w^2)/fs。 */
export function energyGain(w: Float64Array): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * w[i];
  return s;
}
