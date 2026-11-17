/**
 * 检测台可调参数与公共类型。
 * 所有阈值集中在此，现场校准只动这一份默认值或传入覆盖，不碰算法代码。
 */

import type { BearingGeometry, FaultKind } from "../dsp/bearing.js";

/** 一组现场常用深沟球轴承几何（6205 为教材标准样例，可替换为实际型号）。 */
export const BEARING_6205: BearingGeometry = {
  ballCount: 9,
  pitchD: 39.04, // mm
  ballD: 7.94, // mm
  contactAngleRad: 0,
};

export interface DetectorConfig {
  sampleRate: number;
  /** Welch 段长 */
  nfft: number;
  welchOverlap: number;
  /** 包络分析 FFT 长度 */
  envelopeFft: number;
  /** 共振解调带通区间 */
  resonanceBand: { lowHz: number; highHz: number };

  /** 基线超差判定：特征频率窗口内最大 z 值达到该数算一次命中 */
  zHitThreshold: number;
  /** 基线 dB 绝对超差门限：比基线均值高多少 dB 算一次命中（共振带故障靠它） */
  dbExcessThreshold: number;
  /** 无基线时，局部突起度命中门限（dB） */
  prominenceHitDb: number;
  /** 包络谱冲击突起度门限（dB） */
  envelopeProminenceDb: number;
  /** 低频通道（<30Hz，主要是 FTF）专用门限：低频本底起伏大，门限适当降低 */
  envelopeProminenceLowDb: number;
  /** 特征频率对齐容差（Hz），容纳转速波动与频率估计误差 */
  freqToleranceHz: number;
  /** 包络谱最低分析频率（FTF 可低至 ~10Hz，默认 5Hz） */
  envelopeMinHz: number;

  /** 通道融合得分超过该值判该故障成立 */
  channelScoreThreshold: number;
  /** 整机判决门限：任一通道超过即不合格 */
  machineFailThreshold: number;

  /** 各故障通道权重：z 分数命中 / 突起度命中 / 包络冲击命中 */
  weights: {
    baselineZ: number;
    prominence: number;
    envelope: number;
  };
}

export const DEFAULT_CONFIG: DetectorConfig = {
  sampleRate: 48000,
  nfft: 8192,
  welchOverlap: 0.5,
  /** 包络谱 FFT 长度；65536 点 @48k ≈ 1.36s，binHz≈0.73，能分辨 ~10Hz 的 FTF */
  envelopeFft: 65536,
  resonanceBand: { lowHz: 1500, highHz: 8000 },

  zHitThreshold: 3.0,
  dbExcessThreshold: 6,
  prominenceHitDb: 8,
  envelopeProminenceDb: 6,
  envelopeProminenceLowDb: 4.5,
  freqToleranceHz: 4,
  envelopeMinHz: 5,

  // 打分 = baselineZ×基线命中数 + envelope×包络命中数
  // 门限 2.4：典型故障 2 次包络命中(2×1.5=3) 即超；合格电机偶发 1 次不超
  channelScoreThreshold: 2.4,
  machineFailThreshold: 2.4,

  weights: {
    baselineZ: 1.0,
    prominence: 0.8,
    envelope: 1.5,
  },
};

/** 单个谐波/特征频率上的证据。 */
export interface HarmonicEvidence {
  kind: FaultKind;
  order: number;
  expectedHz: number;
  measuredHz: number;
  /** 基线 z（无基线时为 null） */
  z: number | null;
  /** 相对基线均值的 dB 超差（无基线时为 null） */
  dbExcess: number | null;
  prominenceDb: number;
  /** 包络谱在该频率的突起度（dB），未命中给实际值 */
  envelopeProminenceDb: number;
}

export interface ChannelVerdict {
  kind: FaultKind;
  label: string;
  baseHz: number;
  score: number;
  /** 0~1 的置信度，score 经 sigmoid 映射 */
  confidence: number;
  hits: {
    baseline: number;
    prominence: number;
    envelope: number;
  };
  evidence: HarmonicEvidence[];
}

export interface DetectorResult {
  verdict: "pass" | "fail";
  rpm: number;
  sampleRate: number;
  rms: number;
  /** 整机不合格置信度（取最强通道） */
  confidence: number;
  channels: ChannelVerdict[];
  /** 判不合格时的主故障类型（null = 合格） */
  primaryFault: { kind: FaultKind; label: string } | null;
  /** 处理耗时（毫秒，不含录音） */
  processingMs: number;
}
