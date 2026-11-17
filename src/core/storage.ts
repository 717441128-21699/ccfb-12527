/**
 * 本地持久化（IndexedDB）。
 *
 * 三个对象库：
 *  - pianos    钢琴档案（型号、类型、序列号、备注）
 *  - sessions  每次上门的工作记录（关联 pianoId，含逐音测量与目标频率）
 *  - settings  全局设置（A4 参考频率、律制、八度类型等）
 *
 * 所有数据只存浏览器本地，不上传。
 */

export interface PianoProfile {
  id: string;
  brand: string;
  model: string;
  /** 立式 / 三角 / 其他 */
  kind: 'upright' | 'grand' | 'other';
  serial?: string;
  location?: string;
  notes?: string;
  createdAt: number;
}

export interface KeyMeasurement {
  midi: number;
  B: number;
  fundamental: number;
  r2: number;
  measuredAt: number;
}

export interface WorkSession {
  id: string;
  pianoId: string;
  date: number;
  temperamentId: string;
  octaveType: '4:2' | '6:3' | '2:1';
  a4: number;
  /** 本次测到的样本音 */
  measurements: KeyMeasurement[];
  /** 拉伸模型参数 */
  stretchModel?: { alpha: number; beta: number };
  /** 调律后的抽检记录（音分偏差） */
  tuningChecks?: { midi: number; cents: number; at: number }[];
  notes?: string;
}

const DB_NAME = 'piano-tuner-db';
const DB_VERSION = 1;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('pianos')) {
        const s = db.createObjectStore('pianos', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('pianoId', 'pianoId');
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

// —— 钢琴档案 —— //

export async function savePiano(p: PianoProfile): Promise<void> {
  await tx('pianos', 'readwrite', (s) => s.put(p));
}

export async function deletePiano(id: string): Promise<void> {
  await tx('pianos', 'readwrite', (s) => s.delete(id));
  // 连带删除该琴的工作记录
  const sessions = await listSessions(id);
  await Promise.all(sessions.map((sess) => tx('sessions', 'readwrite', (s) => s.delete(sess.id))));
}

export async function listPianos(): Promise<PianoProfile[]> {
  const all = await tx<PianoProfile[]>('pianos', 'readonly', (s) => s.getAll() as IDBRequest<PianoProfile[]>);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

// —— 工作记录 —— //

export async function saveSession(sess: WorkSession): Promise<void> {
  await tx('sessions', 'readwrite', (s) => s.put(sess));
}

export async function listSessions(pianoId?: string): Promise<WorkSession[]> {
  const all = await tx<WorkSession[]>('sessions', 'readonly', (s) => s.getAll() as IDBRequest<WorkSession[]>);
  const filtered = pianoId ? all.filter((s) => s.pianoId === pianoId) : all;
  return filtered.sort((a, b) => b.date - a.date);
}

/**
 * 季节性漂移分析：对同一台琴、同一个 midi 键，汇总历次测量的
 * 基频相对名义频率的音分偏差，按时间排序。
 */
export interface DriftPoint {
  date: number;
  midi: number;
  cents: number;
  B: number;
}

export async function driftHistory(pianoId: string, midi: number): Promise<DriftPoint[]> {
  const sessions = await listSessions(pianoId);
  const points: DriftPoint[] = [];
  for (const sess of sessions) {
    const m = sess.measurements.find((x) => x.midi === midi);
    if (!m) continue;
    const nominal = 440 * Math.pow(2, (midi - 69) / 12);
    points.push({
      date: sess.date,
      midi,
      cents: (1200 / Math.LN2) * Math.log(m.fundamental / nominal),
      B: m.B,
    });
  }
  return points.sort((a, b) => a.date - b.date);
}

// —— 设置 —— //

export interface AppSettings {
  a4: number;
  temperamentId: string;
  octaveType: '4:2' | '6:3' | '2:1';
  demoMode: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  a4: 440,
  temperamentId: 'equal',
  octaveType: '4:2',
  demoMode: true,
};

export async function loadSettings(): Promise<AppSettings> {
  try {
    const row = await tx<{ key: string; value: AppSettings } | undefined>(
      'settings',
      'readonly',
      (s) => s.get('app') as IDBRequest<{ key: string; value: AppSettings } | undefined>,
    );
    return row ? { ...DEFAULT_SETTINGS, ...row.value } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(value: AppSettings): Promise<void> {
  await tx('settings', 'readwrite', (s) => s.put({ key: 'app', value }));
}
