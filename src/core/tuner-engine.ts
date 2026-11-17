/**
 * 实时调律引擎：接收音频块，维护分析用环形缓冲，输出稳定的
 * 音分偏差读数与齐音拍频。
 *
 * 稳定性策略（对应需求“指针要稳”）：
 *  - 环形缓冲累积到目标窗长才分析，窗长按音区自适应（低音更长）；
 *  - 每次分析的原始读数先经过最近 N 次中值滤波抗野点；
 *  - 中值结果再做指数平滑，时间常数可调（默认 ~0.4s）；
 *  - 信号过弱（RMS 低于门限）时冻结读数，不让噪声驱动指针。
 */

import { measureInharmonicity } from './inharmonicity';
import { detectBeats } from './beats';
import { centsOff } from './math';

export interface TunerReading {
  /** 实测基频 Hz */
  fundamental: number;
  /** 目标频率 Hz */
  target: number;
  /** 音分偏差（正=偏高） */
  cents: number;
  /** 平滑后的音分偏差（驱动指针） */
  smoothCents: number;
  /** 信号 RMS，用于电平表/静音判断 */
  level: number;
  /** 本次拟合的非谐系数（调律模式下可选展示） */
  B: number;
  /** 拟合优度 */
  r2: number;
  /** 是否有有效信号 */
  active: boolean;
}

export interface BeatReading {
  beatHz: number;
  modulationDepth: number;
  isUnison: boolean;
}

export interface TunerEngineOptions {
  targetF0: number;
  expectedF0: number;
  /** 中值滤波窗口（奇数） */
  medianWindow?: number;
  /** 指数平滑时间常数（秒） */
  smoothTau?: number;
  /** 静音门限（RMS） */
  silenceThreshold?: number;
  partialCount?: number;
}

export class TunerEngine {
  private ring: number[] = [];
  private sampleRate = 48000;
  private readonly opts: Required<TunerEngineOptions>;
  private recentCents: number[] = [];
  private smoothed: number | null = null;
  private lastHopAt = 0;

  constructor(opts: TunerEngineOptions) {
    this.opts = {
      medianWindow: opts.medianWindow ?? 5,
      smoothTau: opts.smoothTau ?? 0.4,
      silenceThreshold: opts.silenceThreshold ?? 0.01,
      partialCount: opts.partialCount ?? 8,
      targetF0: opts.targetF0,
      expectedF0: opts.expectedF0,
    };
  }

  /** 更新目标频率（切换键位或律制时调用） */
  setTarget(targetF0: number, expectedF0: number): void {
    this.opts.targetF0 = targetF0;
    this.opts.expectedF0 = expectedF0;
    this.smoothed = null;
    this.recentCents = [];
  }

  /**
   * 喂入一个音频块。达到分析窗长时返回读数，否则返回 null。
   * 窗长按音区自适应：低音 ~1.37s、中音 ~0.68s、高音 ~0.34s（2 的幂）。
   */
  pushBlock(block: Float32Array, sampleRate: number): TunerReading | null {
    this.sampleRate = sampleRate;
    for (let i = 0; i < block.length; i++) this.ring.push(block[i]);

    const windowLen = this.chooseWindowLength();
    if (this.ring.length < windowLen) return null;

    // 取最近 windowLen 个样本，并把缓冲裁到略大于窗长以免无限增长
    const frame = Float64Array.from(this.ring.slice(this.ring.length - windowLen));
    if (this.ring.length > windowLen * 1.5) {
      this.ring = this.ring.slice(this.ring.length - windowLen);
    }

    let level = 0;
    for (const v of frame) level += v * v;
    level = Math.sqrt(level / frame.length);

    if (level < this.opts.silenceThreshold) {
      return {
        fundamental: 0, target: this.opts.targetF0, cents: 0,
        smoothCents: this.smoothed ?? 0, level, B: 0, r2: 0, active: false,
      };
    }

    const result = measureInharmonicity(frame, sampleRate, {
      expectedF0: this.opts.expectedF0,
      partialCount: this.opts.partialCount,
    });
    if (!result) {
      return {
        fundamental: 0, target: this.opts.targetF0, cents: 0,
        smoothCents: this.smoothed ?? 0, level, B: 0, r2: 0, active: false,
      };
    }

    const rawCents = centsOff(result.fundamental, this.opts.targetF0);
    this.recentCents.push(rawCents);
    if (this.recentCents.length > this.opts.medianWindow) this.recentCents.shift();
    const medianCents = median(this.recentCents);

    // 指数平滑（按实际分析帧间隔）
    const now = performance.now();
    const hop = this.lastHopAt ? (now - this.lastHopAt) / 1000 : 0.2;
    this.lastHopAt = now;
    const alpha = 1 - Math.exp(-hop / this.opts.smoothTau);
    this.smoothed = this.smoothed === null ? medianCents : this.smoothed + alpha * (medianCents - this.smoothed);

    return {
      fundamental: result.fundamental,
      target: this.opts.targetF0,
      cents: rawCents,
      smoothCents: this.smoothed,
      level,
      B: result.B,
      r2: result.r2,
      active: true,
    };
  }

  /** 齐音模式：累积较长缓冲后测拍频 */
  measureBeats(durationSeconds = 4): BeatReading | null {
    const need = Math.floor(durationSeconds * this.sampleRate);
    if (this.ring.length < need) return null;
    const frame = Float64Array.from(this.ring.slice(this.ring.length - need));
    const r = detectBeats(frame, this.sampleRate, { targetF0: this.opts.expectedF0 });
    return { beatHz: r.beatHz, modulationDepth: r.modulationDepth, isUnison: r.isUnison };
  }

  private chooseWindowLength(): number {
    const f = this.opts.expectedF0;
    const targetSeconds = f < 65 ? 1.37 : f < 400 ? 0.68 : 0.34;
    return 1 << Math.round(Math.log2(targetSeconds * this.sampleRate));
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
