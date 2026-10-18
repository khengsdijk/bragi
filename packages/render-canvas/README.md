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

**Status:** scaffold only. Filled by **WP-1.9**, against the frame budgets in
[07 §9](../../specs/07-song-canvas.md).
