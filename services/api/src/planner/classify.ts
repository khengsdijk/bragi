/**
 * Cheap request classification (06 §4): model tier, song-wide intent and explain intent.
 *
 * Deliberately deterministic and small. The tier only picks a model; the song-wide bit gates
 * `scope: "song"` in the validator (06 §7), so a false positive is visible to the user in the
 * variant's description rather than silent.
 */
import type { PlanRequest, Region } from "@bragi/schemas";

import type { PlannerTier } from "./config.js";

/** Words that usually mean "generate something new", which is not a fast mix/fx edit. */
const GENERATION_VERBS = [
  "generate",
  "create",
  "compose",
  "write",
  "record",
  "re-record",
  "rerecord",
  "add a part",
  "add a new",
  "new part",
  "new section",
  "add strings",
  "add drums",
  "add vocals",
  "extend",
  "remix",
  "resing",
  "re-sing",
];

/** Phrases that ask for a whole-song change (06 §7). */
const SONG_WIDE = [
  "whole song",
  "whole track",
  "entire song",
  "entire track",
  "full song",
  "song-wide",
  "song wide",
  "everywhere",
  "all tracks",
  "all sections",
  "every section",
  "every track",
  "throughout",
  "the whole arrangement",
  "entire arrangement",
];

/** Phrases that ask for an explanation instead of a plan (06 §8). */
const EXPLAIN = ["why", "what is", "what's", "explain", "how come", "what happened"];

/**
 * Section-editing verbs (06 §7). A structural op changes the song's structure and the validator
 * requires `scope: "song"`, so a request that rearranges sections counts as song-wide even when it
 * does not say "whole song": "remove the second verse", "shorten the intro".
 */
const ARRANGEMENT_VERBS = [
  "remove",
  "delete",
  "duplicate",
  "move",
  "rename",
  "shorten",
  "lengthen",
  "extend",
  "loop",
  "join",
  "merge",
  "split",
  "reorder",
];

/** The objects those verbs rearrange. */
const ARRANGEMENT_NOUNS = [
  "section",
  "sections",
  "verse",
  "chorus",
  "bridge",
  "intro",
  "outro",
  "arrangement",
];

/** "two bars longer", "4 bars shorter". */
const BAR_CHANGE = /\b(?:\d+|one|two|three|four|eight)\s+bars?\s+(?:longer|shorter)\b/i;

/** The classification the planner and validator use. */
export interface Classification {
  tier: PlannerTier;
  songWideIntent: boolean;
  explainIntent: boolean;
  generationIntent: boolean;
}

/** Classifies one request. */
export function classify(request: PlanRequest): Classification {
  const prompt = request.prompt.toLowerCase();
  const explainIntent = request.explain === true || containsPhrase(prompt, EXPLAIN);
  const generationIntent = containsPhrase(prompt, GENERATION_VERBS);
  return {
    tier: explainIntent
      ? "explain"
      : !generationIntent && fewTracks(request.region)
        ? "fast"
        : "smart",
    songWideIntent: containsPhrase(prompt, SONG_WIDE) || arrangementIntent(prompt),
    explainIntent,
    generationIntent,
  };
}

/** True when the prompt asks for the whole song (used to allow `scope: "song"`). */
export function hasSongWideIntent(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return containsPhrase(lower, SONG_WIDE) || arrangementIntent(lower);
}

/**
 * True when the prompt rearranges sections: a section verb near a section noun, or an explicit
 * "two bars longer". Deliberately errs towards allowing song scope: a false positive only lets
 * the model declare an intent the user can see, while a false negative rejects every structural
 * plan (06 §7).
 */
export function arrangementIntent(prompt: string): boolean {
  if (BAR_CHANGE.test(prompt)) return true;
  const verb = ARRANGEMENT_VERBS.join("|");
  const noun = ARRANGEMENT_NOUNS.join("|");
  const forward = new RegExp(`\\b(?:${verb})\\b[^.!?]{0,40}\\b(?:${noun})\\b`, "i");
  const backward = new RegExp(`\\b(?:${noun})\\b[^.!?]{0,40}\\b(?:${verb})\\b`, "i");
  return forward.test(prompt) || backward.test(prompt);
}

/** True when the prompt looks like a question about the song. */
export function hasExplainIntent(prompt: string): boolean {
  return containsPhrase(prompt.toLowerCase(), EXPLAIN);
}

/** A region that targets at most one track (06 §4's `fast` heuristic). */
function fewTracks(region: Region | undefined): boolean {
  if (region === undefined || region.tracks === "all") return false;
  return region.tracks.length <= 1;
}

/** Whole-word/phrase matching, so "why" does not fire inside "showy". */
function containsPhrase(text: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i").test(text);
  });
}
