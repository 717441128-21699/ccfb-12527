import { describe, it, expect } from 'vitest';
import { fitStretchModel, buildTargetFrequencies, BAt, stretchCentsCurve, type BMeasurement } from '../src/core/stretch';
import { equalTempFrequency, FIRST_MIDI, LAST_MIDI, A4_MIDI, midiToIndex } from '../src/core/notes';
import { TEMPERAMENTS } from '../src/core/temperament';
import { synthesizePianoTone } from '../src/core/synth';
import { detectBeats } from '../src/core/beats';

describe('拉伸曲线拟合', () => {
  // 构造 14 个样本音，B 按真实规律随音位指数增长，加 10% 测量抖动
  const sampleMidis = [21, 28, 33, 40, 45, 49, 52, 57, 60, 64, 69, 76, 84, 96];
  const trueAlpha = Math.log(6e-5);
  const trueBeta = 0.055;
  const samples: BMeasurement[] = sampleMidis.map((midi, i) => ({
    midi,
    B: Math.exp(trueAlpha + trueBeta * midi) * (1 + 0.1 * Math.sin(i * 2.3)),
    r2: 0.999,
  }));

  it('拟合参数能还原生成模型（误差 <15%）', () => {
    const model = fitStretchModel(samples);
    expect(Math.abs((model.beta - trueBeta) / trueBeta)).toBeLessThan(0.15);
    // 样本点上的 B 估计与真值接近
    for (const s of samples) {
      const err = Math.abs(BAt(model, s.midi) - s.B) / s.B;
      expect(err).toBeLessThan(0.35);
    }
  });

  it('目标频率单调递增且覆盖全部 88 键', () => {
    const model = fitStretchModel(samples);
    const tf = buildTargetFrequencies(model, 'equal', '4:2', 440);
    expect(tf.targets.length).toBe(88);
    for (let i = 1; i < 88; i++) {
      expect(tf.targets[i]).toBeGreaterThan(tf.targets[i - 1]);
    }
    // A4 锚点
    expect(tf.targets[midiToIndex(A4_MIDI)]).toBeCloseTo(440, 4);
  });

  it('4:2 拉伸曲线相对平均律：低音偏低、高音偏高', () => {
    const model = fitStretchModel(samples);
    const tf = buildTargetFrequencies(model, 'equal', '4:2', 440);
    const curve = stretchCentsCurve(tf);
    const bass = curve.find((c) => c.midi === FIRST_MIDI)!.cents;
    const treble = curve.find((c) => c.midi === LAST_MIDI)!.cents;
    expect(bass).toBeLessThan(0);
    expect(treble).toBeGreaterThan(0);
    console.log(`4:2 拉伸：A0=${bass.toFixed(1)}音分  C8=${treble.toFixed(1)}音分`);
  });

  it('6:3 的总拉伸量大于 4:2，4:2 大于 2:1', () => {
    const model = fitStretchModel(samples);
    const span = (oct: '4:2' | '6:3' | '2:1') => {
      const tf = buildTargetFrequencies(model, 'equal', oct, 440);
      const curve = stretchCentsCurve(tf);
      const bass = curve[0].cents;
      const treble = curve[curve.length - 1].cents;
      return treble - bass;
    };
    expect(span('6:3')).toBeGreaterThan(span('4:2'));
    expect(span('4:2')).toBeGreaterThan(span('2:1'));
  });

  it('B 很小时拉伸曲线趋近平均律（|偏差| < 3 音分）', () => {
    const tiny: BMeasurement[] = [
      { midi: 33, B: 1e-7, r2: 1 },
      { midi: 60, B: 1.1e-7, r2: 1 },
      { midi: 84, B: 1.2e-7, r2: 1 },
    ];
    const model = fitStretchModel(tiny);
    const tf = buildTargetFrequencies(model, 'equal', '4:2', 440);
    for (let midi = 33; midi <= 84; midi++) {
      const nominal = equalTempFrequency(midi);
      const cents = 1200 / Math.LN2 * Math.log(tf.targets[midiToIndex(midi)] / nominal);
      expect(Math.abs(cents)).toBeLessThan(3);
    }
  });

  it('律制偏移正确叠加：中庸全音律的 C-E 接近纯律大三度', () => {
    // 用极小 B 的模型单独验证律制本身
    const tiny: BMeasurement[] = [
      { midi: 48, B: 1e-9, r2: 1 },
      { midi: 60, B: 1e-9, r2: 1 },
      { midi: 72, B: 1e-9, r2: 1 },
    ];
    const flat = buildTargetFrequencies(fitStretchModel(tiny), 'meantone', '2:1', 440);
    const c4 = flat.targets[midiToIndex(60)];
    const e4 = flat.targets[midiToIndex(64)];
    const thirdCents = 1200 / Math.LN2 * Math.log(e4 / c4);
    // 纯律大三度 = 386.31 音分，允许 2 音分误差
    expect(Math.abs(thirdCents - 386.31)).toBeLessThan(2);
  });

  it('全部律制表均为 12 项且范围合理', () => {
    for (const t of TEMPERAMENTS) {
      expect(t.centsOffset.length).toBe(12);
      for (const c of t.centsOffset) expect(Math.abs(c)).toBeLessThan(30);
    }
  });
});

