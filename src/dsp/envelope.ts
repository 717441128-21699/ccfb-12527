/**
 * 共振解调（包络分析）。
 *
 * 轴承早期冲击在频谱上表现为共振带的周期调制，直接看频谱难以分辨；
 * 经典做法：
 *   1) 带通滤出共振带（RBJ Butterworth 风格 biquad 级联）
 *   2) Hilbert 变换构造解析信号，取模得到包络
 *   3) 包络去趋势后做 FFT，得到包络谱
 *   4) 冲击重复频率 = 某故障特征频率时，对应通道计数
 *
 * 全部频域/时域 FFT 复用 radix-2 实现，避免引入额外依赖。
 */

import { FFT } from "./fft.js";

/* ---------------- RBJ biquad（Audio EQ Cookbook 系数） ---------------- */

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function lowpassQ(fc: number, fs: number, q: number): BiquadCoeffs {
  const w = (2 * Math.PI * fc) / fs;
  const cosw = Math.cos(w);
  const sinw = Math.sin(w);
  const alpha = sinw / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cosw) / 2 / a0,
    b1: (1 - cosw) / a0,
    b2: (1 - cosw) / 2 / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

function highpassQ(fc: number, fs: number, q: number): BiquadCoeffs {
  const w = (2 * Math.PI * fc) / fs;
  const cosw = Math.cos(w);
  const sinw = Math.sin(w);
  const alpha = sinw / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cosw) / 2 / a0,
    b1: -(1 + cosw) / a0,
    b2: (1 + cosw) / 2 / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * 四阶 Butterworth 带通 = 2 个 Q=0.7071 高通级联 + 2 个低通级联。
 * 每级独立做直接 II 型转置滤波，级间拷贝。
 */
export function bandpassButterworth4(
  x: Float64Array,
  fs: number,
  lowHz: number,
  highHz: number,
): Float64Array {
  if (!(lowHz > 0 && highHz > lowHz && highHz < fs / 2)) {
    throw new Error(`非法带通区间 [${lowHz}, ${highHz}]，fs=${fs}`);
  }
  const q = 1 / Math.sqrt(2);
  const stages: BiquadCoeffs[] = [
    highpassQ(lowHz, fs, q),
    highpassQ(lowHz, fs, q),
    lowpassQ(highHz, fs, q),
    lowpassQ(highHz, fs, q),
  ];
  let y = x;
  for (const c of stages) {
    y = applyBiquad(y, c);
  }
  return y;
}

function applyBiquad(x: Float64Array, c: BiquadCoeffs): Float64Array {
  const y = new Float64Array(x.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const out = c.b0 * x[i] + z1;
    z1 = c.b1 * x[i] - c.a1 * out + z2;
    z2 = c.b2 * x[i] - c.a2 * out;
    y[i] = out;
  }
  return y;
}

/* ---------------- Hilbert 包络 ---------------- */

/**
 * 频域 Hilbert 变换：正频率留 2、负频率置 0、DC/Nyquist 置 1，
 * 逆变换得到解析信号，取模即包络。
 * 输入会被复制，不修改原数组。
 */
export function hilbertEnvelope(x: Float64Array): Float64Array {
  const n = x.length;
  if ((n & (n - 1)) !== 0) {
    throw new Error("Hilbert 输入长度必须是 2 的幂");
  }
  const fft = new FFT(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(x);
  fft.run(re, im);

  // 解析信号频谱：正频率 ×2、负频率 ×0、DC/Nyquist ×1
  const h = new Float64Array(n);
  if (n % 2 === 0) {
    h[0] = 1;
    h[n / 2] = 1;
    for (let k = 1; k < n / 2; k++) h[k] = 2;
  } else {
    h[0] = 1;
    for (let k = 1; k <= (n - 1) / 2; k++) h[k] = 2;
  }
  for (let k = 0; k < n; k++) {
    re[k] *= h[k];
    im[k] *= h[k];
  }
  fft.run(re, im, true); // re=解析信号实部（≈原信号），im=Hilbert 变换

  const env = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    env[i] = Math.hypot(re[i], im[i]);
  }
  return env;
}

/* ---------------- 包络谱 ---------------- */

export interface EnvelopeSpectrum {
  /** 包络谱幅度（单边，线性，未归一化绝对值，用于相对比较） */
  magnitude: Float64Array;
  freqs: Float64Array;
  envelope: Float64Array;
  nfft: number;
  binHz: number;
}

export interface EnvelopeOptions {
  /** 共振带下限 Hz，默认 1500 */
  bandLowHz?: number;
  /** 共振带上限 Hz，默认 8000 */
  bandHighHz?: number;
  /** 包络谱 FFT 长度，默认 65536（@48k 约 1.36s，低频分辨率 ~0.73Hz） */
  nfft?: number;
}

/**
 * 完整解调链：带通 → 包络 → 去均值/去趋势 → FFT 幅度谱。
 * 为控制计算量，包络 FFT 只取前 nfft 个样本（5s@48k 中前 ~0.34s@16384，
 * 但带通后先对全长取包络再截断，瞬态冲击覆盖仍充分）。
 */
export function envelopeSpectrum(
  samples: Float64Array | Float32Array,
  sampleRate: number,
  options: EnvelopeOptions = {},
): EnvelopeSpectrum {
  const bandLow = options.bandLowHz ?? 1500;
  const bandHigh = options.bandHighHz ?? Math.min(8000, sampleRate / 2 - 100);
  const nfft = options.nfft ?? 65536;

  const x = samples instanceof Float64Array ? samples : Float64Array.from(samples);
  const filtered = bandpassButterworth4(x, sampleRate, bandLow, bandHigh);

  // Hilbert/FFT 要求 2 的幂：取不超过信号长度、不超过 nfft 的最大 2 的幂
  const useLen = Math.min(nfft, 2 ** Math.floor(Math.log2(filtered.length)));
  const segFiltered = filtered.subarray(0, useLen);
  const envFull = hilbertEnvelope(segFiltered);

  // 去直流 + 线性去趋势（消除包络缓慢漂移）
  const detrended = detrend(envFull);

  const fft = new FFT(useLen);
  const re = new Float64Array(useLen);
  const im = new Float64Array(useLen);
  re.set(detrended);
  fft.run(re, im);

  const half = useLen / 2 + 1;
  const magnitude = new Float64Array(half);
  const freqs = new Float64Array(half);
  const binHz = sampleRate / useLen;
  for (let k = 0; k < half; k++) {
    freqs[k] = k * binHz;
    magnitude[k] = Math.hypot(re[k], im[k]) / useLen;
  }

  return { magnitude, freqs, envelope: envFull, nfft: useLen, binHz };
}

/** 最小二乘线性去趋势（同时去掉均值）。 */
export function detrend(x: Float64Array): Float64Array {
  const n = x.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += x[i];
    sxx += i * i;
    sxy += i * x[i];
  }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const mean = sy / n;
  const xMean = sx / n;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = x[i] - (mean + slope * (i - xMean));
  }
  return out;
}
