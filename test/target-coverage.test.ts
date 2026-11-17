import { describe, it, expect } from 'vitest';
import { fitStretchModel, buildTargetFrequencies, type BMeasurement } from '../src/core/stretch';
import { FIRST_MIDI, LAST_MIDI, midiToIndex } from '../src/core/notes';

const samples: BMeasurement[] = [
  { midi: 21, B: 8e-5, r2: 1 },
  { midi: 45, B: 3e-4, r2: 1 },
  { midi: 69, B: 7e-4, r2: 1 },
  { midi: 93, B: 2.5e-3, r2: 1 },
  { midi: 108, B: 8e-3, r2: 1 },
];

describe('88 键目标频率边界完整性', () => {
  for (const oct of ['2:1', '4:2', '6:3'] as const) {
    for (const temp of ['equal', 'meantone', 'werckmeister3']) {
      it(`${oct} + ${temp}：无零值、无 NaN、严格单调`, () => {
        const model = fitStretchModel(samples);
        const tf = buildTargetFrequencies(model, temp, oct, 442);
        for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
          const f = tf.targets[midiToIndex(midi)];
          expect(Number.isFinite(f)).toBe(true);
          expect(f).toBeGreaterThan(0);
        }
        for (let i = 1; i < 88; i++) {
          expect(tf.targets[i]).toBeGreaterThan(tf.targets[i - 1]);
        }
      });
    }
  }

  it('半音比落在物理合理范围（0.94~1.12 倍）', () => {
    // 历史律制的特征半音（如中庸全音律 B→C）本身偏宽，叠加高音区
    // 6:3 拉伸后可达 ~165 音分（比值 ~1.10），属物理正确而非异常。
    const model = fitStretchModel(samples);
    const tf = buildTargetFrequencies(model, 'meantone', '6:3', 440);
    for (let i = 1; i < 88; i++) {
      const ratio = tf.targets[i] / tf.targets[i - 1];
      expect(ratio).toBeGreaterThan(0.94);
      expect(ratio).toBeLessThan(1.12);
    }
  });
});
