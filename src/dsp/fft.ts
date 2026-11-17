/**
 * FFT — 迭代 radix-2 Cooley–Tukey，原地复数运算。
 *
 * 设计要点：
 * - 长度必须是 2 的幂；非 2 的幂直接抛错（调用方负责补零）。
 * - 正变换不做归一化；逆变换按 1/N 归一化，保证 ifft(fft(x)) ≈ x。
 * - 旋转因子按余弦查表 + 递推，避免每级重复调用三角函数。
 */

export class FFT {
  readonly size: number;
  private readonly bits: number;
  private readonly rev: Int32Array;
  /** 每一级的旋转因子 cos/sin 表，cosTable[k][j], sinTable[k][j] */
  private readonly cosTable: Float64Array[];
  private readonly sinTable: Float64Array[];

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT 长度必须是 2 的幂，收到 ${size}`);
    }
    this.size = size;
    this.bits = Math.log2(size);

    this.rev = new Int32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < this.bits; b++) {
        r = (r << 1) | ((i >> b) & 1);
      }
      this.rev[i] = r;
    }

    const stages = this.bits;
    this.cosTable = new Array(stages);
    this.sinTable = new Array(stages);
    for (let s = 0; s < stages; s++) {
      const half = 1 << s; // 该级蝶形半宽
      const tableSize = half;
      const cos = new Float64Array(tableSize);
      const sin = new Float64Array(tableSize);
      for (let j = 0; j < tableSize; j++) {
        const theta = (-2 * Math.PI * j) / (2 * half);
        cos[j] = Math.cos(theta);
        sin[j] = Math.sin(theta);
      }
      this.cosTable[s] = cos;
      this.sinTable[s] = sin;
    }
  }

  /** 原地复数 FFT。re/im 长度必须等于 size。inverse=true 时按 1/N 归一化。 */
  run(re: Float64Array, im: Float64Array, inverse = false): void {
    const n = this.size;
    if (re.length !== n || im.length !== n) {
      throw new Error(`输入数组长度必须为 ${n}`);
    }

    // 位反转置换
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }

    const sign = inverse ? 1 : -1;
    for (let s = 0; s < this.bits; s++) {
      const half = 1 << s;
      const span = half << 1;
      const cos = this.cosTable[s];
      const sin = this.sinTable[s];
      for (let base = 0; base < n; base += span) {
        for (let j = 0; j < half; j++) {
          // 逆变换旋转因子取共轭：sin 符号翻转
          const wr = cos[j];
          const wi = sign * sin[j];
          const a = base + j;
          const b = a + half;
          const tr = wr * re[b] - wi * im[b];
          const ti = wr * im[b] + wi * re[b];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }

    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] /= n;
        im[i] /= n;
      }
    }
  }
}

/** 实数序列 → 单边幅度谱 |X[k]|（长度 n/2+1，未加窗、不归一化，调用方自行加窗）。 */
export function realFftMagnitude(samples: Float64Array): Float64Array {
  const n = samples.length;
  const fft = new FFT(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(samples);
  fft.run(re, im);
  const out = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) {
    out[k] = Math.hypot(re[k], im[k]);
  }
  return out;
}

/** 实数序列 → 复数频谱（re/im 各长度 n）。内部会复制输入，不改原数组。 */
export function realFft(samples: Float64Array): { re: Float64Array; im: Float64Array } {
  const n = samples.length;
  const fft = new FFT(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(samples);
  fft.run(re, im);
  return { re, im };
}

/** 复数频谱 → 实数序列（逆变换，虚部理论上接近 0）。 */
export function realIfft(re: Float64Array, im: Float64Array): Float64Array {
  const n = re.length;
  const fft = new FFT(n);
  const r = new Float64Array(n);
  const i = new Float64Array(n);
  r.set(re);
  i.set(im);
  fft.run(r, i, true);
  return r;
}
