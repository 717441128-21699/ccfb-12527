/**
 * 离线评估 CLI：在带标签数据集上跑 TPR/FPR/分类准确率。
 *
 * 用法：
 *   npx tsx scripts/run-eval.ts [--good=100] [--per-fault=25] [--json]
 *
 * 当前默认使用合成信号验证算法链路；现场接入真实录音后，
 * 把 loadCase() 换成从 WAV 目录读取 + 标签 CSV 即可，评估逻辑不变。
 */

import { analyze } from "../src/core/detector.js";
import { BaselineBuilder } from "../src/core/baseline.js";
import { welch } from "../src/dsp/welch.js";
import { synthMotorSignal } from "../test/synth.js";
import { BEARING_6205, type DetectorConfig } from "../src/core/config.js";
import type { FaultKind } from "../src/dsp/bearing.js";

interface Args {
  goodTrain: number;
  goodTest: number;
  perFault: number;
  json: boolean;
  threshold?: number;
}

function parseArgs(): Args {
  const args: Args = { goodTrain: 100, goodTest: 100, perFault: 25, json: false };
  for (const a of process.argv.slice(2)) {
    if (a === "--json") args.json = true;
    else if (a.startsWith("--good-train=")) args.goodTrain = Number(a.split("=")[1]);
    else if (a.startsWith("--good-test=")) args.goodTest = Number(a.split("=")[1]);
    else if (a.startsWith("--per-fault=")) args.perFault = Number(a.split("=")[1]);
    else if (a.startsWith("--threshold=")) args.threshold = Number(a.split("=")[1]);
  }
  return args;
}

const RPM = 1500;
const FAULTS: FaultKind[] = ["bpfo", "bpfi", "bsf", "ftf"];

function main(): void {
  const args = parseArgs();
  const config: Partial<DetectorConfig> = {};
  if (args.threshold) {
    config.machineFailThreshold = args.threshold;
    config.channelScoreThreshold = args.threshold;
  }

  // 基线
  let builder: BaselineBuilder | null = null;
  for (let i = 0; i < args.goodTrain; i++) {
    const x = synthMotorSignal({ rpm: RPM, bearing: BEARING_6205, seed: 10000 + i });
    const { psd, freqs, nfft } = welch(x, 48000, { nfft: 8192 });
    if (!builder) builder = new BaselineBuilder(48000, nfft, freqs);
    builder.add(psd);
  }
  const baseline = builder!.build();

  // 合格样本 FPR
  let falseAlarms = 0;
  const goodMs: number[] = [];
  for (let i = 0; i < args.goodTest; i++) {
    const x = synthMotorSignal({ rpm: RPM, bearing: BEARING_6205, seed: 20000 + i });
    const t0 = performance.now();
    const r = analyze({ samples: x, rpm: RPM, bearing: BEARING_6205, baseline, config });
    goodMs.push(performance.now() - t0);
    if (r.verdict === "fail") falseAlarms++;
  }

  // 故障样本 TPR + 分类
  let detected = 0;
  let correctKind = 0;
  const perKind: Record<string, { hit: number; correct: number; total: number }> = {};
  const faultMs: number[] = [];
  for (const kind of FAULTS) {
    perKind[kind] = { hit: 0, correct: 0, total: 0 };
    for (let i = 0; i < args.perFault; i++) {
      const x = synthMotorSignal({
        rpm: RPM,
        bearing: BEARING_6205,
        seed: 30000 + i * 7 + kind.length * 13,
        fault: kind,
        faultLevel: 0.9 + (i % 4) * 0.2,
      });
      const t0 = performance.now();
      const r = analyze({ samples: x, rpm: RPM, bearing: BEARING_6205, baseline, config });
      faultMs.push(performance.now() - t0);
      perKind[kind].total++;
      if (r.verdict === "fail") {
        detected++;
        perKind[kind].hit++;
        if (r.primaryFault?.kind === kind) {
          correctKind++;
          perKind[kind].correct++;
        }
      }
    }
  }

  const totalFaults = args.perFault * FAULTS.length;
  const avgMs = [...goodMs, ...faultMs].reduce((a, b) => a + b, 0) / (goodMs.length + faultMs.length);
  const report = {
    sample: { goodTrain: args.goodTrain, goodTest: args.goodTest, faults: totalFaults },
    fpr: falseAlarms / args.goodTest,
    tpr: detected / totalFaults,
    kindAccuracy: correctKind / totalFaults,
    perKind,
    avgProcessingMs: Number(avgMs.toFixed(1)),
    passFpr: falseAlarms / args.goodTest <= 0.02,
    passTpr: detected / totalFaults >= 0.95,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log("==== 电机异响检测评估（合成带标签信号）====");
  console.log(`基线: ${args.goodTrain} 台合格机 | 测试: ${args.goodTest} 合格 + ${totalFaults} 故障`);
  console.log(`误报率 FPR = ${(report.fpr * 100).toFixed(1)}%  (门限 2%)  ${report.passFpr ? "✓" : "✗"}`);
  console.log(`检出率 TPR = ${(report.tpr * 100).toFixed(1)}%  (门限 95%) ${report.passTpr ? "✓" : "✗"}`);
  console.log(`分类准确率 = ${(report.kindAccuracy * 100).toFixed(1)}%`);
  for (const k of FAULTS) {
    const s = perKind[k];
    console.log(`  ${k.toUpperCase()}: 检出 ${s.hit}/${s.total}，类型正确 ${s.correct}/${s.total}`);
  }
  console.log(`平均处理耗时 ${report.avgProcessingMs}ms（验收门限 1000ms）`);
  if (!report.passFpr || !report.passTpr) process.exitCode = 1;
}

main();
