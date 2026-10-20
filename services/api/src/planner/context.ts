/**
 * The user message the planner sends (06 §2, §4, §7).
 *
 * Three blocks: the deterministic song summary, the capability catalogue, then the user's words
 * inside `<user_request>…</user_request>`. Everything analysis-derived is escaped and quoted as
 * data, so instructions in a track name, lyric or filename cannot close the block (prompt
 * injection, 06 §7).
 */
import type { Project, Region } from "@bragi/schemas";

import { type CapabilityCatalogue, catalogueText } from "./catalogue.js";
import { PlannerUnavailableError } from "./openrouter.js";
import { loadModelWasm } from "./wasm.js";

/** What the summariser is asked to focus on (06 §2). */
export interface SummaryFocus {
  region?: Region;
  selectedTrackIds: string[];
  selectedSectionIds: string[];
}

/** The seam over `summarize_for_llm`; tests pass a fake, WP-2.7's build fills in the real one. */
export interface Summarizer {
  summarize(doc: Project, focus: SummaryFocus): Promise<string>;
}

/** The opening delimiter of the untrusted user block. */
export const USER_REQUEST_OPEN = "<user_request>";
/** The closing delimiter of the untrusted user block. */
export const USER_REQUEST_CLOSE = "</user_request>";

/** The real summariser: `summarizeForLlm` from the same WASM build the app uses (06 §2). */
export function createWasmSummarizer(): Summarizer {
  return {
    async summarize(doc: Project, focus: SummaryFocus): Promise<string> {
      const model = await loadModelWasm();
      const candidate = (model as unknown as Record<string, unknown>).summarizeForLlm;
      if (typeof candidate !== "function") {
        throw new PlannerUnavailableError(
          "This @bragi/model-wasm build has no summarizeForLlm export, so the planner cannot summarise the song. Rebuild the package after WP-2.6 task A lands.",
        );
      }
      const summarize = candidate as (handle: number, focusJson: string) => unknown;
      const handle = model.loadProject(JSON.stringify(doc));
      try {
        const summary = summarize(handle, JSON.stringify(focus));
        if (typeof summary !== "string") {
          throw new PlannerUnavailableError("summarizeForLlm returned a non-string summary");
        }
        return summary;
      } finally {
        model.freeDoc(handle);
      }
    },
  };
}

/** Neutralises `<` and `>` so user text cannot open or close a data block (06 §7). */
export function escapeUserText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "\u2039").replaceAll(">", "\u203A");
}

/** The complete user message. The stable catalogue sits before the untrusted block. */
export function buildUserMessage(input: {
  summary: string;
  prompt: string;
  catalogue?: CapabilityCatalogue;
}): string {
  return [
    "SONG AND ANALYSIS",
    input.summary.trim(),
    "",
    "CAPABILITIES (IDs and numeric ranges only; no generation capability is offered)",
    catalogueText(input.catalogue),
    "",
    USER_REQUEST_OPEN,
    escapeUserText(input.prompt),
    USER_REQUEST_CLOSE,
  ].join("\n");
}
