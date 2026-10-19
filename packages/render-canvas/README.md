# @bragi/render-canvas

The PixiJS v8 renderers for the Song Canvas: skyline, section blocks, harmony strip, stem ribbons,
beat grid, playhead and the Moment view ([07-song-canvas.md](../../specs/07-song-canvas.md)).

Rules:

- **Framework-agnostic classes.** This package never imports React
  ([13 §3](../../specs/13-agent-guide.md)); React mounts a renderer and passes it data.
- **WebGPU with an automatic WebGL2 fallback.** Every renderer must work on WebGL2 — Linux
  WebKitGTK may have no WebGPU at all ([01 §1, §3](../../specs/01-architecture.md)), and visual
  regression runs with WebGPU on and off.
- Whatever is drawn on the canvas also exists in the accessible DOM
  ([11 §6.1](../../specs/11-ux-and-accessibility.md)).

**Status:** built by **WP-1.9** (see [`docs/wp/1.9.md`](../../docs/wp/1.9.md)).

## Surface

```ts
const canvas = await SongCanvas.create({ container, palette, strings, renderer: "webgl" /* optional */ });
canvas.setDocument(canvasDocument);   // sections, tracks, clips, beat times (seconds)
canvas.setAnalysis(analysisView);     // stage statuses + energy/chords/ribbons as they arrive
canvas.setSelection(selection); canvas.setPlayhead(sec); canvas.setMeters({ trk_a: 0.4 });
canvas.on("trackToggle", ({ trackId, field, value }) => { /* build a track.update batch */ });
```

The pure modules (`viewport`, `selection`, `geometry`, `layout`, `progressive`, `palette`) have no
GPU dependency and are unit-tested in Node; `SongCanvas` is the Pixi stage on top. Colours come from
the design tokens (CSS variables or `tokens.json`), never restated here. Types for the data-in
contract are in `src/types.ts`; WP-1.10 maps analysis results onto `AnalysisView`.
