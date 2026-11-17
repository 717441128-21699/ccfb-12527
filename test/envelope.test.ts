import { describe, it, expect } from "vitest";
import {
  bandpassButterworth4,
  hilbertEnvelope,
  envelopeSpectrum,
  detrend,
} from "../src/dsp/envelope.js";

describe("共振解调 / 包络", () => {
  const fs = 48000;

  it("带通滤波器保留通带、压制阻带", () => {
    const n = 16384;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] =
        Math.sin(2 * Math.PI * 3500 * (i / fs)) + // 通带内
        Math.sin(2 * Math.PI * 200 * (i / fs)); // 通带外
    }
    const y = bandpassButterworth4(x, fs, 1500, 8000);
    // 跳过起振暂态后比较 RMS
    const rms = (a: Float64Array, from: number) => {
      let s = 0;
      for (let i = from; i < a.length; i++) s += a[i] * a[i];
      return Math.sqrt(s / (a.length - from));
    };
    const out = rms(y, 4000);
    // 单独跑一个 200Hz 信号量化阻带衰减
    const low = new Float64Array(n);
    for (let i = 0; i < n; i++) low[i] = Math.sin(2 * Math.PI * 200 * (i / fs));
    const lowFilt = bandpassButterworth4(low, fs, 1500, 8000);
    const stopRatio = rms(lowFilt, 4000) / Math.SQRT1_2;
    expect(stopRatio).toBeLessThan(0.05); // 200Hz 衰减 26dB 以上
    expect(out).toBeGreaterThan(0.5); // 3.5kHz 基本保留
  });

  it("Hilbert 包络能提取幅度调制频率", () => {
    const n = 16384;
    const carrier = 3000;
    const mod = 120; // 120Hz 幅度调制
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const env = 1 + 0.8 * Math.sin(2 * Math.PI * mod * (i / fs));
      x[i] = env * Math.sin(2 * Math.PI * carrier * (i / fs));
    }
    const env = hilbertEnvelope(x);
    // 包络均值应在 1 附近，且含明显 120Hz 周期 → 标准差显著
    let mean = 0;
    for (const v of env) mean += v;
    mean /= n;
    expect(mean).toBeGreaterThan(0.8);
    let varc = 0;
    for (const v of env) varc += (v - mean) ** 2;
    expect(Math.sqrt(varc / n)).toBeGreaterThan(0.3);
  });

  it("周期冲击串在包络谱的重复频率处出峰", () => {
    const n = fs; // 1 秒
    const repeat = 89; // 89Hz 冲击
    const x = new Float64Array(n);
    const period = Math.round(fs / repeat);
    for (let p = 0; p * period < n; p++) {
      const start = p * period;
      for (let k = 0; k < 400 && start + k < n; k++) {
        x[start + k] += Math.exp(-k / 80) * Math.sin(2 * Math.PI * 3200 * (k / fs));
      }
    }
    const { magnitude, freqs } = envelopeSpectrum(x, fs, {
      bandLowHz: 1500,
      bandHighHz: 8000,
      nfft: 16384,
    });
    const binHz = freqs[1] - freqs[0];
    const target = Math.round(repeat / binHz);
    let localMax = 0;
    for (let d = -3; d <= 3; d++) localMax = Math.max(localMax, magnitude[target + d]);
    const bandAvg =
      magnitude.slice(20, 200).reduce((a, b) => a + b, 0) / magnitude.slice(20, 200).length;
    expect(localMax).toBeGreaterThan(bandAvg * 5);
  });

  it("detrend 去掉均值与线性趋势", () => {
    const x = Float64Array.from({ length: 1000 }, (_, i) => 3 + 0.01 * i + Math.sin(i * 0.2));
    const y = detrend(x);
    const mean = y.reduce((a, b) => a + b, 0) / y.length;
    expect(mean).toBeCloseTo(0, 9);
    // 端点不再带趋势偏移
    expect(Math.abs(y[0])).toBeLessThan(2);
    expect(Math.abs(y[999])).toBeLessThan(2);
  });

  it("非法带通区间抛错", () => {
    expect(() =>
      bandpassButterworth4(new Float64Array(1024), fs, 8000, 1000),
    ).toThrow();
  });
});
