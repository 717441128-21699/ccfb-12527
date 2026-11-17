/**
 * 音频采集引擎。
 *
 * 两种信号源：
 *  - 麦克风：getUserMedia + AudioWorklet 逐块回调，输出 Float32 帧；
 *  - 演示模式：用合成器周期性生成带非谐性的钢琴音，无需麦克风即可全流程演练。
 *
 * 对外只暴露统一的 subscribe(cb) 接口，业务层不关心信号来源。
 */

import { synthesizePianoTone } from './synth';

export type AudioFrameHandler = (frame: Float32Array, sampleRate: number) => void;

export interface AudioEngine {
  readonly sampleRate: number;
  subscribe(handler: AudioFrameHandler): () => void;
  stop(): void;
}

/** 麦克风采集引擎 */
class MicEngine implements AudioEngine {
  readonly sampleRate: number;
  private ctx: AudioContext;
  private node: AudioWorkletNode;
  private stream: MediaStream;
  private handlers = new Set<AudioFrameHandler>();

  private constructor(ctx: AudioContext, node: AudioWorkletNode, stream: MediaStream) {
    this.ctx = ctx;
    this.node = node;
    this.stream = stream;
    this.sampleRate = ctx.sampleRate;
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      for (const h of this.handlers) h(e.data, ctx.sampleRate);
    };
  }

  static async create(): Promise<MicEngine> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', document.baseURI).toString());
    const node = new AudioWorkletNode(ctx, 'piano-recorder');
    const source = ctx.createMediaStreamSource(stream);
    source.connect(node);
    return new MicEngine(ctx, node, stream);
  }

  subscribe(handler: AudioFrameHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  stop(): void {
    this.handlers.clear();
    this.node.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());
    void this.ctx.close();
  }
}

export interface DemoEngineOptions {
  f1: number;
  B: number;
  /** 每次鸣响的间隔（秒） */
  interval?: number;
  /** 三弦失谐比例（演示齐音用），null 表示完全齐 */
  detunes?: number[] | null;
  noiseLevel?: number;
}

/** 演示引擎：用合成音模拟周期性弹奏，按真实时间节奏分块投递 */
class DemoEngine implements AudioEngine {
  readonly sampleRate: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private handlers = new Set<AudioFrameHandler>();
  private opts: Required<Omit<DemoEngineOptions, 'detunes'>> & { detunes: number[] | null };

  constructor(opts: DemoEngineOptions) {
    this.sampleRate = 48000;
    this.opts = {
      f1: opts.f1,
      B: opts.B,
      interval: opts.interval ?? 2.5,
      detunes: opts.detunes ?? null,
      noiseLevel: opts.noiseLevel ?? 0.002,
    };
  }

  start(): void {
    const block = 4096;
    const blockSeconds = block / this.sampleRate;

    const scheduleOne = () => {
      if (this.stopped) return;
      const { f1, B, detunes, noiseLevel } = this.opts;
      const signal = synthesizePianoTone({
        f1,
        B,
        sampleRate: this.sampleRate,
        duration: this.opts.interval,
        noiseLevel,
        strings: detunes
          ? detunes.map((d) => ({ gain: 1, detune: d }))
          : [{ gain: 1 }, { gain: 1 }, { gain: 1 }],
      });
      // 按块的真实时长依次投递，保持实时节奏
      let off = 0;
      const emitBlock = () => {
        if (this.stopped || off + block > signal.length) {
          this.timer = setTimeout(scheduleOne, (this.opts.interval - (off / this.sampleRate)) * 1000);
          return;
        }
        const frame = Float32Array.from(signal.subarray(off, off + block));
        for (const h of this.handlers) h(frame, this.sampleRate);
        off += block;
        this.timer = setTimeout(emitBlock, blockSeconds * 1000);
      };
      emitBlock();
    };
    scheduleOne();
  }

  subscribe(handler: AudioFrameHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.handlers.clear();
  }
}

export async function createMicEngine(): Promise<AudioEngine> {
  return MicEngine.create();
}

export function createDemoEngine(opts: DemoEngineOptions): AudioEngine {
  const engine = new DemoEngine(opts);
  engine.start();
  return engine;
}
