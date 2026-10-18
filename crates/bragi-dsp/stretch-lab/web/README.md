# WP-0.4 AudioWorklet test page

Proof that the `bragi-dsp` stretcher builds for `wasm32-unknown-unknown` and runs inside an
AudioWorklet. It is not shipping glue (that is WP-1.1); it is the acceptance-#3 harness.

```
index.html    loads the wasm, renders fixtures/audio/drums_120.wav through an AudioWorkletNode
              in an OfflineAudioContext, checks length/finiteness/hit timing, exposes window.__result
processor.js  the AudioWorkletProcessor: pv_new / pv_configure / pv_input_required / pv_process
build.mjs     cargo wasm build + copy the .wasm next to the page
run.mjs       static server + headless Chrome over raw CDP (Node's built-in WebSocket, no npm deps)
```

Run it:

```sh
node crates/bragi-dsp/stretch-lab/web/run.mjs
```

`run.mjs` builds the wasm if needed, serves `web/` and `fixtures/audio/`, launches
`--headless=new` Chrome (override with `CHROME_PATH`), and exits non-zero unless the page reports
`ok: true`. The currently-open page result:

```json
{ "ratio": 1.12, "srcFrames": 192000, "latency": 1024, "expectedFrames": 216064,
  "renderedFrames": 220160, "channels": 2, "finite": true, "peak": 0.89, "rms": 0.107,
  "worstTimingMs": 3.67, "hits": 7, "ok": true }
```

The wasm module is compiled on the main thread and handed to the processor via
`processorOptions.module`, so the audio thread only does a synchronous `new WebAssembly.Instance`.
The worklet reads from the posted source buffer, not the graph input, because the offline render
has no live input — the point is the wasm pull loop, not a full engine.

Per [03 §11](../../../../specs/03-audio-engine.md) the wasm and native output should null to
≤ −90 dBFS; that full null test is WP-1.1's engine-conformance job. Here the page checks the
output is finite, non-silent, the right length, and that the drum hits land where
`latency + ratio·t` says (within one envelope window).
