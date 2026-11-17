import { describe, it, expect } from "vitest";
import { analyze } from "../src/core/detector.js";
import { synthMotorSignal } from "./synth.js";
import { BEARING_6205 } from "../src/core/config.js";
import { BaselineBuilder } from "../src/core/baseline.js";
import { welch } from "../src/dsp/welch.js";

/**
 * 验收指标 1：一台电机从录音结束到出结论 < 1000ms。
 * 录音 5s 是采集时间，不计入处理耗时；处理只含 Welch + 包络 + 判决。
 * 在 CI/普通办公机上留 3 倍余量，门限设 300ms。
 */
describe("性能（验收：处理 < 1s）", () => {
  it("5s@48k 全流程处理耗时 < 300ms", () => {
    const x = synthMotorSignal({
      rpm: 1500,
      bearing: BEARING_6205,
      durationSec: 5,
      seed: 99,
      fault: "bpfo",
    });
    // 预热（JIT、查表初始化）
    analyze({ samples: x, rpm: 1500, bearing: BEARING_6205 });

    const t0 = performance.now();
    const r = analyze({ samples: x, rpm: 1500, bearing: BEARING_6205 });
    const elapsed = performance.now() - t0;
    console.log(`处理耗时: ${elapsed.toFixed(1)}ms（检测器自报 ${r.processingMs.toFixed(1)}ms）`);
    expect(elapsed).toBeLessThan(300);
    expect(r.processingMs).toBeLessThan(300);
  });

  it("带基线的 100 台连续处理平均耗时 < 200ms", () => {
    const builder = new BaselineBuilder(
      48000,
      8192,
      welch(
        synthMotorSignal({ rpm: 1500, bearing: BEARING_6205, seed: 1 }),
        48000,
        { nfft: 8192 },
      ).freqs,
    );
    for (let i = 0; i < 100; i++) {
      builder.add(
        welch(
          synthMotorSignal({ rpm: 1500, bearing: BEARING_6205, seed: 5000 + i }),
          48000,
          { nfft: 8192 },
        ).psd,
      );
    }
    const baseline = builder.build();

    let total = 0;
    for (let i = 0; i < 20; i++) {
      const x = synthMotorSignal({ rpm: 1500, bearing: BEARING_6205, seed: 7000 + i });
      const t0 = performance.now();
      analyze({ samples: x, rpm: 1500, bearing: BEARING_6205, baseline });
      total += performance.now() - t0;
    }
    const avg = total / 20;
    console.log(`20 次平均处理耗时: ${avg.toFixed(1)}ms`);
    expect(avg).toBeLessThan(200);
  });
});
