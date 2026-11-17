import { buildTargetFrequencies } from '../../../core/stretch';
import { midiToName, indexToMidi, FIRST_MIDI, LAST_MIDI, midiToIndex, equalTempFrequency } from '../../../core/notes';
import { TunerEngine, type TunerReading } from '../../../core/tuner-engine';
import { store } from '../../store';
import { el, clearNode, toast, fmtCents } from '../../dom';
import { startAudio, stopAudio, typicalB } from '../../audio-session';

export function renderTuneView(root: HTMLElement): void {
  clearNode(root);
  if (!store.state.currentPiano) {
    root.append(el('div', { class: 'empty' }, '请先在「钢琴档案」选择钢琴，并在「逐音测量」采集样本生成拉伸曲线。'));
    return;
  }
  if (!store.state.stretchModel) {
    root.append(el('div', { class: 'empty' }, '拉伸曲线尚未生成，至少需要 2 个样本音。'));
    return;
  }

  const settings = store.state.settings;
  const tf = buildTargetFrequencies(store.state.stretchModel, settings.temperamentId, settings.octaveType, settings.a4);

  const top = el('div', { class: 'panel' }, [
    el('h2', {}, '调律模式'),
    el('div', { class: 'row' }, [
      el('button', { class: 'btn', id: 'tune-toggle' }, '开始调律'),
      el('label', { class: 'ctrl' }, [
        document.createTextNode('模式 '),
        el('select', { id: 'tune-mode' }, [
          el('option', { value: 'single' }, '单弦音准'),
          el('option', { value: 'unison' }, '齐音拍频'),
        ]),
      ]),
    ]),
    el('div', { class: 'key-selector', id: 'tune-keys', style: 'margin-top:12px' }),
  ]);

  const meterPanel = el('div', { class: 'panel' }, [
    el('h2', { id: 'tune-title' }, '音准指针'),
    el('div', { class: 'meter', id: 'meter' }, buildMeterTicks()),
    el('div', { class: 'readout', id: 'readout' }),
    el('div', { class: 'level-bar' }, el('div', { id: 'level-fill' })),
    el('div', { id: 'beat-box', style: 'margin-top:14px' }),
  ]);

  root.append(top, meterPanel);

  // 键位
  const keyBox = top.querySelector('#tune-keys')!;
  for (let index = 0; index <= LAST_MIDI - FIRST_MIDI; index++) {
    const midi = indexToMidi(index);
    const chip = el('button', { class: 'key-chip' + (midi === store.state.selectedMidi ? ' active' : '') }, [midiToName(midi)]);
    chip.addEventListener('click', () => store.selectKey(midi));
    keyBox.append(chip);
  }

  let engine: TunerEngine | null = null;
  let running = false;
  let mode: 'single' | 'unison' = 'single';

  const targetsFor = (midi: number) => {
    const target = tf.targets[midiToIndex(midi)];
    return { target, expected: equalTempFrequency(midi, settings.a4) };
  };

  const renderReadout = (r: TunerReading | null, midi: number) => {
    const box = meterPanel.querySelector('#readout')!;
    clearNode(box);
    const { target } = targetsFor(midi);
    if (!r || !r.active) {
      box.append(
        el('div', {}, [el('div', { class: 'sub' }, '当前键'), el('div', { class: 'big' }, midiToName(midi))]),
        el('div', {}, [el('div', { class: 'sub' }, '目标频率'), el('div', { class: 'big' }, target.toFixed(2)), el('div', { class: 'sub' }, 'Hz')]),
        el('div', {}, [el('div', { class: 'sub' }, '状态'), el('div', { class: 'big', style: 'font-size:24px;color:var(--muted)' }, '等待声音…')]),
      );
      setNeedle(0, true);
      return;
    }
    const c = r.smoothCents;
    const cls = Math.abs(c) < 3 ? 'in-tune' : c > 0 ? 'sharp' : 'flat';
    const label = Math.abs(c) < 3 ? '音准良好' : c > 0 ? '偏高' : '偏低';
    box.append(
      el('div', {}, [el('div', { class: 'sub' }, '当前键'), el('div', { class: 'big' }, midiToName(midi))]),
      el('div', {}, [el('div', { class: 'sub' }, '实测 / 目标 Hz'), el('div', { class: 'big', style: 'font-size:26px' }, `${r.fundamental.toFixed(2)} / ${target.toFixed(2)}`)]),
      el('div', {}, [el('div', { class: 'sub' }, '音分偏差'), el('div', { class: `big ${cls}` }, `${fmtCents(c)}`), el('div', { class: 'sub' }, label)]),
      el('div', {}, [el('div', { class: 'sub' }, 'B / R²'), el('div', { style: 'font-variant-numeric:tabular-nums' }, `${r.B.toExponential(2)} / ${r.r2.toFixed(3)}`)]),
    );
    setNeedle(c, false);
    (meterPanel.querySelector('#level-fill') as HTMLElement).style.width = `${Math.min(100, r.level * 180)}%`;
  };

  const setNeedle = (cents: number, centered: boolean) => {
    const needle = meterPanel.querySelector('.needle') as HTMLElement;
    if (centered) { needle.style.left = '50%'; return; }
    // ±50 音分映射到 5%~95% 宽度
    const clamped = Math.max(-50, Math.min(50, cents));
    const pct = 50 + (clamped / 50) * 45;
    needle.style.left = `${pct}%`;
  };

  const renderBeat = (midi: number) => {
    const box = meterPanel.querySelector('#beat-box')!;
    clearNode(box);
    if (mode !== 'unison' || !engine) {
      box.append(el('div', { class: 'hint' }, '齐音模式：弹下同音三根弦，测量每秒拍数，拍频趋近 0 即调齐。'));
      return;
    }
    const beat = engine.measureBeats(4);
    if (!beat) {
      box.append(el('div', { class: 'hint' }, '正在累积拍频分析缓冲（约 4 秒）…'));
      return;
    }
    box.append(
      el('div', { class: 'beat-display' }, [
        el('div', { class: 'sub' }, `${midiToName(midi)} 齐音拍频`),
        el('div', { class: 'beat-value' }, beat.beatHz.toFixed(2)),
        el('div', { class: 'sub' }, `拍/秒 · 调制深度 ${(beat.modulationDepth * 100).toFixed(1)}%`),
        el('span', { class: `status-pill ${beat.isUnison ? 'good' : 'bad'}` }, beat.isUnison ? '已齐音' : '仍有拍，继续微调'),
      ]),
    );
  };

  // 初始读数
  renderReadout(null, store.state.selectedMidi);

  const toggle = top.querySelector('#tune-toggle')! as HTMLButtonElement;
  const modeSelect = top.querySelector('#tune-mode') as HTMLSelectElement;
  modeSelect.addEventListener('change', () => {
    mode = modeSelect.value as 'single' | 'unison';
    meterPanel.querySelector('#tune-title')!.textContent = mode === 'unison' ? '齐音拍频' : '音准指针';
    renderBeat(store.state.selectedMidi);
  });

  toggle.addEventListener('click', async () => {
    running = !running;
    if (running) {
      const midi = store.state.selectedMidi;
      const { target, expected } = targetsFor(midi);
      engine = new TunerEngine({ targetF0: target, expectedF0: expected, smoothTau: 0.35 });
      await startAudio((frame, sr) => {
        const reading = engine!.pushBlock(frame, sr);
        if (reading && mode === 'single') renderReadout(reading, store.state.selectedMidi);
      }, expected, typicalB(midi));
      toggle.textContent = '停止调律';
      if (mode === 'unison') beatTimer = setInterval(() => renderBeat(store.state.selectedMidi), 1000);
      toast('调律监听已启动');
    } else {
      if (beatTimer) clearInterval(beatTimer);
      beatTimer = null;
      await stopAudio();
      engine = null;
      toggle.textContent = '开始调律';
      renderReadout(null, store.state.selectedMidi);
    }
  });

  let beatTimer: ReturnType<typeof setInterval> | null = null;

  // 切换键位：更新引擎目标并切换演示音源
  const unsub = store.subscribe((s) => {
    const midi = s.selectedMidi;
    keyBox.querySelectorAll('.key-chip').forEach((c, i) => {
      c.classList.toggle('active', indexToMidi(i) === midi);
    });
    const { target, expected } = targetsFor(midi);
    if (engine) engine.setTarget(target, expected);
    renderReadout(null, midi);
    if (running && s.settings.demoMode) {
      void startAudio((frame, sr) => {
        const reading = engine!.pushBlock(frame, sr);
        if (reading && mode === 'single') renderReadout(reading, midi);
      }, expected, typicalB(midi));
    }
  });

  root.addEventListener('view-cleanup', () => {
    unsub();
    if (beatTimer) clearInterval(beatTimer);
    void stopAudio();
  });
}

function buildMeterTicks(): Node[] {
  const nodes: Node[] = [el('div', { class: 'scale-line' }), el('div', { class: 'needle' })];
  for (const cents of [-50, -30, -10, 10, 30, 50]) {
    const pct = 50 + (cents / 50) * 45;
    nodes.push(el('div', { class: 'tick', style: `left:${pct}%` }));
    nodes.push(el('div', { class: 'cents-label', style: `left:${pct}%` }, String(cents)));
  }
  return nodes;
}
