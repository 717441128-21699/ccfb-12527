/**
 * Welch 法功率谱密度估计。
 *
 * 分段 → 加窗 → FFT → 周期图平均。
 * 归一化：P[k] = mean(|X[k]|^2) / (fs * U)，U = sum(w^2)。
 * 这样 P 的单位为 V^2/Hz（麦克风电压的话），不同分段数/窗长之间结果可比。
 * 单边谱除直流与 Nyquist 外乘 2。
 */

import { FFT } from "./fft.js";
import { makeWindow, energyGain, type WindowType } from "./window.js";

export interface WelchResult {
  /** 单边 PSD，长度 nfft/2+1，单位为功率/Hz（线性值，非 dB） */
  psd: Float64Array;
  /** 频率轴（Hz），与 psd 等长 */
  freqs: Float64Array;
  nfft: number;
  /** 实际参与平均的段数 */
  segments: number;
  binHz: number;
}

export interface WelchOptions {
  nfft?: number; // 默认 8192
  overlap?: number; // 0~1，默认 0.5
  window?: WindowType; // 默认 hann
}

export function nextPow2(n: number): number {
  return 1 << Math.ceil(Math.log2(Math.max(2, n)));
}

export function welch(
  samples: Float64Array | Float32Array,
  sampleRate: number,
  options: WelchOptions = {},
): WelchResult {
  const nfft = options.nfft ?? nextPow2(Math.min(8192, samples.length));
  const overlap = options.overlap ?? 0.5;
  const winType = options.window ?? "hann";

  if ((nfft & (nfft - 1)) !== 0) {
    throw new Error(`nfft 必须是 2 的幂，收到 ${nfft}`);
  }
  if (samples.length < nfft) {
    throw new Error(`样本数 ${samples.length} 小于 nfft ${nfft}，无法分段`);
  }

  const window = makeWindow(winType, nfft);
  const u = energyGain(window);
  const step = Math.max(1, Math.round(nfft * (1 - overlap)));

  const fft = new FFT(nfft);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const half = nfft / 2 + 1;
  const acc = new Float64Array(half);

  let segments = 0;
  for (let start = 0; start + nfft <= samples.length; start += step) {
    for (let i = 0; i < nfft; i++) {
      re[i] = samples[start + i] * window[i];
      im[i] = 0;
    }
    fft.run(re, im);
    for (let k = 0; k < half; k++) {
      acc[k] += re[k] * re[k] + im[k] * im[k];
    }
    segments++;
  }

  const psd = new Float64Array(half);
  const freqs = new Float64Array(half);
  const norm = 1 / (sampleRate * u * segments);
  for (let k = 0; k < half; k++) {
    freqs[k] = (k * sampleRate) / nfft;
    let p = acc[k] * norm;
    if (k !== 0 && k !== half - 1) p *= 2; // 单边谱
    psd[k] = p;
  }

  return { psd, freqs, nfft, segments, binHz: sampleRate / nfft };
}

/** PSD 转 dB（参考 1，即 10*log10(P)），加 floor 防 log(0)。 */
export function psdToDb(psd: Float64Array, floor = 1e-20): Float64Array {
  const out = new Float64Array(psd.length);
  for (let i = 0; i < psd.length; i++) {
    out[i] = 10 * Math.log10(Math.max(psd[i], floor));
  }
  return out;
}
