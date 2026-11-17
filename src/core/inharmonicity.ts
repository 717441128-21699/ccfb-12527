/**
 * 钢琴弦非谐性（inharmonicity）测量。
 *
 * 物理模型（Fletcher 刚性弦模型）：
 *     f_n = n · f1 · sqrt(1 + B · n²)
 * n 为泛音序号（n=1 即基频），B 为非谐系数，立式琴常见 1e-4~1e-3，
 * 三角琴低音区可低至 ~1e-5，短弦高音区可达数 e-3。
 *
 * 两边平方后线性化：
 *     (f_n / n)² = f1² + f1²·B · n²
 * 即 y = a + b·x，其中 x=n², y=(f_n/n)²，B = b / a。
 *
 * 各泛音的绝对频率测量精度近似相同（都靠谱峰插值），故 y 的方差
 * 近似同阶，回归采用等权（早期版本用 1/n 加权会压制携带 B 信息
 * 的高次泛音，实测在低音区偏差明显）。
 */

import { analyzeFrame, findStrongestPeak, refinePeakFrequency, windowCoefficients } from './fft';
import { median } from './math';

export interface HarmonicPartial {
  n: number;
  frequency: number;
  /** 该泛音相对「严格整数倍」的偏离音分（正值=偏高，非谐性使其恒偏正） */
  stretchCents: number;
  magnitude: number;
}

export interface InharmonicityResult {
  /** 拟合出的基频 f1（Hz） */
  fundamental: number;
  /** 非谐系数 B */
  B: number;
  partials: HarmonicPartial[];
  /** 回归拟合优度 R²（对线性化后的 y；仅 2 个点时恒为 1） */
  r2: number;
}

export interface MeasureOptions {
  /** 粗估基频，比如由键位平均律频率给出，用于限定搜索范围 */
  expectedF0: number;
  /** 使用前多少个泛音（需求要求 8，实际会受奈奎斯特频率截断） */
  partialCount?: number;
  /** 单泛音搜索半宽，按该泛音预期频率的比例给（默认 ±9%） */
  searchBandRatio?: number;
  /** 弱泛音剔除阈值：低于最强泛音该比例的峰不参与拟合（默认 2%） */
  magnitudeThreshold?: number;
  /** 奈奎斯特安全余量：只分析低于该比例×奈奎斯特的泛音（默认 0.45） */
  nyquistMargin?: number;
  window?: 'hann' | 'hamming' | 'blackman' | 'rect';
}

interface RawPoint {
  n: number;
  freq: number;
  mag: number;
}

/**
 * 顺序自适应泛音搜索：
 * 先用 expectedF0 找 n=1、2，粗估 (f1, B)；之后每找一个泛音，
 * 都用当前 (f1, B) 预测下一个的位置，在其附近窄窗内找峰，
 * 每加入一个泛音就重新回归更新 (f1, B)。即使 B 较大、高次泛音
 * 明显偏离整数倍，也不会搜错峰。
 *
 * 高音区受奈奎斯特限制可分析泛音很少（极端时只有 n=1,2），
 * 两点同样可解出 B，只是没有冗余校验。
 */
