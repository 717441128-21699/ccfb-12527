/**
 * 滚动轴承故障特征频率。
 *
 * 约定参数（轴承几何）：
 * - ballCount  滚动体数量 N
 * - pitchD     节圆直径 D（滚动体中心所在圆）
 * - ballD      滚动体直径 d
 * - contactAngle 接触角 α（弧度），深沟球轴承通常 0
 *
 * 轴转速以 rpm 输入，内部换算为旋转频率 fr = rpm/60。
 *
 * 标准公式（外圈固定、内圈随轴旋转）：
 *   BPFO = N/2 * fr * (1 - (d/D)cosα)   外圈故障
 *   BPFI = N/2 * fr * (1 + (d/D)cosα)   内圈故障
 *   BSF  = D/(2d) * fr * (1 - ((d/D)cosα)^2)  滚动体故障
 *   FTF  = 1/2   * fr * (1 - (d/D)cosα)       保持架故障
 */

export interface BearingGeometry {
  ballCount: number;
  pitchD: number;
  ballD: number;
  contactAngleRad?: number;
}

export interface BearingFrequencies {
  /** 轴旋转频率 fr（Hz） */
  shaft: number;
  bpfo: number;
  bpfi: number;
  bsf: number;
  ftf: number;
}

export type FaultKind = "bpfo" | "bpfi" | "bsf" | "ftf";

/** 教材标准 6205 几何，供测试与默认配置引用，修改需同步更新测试参考值。 */
export const BEARING_REF_GUARD: BearingGeometry = {
  ballCount: 9,
  pitchD: 39.04,
  ballD: 7.94,
  contactAngleRad: 0,
};

export const FAULT_LABELS: Record<FaultKind, string> = {
  bpfo: "外圈故障",
  bpfi: "内圈故障",
  bsf: "滚动体故障",
  ftf: "保持架故障",
};

export function bearingFrequencies(rpm: number, geo: BearingGeometry): BearingFrequencies {
  if (rpm <= 0) throw new Error(`转速必须为正，收到 ${rpm}`);
  if (geo.ballCount < 2) throw new Error("滚动体数量至少为 2");
  if (!(geo.pitchD > 0) || !(geo.ballD > 0)) {
    throw new Error("节径与滚珠直径必须为正");
  }
  if (geo.ballD >= geo.pitchD) {
    throw new Error("滚珠直径必须小于节径");
  }
  const fr = rpm / 60;
  const ratio = geo.ballD / geo.pitchD;
  const cosA = Math.cos(geo.contactAngleRad ?? 0);
  const n = geo.ballCount;

  return {
    shaft: fr,
    bpfo: (n / 2) * fr * (1 - ratio * cosA),
    bpfi: (n / 2) * fr * (1 + ratio * cosA),
    bsf: (geo.pitchD / (2 * geo.ballD)) * fr * (1 - ratio * ratio * cosA * cosA),
    ftf: 0.5 * fr * (1 - ratio * cosA),
  };
}

/**
 * 生成某故障通道需要检查的特征频率列表（基频 + 谐波）。
 * 注意：滚动体冲击每转击打内外圈各一次，重复频率为 2×BSF，
 * 因此 BSF 通道从 2 阶起查；FTF 能量弱通常只看 1~2 阶。
 */
export function faultHarmonics(
  kind: FaultKind,
  freq: BearingFrequencies,
  maxOrder?: number,
): { order: number; hz: number }[] {
  const base = freq[kind];
  const out: { order: number; hz: number }[] = [];
  if (kind === "bsf") {
    const top = maxOrder ?? 4;
    // 2×BSF、3×BSF、4×BSF（跳过基频）
    for (let h = 2; h <= top; h++) out.push({ order: h, hz: base * h });
    return out;
  }
  const order = maxOrder ?? (kind === "ftf" ? 2 : 4);
  for (let h = 1; h <= order; h++) {
    out.push({ order: h, hz: base * h });
  }
  return out;
}
