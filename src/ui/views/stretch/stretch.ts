import { BAt, buildTargetFrequencies, stretchCentsCurve } from '../../../core/stretch';
import { midiToName, FIRST_MIDI, LAST_MIDI, equalTempFrequency, A4_MIDI } from '../../../core/notes';
import { store } from '../../store';
import { el, clearNode } from '../../dom';

export function renderStretchView(root: HTMLElement): void {
  clearNode(root);
  if (!store.state.currentPiano) {
    root.append(el('div', { class: 'empty' }, '请先在「钢琴档案」选择一台钢琴。'));
    return;
  }

  const info = el('div', { class: 'panel' }, [
    el('h2', {}, '拉伸曲线'),
    el('p', { class: 'hint' }, '基于已测样本音的非谐系数拟合。样本越多、覆盖音区越广，曲线越可靠（建议 ≥10 个、至少 2 个）。'),
    el('div', { id: 'model-info' }),
  ]);
  const bChart = el('div', { class: 'panel' }, [
    elh3('非谐系数 B 随键位变化（对数轴）'),
    el('canvas', { class: 'chart', id: 'b-chart' }),
  ]);
  const centsChart = el('div', { class: 'panel' }, [
    elh3('整琴拉伸量（相对平均律，音分）'),
    el('canvas', { class: 'chart', id: 'cents-chart' }),
  ]);
  const tablePanel = el('div', { class: 'panel' }, [
    elh3('88 键目标频率（节选展示，完整数据用于调律模式）'),
    el('div', { id: 'target-table', style: 'max-height:320px;overflow:auto' }),
  ]);
  root.append(info, bChart, centsChart, tablePanel);

  const draw = () => {
    const model = store.state.stretchModel;
    const modelBox = info.querySelector('#model-info')!;
    clearNode(modelBox);
    if (!model) {
      modelBox.append(el('div', { class: 'empty' }, '样本不足 2 个，无法拟合。请到「逐音测量」采集数据。'));
      return;
    }
    const s = store.state.settings;
    const tf = buildTargetFrequencies(model, s.temperamentId, s.octaveType, s.a4);
    modelBox.append(
      el('div', { class: 'readout' }, [
        el('div', {}, [el('div', { class: 'sub' }, '拟合参数 lnB = α + β·m'), el('div', { class: 'big', style: 'font-size:22px' }, `β=${model.beta.toFixed(4)}`)]),
        el('div', {}, [el('div', { class: 'sub' }, '样本数'), el('div', { class: 'big', style: 'font-size:22px' }, String(model.samples.length))]),
        el('div', {}, [el('div', { class: 'sub' }, '律制 / 八度'), el('div', { class: 'big', style: 'font-size:22px' }, `${s.temperamentId} / ${s.octaveType}`)]),
      ]),
    );

    drawBChart(model);
    drawCentsChart(tf);
    drawTargetTable(tf);
  };

  const drawBChart = (model: NonNullable<ReturnType<() => typeof store.state.stretchModel>>) => {
    const canvas = root.querySelector('#b-chart') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    sizeCanvas(canvas);
    const { w, h } = { w: canvas.width, h: canvas.height };
    ctx.clearRect(0, 0, w, h);
    const pad = { l: 64, r: 16, t: 16, b: 36 };
    const xMin = FIRST_MIDI, xMax = LAST_MIDI;
    const yMin = Math.log10(model.minB), yMax = Math.log10(model.maxB);
    const X = (m: number) => pad.l + ((m - xMin) / (xMax - xMin)) * (w - pad.l - pad.r);
    const Y = (logb: number) => h - pad.b - ((logb - yMin) / (yMax - yMin)) * (h - pad.t - pad.b);

    // 网格 + 轴标签
    ctx.strokeStyle = '#343b47'; ctx.fillStyle = '#9aa5b3'; ctx.font = '11px sans-serif';
    for (let p = Math.ceil(yMin); p <= yMax; p++) {
      ctx.beginPath(); ctx.moveTo(pad.l, Y(p)); ctx.lineTo(w - pad.r, Y(p)); ctx.stroke();
      ctx.fillText(`1e${p}`, 6, Y(p) + 4);
    }
    for (const midi of [21, 33, 45, 57, 69, 81, 93, 105]) {
      ctx.fillText(midiToName(midi), X(midi) - 10, h - 12);
    }

    // 拟合曲线
    ctx.strokeStyle = '#4f9cf9'; ctx.lineWidth = 2; ctx.beginPath();
    for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
      const x = X(midi), y = Y(Math.log10(BAt(model, midi)));
      midi === FIRST_MIDI ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 实测散点
    ctx.fillStyle = '#34c77b';
    for (const smp of model.samples) {
      ctx.beginPath();
      ctx.arc(X(smp.midi), Y(Math.log10(smp.B)), 5, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  const drawCentsChart = (tf: ReturnType<typeof buildTargetFrequencies>) => {
    const canvas = root.querySelector('#cents-chart') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    sizeCanvas(canvas);
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const pad = { l: 56, r: 16, t: 16, b: 36 };
    const curve = stretchCentsCurve(tf);
    const centsVals = curve.map((c) => c.cents);
    const yMin = Math.min(-5, ...centsVals), yMax = Math.max(5, ...centsVals);
    const X = (m: number) => pad.l + ((m - FIRST_MIDI) / (LAST_MIDI - FIRST_MIDI)) * (w - pad.l - pad.r);
    const Y = (c: number) => h - pad.b - ((c - yMin) / (yMax - yMin)) * (h - pad.t - pad.b);

    ctx.strokeStyle = '#343b47'; ctx.fillStyle = '#9aa5b3'; ctx.font = '11px sans-serif';
    for (let c = Math.ceil(yMin / 10) * 10; c <= yMax; c += 10) {
      ctx.beginPath(); ctx.moveTo(pad.l, Y(c)); ctx.lineTo(w - pad.r, Y(c)); ctx.stroke();
      ctx.fillText(`${c}`, 8, Y(c) + 4);
    }
    // 零线
    ctx.strokeStyle = '#34c77b'; ctx.beginPath(); ctx.moveTo(pad.l, Y(0)); ctx.lineTo(w - pad.r, Y(0)); ctx.stroke();

    ctx.strokeStyle = '#f0a848'; ctx.lineWidth = 2; ctx.beginPath();
    curve.forEach((c, i) => (i === 0 ? ctx.moveTo(X(c.midi), Y(c.cents)) : ctx.lineTo(X(c.midi), Y(c.cents))));
    ctx.stroke();
    for (const midi of [21, 33, 45, 57, 69, 81, 93, 105]) {
      ctx.fillStyle = '#9aa5b3';
      ctx.fillText(midiToName(midi), X(midi) - 10, h - 12);
    }
  };

  const drawTargetTable = (tf: ReturnType<typeof buildTargetFrequencies>) => {
    const box = tablePanel.querySelector('#target-table')!;
    clearNode(box);
    const rows: Node[] = [el('tr', {}, [el('th', {}, '琴键'), el('th', {}, '平均律 Hz'), el('th', {}, '目标 Hz'), el('th', {}, '拉伸 音分')])];
    for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
      const nominal = equalTempFrequency(midi, store.state.settings.a4);
      const target = tf.targets[midi - FIRST_MIDI];
      const cents = (1200 / Math.LN2) * Math.log(target / nominal);
      if (midi % 7 === 0 || midi === A4_MIDI || midi === LAST_MIDI) {
        rows.push(el('tr', {}, [
          el('td', {}, midiToName(midi)),
          el('td', {}, nominal.toFixed(2)),
          el('td', {}, target.toFixed(2)),
          el('td', {}, (cents > 0 ? '+' : '') + cents.toFixed(1)),
        ]));
      }
    }
    box.append(el('table', {}, el('tbody', {}, rows)));
  };

  draw();
  const unsub = store.subscribe(draw);
  root.addEventListener('view-cleanup', () => unsub());
  // 窗口尺寸变化时重绘
  const onResize = () => draw();
  window.addEventListener('resize', onResize);
  root.addEventListener('view-cleanup', () => window.removeEventListener('resize', onResize));
}

function elh3(text: string): HTMLElement {
  return el('h3', { style: 'margin-top:0' }, text);
}

function sizeCanvas(canvas: HTMLCanvasElement): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  // 用 CSS 像素坐标绘图
  canvas.width = Math.round(rect.width);
  canvas.height = Math.round(rect.height);
}