describe('齐音拍频检测', () => {
  const SR = 48000;
  const f0 = equalTempFrequency(60); // C4 ≈ 261.6
  // 慢衰减，保证整个测量窗内都有足够信号
  const slowDecay = [4, 4, 4, 4, 4, 4, 4, 4];

  it('三弦完全齐音时拍频≈0，判定为齐', () => {
    const sig = synthesizePianoTone({
      f1: f0, B: 5e-4, sampleRate: SR, duration: 6, decayTaus: slowDecay,
      strings: [{ gain: 1 }, { gain: 1 }, { gain: 1 }],
      noiseLevel: 0.001, seed: 3,
    });
    const r = detectBeats(sig, SR, { targetF0: f0 });
    console.log(`齐音：beat=${r.beatHz.toFixed(2)}Hz depth=${r.modulationDepth.toFixed(3)} isUnison=${r.isUnison}`);
    expect(r.isUnison).toBe(true);
    expect(r.modulationDepth).toBeLessThan(0.1);
  });

  it('两弦相差 2Hz 时能测出约 2 拍/秒', () => {
    const sig = synthesizePianoTone({
      f1: f0, B: 5e-4, sampleRate: SR, duration: 6, decayTaus: slowDecay,
      strings: [
        { gain: 1, detune: 1 },
        { gain: 1, detune: 1 + 2 / f0 },
        { gain: 1, detune: 1 + 2 / f0 },
      ],
      noiseLevel: 0.001, seed: 5,
    });
    const r = detectBeats(sig, SR, { targetF0: f0 });
    console.log(`2Hz失谐：beat=${r.beatHz.toFixed(2)}Hz depth=${r.modulationDepth.toFixed(3)}`);
    expect(r.isUnison).toBe(false);
    expect(Math.abs(r.beatHz - 2)).toBeLessThan(0.6);
  });

  it('轻微失谐 1Hz 仍可检出（接近齐音的实用边界）', () => {
    const sig = synthesizePianoTone({
      f1: f0, B: 5e-4, sampleRate: SR, duration: 8, decayTaus: slowDecay,
      strings: [
        { gain: 1, detune: 1 },
        { gain: 1, detune: 1 + 1 / f0 },
        { gain: 1, detune: 1 + 1 / f0 },
      ],
      noiseLevel: 0.001, seed: 9,
    });
    const r = detectBeats(sig, SR, { targetF0: f0 });
    console.log(`1Hz失谐：beat=${r.beatHz.toFixed(2)}Hz depth=${r.modulationDepth.toFixed(3)} isUnison=${r.isUnison}`);
    expect(r.isUnison).toBe(false);
    expect(Math.abs(r.beatHz - 1)).toBeLessThan(0.4);
  });
});
