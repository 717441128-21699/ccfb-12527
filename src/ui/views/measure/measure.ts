import { measureInharmonicity, type InharmonicityResult } from '../../../core/inharmonicity';
import { synthesizePianoTone } from '../../../core/synth';
import { midiToName, FIRST_MIDI, LAST_MIDI, indexToMidi, equalTempFrequency } from '../../../core/notes';
import { store } from '../../store';
import { el, clearNode, toast, fmtCents } from '../../dom';
import { startAudio, stopAudio, typicalB, nominalF0 } from '../../audio-session';
import type { KeyMeasurement } from '../../../core/storage';

// 推荐的样本测量键（覆盖四个音区，约 14 个）
const SAMPLE_KEYS = [21, 28, 33, 40, 45, 49, 52, 57, 60, 64, 69, 76, 84, 96];

export function renderMeasureView(root: HTMLElement): void {
  clearNode(root);
  if (!store.state.currentPiano) {
    root.append(el('div', { class: 'empty' }, '请先在「钢琴档案」选择一台钢琴。'));
    return;
  }

  const piano = store.state.currentPiano;
  const header = el('div', { class: 'panel' }, [
    el('h2', {}, `逐音测量 — ${piano.brand} ${piano.model}`),
    el('p', { class: 'hint' }, '建议至少测量 10~14 个样本音（绿框为推荐样本）。每按一次「测量当前音」会分析前 8 个泛音并拟合非谐系数 B。'),
    el('div', { class: 'row' }, [
      el('button', { class: 'btn', id: 'measure-toggle' }, '开始监听'),
      el('button', { class: 'btn secondary', id: 'measure-now' }, '测量当前音'),
      el('button', { class: 'btn secondary', id: 'measure-sample-all' }, '自动测推荐样本（演示）'),
    ]),
  ]);

  const keyPanel = el('div', { class: 'panel' }, [
    el('h2', {}, '选择琴键'),
    el('div', { class: 'key-selector', id: 'key-selector' }),
  ]);

  const resultPanel = el('div', { class: 'panel' }, [
    el('h2', {}, '测量结果'),
    el('div', { id: 'measure-result' }, el('div', { class: 'empty' }, '尚未测量')),
  ]);

  const historyPanel = el('div', { class: 'panel' }, [
    el('h2', {}, '本琴已测样本'),
    el('div', { id: 'measure-history' }),
  ]);

  root.append(header, keyPanel, resultPanel, historyPanel);

  let listening = false;
  let latestSR = 48000;

  // 块累积器：收集最近的音频块，分析时取最近的目标窗长
  const accumulator = makeAccumulator();
  const frameHandler = (frame: Float32Array, sr: number) => {
    latestSR = sr;
    accumulator.push(frame, sr);
  };

  const selector = keyPanel.querySelector('#key-selector')!;
  const renderKeys = () => {
    clearNode(selector);
    for (let index = 0; index <= LAST_MIDI - FIRST_MIDI; index++) {
      const midi = indexToMidi(index);
      const measured = store.state.measurements.has(midi);
      const isSample = SAMPLE_KEYS.includes(midi);
      const active = store.state.selectedMidi === midi;
      const chip = el('button', {
        class: `key-chip${measured ? ' measured' : ''}${active ? ' active' : ''}`,
        style: isSample && !measured ? 'border-color:var(--warn)' : '',
      }, [midiToName(midi)]);
      chip.title = isSample ? '推荐样本音' : '';
      chip.addEventListener('click', () => store.selectKey(midi));
      selector.append(chip);
    }
  };
  renderKeys();

  const renderHistory = () => {
    const box = historyPanel.querySelector('#measure-history')!;
    clearNode(box);
    const rows = [...store.state.measurements.values()].sort((a, b) => a.midi - b.midi);
    if (rows.length === 0) {
      box.append(el('div', { class: 'empty' }, '暂无测量数据'));
      return;
    }
    const table = el('table', {}, [
      el('thead', {}, el('tr', {}, [
        el('th', {}, '琴键'), el('th', {}, '基频 Hz'), el('th', {}, 'B 系数'),
        el('th', {}, 'R²'), el('th', {}, ''),
      ])),
      el('tbody', {}, rows.map((m) =>
        el('tr', {}, [
          el('td', {}, midiToName(m.midi)),
          el('td', {}, m.fundamental.toFixed(2)),
          el('td', {}, m.B.toExponential(2)),
          el('td', {}, m.r2.toFixed(4)),
          el('td', {}, el('button', { class: 'btn secondary', 'data-midi': String(m.midi) }, '删除')),
        ]),
      )),
    ]);
    table.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-midi]') as HTMLButtonElement | null;
      if (btn) store.removeMeasurement(Number(btn.dataset.midi));
    });
    box.append(table);
  };
  renderHistory();

  const unsubStore = store.subscribe(() => {
    renderKeys();
    renderHistory();
  });

  const analyze = (): InharmonicityResult | null => {
    const midi = store.state.selectedMidi;
    const targetSeconds = midi < 40 ? 1.37 : midi < 72 ? 0.68 : 0.34;
    const need = Math.round(targetSeconds * latestSR);
    const frame = accumulator.take(need, latestSR);
    if (frame.length < need * 0.9) {
      toast('信号缓冲不足，请先开始监听并持续弹奏该音');
      return null;
    }
    const expected = equalTempFrequency(midi, store.state.settings.a4);
    return measureInharmonicity(frame, latestSR, { expectedF0: expected });
  };

  const toggle = header.querySelector('#measure-toggle')! as HTMLButtonElement;
  toggle.addEventListener('click', async () => {
    listening = !listening;
    if (listening) {
      const midi = store.state.selectedMidi;
      await startAudio(frameHandler, nominalF0(midi), typicalB(midi));
      toggle.textContent = '停止监听';
      toast(store.state.settings.demoMode ? '演示音源已启动' : '麦克风已启动');
    } else {
      await stopAudio();
      toggle.textContent = '开始监听';
    }
  });

  header.querySelector('#measure-now')!.addEventListener('click', () => {
    const r = analyze();
    if (!r) return;
    renderResult(r);
    const midi = store.state.selectedMidi;
    const m: KeyMeasurement = {
      midi, B: r.B, fundamental: r.fundamental, r2: r.r2, measuredAt: Date.now(),
    };
    store.addMeasurement(m);
    toast(`${midiToName(midi)} 测量完成，B=${r.B.toExponential(2)}`);
  });

  // 演示模式一键自动测量推荐样本（离线合成，确定性强、瞬时完成）
  header.querySelector('#measure-sample-all')!.addEventListener('click', async () => {
    if (!store.state.settings.demoMode) return toast('自动测量仅在演示模式下可用');
    const btn = header.querySelector('#measure-sample-all') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = '测量中…';
    // 让按钮有机会重绘，再同步跑 14 个合成测量
    await new Promise((r) => setTimeout(r, 30));
    for (const midi of SAMPLE_KEYS) {
      const f0 = nominalF0(midi);
      const B = typicalB(midi);
      const targetSeconds = midi < 40 ? 2.5 : midi < 72 ? 2 : 1.5;
      const signal = synthesizePianoTone({
        f1: f0, B, sampleRate: 48000, duration: targetSeconds,
        decayTaus: midi < 40 ? [3, 2.4, 1.9, 1.5, 1.2, 1, 0.85, 0.7] : undefined,
        noiseLevel: 0.002, seed: midi,
      });
      const len = 1 << Math.floor(Math.log2(targetSeconds * 0.7 * 48000));
      const frame = signal.subarray(1000, 1000 + len) as Float64Array;
      const r = measureInharmonicity(frame, 48000, { expectedF0: f0 });
      if (r) {
        store.addMeasurement({ midi, B: r.B, fundamental: r.fundamental, r2: r.r2, measuredAt: Date.now() });
      }
    }
    btn.disabled = false;
    btn.textContent = '自动测推荐样本（演示）';
    toast('推荐样本测量完成，可到「拉伸曲线」查看');
  });

  function renderResult(r: InharmonicityResult) {
    const box = resultPanel.querySelector('#measure-result')!;
    clearNode(box);
    const maxMag = Math.max(...r.partials.map((p) => p.magnitude));
    const rows = r.partials.map((p) =>
      el('div', { class: 'partial-row' }, [
        el('div', { style: 'width:48px' }, `第${p.n}泛音`),
        el('div', { style: 'width:96px;font-variant-numeric:tabular-nums' }, `${p.frequency.toFixed(2)} Hz`),
        el('div', { style: 'width:80px' }, `${fmtCents(p.stretchCents)} 音分`),
        el('div', { class: 'bar', style: `width:${Math.max(2, (p.magnitude / maxMag) * 220)}px` }),
      ]),
    );
    box.append(
      el('div', { class: 'readout' }, [
        el('div', {}, [
          el('div', { class: 'sub' }, '拟合基频'),
          el('div', { class: 'big' }, `${r.fundamental.toFixed(2)}`),
          el('div', { class: 'sub' }, 'Hz'),
        ]),
        el('div', {}, [
          el('div', { class: 'sub' }, '非谐系数 B'),
          el('div', { class: 'big' }, r.B.toExponential(3)),
        ]),
        el('div', {}, [
          el('div', { class: 'sub' }, '拟合优度 R²'),
          el('div', { class: 'big' }, r.r2.toFixed(5)),
        ]),
      ]),
      el('h3', {}, '泛音明细（偏离整数倍的音分应随序号递增）'),
      ...rows,
    );
  }

  // 切换键位时若正在监听，重启演示引擎以切换音源
  const keySwitchUnsub = store.subscribe((s) => {
    if (listening && s.settings.demoMode) {
      const midi = s.selectedMidi;
      void startAudio(frameHandler, nominalF0(midi), typicalB(midi));
    }
  });

  // 视图卸载清理（通过自定义事件由 main 触发）
  root.addEventListener('view-cleanup', () => {
    unsubStore();
    keySwitchUnsub();
    void stopAudio();
  });
}

interface Accumulator {
  push(frame: Float32Array, sr: number): void;
  take(needSamples: number, sr: number): Float64Array;
}

function makeAccumulator(): Accumulator {
  const chunks: Float32Array[] = [];
  let total = 0;
  return {
    push(frame) {
      chunks.push(frame);
      total += frame.length;
      // 限制缓冲总量（约 3 秒），丢弃最旧的块
      while (chunks.length > 2 && total > 48000 * 3) {
        total -= chunks.shift()!.length;
      }
    },
    take(need) {
      let need2 = need;
      const out: number[] = [];
      for (let i = chunks.length - 1; i >= 0 && need2 > 0; i--) {
        const c = chunks[i];
        const take = Math.min(c.length, need2);
        for (let j = c.length - take; j < c.length; j++) out.unshift(c[j]);
        need2 -= take;
      }
      return Float64Array.from(out);
    },
  };
}
