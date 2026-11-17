/**
 * 麦克风采集层（Web Audio API）。
 *
 * 设计：
 * - AudioWorklet 逐块累积到离线缓冲，录满指定时长后一次性返回 Float32Array，
 *   避免 ScriptProcessorNode 的主线程卡顿与弃用问题。
 * - 约束单声道、指定采样率（48k）；浏览器不支持精确采样率时返回实际值，
 *   由调用方决定是否接受（检测算法按实际 fs 工作，但基线要求 fs 一致）。
 * - 提供实时 RMS 表，方便操作员确认麦克风增益与安装距离正常。
 */

export interface RecordingResult {
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
  /** 全程峰值（绝对幅度），用于削波诊断 */
  peak: number;
  rms: number;
}

export interface RecordOptions {
  durationSec: number;
  sampleRate?: number;
  echoCancellation?: boolean; // 工业测量应关闭语音处理
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  onLevel?: (rms: number, peak: number) => void;
}

export class MicRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private fallbackProcessor: ScriptProcessorNode | null = null;

  /** 实际生效的采样率（未开始录音时为 null） */
  get activeSampleRate(): number | null {
    return this.ctx ? this.ctx.sampleRate : null;
  }

  async dispose(): Promise<void> {
    this.node?.disconnect();
    this.fallbackProcessor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.node = null;
    this.fallbackProcessor = null;
  }

  async record(opts: RecordOptions): Promise<RecordingResult> {
    const targetRate = opts.sampleRate ?? 48000;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: targetRate,
        echoCancellation: opts.echoCancellation ?? false,
        noiseSuppression: opts.noiseSuppression ?? false,
        autoGainControl: opts.autoGainControl ?? false,
      },
    });

    this.ctx = new AudioContext({ sampleRate: targetRate });
    const sr = this.ctx.sampleRate;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    const total = Math.floor(sr * opts.durationSec);
    const buffer = new Float32Array(total);
    let offset = 0;
    let runningPeak = 0;
    let runningSq = 0;
    let runningCount = 0;

    const ingest = (chunk: Float32Array) => {
      const remain = total - offset;
      const take = Math.min(remain, chunk.length);
      if (take > 0) buffer.set(chunk.subarray(0, take), offset);
      for (let i = 0; i < take; i++) {
        const v = chunk[i];
        const a = Math.abs(v);
        if (a > runningPeak) runningPeak = a;
        runningSq += v * v;
      }
      runningCount += take;
      offset += take;
      if (opts.onLevel && runningCount > 0) {
        opts.onLevel(Math.sqrt(runningSq / runningCount), runningPeak);
      }
    };

    // 优先 AudioWorklet；内联 worklet 代码，避免额外静态资源路径配置
    try {
      const workletCode = `
        class RecorderProcessor extends AudioWorkletProcessor {
          process(inputs) {
            const ch = inputs[0]?.[0];
            if (ch && ch.length) this.port.postMessage(ch.slice(0), [ch.buffer]);
            return true;
          }
        }
        registerProcessor("recorder-processor", RecorderProcessor);
      `;
      const blob = new Blob([workletCode], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      try {
        await this.ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      await new Promise<void>((resolve, reject) => {
        if (!this.ctx || !this.source) return reject(new Error("音频上下文已释放"));
        const node = new AudioWorkletNode(this.ctx, "recorder-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 0,
        });
        this.node = node;
        node.port.onmessage = (e: MessageEvent<Float32Array>) => ingest(e.data);
        this.source.connect(node);
        setTimeout(() => resolve(), opts.durationSec * 1000 + 50);
      });
    } catch {
      // 退化路径：ScriptProcessor（已弃用但兼容性最广，离线缓冲不涉及播放）
      await new Promise<void>((resolve) => {
        if (!this.ctx || !this.source) return resolve();
        const sp = this.ctx.createScriptProcessor(4096, 1, 1);
        this.fallbackProcessor = sp;
        sp.onaudioprocess = (e) => ingest(e.inputBuffer.getChannelData(0));
        this.source.connect(sp);
        sp.connect(this.ctx.destination); // 不发声，仅满足 API 图要求
        setTimeout(() => resolve(), opts.durationSec * 1000 + 50);
      });
    }

    const samples = buffer.subarray(0, Math.min(offset, total));
    const rms = runningCount > 0 ? Math.sqrt(runningSq / runningCount) : 0;
    const result: RecordingResult = {
      samples: Float32Array.from(samples),
      sampleRate: sr,
      durationSec: samples.length / sr,
      peak: runningPeak,
      rms,
    };
    await this.dispose();
    return result;
  }
}
