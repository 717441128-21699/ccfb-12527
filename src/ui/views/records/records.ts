import { driftHistory, listSessions } from '../../../core/storage';
import { midiToName } from '../../../core/notes';
import { store } from '../../store';
import { el, clearNode, toast, fmtDate } from '../../dom';

export function renderRecordsView(root: HTMLElement): void {
  clearNode(root);
  if (!store.state.currentPiano) {
    root.append(el('div', { class: 'empty' }, '请先在「钢琴档案」选择一台钢琴。'));
    return;
  }

  const actionPanel = el('div', { class: 'panel' }, [
    el('h2', {}, '本次工作存档'),
    el('p', { class: 'hint' }, '把当前逐音测量结果固化为一次上门记录，之后可在下方追踪音准随时间的漂移。'),
    el('textarea', { class: 'field', id: 'session-notes', rows: '2', placeholder: '本次工作备注（如 换季保养、更换弦轴…）' }),
    el('button', { class: 'btn', id: 'commit-session', style: 'margin-top:8px' }, '保存本次工作记录'),
  ]);

  const driftPanel = el('div', { class: 'panel' }, [
    el('h2', {}, '季节性漂移分析'),
    el('div', { class: 'row' }, [
      el('label', { class: 'ctrl' }, [
        document.createTextNode('选择琴键 '),
        el('select', { id: 'drift-key' }),
      ]),
    ]),
    el('canvas', { class: 'chart', id: 'drift-chart', style: 'margin-top:12px' }),
    el('div', { id: 'drift-empty' }),
  ]);

  const listPanel = el('div', { class: 'panel' }, [
    el('h2', {}, '历史工作记录'),
    el('div', { id: 'session-list', style: 'max-height:420px;overflow:auto' }),
  ]);

  root.append(actionPanel, driftPanel, listPanel);

  const piano = store.state.currentPiano;
  const driftKeySelect = driftPanel.querySelector('#drift-key') as HTMLSelectElement;

  const refreshDriftKeyOptions = () => {
    const prev = driftKeySelect.value;
    clearNode(driftKeySelect);
    // 汇总该琴所有会话中出现过的键
    const midiSet = new Set<number>();
    void listSessions(piano.id).then((sessions) => {
      for (const s of sessions) for (const m of s.measurements) midiSet.add(m.midi);
      const sorted = [...midiSet].sort((a, b) => a - b);
      for (const midi of sorted) {
        driftKeySelect.append(el('option', { value: String(midi) }, midiToName(midi)));
      }
      if (prev) driftKeySelect.value = prev;
      if (sorted.length) void drawDrift(Number(driftKeySelect.value || sorted[0]));
    });
  };

  const drawDrift = async (midi: number) => {
    const points = await driftHistory(piano.id, midi);
    const canvas = driftPanel.querySelector('#drift-chart') as HTMLCanvasElement;
    const emptyBox = driftPanel.querySelector('#drift-empty')!;
    clearNode(emptyBox);
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width, h = rect.height;
    ctx.clearRect(0, 0, w, h);
    if (points.length < 2) {
      emptyBox.append(el('div', { class: 'empty' }, '该键至少需要 2 次历史测量才能绘制漂移曲线。'));
      return;
    }
    const pad = { l: 56, r: 16, t: 16, b: 40 };
    const xs = points.map((p) => p.date);
    const ys = points.map((p) => p.cents);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yPad = Math.max(2, (Math.max(...ys) - Math.min(...ys)) * 0.2);
    const yMin = Math.min(...ys) - yPad, yMax = Math.max(...ys) + yPad;
    const X = (t: number) => pad.l + ((t - xMin) / Math.max(1, xMax - xMin)) * (w - pad.l - pad.r);
    const Y = (c: number) => h - pad.b - ((c - yMin) / (yMax - yMin)) * (h - pad.t - pad.b);

    ctx.strokeStyle = '#343b47'; ctx.fillStyle = '#9aa5b3'; ctx.font = '11px sans-serif';
    for (let i = 0; i <= 4; i++) {
      const c = yMin + ((yMax - yMin) * i) / 4;
      ctx.beginPath(); ctx.moveTo(pad.l, Y(c)); ctx.lineTo(w - pad.r, Y(c)); ctx.stroke();
      ctx.fillText(`${c.toFixed(1)}`, 6, Y(c) + 4);
    }
    ctx.strokeStyle = '#4f9cf9'; ctx.lineWidth = 2; ctx.beginPath();
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(X(p.date), Y(p.cents)) : ctx.lineTo(X(p.date), Y(p.cents))));
    ctx.stroke();
    ctx.fillStyle = '#34c77b';
    for (const p of points) {
      ctx.beginPath(); ctx.arc(X(p.date), Y(p.cents), 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#9aa5b3';
      ctx.fillText(fmtDate(p.date).slice(5, 10), X(p.date) - 16, h - 14);
      ctx.fillStyle = '#34c77b';
    }
  };

  driftKeySelect.addEventListener('change', () => void drawDrift(Number(driftKeySelect.value)));

  const renderList = async () => {
    const sessions = await listSessions(piano.id);
    const box = listPanel.querySelector('#session-list')!;
    clearNode(box);
    if (sessions.length === 0) {
      box.append(el('div', { class: 'empty' }, '还没有工作记录。'));
      return;
    }
    const rows: Node[] = [el('tr', {}, [
      el('th', {}, '日期'), el('th', {}, '律制/八度'), el('th', {}, '样本数'),
      el('th', {}, 'A4'), el('th', {}, '备注'),
    ])];
    for (const s of sessions) {
      rows.push(el('tr', {}, [
        el('td', {}, fmtDate(s.date)),
        el('td', {}, `${s.temperamentId} / ${s.octaveType}`),
        el('td', {}, String(s.measurements.length)),
        el('td', {}, String(s.a4)),
        el('td', {}, s.notes ?? '—'),
      ]));
    }
    box.append(el('table', {}, el('tbody', {}, rows)));
  };

  actionPanel.querySelector('#commit-session')!.addEventListener('click', async () => {
    if (store.state.measurements.size === 0) return toast('当前没有测量数据可保存');
    const notes = (actionPanel.querySelector('#session-notes') as HTMLTextAreaElement).value.trim();
    const session = await store.commitSession(notes || undefined);
    if (session) {
      toast('工作记录已保存');
      (actionPanel.querySelector('#session-notes') as HTMLTextAreaElement).value = '';
      void renderList();
      refreshDriftKeyOptions();
    }
  });

  void renderList();
  refreshDriftKeyOptions();
}
