/**
 * Smooth with AI: the shared generation session with the `generate.transition` adapter (09 §4.4).
 *
 * The chip on a moved boundary (07 §4.1) calls `start` with the incoming section and a 1- or 2-bar
 * bridge; on Accept the section's `transitionIn` becomes `generated` with the candidate's asset.
 */
import {
  createGenerationFlow,
  type GenerationDependencies,
  type GenerationFlow,
} from "./generation-session.js";
import { createTransitionAdapter, type SmoothRequest } from "./adapters/transition.js";

export {
  DEFAULT_SMOOTH_BARS,
  SMOOTH_BARS,
  SMOOTH_CANDIDATES,
  SMOOTH_CONTEXT_BARS,
  type SmoothBarCount,
  type SmoothRequest,
} from "./adapters/transition.js";

export type SmoothFlow = GenerationFlow<SmoothRequest>;

export function createSmoothFlow(deps: GenerationDependencies): SmoothFlow {
  return createGenerationFlow(deps, createTransitionAdapter());
}
