/**
 * `@bragi/render-canvas`: the Song Canvas renderer (07 §9). Framework-agnostic (13 §3): React
 * mounts it from `packages/app` and passes data in; it answers with events and never imports
 * React.
 *
 * The pure modules (viewport, selection, geometry, layout, progressive states, palette) have no
 * GPU dependency and are unit-tested in Node. {@link SongCanvas} is the PixiJS stage on top.
 */
export const PACKAGE_NAME = "@bragi/render-canvas";

export * from "./drag.js";
export * from "./geometry.js";
export * from "./layout.js";
export * from "./palette.js";
export * from "./progressive.js";
export * from "./selection.js";
export {
  type CanvasStats,
  type CanvasStrings,
  meanOfCurve,
  SongCanvas,
  type SongCanvasOptions,
} from "./song-canvas.js";
export * from "./types.js";
export * from "./viewport.js";
