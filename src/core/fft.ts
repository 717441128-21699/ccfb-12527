/**
 * 迭代式 radix-2 Cooley–Tukey FFT（双精度），配合加窗与峰值插值。
 * 钢琴测量全部在频域做，频率分辨率靠「插值 + 足够长的窗」保证，
 * 而不是单纯堆 FFT 点数。
 */

export type WindowType = 'hann' | 'hamming' | 'blackman' | 'rect';

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export function windowCoefficients(size: number, type: WindowType): Float64Array {
  const w = new Float64Array(size);
  switch (type) {
    case 'rect':
      w.fill(1);
      break;
    case 'hamming':
      for (let i = 0; i < size; i++) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (size - 1));
      break;
    case 'blackman':
      for (let i = 0; i < size; i++) {
        const x = (2 * Math.PI * i) / (size - 1);
        w[i] = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
      }
      break;
    case 'hann':
    default:
      for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
      break;
  }
  return w;
}

export interface FftResult {
  /** 长度 n/2+1 的幅度谱（线性） */
  magnitude: Float64Array;
  binHz: number;
  n: number;
}

/** 原地 radix-2 FFT，输入长度必须为 2 的幂；re/im 长度均为 n */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (!isPowerOfTwo(n)) throw new Error('FFT 长度必须是 2 的幂');

  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = i + k + half;
        const tr = curR * re[b] - curI * im[b];
        const ti = curR * im[b] + curI * re[b];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nextR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nextR;
      }
    }
  }
}

/**
 * 对一帧实信号做加窗 FFT，返回单边幅度谱与加窗后的信号。
 * 内部复制输入，不修改原数据；加窗信号可供后续 DFT 精修复用。
 */
export function analyzeFrame(samples: Float64Array | Float32Array, sampleRate: number, win: WindowType = 'hann'): FftResult {
  const n = samples.length;
  if (!isPowerOfTwo(n)) throw new Error('帧长必须是 2 的幂');
  const coeffs = windowCoefficients(n, win);
  const windowed = new Float64Array(n);
  for (let i = 0; i < n; i++) windowed[i] = samples[i] * coeffs[i];
  return fftMagnitude(windowed, sampleRate);
}

/** 对已加窗的帧做 FFT，返回单边幅度谱 */
export function fftMagnitude(windowed: Float64Array, sampleRate: number): FftResult {
  const n = windowed.length;
  if (!isPowerOfTwo(n)) throw new Error('帧长必须是 2 的幂');
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(windowed);
  fftInPlace(re, im);

  const half = n >> 1;
  const magnitude = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) magnitude[k] = Math.hypot(re[k], im[k]);
  return { magnitude, binHz: sampleRate / n, n };
}

/**
 * DFT 相关频率精修：在给定初值附近，直接对加窗信号求 |X(f)|² 并做
 * 黄金分割搜索。精度不依赖 FFT 谱线网格，对加窗 + 缓变包络信号的
 * 测频误差通常在 bin 的千分之几量级。
 *
 * 不用牛顿法：|X|² 在谱峰附近 Hessian 很小，二阶导累加存在数值相消，
 * 牛顿步长不稳定。黄金分割只需要函数求值，无条件稳定。
 *
 * @param maxStepHz 搜索半宽（一般给 1 个 bin 多一点）
 */
export function refinePeakFrequency(
  windowed: Float64Array,
  sampleRate: number,
  guessHz: number,
  maxStepHz: number,
  iterations = 25,
): { frequency: number; magnitude: number } {
  const n = windowed.length;
  const powerAt = (f: number): number => {
    let re = 0;
    let im = 0;
    const w0 = (2 * Math.PI) / sampleRate;
    for (let i = 0; i < n; i++) {
      const theta = w0 * f * i;
      re += windowed[i] * Math.cos(theta);
      im -= windowed[i] * Math.sin(theta);
    }
    return re * re + im * im;
  };

  // 黄金分割搜索（最大化）
  const phi = (Math.sqrt(5) - 1) / 2; // ≈0.618
  let lo = guessHz - maxStepHz * 1.2;
  let hi = guessHz + maxStepHz * 1.2;
  let x1 = hi - phi * (hi - lo);
  let x2 = lo + phi * (hi - lo);
  let p1 = powerAt(x1);
  let p2 = powerAt(x2);
  for (let k = 0; k < iterations; k++) {
    if (p1 >= p2) {
      hi = x2;
      x2 = x1;
      p2 = p1;
      x1 = hi - phi * (hi - lo);
      p1 = powerAt(x1);
    } else {
      lo = x1;
      x1 = x2;
      p1 = p2;
      x2 = lo + phi * (hi - lo);
      p2 = powerAt(x2);
    }
  }
  const frequency = p1 >= p2 ? x1 : x2;

  // 精修后的幅度（直接相关值）
  let re = 0;
  let im = 0;
  const w0 = (2 * Math.PI) / sampleRate;
  for (let i = 0; i < n; i++) {
    const theta = w0 * frequency * i;
    re += windowed[i] * Math.cos(theta);
    im -= windowed[i] * Math.sin(theta);
  }
  return { frequency, magnitude: Math.hypot(re, im) };
}

export interface Peak {
  bin: number;
  /** 抛物线插值后的亚 bin 位置 */
  interpBin: number;
  frequency: number;
  magnitude: number;
}

/**
 * 在 [loHz, hiHz] 内找幅度最大的谱峰，并做对数幅度抛物线插值。
 * 对加窗信号，插值后的频率误差通常远小于一个 bin。
 */
export function findStrongestPeak(spec: FftResult, loHz: number, hiHz: number): Peak | null {
  const { magnitude, binHz } = spec;
  const lo = Math.max(1, Math.floor(loHz / binHz));
  const hi = Math.min(magnitude.length - 2, Math.ceil(hiHz / binHz));
  if (hi <= lo) return null;

  let peakBin = -1;
  let peakMag = -Infinity;
  for (let k = lo; k <= hi; k++) {
    if (magnitude[k] > peakMag) {
      peakMag = magnitude[k];
      peakBin = k;
    }
  }
  if (peakBin <= 0 || peakBin >= magnitude.length - 1) return null;

  const a = Math.log(magnitude[peakBin - 1]);
  const b = Math.log(magnitude[peakBin]);
  const c = Math.log(magnitude[peakBin + 1]);
  if (!Number.isFinite(a + b + c)) {
    return { bin: peakBin, interpBin: peakBin, frequency: peakBin * binHz, magnitude: peakMag };
  }
  const denom = a - 2 * b + c;
  // 正常窗谱主峰 denom < 0；退化时退回整数 bin
  const offset = denom !== 0 ? 0.5 * (a - c) / denom : 0;
  const interpBin = peakBin + Math.max(-1, Math.min(1, offset));
  return {
    bin: peakBin,
    interpBin,
    frequency: interpBin * binHz,
    magnitude: peakMag,
  };
}
