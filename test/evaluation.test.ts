import { describe, it, expect } from "vitest";
import { analyze } from "../src/core/detector.js";
import { BaselineBuilder } from "../src/core/baseline.js";
import { welch } from "../src/dsp/welch.js";
import { synthMotorSignal } from "./synth.js";
import { BEARING_6205, type DetectorConfig } from "../src/core/config.js";
import type { FaultKind } from "../src/dsp/bearing.js";

/**
 * 验收指标 2 的算法侧验证（合成信号）：
 *   检出率 TPR ≥ 95%，误报率 FPR ≤ 2%，故障类型准确率 ≥ 90%。
 *
 * 现场验收需用老师傅双判的真实录音替换合成集，本测试只证明
 * “阈值 + 信号链”在已知机理信号上能达到目标区分度。
 */

const RPM = 1500;
const FAULTS: FaultKind[] = ["bpfo", "bpfi", "bsf", "ftf"];
const N_GOOD_TRAIN = 100; // 基线库规模（需求：100 台合格电机）
const N_GOOD_TEST = 100;
const N_PER_FAULT = 25; // 4 × 25 = 100 台故障

function baselineFromGood(seedBase: number) {
  let builder: BaselineBuilder | null = null;
  for (let i = 0; i < N_GOOD_TRAIN; i++) {
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

describe("评估：TPR ≥95% / FPR ≤2%（合成带标签集）", () => {
  it("全量统计达标", () => {
    const baseline = baselineFromGood(10000);

    // --- 合格电机误报 ---
    let falseAlarms = 0;
    for (let i = 0; i < N_GOOD_TEST; i++) {
      const x = synthMotorSignal({
        rpm: RPM,
        bearing: BEARING_6205,
        seed: 20000 + i,
        fault: null,
      });
      const r = analyze({ samples: x, rpm: RPM, bearing: BEARING_6205, baseline });
      if (r.verdict === "fail") falseAlarms++;
    }
    const fpr = falseAlarms / N_GOOD_TEST;

    // --- 故障电机检出 + 分类 ---
    let detected = 0;
    let correctKind = 0;
    const perKind: Record<string, { hit: number; total: number }> = {};
    for (const kind of FAULTS) {
      perKind[kind] = { hit: 0, total: 0 };
      for (let i = 0; i < N_PER_FAULT; i++) {
        const x = synthMotorSignal({
          rpm: RPM,
          bearing: BEARING_6205,
          seed: 30000 + i * 7 + kind.length * 13,
          fault: kind,
          // 故障强度在 0.9~1.5 间分散，模拟现场离散度
          faultLevel: 0.9 + (i % 4) * 0.2,
        });
        const r = analyze({ samples: x, rpm: RPM, bearing: BEARING_6205, baseline });
        perKind[kind].total++;
        if (r.verdict === "fail") {
          detected++;
          perKind[kind].hit++;
          if (r.primaryFault?.kind === kind) correctKind++;
        }
      }
    }

    const totalFaults = N_PER_FAULT * FAULTS.length;
    const tpr = detected / totalFaults;
    const kindAcc = correctKind / totalFaults;

    console.log("==== 评估结果（合成信号）====");
    console.log(`合格样本 ${N_GOOD_TEST} 台，误报 ${falseAlarms} 台，FPR=${(fpr * 100).toFixed(1)}%`);
    console.log(`故障样本 ${totalFaults} 台，检出 ${detected} 台，TPR=${(tpr * 100).toFixed(1)}%`);
    console.log(`故障类型准确率=${(kindAcc * 100).toFixed(1)}%`);
    for (const kind of FAULTS) {
      const s = perKind[kind];
      console.log(`  ${kind}: ${s.hit}/${s.total}`);
    }

    expect(fpr).toBeLessThanOrEqual(0.02);
    expect(tpr).toBeGreaterThanOrEqual(0.95);
    expect(kindAcc).toBeGreaterThanOrEqual(0.9);
  });

  it("门限配置自洽：提高判决门限应单调降低误报", () => {
    const baseline = baselineFromGood(40000);
    const failsAt = (threshold: number) => {
      const cfg: Partial<DetectorConfig> = { machineFailThreshold: threshold, channelScoreThreshold: threshold };
      let fails = 0;
      for (let i = 0; i < 30; i++) {
        const x = synthMotorSignal({
          rpm: RPM,
          bearing: BEARING_6205,
          seed: 50000 + i,
          fault: null,
        });
        if (analyze({ samples: x, rpm: RPM, bearing: BEARING_6205, baseline, config: cfg }).verdict === "fail") {
          fails++;
        }
      }
      return fails;
    };
    expect(failsAt(4)).toBeLessThanOrEqual(failsAt(1.5));
  });
});
