// AudioWorkletProcessor that drives the WP-0.4 wasm shim (`bragi_stretch_worklet.wasm`).
//
// The whole source clip is posted in, and the processor pulls the stretcher exactly the way the
// engine does: `pv_input_required` then `pv_process`. The wasm module is compiled on the main
// thread and handed over via `processorOptions.module`, so no async work happens on the audio
// thread.

class StretchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions || {};
    this.ratio = opts.ratio ?? 1.12;
    this.semitones = opts.semitones ?? 0;
    this.quality = opts.quality ?? 0;
    this.source = null;
    this.ready = false;
    this.done = false;
    this.channels = 0;
    this.inPos = 0;
    this.produced = 0;
    this.outputFrames = 0;
    try {
      this.wasm = new WebAssembly.Instance(opts.module, {}).exports;
      this.ready = true;
    } catch (err) {
      this.port.postMessage({ type: "error", message: String(err) });
    }
    if (opts.channels) this.setSource(opts.channels, opts.sampleRate ?? sampleRate);
    this.port.onmessage = (e) => {
      if (e.data.type === "source") this.setSource(e.data.channels, e.data.sampleRate);
    };
  }

  setSource(channels, sampleRate) {
    this.source = channels;
    this.channels = channels.length;
    this.handle = this.wasm.pv_new(this.channels, sampleRate);
    const _rc = this.wasm.pv_configure(this.handle, this.ratio, this.semitones, this.quality);
    this.latency = this.wasm.pv_latency(this.handle);
    const srcFrames = channels[0].length;
    this.outputFrames = this.latency + Math.floor(srcFrames * this.ratio);
    // Planar scratch: worst case is one full window times the pitch factor per call.
    this.inCap = 1 << 17;
    this.outCap = 4096;
    this.inBytes = this.inCap * this.channels * 4;
    this.inPtr = this.wasm.pv_alloc(this.inBytes);
    this.outBytes = this.outCap * this.channels * 4;
    this.outPtr = this.wasm.pv_alloc(this.outBytes);
    this.port.postMessage({
      type: "source-set",
      latency: this.latency,
      outputFrames: this.outputFrames,
      channels: this.channels,
    });
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const frames = out[0].length;
    if (!this.ready || !this.source || this.done) {
      for (const c of out) c.fill(0);
      return !this.done;
    }
    if (this.produced >= this.outputFrames) {
      for (const c of out) c.fill(0);
      this.done = true;
      this.port.postMessage({ type: "done", produced: this.produced });
      return false;
    }
    const need = this.wasm.pv_input_required(this.handle, frames);
    const mem = new Float32Array(this.wasm.memory.buffer);
    const inBase = this.inPtr >> 2;
    for (let c = 0; c < this.channels; c++) {
      const src = this.source[c];
      for (let i = 0; i < need; i++) {
        const idx = this.inPos + i;
        mem[inBase + c * need + i] = idx < src.length ? src[idx] : 0;
      }
    }
    this.inPos += need;
    this.wasm.pv_process(this.handle, this.inPtr, this.outPtr, frames, this.channels);
    const outBase = this.outPtr >> 2;
    for (let c = 0; c < out.length; c++) {
      out[c].set(mem.subarray(outBase + c * frames, outBase + (c + 1) * frames));
    }
    this.produced += frames;
    return true;
  }
}

registerProcessor("stretch", StretchProcessor);
