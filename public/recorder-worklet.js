/**
 * AudioWorklet：把麦克风流切成固定长度块投递给主线程。
 * 静态资源（public/），由 audioWorklet.addModule 直接加载，
 * 不参与打包、不能引用项目其他模块。
 */
class PianoRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 约 93ms@48k，兼顾频率分析稳定性与界面刷新节奏
    this.blockSize = 4096;
    this.buffer = new Float32Array(this.blockSize);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.offset++] = channel[i];
      if (this.offset >= this.blockSize) {
        this.port.postMessage(this.buffer.slice(0));
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('piano-recorder', PianoRecorderProcessor);
