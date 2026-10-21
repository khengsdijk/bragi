/**
 * Fill gap with AI: the shared generation session with the `generate.inpaint` adapter (09 §4.3).
 *
 * The chip (07 §4.8) calls `start` with the erased region; the flow renders the two context sides,
 * streams candidates and, on Accept, analyses the fill so its stems land in the gap.
 */

import { createFillAdapter, type FillGapRequest } from "./adapters/inpaint.js";
import {
  createGenerationFlow,
  type GenerationDependencies,
  type GenerationFlow,
} from "./generation-session.js";

export {
  FILL_CANDIDATES,
  FILL_CONTEXT_SECONDS,
  FILL_OVERLAP_BARS,
  type FillGapRequest,
} from "./adapters/inpaint.js";

export type FillGapFlow = GenerationFlow<FillGapRequest>;

export function createFillGapFlow(deps: GenerationDependencies): FillGapFlow {
  return createGenerationFlow(deps, createFillAdapter());
}
