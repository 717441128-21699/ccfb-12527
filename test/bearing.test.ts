import { describe, it, expect } from "vitest";
import {
  bearingFrequencies,
  faultHarmonics,
  BEARING_REF_GUARD,
} from "../src/dsp/bearing.js";

// 教材标准 6205 轴承：N=9, d=7.94mm, D=39.04mm, α=0
const GEO = { ballCount: 9, pitchD: 39.04, ballD: 7.94 };

describe("轴承特征频率", () => {
  it("与 SKF 教材 6205@1500rpm 参考值吻合（误差 <1.5%）", () => {
    const f = bearingFrequencies(1500, GEO);
    const fr = 1500 / 60; // 25 Hz
    // 教材系数：BPFO≈3.585fr, BPFI≈5.415fr, BSF≈2.357fr, FTF≈0.398fr
    expect(f.bpfo / fr).toBeGreaterThan(3.5);
    expect(f.bpfo / fr).toBeLessThan(3.65);
    expect(f.bpfi / fr).toBeGreaterThan(5.3);
    expect(f.bpfi / fr).toBeLessThan(5.5);
    expect(f.bsf / fr).toBeGreaterThan(2.25);
    expect(f.bsf / fr).toBeLessThan(2.45);
    expect(f.ftf / fr).toBeGreaterThan(0.38);
    expect(f.ftf / fr).toBeLessThan(0.42);
  });

  it("BPFI > BPFO 且两者关于 N/2·fr 对称", () => {
    const f = bearingFrequencies(1800, GEO);
    expect(f.bpfi).toBeGreaterThan(f.bpfo);
    const mid = (f.bpfi + f.bpfo) / 2;
    expect(mid).toBeCloseTo((GEO.ballCount / 2) * f.shaft, 8);
  });

  it("频率随转速线性变化", () => {
    const a = bearingFrequencies(1000, GEO);
    const b = bearingFrequencies(2000, GEO);
    expect(b.bpfo).toBeCloseTo(2 * a.bpfo, 9);
    expect(b.bsf).toBeCloseTo(2 * a.bsf, 9);
  });

  it("非法几何参数抛错", () => {
    expect(() => bearingFrequencies(1500, { ...GEO, ballCount: 1 })).toThrow();
    expect(() => bearingFrequencies(1500, { ...GEO, ballD: 99 })).toThrow();
    expect(() => bearingFrequencies(0, GEO)).toThrow();
  });

  it("faultHarmonics：FTF 只到 2 阶，BSF 从 2 阶起查（2×BSF 机理）", () => {
    const f = bearingFrequencies(1500, GEO);
    const bpfo = faultHarmonics("bpfo", f);
    expect(bpfo).toHaveLength(4);
    expect(bpfo[1].hz).toBeCloseTo(2 * f.bpfo, 9);
    const ftf = faultHarmonics("ftf", f);
    expect(ftf).toHaveLength(2);
    const bsf = faultHarmonics("bsf", f);
    expect(bsf[0].order).toBe(2);
    expect(bsf[0].hz).toBeCloseTo(2 * f.bsf, 9);
  });

  it("接触角增大使 BPFO/BPFI 间距收窄", () => {
    const zero = bearingFrequencies(1500, GEO);
    const angled = bearingFrequencies(1500, { ...GEO, contactAngleRad: 0.3 });
    expect(angled.bpfi - angled.bpfo).toBeLessThan(zero.bpfi - zero.bpfo);
  });

  it("守卫常量存在且为教材几何（防误改）", () => {
    expect(BEARING_REF_GUARD.ballCount).toBe(9);
  });
});
