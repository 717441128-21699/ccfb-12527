import { describe, it, expect } from "vitest";
import { BaselineBuilder, parseBaseline, zScoreVsBaseline } from "../src/core/baseline.js";

function makePsd(seed: number, len = 257, scale = 1): Float64Array {
  let s = seed;
  const rng = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  return Float64Array.from({ length: len }, (_, k) => scale * (1 + 0.1 * Math.sin(k * 0.3) + 0.02 * rng()));
}

describe("基线库", () => {
  const freqs = Float64Array.from({ length: 257 }, (_, k) => k * 18.75);

  it("100 台样本构建后可序列化往返且统计量正确", () => {
    const b = new BaselineBuilder(48000, 512, freqs);
    for (let i = 0; i < 100; i++) b.add(makePsd(i + 1));
    const data = b.build();
    expect(data.count).toBe(100);
    expect(data.meanDb).toHaveLength(257);
    const round = parseBaseline(JSON.stringify(data));
    expect(round.meanDb[10]).toBeCloseTo(data.meanDb[10], 10);
  });

  it("z-score：正常样本接近 0，异常抬升频段给出大正值", () => {
    const b = new BaselineBuilder(48000, 512, freqs);
    for (let i = 0; i < 100; i++) b.add(makePsd(i + 1));
    const baseline = b.build();

    const normal = makePsd(777);
    const zNormal = zScoreVsBaseline(normal, baseline);
    const normalMean = zNormal.reduce((a, x) => a + x, 0) / zNormal.length;
    expect(Math.abs(normalMean)).toBeLessThan(0.5);

    const loud = makePsd(777);
    for (let k = 40; k < 60; k++) loud[k] *= 8; // +9dB
    const zLoud = zScoreVsBaseline(loud, baseline);
    const maxZ = Math.max(...zLoud);
    expect(maxZ).toBeGreaterThan(3);
  });

  it("空基线 build 抛错、损坏 JSON 抛错", () => {
    const b = new BaselineBuilder(48000, 512, freqs);
    expect(() => b.build()).toThrow();
    expect(() => parseBaseline(JSON.stringify({ version: 2 }))).toThrow();
  });

  it("长度不一致的 PSD 被拒绝", () => {
    const b = new BaselineBuilder(48000, 512, freqs);
    expect(() => b.add(new Float64Array(10))).toThrow();
  });
});
