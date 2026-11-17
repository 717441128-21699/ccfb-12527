/**
 * 标准 88 键钢琴键盘映射（A0 = MIDI 21 … C8 = MIDI 108）。
 * 内部一律以 midi 号表示键；index = midi - 21，范围 0..87。
 */

export const FIRST_MIDI = 21; // A0
export const LAST_MIDI = 108; // C8
export const KEY_COUNT = LAST_MIDI - FIRST_MIDI + 1; // 88
export const A4_MIDI = 69;

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToIndex(midi: number): number {
  return midi - FIRST_MIDI;
}

export function indexToMidi(index: number): number {
  return index + FIRST_MIDI;
}

export function isMidiOnKeyboard(midi: number): boolean {
  return midi >= FIRST_MIDI && midi <= LAST_MIDI;
}

/** 如 "A4"、"C#5" */
export function midiToName(midi: number): string {
  const name = NAMES[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

export function nameToMidi(name: string): number {
  const m = /^([A-G]#?)(-?\d+)$/.exec(name.trim());
  if (!m) throw new Error(`无法识别的音名: ${name}`);
  const cls = NAMES.indexOf(m[1]);
  const octave = parseInt(m[2], 10);
  return (octave + 1) * 12 + cls;
}

/** 音名中的音级 0..11（C=0），用于按律制查表 */
export function pitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

/** 平均律下的名义频率（A4 参考频率可调，默认 440Hz） */
export function equalTempFrequency(midi: number, a4 = 440): number {
  return a4 * Math.pow(2, (midi - A4_MIDI) / 12);
}
