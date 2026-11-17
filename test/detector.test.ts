import { describe, it, expect } from "vitest";
import { analyze } from "../src/core/detector.js";
import { BaselineBuilder } from "../src/core/baseline.js";
import { welch } from "../src/dsp/welch.js";
import { synthMotorSignal } from "./synth.js";
import { BEARING_6205 } from "../src/core/config.js";

const RPM = 1500;

function buildBaseline(count: number, seedBase: number) {
  let builder: BaselineBuilder | null = null;
  for (let i = 0; i < count; i++) {
    const x = synthMotorSignal({
      rpm: RPM,
      bearing: BEARING_6205,
      seed: seedBase + i,
      fault: null,
    });
    const { psd, freqs, nfft } = welch(x, 48000, { nfft: 8192 });
    if (!builder) builder = new BaselineBuilder(48000, nfft, freqs);
    builder.add(psd);
  }
  return builder!.build();
}

describe("端到端判决（合成信号）", () => {
  it("合格电机判 pass，且不报任何故障通道", () => {
    const baseline = buildBaseline(60, 1000);
    const x = synthMotorSignal({ rpm: RPM, bearing: BEARING_6205, seed: 9001, fault: null });
    const r = analyze({ samples: x, rpm: RPM, bearing: BEARING_6205, baseline });
    expect(r.verdict).toBe("pass");
    expect(r.primaryFault).toBeNull();
    for (const c of r.channels) expect(c.score).toBeLessThan(2.5);
  });

  it.each(["bpfo", "bpfi", "bsf", "ftf"] as const)(
    "%s 故障电机判 fail 且主故障类型正确",
    (kind) => {
      const baseline = buildBaseline(60, 2000);
      const x = synthMotorSignal({
        rpm: RPM,
        bearing: BEARING_6205,
        seed: 3000 + kind.length,
        fault: kind,
        faultLevel: 1.2,
      });
      const r = analyze({ samples: x, rpm: RPM, bearing: BEARING_6205, baseline });
      expect(r.verdict).toBe("fail");
      expect(r.primaryFault?.kind).toBe(kind);
    },
  );

  it("无基线模式仍可凭突起度+包络检出强故障", () => {
    const x = synthMotorSignal({
      rpm: RPM,
      bearing: BEARING_6205,
      seed: 4242,
      fault: "bpfo",
      faultLevel: 1.6,
    });
    const r = analyze({ samples: x, rpm: RPM, bearing: BEARING_6205 });
    expect(r.verdict).toBe("fail");
    expect(r.primaryFault?.kind).toBe("bpfo");
  });

  it("故障越强得分越高（单调性）", () => {
    const baseline = buildBaseline(60, 4000);
    const scoreOf = (level: number) => {
      const x = synthMotorSignal({
        rpm: RPM,
        bearing: BEARING_6205,
        seed: 555,
        fault: "bpfi",
        faultLevel: level,
      });
      return analyze({ samples: x, rpm: RPM, bearing: BEARING_6205, baseline })
        .channels.find((c) => c.kind === "bpfi")!.score;
    };
    expect(scoreOf(0.5)).toBeLessThan(scoreOf(1.5));
  });

  it("结果包含可解释证据（每通道谐波证据齐全）", () => {
    const x = synthMotorSignal({ rpm: RPM, bearing: BEARING_6205, seed: 77, fault: "bpfo" });
    const r = analyze({ samples: x, rpm: RPM, bearing: BEARING_6205 });
    for (const ch of r.channels) {
      expect(ch.evidence.length).toBeGreaterThan(0);
      for (const e of ch.evidence) {
        expect(e.expectedHz).toBeGreaterThan(0);
        expect(Number.isFinite(e.prominenceDb)).toBe(true);
      }
    }
    expect(r.rms).toBeGreaterThan(0);
  });
});
