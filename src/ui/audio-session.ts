/**
 * 音频会话管理：根据全局「演示模式」开关创建麦克风或演示引擎，
 * 维护唯一的活动引擎，切换信号源/键位时安全重建。
 */

import { createDemoEngine, createMicEngine, type AudioEngine, type AudioFrameHandler } from '../core/audio-engine';
import { equalTempFrequency } from '../core/notes';
import { store } from './store';

let engine: AudioEngine | null = null;
let unsub: (() => void) | null = null;
let running = false;

export function isAudioRunning(): boolean {
  return running;
}

/**
 * 启动音频并把帧交给 handler。
 * @param demoF0 演示模式下的合成基频（一般取当前键的平均律频率）
 * @param demoB  演示模式下的合成非谐系数
 */
export async function startAudio(
  handler: AudioFrameHandler,
  demoF0: number,
  demoB: number,
  demoDetunes?: number[] | null,
): Promise<void> {
  await stopAudio();
  const demo = store.state.settings.demoMode;
  if (demo) {
    engine = createDemoEngine({ f1: demoF0, B: demoB, detunes: demoDetunes ?? null });
  } else {
    engine = await createMicEngine();
  }
  unsub = engine.subscribe(handler);
  running = true;
}

export async function stopAudio(): Promise<void> {
  if (unsub) unsub();
  unsub = null;
  if (engine) engine.stop();
  engine = null;
  running = false;
}

/** 演示模式下给当前键一个合理的默认 B（沿键盘指数变化的典型值） */
export function typicalB(midi: number): number {
  // 近似：A0 ~ 8e-5 到 C8 ~ 8e-3 的指数曲线
  const alpha = Math.log(8e-5);
  const beta = (Math.log(8e-3) - Math.log(8e-5)) / (108 - 21);
  return Math.exp(alpha + beta * (midi - 21));
}

export function nominalF0(midi: number): number {
  return equalTempFrequency(midi, store.state.settings.a4);
}
