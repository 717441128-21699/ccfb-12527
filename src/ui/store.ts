/**
 * 应用级状态（轻量发布订阅 store）。集中管理当前钢琴、逐音测量、
 * 拉伸模型、设置与音频引擎，各视图订阅变化自行重渲染。
 */

import {
  type AppSettings,
  type KeyMeasurement,
  type PianoProfile,
  type WorkSession,
  loadSettings,
  savePiano,
  saveSession,
  saveSettings,
  uid,
} from '../core/storage';
import { fitStretchModel, type StretchModel } from '../core/stretch';

export interface AppState {
  settings: AppSettings;
  pianos: PianoProfile[];
  currentPiano: PianoProfile | null;
  /** 当前工作记录中的逐音测量，按 midi 索引 */
  measurements: Map<number, KeyMeasurement>;
  stretchModel: StretchModel | null;
  /** 当前选中的键 */
  selectedMidi: number;
}

type Listener = (state: AppState) => void;

class Store {
  state: AppState = {
    settings: {
      a4: 440,
      temperamentId: 'equal',
      octaveType: '4:2',
      demoMode: true,
    },
    pianos: [],
    currentPiano: null,
    measurements: new Map(),
    stretchModel: null,
    selectedMidi: 69,
  };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  async init(pianos: PianoProfile[]): Promise<void> {
    this.state.pianos = pianos;
    this.state.settings = await loadSettings();
    this.emit();
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<void> {
    this.state.settings = { ...this.state.settings, ...patch };
    await saveSettings(this.state.settings);
    this.emit();
  }

  selectPiano(piano: PianoProfile | null): void {
    this.state.currentPiano = piano;
    this.state.measurements = new Map();
    this.state.stretchModel = null;
    this.emit();
  }

  async upsertPiano(p: PianoProfile): Promise<void> {
    await savePiano(p);
    const idx = this.state.pianos.findIndex((x) => x.id === p.id);
    if (idx >= 0) this.state.pianos[idx] = p;
    else this.state.pianos.unshift(p);
    this.emit();
  }

  addMeasurement(m: KeyMeasurement): void {
    this.state.measurements.set(m.midi, m);
    this.rebuildStretch();
    this.emit();
  }

  removeMeasurement(midi: number): void {
    this.state.measurements.delete(midi);
    this.rebuildStretch();
    this.emit();
  }

  private rebuildStretch(): void {
    const samples = [...this.state.measurements.values()].map((m) => ({
      midi: m.midi,
      B: m.B,
      r2: m.r2,
    }));
    this.state.stretchModel = samples.length >= 2 ? fitStretchModel(samples) : null;
  }

  selectKey(midi: number): void {
    this.state.selectedMidi = midi;
    this.emit();
  }

  /** 把当前测量固化为一次工作记录 */
  async commitSession(notes?: string): Promise<WorkSession | null> {
    if (!this.state.currentPiano) return null;
    const s = this.state.settings;
    const session: WorkSession = {
      id: uid(),
      pianoId: this.state.currentPiano.id,
      date: Date.now(),
      temperamentId: s.temperamentId,
      octaveType: s.octaveType,
      a4: s.a4,
      measurements: [...this.state.measurements.values()],
      stretchModel: this.state.stretchModel
        ? { alpha: this.state.stretchModel.alpha, beta: this.state.stretchModel.beta }
        : undefined,
      notes,
    };
    await saveSession(session);
    return session;
  }
}

export const store = new Store();
