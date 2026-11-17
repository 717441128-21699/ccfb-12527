/**
 * 整琴拉伸曲线。
 *
 * 测量阶段在十几个样本音上得到各自的非谐系数 B(m)；B 随键位近似
 * 指数变化，故对 ln(B) 关于 midi 号做加权线性拟合：
 *     ln B(m) = α + β·m
 * 未测到的键由该模型给出 B（端点外采用最近样本值外推并限幅）。
 *
 * 目标频率以 A4 为锚，按所选「八度类型」递归：
 *   4:2 — 下键第 4 泛音 = 上键第 2 泛音（常用，整琴较均衡）
 *   6:3 — 第 6 泛音 = 第 3 泛音（拉伸更大，高音明亮，受非谐影响显著）
 *   2:1 — 第 2 泛音 = 基频（拉伸最小）
 * 历史律制的音分偏移最后叠加在每个键的目标上。
 */

import { A4_MIDI, FIRST_MIDI, KEY_COUNT, LAST_MIDI, equalTempFrequency, pitchClass } from './notes';
import { getTemperament } from './temperament';
import { predictedFrequency } from './inharmonicity';
import { centsToRatio } from './math';

export type OctaveType = '4:2' | '6:3' | '2:1';

export interface BMeasurement {
  midi: number;
  B: number;
  /** 实测基频（可选，仅存档展示用，拟合不依赖） */
  fundamental?: number;
  /** 拟合优度，作为该样本的权重依据（可选） */
  r2?: number;
}

export interface StretchModel {
  alpha: number;
  beta: number;
  /** 实际观测到的 B 范围（用于限幅，避免端点外推失控） */
  minB: number;
  maxB: number;
  samples: BMeasurement[];
}

export function fitStretchModel(samples: BMeasurement[]): StretchModel {
  if (samples.length < 2) throw new Error('至少需要 2 个样本音才能拟合拉伸曲线');
  // 权重：有 r2 时按 r2^4 给，没有则等权
  const weights = samples.map((s) => (s.r2 === undefined ? 1 : Math.pow(Math.max(0.01, s.r2), 4)));
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  samples.forEach((s, i) => {
    const w = weights[i];
    const x = s.midi;
    const y = Math.log(s.B);
    sw += w;
    sx += w * x;
    sy += w * y;
    sxx += w * x * x;
    sxy += w * x * y;
  });
  const denom = sw * sxx - sx * sx;
  const beta = (sw * sxy - sx * sy) / denom;
  const alpha = (sy - beta * sx) / sw;
  const Bs = samples.map((s) => s.B);
  return {
    alpha,
    beta,
    minB: Math.min(...Bs) * 0.5,
    maxB: Math.max(...Bs) * 2,
    samples,
  };
}

/** 由拉伸模型取某键的 B（外推限幅在观测范围的 0.5~2 倍内） */
export function BAt(model: StretchModel, midi: number): number {
  const raw = Math.exp(model.alpha + model.beta * midi);
  return Math.min(model.maxB, Math.max(model.minB, raw));
}

/** 拉伸量（相对平均律名义频率的音分），供曲线绘制 */export interface TargetFrequencies {
  /** 88 键目标频率，索引 = midi - 21 */
  targets: Float64Array;
  /** 每个键使用的 B */
  BPerKey: Float64Array;
  octaveType: OctaveType;
  temperamentId: string;
  a4: number;
}

/**
 * 生成整琴目标频率。
 * @param model        拉伸模型
 * @param temperamentId 律制 id
 * @param octaveType   八度匹配类型
 * @param a4           A4 参考频率（默认 440）
 */