export function measureInharmonicity(
  samples: Float64Array | Float32Array,
  sampleRate: number,
  opts: MeasureOptions,
): InharmonicityResult | null {
  const { expectedF0 } = opts;
  const partialCount = opts.partialCount ?? 8;
  const band = opts.searchBandRatio ?? 0.09;
  const magThreshold = opts.magnitudeThreshold ?? 0.02;
  const nyquistLimit = sampleRate * 0.5 * (opts.nyquistMargin ?? 0.45);
  const winType = opts.window ?? 'hann';
  const spec = analyzeFrame(samples, sampleRate, winType);
  // 加窗帧只构造一次，供 DFT 精修在每个泛音上复用
  const coeffs = windowCoefficients(samples.length, winType);
  const windowed = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) windowed[i] = samples[i] * coeffs[i];

  /** 谱峰粗定位 + 相关精修，返回精修后的频率与幅度 */
  const locate = (loHz: number, hiHz: number): { frequency: number; magnitude: number } | null => {
    const peak = findStrongestPeak(spec, loHz, hiHz);
    if (!peak) return null;
    return refinePeakFrequency(windowed, sampleRate, peak.frequency, spec.binHz);
  };

  const found: RawPoint[] = [];

  // —— 第一阶段：n=1 与 n=2，窗口放宽 —— //
  const p1 = locate(expectedF0 * 0.85, expectedF0 * 1.18);
  if (!p1) return null;
  found.push({ n: 1, freq: p1.frequency, mag: p1.magnitude });

  const p2 = locate(p1.frequency * 2 * 0.9, p1.frequency * 2 * 1.12);
  if (!p2) return null;
  found.push({ n: 2, freq: p2.frequency, mag: p2.magnitude });

  let fit = regress(found);

  // —— 第二阶段：逐个泛音自适应搜索，受奈奎斯特截断 —— //
  for (let n = 3; n <= partialCount; n++) {
    const predicted = predictedFrequency(fit.f1, fit.B, n);
    if (predicted > nyquistLimit) break; // 更高的泛音必然也越界
    const peak = locate(predicted * (1 - band), predicted * (1 + band));
    if (!peak) continue; // 该泛音缺失（低音区长衰减后常见），跳过
    found.push({ n, freq: peak.frequency, mag: peak.magnitude });
    fit = regress(found);
  }

  // 剔除幅度相对过弱的峰（多半落在噪声底上），但至少保留 2 个点
  const strongest = Math.max(...found.map((p) => p.mag));
  const kept = found.filter((p, i) => i < 2 || p.mag >= strongest * magThreshold);
  if (kept.length < 2) return null;

  const finalFit = regress(kept);
  return toResult(finalFit, kept);
}

/** 非谐模型下第 n 号泛音的频率 */
export function predictedFrequency(f1: number, B: number, n: number): number {
  return n * f1 * Math.sqrt(1 + B * n * n);
}

interface LinearFit {
  f1: number;
  B: number;
  r2: number;
}

/**
 * 等权最小二乘：x = n², y = (f_n/n)²，y = a + b·x。
 * 各泛音绝对测频精度近似同阶 → y 方差近似同阶 → 等权合理。
 */
function regress(points: RawPoint[]): LinearFit & { fundamental: number } {
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  const m = points.length;
  for (const p of points) {
    const x = p.n * p.n;
    const y = (p.freq / p.n) ** 2;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denom = m * sxx - sx * sx;
  const a = (sy * sxx - sx * sxy) / denom;
  const b = (m * sxy - sx * sy) / denom;
  const f1 = Math.sqrt(Math.max(a, 1e-12));
  const B = Math.max(0, b / a);

  let ssRes = 0;
  let ssTot = 0;
  const yMean = sy / m;
  for (const p of points) {
    const x = p.n * p.n;
    const y = (p.freq / p.n) ** 2;
    const yHat = a + b * x;
    ssRes += (y - yHat) ** 2;
    ssTot += (y - yMean) ** 2;
  }
  const r2 = m <= 2 || ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { f1, fundamental: f1, B, r2 };
}

function toResult(fit: LinearFit, found: RawPoint[]): InharmonicityResult {
  const partials: HarmonicPartial[] = found.map((p) => {
    const ideal = p.n * fit.f1;
    return {
      n: p.n,
      frequency: p.freq,
      stretchCents: (1200 / Math.LN2) * Math.log(p.freq / ideal),
      magnitude: p.mag,
    };
  });
  return { fundamental: fit.f1, B: fit.B, partials, r2: fit.r2 };
}

/**
 * 对多帧测量取 B 与 f1 的中位数。真实录音里偶尔会有某次峰搜偏，
 * 中位数能把野点挡掉。
 */
export function robustMeasure(
  frames: { samples: Float64Array | Float32Array; sampleRate: number; expectedF0: number }[],
  partialCount = 8,
): InharmonicityResult | null {
  const results: InharmonicityResult[] = [];
  for (const f of frames) {
    const r = measureInharmonicity(f.samples, f.sampleRate, { expectedF0: f.expectedF0, partialCount });
    if (r && r.r2 > 0.9) results.push(r);
  }
  if (results.length === 0) return null;
  const Bs = results.map((r) => r.B);
  const f1s = results.map((r) => r.fundamental);
  const best = results.reduce((a, b) => (b.r2 > a.r2 ? b : a));
  return {
    ...best,
    B: median(Bs),
    fundamental: median(f1s),
  };
}
