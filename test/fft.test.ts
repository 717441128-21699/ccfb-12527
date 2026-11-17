import { describe, it, expect } from "vitest";
import { FFT, realFftMagnitude, realIfft } from "../src/dsp/fft.js";

describe("FFT", () => {
  it("拒绝非 2 的幂长度", () => {
    expect(() => new FFT(1000)).toThrow();
    expect(() => new FFT(1)).toThrow();
  });

  it("直流信号能量集中在 0 号 bin", () => {
    const n = 1024;
    const fft = new FFT(n);
    const re = new Float64Array(n).fill(3);
    const im = new Float64Array(n);
    fft.run(re, im);
    expect(Math.abs(re[0])).toBeCloseTo(3 * n, 6);
    expect(Math.abs(im[0])).toBeLessThan(1e-9);
    let otherEnergy = 0;
    for (let k = 1; k < n; k++) otherEnergy += re[k] * re[k] + im[k] * im[k];
    expect(otherEnergy).toBeLessThan(1e-12);
  });

  it("单频正弦峰值落在正确 bin，幅度满足 Parseval 关系", () => {
    const n = 2048;
    const fs = 48000;
    const f0 = 1000; // 整 bin：1000/(48000/2048)=42.666… 非整 bin，改选整 bin
    const binHz = fs / n;
    const k0 = 170;
    const freq = k0 * binHz;
    const re = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin(2 * Math.PI * freq * (i / fs));
    const im = new Float64Array(n);
    new FFT(n).run(re, im);
    // 实正弦 |X[k0]| = N/2
    expect(Math.hypot(re[k0], im[k0])).toBeCloseTo(n / 2, 6);
    expect(Math.hypot(re[n - k0], im[n - k0])).toBeCloseTo(n / 2, 6);
    void f0;
  });

  it("ifft(fft(x)) 还原原序列", () => {
    const n = 512;
    const fft = new FFT(n);
    const orig = new Float64Array(n);
    for (let i = 0; i < n; i++) orig[i] = Math.sin(i * 0.1) + 0.3 * Math.cos(i * 0.03);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    re.set(orig);
    fft.run(re, im);
    const back = realIfft(re, im);
    for (let i = 0; i < n; i++) {
      expect(back[i]).toBeCloseTo(orig[i], 9);
    }
  });

  it("realFftMagnitude 输出单边长度 n/2+1", () => {
    const n = 256;
    const x = new Float64Array(n).map((_, i) => Math.sin(i * 0.2));
    const mag = realFftMagnitude(x);
    expect(mag.length).toBe(n / 2 + 1);
    expect(mag[0]).toBeGreaterThanOrEqual(0);
  });

  it("不同尺寸实例互不干扰（旋转因子表隔离）", () => {
    const a = new FFT(64);
    const b = new FFT(256);
    const ra = new Float64Array(64).fill(1);
    const ia = new Float64Array(64);
    const rb = new Float64Array(256).fill(1);
    const ib = new Float64Array(256);
    a.run(ra, ia);
    b.run(rb, ib);
    expect(ra[0]).toBeCloseTo(64, 9);
    expect(rb[0]).toBeCloseTo(256, 9);
  });
});
