import { describe, it, expect } from 'vitest';
import { synthesizePianoTone } from '../src/core/synth';
import { measureInharmonicity, robustMeasure, predictedFrequency } from '../src/core/inharmonicity';
import { equalTempFrequency } from '../src/core/notes';

// 浏览器 AudioContext 最常见的工作采样率
const SR = 48000;

/**
 * 按音区取 2 的幂长度稳态帧：
 * 低音需要长帧保证基频附近的频率分辨率，高音用短帧即可。
 */
function takeFrame(signal: Float64Array, midi: number, startSeconds = 0.02): Float64Array {
  const targetSeconds = midi < 40 ? 1.37 : midi < 72 ? 0.68 : 0.34;
  const len = 1 << Math.round(Math.log2(targetSeconds * SR));
  const start = Math.floor(startSeconds * SR);
  return signal.subarray(start, start + len) as Float64Array;
}

/** 低音弦泛音衰减明显更慢，给一组贴近真实的时间常数（秒） */
const BASS_DECAYS = [3.0, 2.4, 1.9, 1.5, 1.2, 1.0, 0.85, 0.7];

describe('非谐性 B 拟合精度（验收：与设定值相差 ≤5%）', () => {
  // 覆盖低音区小 B 到高音区大 B 的典型范围
  const cases: { name: string; midi: number; B: number }[] = [
    { name: '三角琴低音 A0 级', midi: 21, B: 8e-5 },
    { name: '低音区 A1', midi: 33, B: 2.5e-4 },
    { name: '中音区 A3', midi: 57, B: 6e-4 },
    { name: '中央 C4', midi: 60, B: 8e-4 },
    { name: '高音区 A5', midi: 81, B: 2e-3 },
    { name: '最高音区 C7', midi: 96, B: 4.5e-3 },
    { name: '短弦立式高音 C8', midi: 108, B: 8e-3 },
  ];

  for (const c of cases) {
    it(`${c.name}：B=${c.B}`, () => {
      const f0 = equalTempFrequency(c.midi);
      const signal = synthesizePianoTone({
        f1: f0,
        B: c.B,
        sampleRate: SR,
        duration: 3,
        partialCount: 8,
        decayTaus: c.midi < 40 ? BASS_DECAYS : undefined,
        noiseLevel: 0.002,
        seed: c.midi,
      });
      const frame = takeFrame(signal, c.midi);
      const result = measureInharmonicity(frame, SR, { expectedF0: f0 * 1.001 });
      expect(result).not.toBeNull();
      const r = result!;
      const err = Math.abs(r.B - c.B) / c.B;
      console.log(
        `${c.name.padEnd(16)} B设定=${c.B.toExponential(2)} B拟合=${r.B.toExponential(2)} ` +
        `误差=${(err * 100).toFixed(2)}% R²=${r.r2.toFixed(6)} 泛音数=${r.partials.length} ` +
        `f1误差=${(100 * Math.abs(r.fundamental - f0) / f0).toFixed(3)}%`,
      );
      expect(err).toBeLessThanOrEqual(0.05);
      expect(r.r2).toBeGreaterThan(0.99);
      expect(Math.abs(r.fundamental - f0) / f0).toBeLessThan(0.002);
    });
  }

  it('44.1kHz 采样率下同样达标', () => {
    const sr = 44100;
    const midi = 60;
    const B = 7e-4;
    const f0 = equalTempFrequency(midi);
    const signal = synthesizePianoTone({ f1: f0, B, sampleRate: sr, duration: 3, noiseLevel: 0.002, seed: 7 });
    const len = 1 << Math.round(Math.log2(0.68 * sr));
    const frame = signal.subarray(1000, 1000 + len) as Float64Array;
    const r = measureInharmonicity(frame, sr, { expectedF0: f0 });
    expect(r).not.toBeNull();
    const err = Math.abs(r!.B - B) / B;
    console.log(`44.1k 测试 B拟合=${r!.B.toExponential(2)} 误差=${(err * 100).toFixed(2)}%`);
    expect(err).toBeLessThanOrEqual(0.05);
  });

  it('噪声较大时（1% 加性噪声）多帧中位数仍 ≤5%', () => {
    const midi = 49; // A2
    const B = 4e-4;
    const f0 = equalTempFrequency(midi);
    const frames = [];
    for (let seed = 1; seed <= 5; seed++) {
      const signal = synthesizePianoTone({
        f1: f0, B, sampleRate: SR, duration: 3, noiseLevel: 0.01, seed,
      });
      frames.push({ samples: takeFrame(signal, midi, 0.02 + seed * 0.1), sampleRate: SR, expectedF0: f0 });
    }
    const r = robustMeasure(frames);
    expect(r).not.toBeNull();
    const err = Math.abs(r!.B - B) / B;
    console.log(`噪声测试 B拟合=${r!.B.toExponential(2)} 误差=${(err * 100).toFixed(2)}%`);
    expect(err).toBeLessThanOrEqual(0.05);
  });

  it('三根齐音弦轻微失谐时仍 ≤5%', () => {
    const midi = 60;
    const B = 7e-4;
    const f0 = equalTempFrequency(midi);
    const signal = synthesizePianoTone({
      f1: f0,
      B,
      sampleRate: SR,
      duration: 3,
      noiseLevel: 0.002,
      strings: [
        { gain: 1, detune: 0.9996 },
        { gain: 1, detune: 1.0 },
        { gain: 1, detune: 1.0005 },
      ],
    });
    const r = measureInharmonicity(takeFrame(signal, midi), SR, { expectedF0: f0 });
    expect(r).not.toBeNull();
    const err = Math.abs(r!.B - B) / B;
    console.log(`三弦测试 B拟合=${r!.B.toExponential(2)} 误差=${(err * 100).toFixed(2)}% 泛音数=${r!.partials.length}`);
    expect(err).toBeLessThanOrEqual(0.05);
  });

  it('泛音频率与非谐物理模型自洽', () => {
    const f1 = 27.5;
    const B = 1e-4;
    for (let n = 1; n <= 8; n++) {
      const f = predictedFrequency(f1, B, n);
      expect(f).toBeGreaterThan(n * f1); // 刚性弦泛音恒偏高
      expect(f / (n * f1)).toBeCloseTo(Math.sqrt(1 + B * n * n), 10);
    }
  });
});
