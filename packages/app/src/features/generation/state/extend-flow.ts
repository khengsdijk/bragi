/**
 * One `generate.extend` request end to end (09 §4.2, §5; 07 §4.2, §6).
 *
 * WP-2.8 moved the shared plumbing (context render → upload → submit → partials → candidates →
 * accept → HQ + analysis → cancel) into `generation-session.ts`; this module is the extend
 * capability's entry point and keeps WP-2.7's public surface: the constants, request type, state
 * type and the adapter that places a finished candidate as a new section.
 *
 * Plain TypeScript over injected clients, so the whole flow is testable with a fake API, a fake
 * socket and a fake engine render.
 */
import {
  createGenerationFlow,
  type GenerationDependencies,
  type GenerationFlow,
  type GenerationState,
  generationErrorMessage,
  type WarmupStatus,
} from "./generation-session.js";
import { createExtendAdapter, type ExtendRequest } from "./adapters/extend.js";

export {
  CONTEXT_SECONDS,
  CROSSFADE_MAX_SEC,
  DEFAULT_EXTEND_BARS,
  EXTEND_BARS,
  EXTEND_CANDIDATES,
  OVERLAP_BARS,
  type ExtendBarCount,
  type ExtendDirection,
  type ExtendRequest,
} from "./adapters/extend.js";

/** The handle's view of the flow. */
export type ExtendState = GenerationState;

/** The extend flow's dependencies: the shared ones. */
export type ExtendFlowDependencies = GenerationDependencies;

/** The extend handle's controller. */
export type ExtendFlow = GenerationFlow<ExtendRequest>;

/** A plain-language message for a generation failure (09 §5, 05 §2). */
export const extendErrorMessage = generationErrorMessage;

/** Creates the extend flow: the shared session with the extend adapter. */
export function createExtendFlow(deps: ExtendFlowDependencies): ExtendFlow {
  return createGenerationFlow(deps, createExtendAdapter());
}

/** Kept for callers that import the warm-up type from here. */
export type { WarmupStatus };
