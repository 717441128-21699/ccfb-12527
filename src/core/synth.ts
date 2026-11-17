/**
 * 合成带非谐性的钢琴音，用于离线验证整套测量算法，
 * 同时作为网页端「演示模式」的信号源（没有麦克风也能跑全流程）。
 *
 * 模型：8 个非谐泛音叠加，各自带指数衰减包络、小幅初始失谐与随机初相，
 * 可叠加 2~3 根弦的合唱（unison chorus）与测量噪声。
 */

export interface SynthString {
  /** 该弦相对主基频的比例（齐音失谐，如 1.0004） */
  detune?: number;
  /** 该弦独立的 B 覆盖值（默认用整体 B） */
  BOverride?: number;
  /** 各泛音相对幅度，长度可少于 partialCount，缺省按 1/n 衰减 */
  partialGains?: number[];
  gain?: number;
}

export interface SynthOptions {
  f1: number;
  B: number;
  sampleRate?: number;
  duration?: number;
  partialCount?: number;
  /** 泛音衰减时间常数数组（秒），缺省高音泛音衰减更快 */
  decayTaus?: number[];
  /** 起音时间（秒） */
  attack?: number;
  strings?: SynthString[];
  /** 加性高斯噪声标准差（相对满幅） */
  noiseLevel?: number;
  /** 随机种子（可复现） */
  seed?: number;
}

/** 可复现的轻量 PRNG（mulberry32） */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function partialFrequency(f1: number, B: number, n: number): number {
  return n * f1 * Math.sqrt(1 + B * n * n);
}

export function synthesizePianoTone(opts: SynthOptions): Float64Array {
  const {
    f1,
    B,
    sampleRate = 44100,
    duration = 2,
    partialCount = 8,
    attack = 0.004,
    noiseLevel = 0,
    seed = 42,
  } = opts;
  const total = Math.round(duration * sampleRate);
  const out = new Float64Array(total);
  const rng = makeRng(seed);
  const strings = opts.strings ?? [{ gain: 1 }];
  const stringGainSum = strings.reduce((s, x) => s + (x.gain ?? 1), 0) || 1;

  for (const str of strings) {
    const strF1 = f1 * (str.detune ?? 1);
    const strB = str.BOverride ?? B;
    const strGain = (str.gain ?? 1) / stringGainSum;
    const phases: number[] = [];
    for (let n = 1; n <= partialCount; n++) phases.push(rng() * 2 * Math.PI);

    for (let i = 0; i < total; i++) {
      const t = i / sampleRate;
      const envAttack = Math.min(1, t / attack);
      let v = 0;
      for (let n = 1; n <= partialCount; n++) {
        const freq = partialFrequency(strF1, strB, n);
        const gain = str.partialGains?.[n - 1] ?? 1 / n;
        const tau = opts.decayTaus?.[n - 1] ?? Math.max(0.25, 2.2 / n);
        v += gain * Math.exp(-t / tau) * Math.cos(2 * Math.PI * freq * t + phases[n - 1]);
      }
      out[i] += strGain * envAttack * v;
    }
  }

  if (noiseLevel > 0) {
    for (let i = 0; i < total; i++) out[i] += noiseLevel * (rng() * 2 - 1);
  }

  // 归一化到 ±0.9，避免削波
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) {
    const k = 0.9 / peak;
    for (let i = 0; i < total; i++) out[i] *= k;
  }
  return out;
}

export function rms(samples: Float64Array | Float32Array): number {
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  return Math.sqrt(s / samples.length);
}