export function buildTargetFrequencies(
  model: StretchModel,
  temperamentId: string,
  octaveType: OctaveType = '4:2',
  a4 = 440,
): TargetFrequencies {
  const targets = new Float64Array(KEY_COUNT);
  const BPerKey = new Float64Array(KEY_COUNT);
  for (let i = 0; i < KEY_COUNT; i++) BPerKey[i] = BAt(model, FIRST_MIDI + i);

  const temperament = getTemperament(temperamentId);
  // 奈奎斯特安全上限（按 48k 采样率留 10% 余量）
  const nyquistSafe = 21600;

  /**
   * 单个八度递归步的泛音序号选择：6:3 在第 6 泛音越过奈奎斯特安全线
   * 的高音八度自动降级为 4:2；2:1 始终保持。每个八度独立判断。
   */
  const partialsForOctave = (lowMidi: number): [number, number] => {
    if (octaveType === '2:1') return [2, 1];
    if (octaveType === '4:2') return [4, 2];
    // 6:3
    const f6 = predictedFrequency(equalTempFrequency(lowMidi), BPerKey[lowMidi - FIRST_MIDI], 6);
    return f6 > nyquistSafe ? [4, 2] : [6, 3];
  };

  // A4 锚点：先按平均律取名义频率，再叠 A 音级的律制偏移
  const a4Index = A4_MIDI - FIRST_MIDI;
  const a4Tempered = a4 * centsToRatio(temperament.centsOffset[pitchClass(A4_MIDI)]);
  targets[a4Index] = a4Tempered;

  // 八度锚点递归（步长 12 个半音！八度方程只对相距八度的键成立）。
  // 向下：f_L = nHigh·f_H·sqrt(1+B_H·nHigh²) / [nLow·sqrt(1+B_L·nLow²)]
  for (let midi = A4_MIDI - 12; midi >= FIRST_MIDI; midi -= 12) {
    const [nLow, nHigh] = partialsForOctave(midi);
    const fH = targets[midi + 12 - FIRST_MIDI];
    const BH = BPerKey[midi + 12 - FIRST_MIDI];
    const BL = BPerKey[midi - FIRST_MIDI];
    const numerator = nHigh * fH * Math.sqrt(1 + BH * nHigh * nHigh);
    targets[midi - FIRST_MIDI] = numerator / (nLow * Math.sqrt(1 + BL * nLow * nLow));
  }

  // 向上：f_H = nLow·f_L·sqrt(1+B_L·nLow²) / [nHigh·sqrt(1+B_H·nHigh²)]
  // 终止条件放宽到 LAST_MIDI+11：最高八度的 A 锚点可能略高于最后一个被测键。
  for (let midi = A4_MIDI + 12; midi <= LAST_MIDI + 11; midi += 12) {
    const bhIndex = midi - FIRST_MIDI;
    if (bhIndex >= KEY_COUNT) break;
    const lowMidi = midi - 12;
    const [nLow, nHigh] = partialsForOctave(lowMidi);
    const fL = targets[lowMidi - FIRST_MIDI];
    const BL = BPerKey[lowMidi - FIRST_MIDI];
    const BH = BPerKey[bhIndex];
    const numerator = nLow * fL * Math.sqrt(1 + BL * nLow * nLow);
    targets[bhIndex] = numerator / (nHigh * Math.sqrt(1 + BH * nHigh * nHigh));
  }

  // 八度内部的 11 个键：以本八度的 A 锚点为基准，按平均律半音比 +
  // 律制偏移填充。这样八度拉伸由锚点承载，律制色彩由音级偏移承载。
  // 按 C 音（音级 0）枚举每个八度，C 的 midi 号恒为 12 的倍数。
  // 枚举范围向高端放宽一个八度：键盘末尾的不完整八度（C8 所在八度的 A
  // 已超出键盘）借用上一个八度的 A 锚点，按实际半音差计算即可。
  const firstC = Math.floor(FIRST_MIDI / 12) * 12; // A0=21 → C0=12
  for (let cMidi = firstC; cMidi <= LAST_MIDI + 11; cMidi += 12) {
    let aMidi = cMidi + 9; // 本八度的 A
    if (aMidi > LAST_MIDI) aMidi -= 12; // 最高八度借上一个 A
    if (aMidi < FIRST_MIDI) continue;
    const aTarget = targets[aMidi - FIRST_MIDI];
    if (!(aTarget > 0)) continue; // 防御：锚点缺失则跳过
    const aPc = pitchClass(aMidi);
    for (let pc = 0; pc < 12; pc++) {
      const midi = cMidi + pc;
      if (midi < FIRST_MIDI || midi > LAST_MIDI || midi === aMidi) continue;
      const semitones = midi - aMidi; // 借锚点时差值自动包含跨八度的 12
      const ratio =
        Math.pow(2, semitones / 12) *
        centsToRatio(temperament.centsOffset[pc] - temperament.centsOffset[aPc]);
      targets[midi - FIRST_MIDI] = aTarget * ratio;
    }
  }

  return { targets, BPerKey, octaveType, temperamentId, a4 };
}

/** 拉伸量（相对平均律名义频率的音分），供曲线绘制 */
export function stretchCentsCurve(tf: TargetFrequencies): { midi: number; cents: number }[] {
  const out: { midi: number; cents: number }[] = [];
  for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
    const nominal = equalTempFrequency(midi, tf.a4);
    const cents = (1200 / Math.LN2) * Math.log(tf.targets[midi - FIRST_MIDI] / nominal);
    out.push({ midi, cents });
  }
  return out;
}
