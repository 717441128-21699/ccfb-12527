/**
 * 合格电机基线库。
 *
 * 对每台合格电机录一次 5s 音频，算 Welch PSD 后逐 bin 累积：
 *   count、sum、sumSq —— 在线合并，无需保留全部原始谱，
 *   导出时得到每个 bin 的 mean / std（dB 域统计更符合人耳与对数能量分布）。
 *
 * 基线以 JSON 落盘/加载，纯数据可移植；新电机对比在 dB 域做 z-score。
 */

export interface BaselineData {
  version: 1;
  sampleRate: number;
  nfft: number;
  count: number;
  /** dB 域每 bin 均值 */
  meanDb: number[];
  /** dB 域每 bin 标准差（总体标准差） */
  stdDb: number[];
  /** 频率轴，便于 UI 直接绘制 */
  freqs: number[];
  createdAt: string;
}

export class BaselineBuilder {
  private sum: Float64Array;
  private sumSq: Float64Array;
  count = 0;
  readonly freqs: Float64Array;
  readonly sampleRate: number;
  readonly nfft: number;

  constructor(sampleRate: number, nfft: number, freqs: Float64Array) {
    this.sampleRate = sampleRate;
    this.nfft = nfft;
    this.freqs = freqs;
    this.sum = new Float64Array(freqs.length);
    this.sumSq = new Float64Array(freqs.length);
  }

  /** 加入一台合格电机的 PSD（线性功率，内部转 dB 累积）。长度需与构造时一致。 */
  add(psdLinear: Float64Array): void {
    if (psdLinear.length !== this.sum.length) {
      throw new Error(
        `PSD 长度 ${psdLinear.length} 与基线 ${this.sum.length} 不一致（nfft 是否相同？）`,
      );
    }
    for (let k = 0; k < psdLinear.length; k++) {
      const db = 10 * Math.log10(Math.max(psdLinear[k], 1e-20));
      this.sum[k] += db;
      this.sumSq[k] += db * db;
    }
    this.count++;
  }

  build(createdAt = new Date().toISOString()): BaselineData {
    if (this.count === 0) throw new Error("基线为空，至少加入一台合格电机");
    const n = this.sum.length;
    const meanDb = new Array<number>(n);
    const stdDb = new Array<number>(n);
    const inv = 1 / this.count;
    for (let k = 0; k < n; k++) {
      const mean = this.sum[k] * inv;
      // 总体方差；浮点误差可能给出微小负值，截断到 0
      const variance = Math.max(0, this.sumSq[k] * inv - mean * mean);
      meanDb[k] = mean;
      stdDb[k] = Math.sqrt(variance);
    }
    return {
      version: 1,
      sampleRate: this.sampleRate,
      nfft: this.nfft,
      count: this.count,
      meanDb,
      stdDb,
      freqs: Array.from(this.freqs),
      createdAt,
    };
  }
}

/** 基线 JSON 解析与基本校验。 */
export function parseBaseline(json: string): BaselineData {
  const obj = JSON.parse(json) as BaselineData;
  if (obj.version !== 1) throw new Error(`不支持的基线版本 ${obj.version}`);
  if (obj.meanDb.length !== obj.stdDb.length || obj.meanDb.length !== obj.freqs.length) {
    throw new Error("基线数组长度不一致，文件可能损坏");
  }
  if (obj.count <= 0) throw new Error("基线样本数为 0");
  return obj;
}

/**
 * 新电机 PSD（线性）相对基线的逐 bin z-score（dB 域）。
 * std 过小的 bin 用 floorStd 兜底，防止静音段除零放大。
 */
export function zScoreVsBaseline(
  psdLinear: Float64Array,
  baseline: BaselineData,
  floorStdDb = 1.5,
): Float64Array {
  if (psdLinear.length !== baseline.meanDb.length) {
    throw new Error(
      `PSD 长度 ${psdLinear.length} 与基线 ${baseline.meanDb.length} 不一致`,
    );
  }
  const z = new Float64Array(psdLinear.length);
  for (let k = 0; k < psdLinear.length; k++) {
    const db = 10 * Math.log10(Math.max(psdLinear[k], 1e-20));
    const std = Math.max(baseline.stdDb[k], floorStdDb);
    z[k] = (db - baseline.meanDb[k]) / std;
  }
  return z;
}
