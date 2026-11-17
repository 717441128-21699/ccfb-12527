/**
 * 端到端：模拟一次完整的调律工作流，验证各核心模块衔接。
 * 合成样本音 → 测 B（验收 5%）→ 拟合拉伸模型 → 生成 88 键目标
 * → 调律读数（音分偏差方向正确）→ 齐音拍频。
 */
import { describe, it, expect } from 'vitest';
import { synthesizePianoTone } from '../src/core/synth';
import { measureInharmonicity } from '../src/core/inharmonicity';
import { fitStretchModel, buildTargetFrequencies, BAt } from '../src/core/stretch';
import type { KeyMeasurement } from '../src/core/storage';
import { equalTempFrequency, midiToIndex, A4_MIDI } from '../src/core/notes';
import { TunerEngine } from '../src/core/tuner-engine';
import { detectBeats } from '../src/core/beats';

const SR = 48000;
const SAMPLE_MIDIS = [21, 28, 33, 40, 45, 49, 52, 57, 60, 64, 69, 76, 84, 96];

/** 与 audio-session.typicalB 相同的典型 B 曲线，作为合成“真值” */
function trueB(midi: number): number {
  const alpha = Math.log(8e-5);
  const beta = (Math.log(8e-3) - Math.log(8e-5)) / (108 - 21);
  return Math.exp(alpha + beta * (midi - 21));
}

describe('端到端调律工作流', () => {
  it('完整链路：合成→测量→拟合→目标→调律→拍频', () => {
    // 1) 逐音测量
    const measurements: KeyMeasurement[] = [];
    for (const midi of SAMPLE_MIDIS) {
      const f0 = equalTempFrequency(midi);
      const B = trueB(midi);
      const sig = synthesizePianoTone({
        f1: f0, B, sampleRate: SR,
        duration: midi < 40 ? 3 : 2.5,
        decayTaus: midi < 40 ? [3, 2.4, 1.9, 1.5, 1.2, 1, 0.85, 0.7] : undefined,
        noiseLevel: 0.002, seed: midi,
      });
      const targetSeconds = midi < 40 ? 1.37 : midi < 72 ? 0.68 : 0.34;
      const len = 1 << Math.floor(Math.log2(targetSeconds * SR));
      const frame = sig.subarray(1000, 1000 + len) as Float64Array;
      const r = measureInharmonicity(frame, SR, { expectedF0: f0 });
      expect(r).not.toBeNull();
      // 验收硬指标：每个样本 B 误差 ≤5%
      expect(Math.abs(r!.B - B) / B).toBeLessThanOrEqual(0.05);
      measurements.push({ midi, B: r!.B, fundamental: r!.fundamental, r2: r!.r2, measuredAt: Date.now() });
    }

    // 2) 拟合拉伸模型
    const model = fitStretchModel(measurements);
    // 模型在样本点上应贴近实测
    for (const m of measurements) {
      expect(Math.abs(BAt(model, m.midi) - m.B) / m.B).toBeLessThan(0.4);
    }

    // 3) 三种八度类型都能生成合法的 88 键目标
    for (const oct of ['2:1', '4:2', '6:3'] as const) {
      const tf = buildTargetFrequencies(model, 'equal', oct, 440);
      expect(tf.targets.length).toBe(88);
      for (let i = 1; i < 88; i++) expect(tf.targets[i]).toBeGreaterThan(tf.targets[i - 1]);
      // A4 锚点
      expect(tf.targets[midiToIndex(A4_MIDI)]).toBeCloseTo(440, 3);
    }

    // 4) 调律读数：故意把音弹高 15 音分，引擎应判正偏差
    const tf = buildTargetFrequencies(model, 'equal', '4:2', 440);
    const testMidi = 60;
    const target = tf.targets[midiToIndex(testMidi)];
    const sharpFactor = Math.pow(2, 15 / 1200);
    const sharpSig = synthesizePianoTone({
      f1: equalTempFrequency(testMidi) * sharpFactor,
      B: trueB(testMidi), sampleRate: SR, duration: 2, noiseLevel: 0.001, seed: 77,
    });
    const engine = new TunerEngine({
      targetF0: target,
      expectedF0: equalTempFrequency(testMidi),
      smoothTau: 0.05, // 测试里用小时间常数快速收敛
      medianWindow: 1,
    });
    const block = 4096;
    let reading: ReturnType<TunerEngine['pushBlock']> = null;
    for (let off = 0; off + block <= sharpSig.length; off += block) {
      const r = engine.pushBlock(Float32Array.from(sharpSig.subarray(off, off + block)), SR);
      if (r && r.active) reading = r;
    }
    expect(reading).not.toBeNull();
    expect(reading!.active).toBe(true);
    // 平滑后读数应在 +15 音分附近（容差放宽，受窗与平滑影响）
    expect(reading!.smoothCents).toBeGreaterThan(8);
    expect(reading!.smoothCents).toBeLessThan(22);

    // 5) 齐音拍频：两弦差 2Hz 应检出 ~2 拍/秒且判未齐
    const beatSig = synthesizePianoTone({
      f1: equalTempFrequency(testMidi), B: trueB(testMidi), sampleRate: SR, duration: 6,
      decayTaus: [4, 4, 4, 4, 4, 4, 4, 4], noiseLevel: 0.001, seed: 88,
      strings: [
        { gain: 1, detune: 1 },
        { gain: 1, detune: 1 + 2 / equalTempFrequency(testMidi) },
        { gain: 1, detune: 1 + 2 / equalTempFrequency(testMidi) },
      ],
    });
    const beat = detectBeats(beatSig, SR, { targetF0: equalTempFrequency(testMidi) });
    expect(beat.isUnison).toBe(false);
    expect(Math.abs(beat.beatHz - 2)).toBeLessThan(0.6);
  });
});
