/**
 * Canvas 二维谱图绘制。
 * 纯函数式：给定 canvas 与数据立即重绘，不持有状态。
 * 支持 Welch PSD（dB）+ 基线均值叠加 + 特征频率标记线。
 */

export interface Marker {
  hz: number;
  label: string;
  color: string;
}

export interface PlotOptions {
  title?: string;
  xMaxHz?: number;
  markers?: Marker[];
  baselineDb?: number[];
  baselineFreqs?: number[];
  yLabel?: string;
}

export function drawSpectrum(
  canvas: HTMLCanvasElement,
  freqs: Float64Array,
  valuesDb: Float64Array,
  options: PlotOptions = {},
): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 240;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  const W = cssW;
  const H = cssH;
  const padL = 56;
  const padR = 12;
  const padT = 28;
  const padB = 34;

  ctx.clearRect(0, 0, W, H);
  ctx.font = "11px system-ui, sans-serif";

  const xMax = options.xMaxHz ?? freqs[freqs.length - 1];
  let minV = Infinity;
  let maxV = -Infinity;
  for (let k = 0; k < freqs.length && freqs[k] <= xMax; k++) {
    if (Number.isFinite(valuesDb[k])) {
      minV = Math.min(minV, valuesDb[k]);
      maxV = Math.max(maxV, valuesDb[k]);
    }
  }
  if (!Number.isFinite(minV)) {
    minV = -100;
    maxV = 0;
  }
  const pad = (maxV - minV) * 0.1 || 10;
  minV -= pad;
  maxV += pad;

  const xOf = (hz: number) => padL + (hz / xMax) * (W - padL - padR);
  const yOf = (v: number) => padT + (1 - (v - minV) / (maxV - minV)) * (H - padT - padB);

  // 网格 + y 轴刻度
  ctx.strokeStyle = "#e5e7eb";
  ctx.fillStyle = "#6b7280";
  ctx.lineWidth = 1;
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const v = minV + ((maxV - minV) * i) / yTicks;
    const y = yOf(v);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.fillText(v.toFixed(0), 6, y + 3);
  }
  // x 轴刻度
  const xTicks = 6;
  for (let i = 0; i <= xTicks; i++) {
    const hz = (xMax * i) / xTicks;
    const x = xOf(hz);
    ctx.fillText(`${hz >= 1000 ? (hz / 1000).toFixed(1) + "k" : hz.toFixed(0)}`, x - 10, H - 12);
    ctx.strokeStyle = "#f3f4f6";
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, H - padB);
    ctx.stroke();
  }

  // 基线（虚线）
  if (options.baselineDb && options.baselineFreqs) {
    ctx.strokeStyle = "#9ca3af";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    const bFreq = options.baselineFreqs;
    const bVal = options.baselineDb;
    for (let k = 0; k < bFreq.length && bFreq[k] <= xMax; k++) {
      const x = xOf(bFreq[k]);
      const y = yOf(bVal[k]);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 主谱线
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  let started = false;
  for (let k = 0; k < freqs.length && freqs[k] <= xMax; k++) {
    const x = xOf(freqs[k]);
    const y = yOf(valuesDb[k]);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 特征频率标记
  if (options.markers) {
    for (const m of options.markers) {
      if (m.hz > xMax) continue;
      const x = xOf(m.hz);
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, H - padB);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.save();
      ctx.translate(x + 3, padT + 10);
      ctx.fillStyle = m.color;
      ctx.fillText(m.label, 0, 0);
      ctx.restore();
    }
  }

  // 标题与轴名
  if (options.title) {
    ctx.fillStyle = "#111827";
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.fillText(options.title, padL, 16);
  }
  ctx.fillStyle = "#6b7280";
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillText("Hz", W - padR - 14, H - 12);
  if (options.yLabel) {
    ctx.save();
    ctx.translate(14, padT + (H - padT - padB) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(options.yLabel, -20, 0);
    ctx.restore();
  }
}
