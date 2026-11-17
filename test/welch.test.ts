import { describe, it, expect } from "vitest";
import { welch, psdToDb, nextPow2 } from "../src/dsp/welch.js";

describe("Welch PSD", () => {
  const fs = 48000;
  const n = fs * 2; // 2 秒

  it("白噪声 PSD 近似平坦且总能量与信号方差一致", () => {
    const x = new Float64Array(n);
    let seed = 42;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < n; i++) x[i] = rng() * 2 - 1; // 方差 1/3
    const { psd, freqs, segments } = welch(x, fs, { nfft: 4096 });
    expect(freqs[1] - freqs[0]).toBeCloseTo(fs / 4096, 6);
    expect(segments).toBeGreaterThan(10);

    // 积分 PSD（梯形法）应回到信号方差 1/3，这是比逐点均值更本质的归一化校验
    const binHz = freqs[1] - freqs[0];
    let power = 0;
    for (let k = 0; k < psd.length - 1; k++) power += 0.5 * (psd[k] + psd[k + 1]) * binHz;
    expect(power).toBeGreaterThan((1 / 3) * 0.85);
    expect(power).toBeLessThan((1 / 3) * 1.15);

    // 白噪声 PSD 均值 ≈ 方差/fs（含 DC/Nyquist 不翻倍的影响，容差放宽）
    let mean = 0;
    for (const p of psd) mean += p;
    mean /= psd.length;
    expect(mean).toBeGreaterThan((1 / 3 / fs) * 0.6);
    expect(mean).toBeLessThan((1 / 3 / fs) * 2.0);
  });

  it("正弦信号在其频率处形成显著峰，相邻 bin 明显更低", () => {
    const f0 = 1234;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * f0 * (i / fs));
    const { psd, freqs } = welch(x, fs, { nfft: 8192 });
    let peakK = 0;
    for (let k = 1; k < psd.length; k++) if (psd[k] > psd[peakK]) peakK = k;
    expect(freqs[peakK]).toBeGreaterThan(f0 - 10);
    expect(freqs[peakK]).toBeLessThan(f0 + 10);
    expect(psd[peakK]).toBeGreaterThan(psd[peakK - 5] * 20);
  });

  it("样本短于 nfft 时抛错而不是静默补零", () => {
    expect(() => welch(new Float64Array(100), fs, { nfft: 4096 })).toThrow();
  });

  it("psdToDb 单调且不产生 -Infinity", () => {
    const db = psdToDb(new Float64Array([0, 1e-10, 1e-3, 1]));
    expect(Number.isFinite(db[0])).toBe(true);
    expect(db[3]).toBeCloseTo(0, 6);
    expect(db[2]).toBeLessThan(db[3]);
  });

  it("nextPow2 边界", () => {
    expect(nextPow2(2)).toBe(2);
    expect(nextPow2(1000)).toBe(1024);
    expect(nextPow2(8192)).toBe(8192);
  });
});
