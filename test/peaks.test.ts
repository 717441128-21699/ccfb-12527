import { describe, it, expect } from "vitest";
import {
  nearestBin,
  interpolatedBin,
  localProminence,
  findPeaks,
} from "../src/dsp/peaks.js";

describe("峰检测", () => {
  const freqs = Float64Array.from({ length: 513 }, (_, k) => k * 10); // 10Hz/bin
  const values = new Float64Array(513).fill(1e-6);

  it("nearestBin 夹在边界内", () => {
    expect(nearestBin(freqs, 105)).toBe(11);
    expect(nearestBin(freqs, -50)).toBe(0);
    expect(nearestBin(freqs, 99999)).toBe(512);
  });

  it("抛物线插值把峰频率估计到亚 bin 精度", () => {
    // 在 bin 20 放一个非对称峰（真实峰偏右）
    values[19] = 0.5;
    values[20] = 1;
    values[21] = 0.8;
    const r = interpolatedBin(freqs, values, 200);
    expect(r.hz).toBeGreaterThan(200); // 右侧更高 → 估计频率上移
    expect(r.hz).toBeLessThan(205);
  });

  it("localProminence 对高地板不敏感、对尖峰敏感", () => {
    const v = new Float64Array(64).fill(0.1); // 地板 0.1
    v[32] = 1; // 10 倍 → 10dB
    const prom = localProminence(v, 32, 8);
    expect(prom).toBeGreaterThan(9);
    expect(prom).toBeLessThan(11);

    const flat = new Float64Array(64).fill(0.1);
    expect(localProminence(flat, 32, 8)).toBeLessThan(1);
  });

  it("findPeaks 只报告超过突起门限的局部极大值", () => {
    const f = Float64Array.from({ length: 1025 }, (_, k) => k * 5);
    const v = new Float64Array(1025).fill(1e-5);
    v[100] = 1e-2; // 30dB 峰
    v[500] = 1e-5 * 2; // 3dB，不应报
    const peaks = findPeaks(f, v, { minProminenceDb: 10, minHz: 10 });
    expect(peaks).toHaveLength(1);
    expect(peaks[0].index).toBe(100);
  });
});
