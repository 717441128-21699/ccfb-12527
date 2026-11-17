import './styles.css';
import { listPianos } from '../core/storage';
import { TEMPERAMENTS } from '../core/temperament';
import { store } from './store';
import { renderPianosView } from './views/pianos';
import { renderMeasureView } from './views/measure/measure';
import { renderStretchView } from './views/stretch/stretch';
import { renderTuneView } from './views/tune/tune';
import { renderRecordsView } from './views/records/records';
import { stopAudio } from './audio-session';

const viewRoots: Record<string, HTMLElement> = {
  pianos: document.getElementById('view-pianos')!,
  measure: document.getElementById('view-measure')!,
  stretch: document.getElementById('view-stretch')!,
  tune: document.getElementById('view-tune')!,
  records: document.getElementById('view-records')!,
};

const renderers: Record<string, (root: HTMLElement) => void> = {
  pianos: renderPianosView,
  measure: renderMeasureView,
  stretch: renderStretchView,
  tune: renderTuneView,
  records: renderRecordsView,
};

let activeView = 'pianos';

function switchView(name: string): void {
  if (name === activeView) return;
  // 离开旧视图：清理音频与订阅
  viewRoots[activeView].dispatchEvent(new CustomEvent('view-cleanup'));
  void stopAudio();
  activeView = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', (t as HTMLElement).dataset.view === name));
  Object.entries(viewRoots).forEach(([key, root]) => root.classList.toggle('active', key === name));
  renderers[name](viewRoots[name]);
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchView((tab as HTMLElement).dataset.view!));
});

// 顶部全局控件
function initGlobalControls(): void {
  const temperSelect = document.getElementById('temperament-select') as HTMLSelectElement;
  for (const t of TEMPERAMENTS) {
    temperSelect.append(new Option(t.name, t.id));
  }
  const a4Input = document.getElementById('a4-input') as HTMLInputElement;
  const octaveSelect = document.getElementById('octave-select') as HTMLSelectElement;
  const demoToggle = document.getElementById('demo-toggle') as HTMLInputElement;

  // 设置变化 → store
  a4Input.addEventListener('change', () => {
    const v = Number(a4Input.value);
    if (v >= 420 && v <= 460) void store.updateSettings({ a4: v });
  });
  temperSelect.addEventListener('change', () => void store.updateSettings({ temperamentId: temperSelect.value }));
  octaveSelect.addEventListener('change', () => void store.updateSettings({ octaveType: octaveSelect.value as '4:2' | '6:3' | '2:1' }));
  demoToggle.addEventListener('change', () => void store.updateSettings({ demoMode: demoToggle.checked }));

  // store → 控件（初始化与外部更新同步）
  store.subscribe((s) => {
    a4Input.value = String(s.settings.a4);
    temperSelect.value = s.settings.temperamentId;
    octaveSelect.value = s.settings.octaveType;
    demoToggle.checked = s.settings.demoMode;
  });
}

async function bootstrap(): Promise<void> {
  initGlobalControls();
  const pianos = await listPianos();
  await store.init(pianos);
  renderers.pianos(viewRoots.pianos);
}

void bootstrap();
