/**
 * What an audition candidate's badge says (07 §6): `queued`, `generating n%`, `preview` or `HQ`.
 *
 * The status comes from job events (`JobEvent`, 05 §4.3) through a {@link CandidateSource}. The
 * planner (WP-2.6) and the generator (WP-2.7) plug real jobs in; until then the tests drive it.
 */
import type { JobEvent } from "@bragi/schemas";

export type CandidateStatus =
  | { readonly kind: "queued" }
  | { readonly kind: "generating"; readonly pct: number }
  | { readonly kind: "preview" }
  | { readonly kind: "hq" }
  | { readonly kind: "failed" };

/** Maps one job event onto the candidate's badge. */
export function statusFromJobEvent(event: JobEvent): CandidateStatus {
  switch (event.type) {
    case "started":
      return { kind: "generating", pct: 0 };
    case "progress":
      return { kind: "generating", pct: Math.max(0, Math.min(1, event.pct ?? 0)) };
    case "partial":
      return { kind: "preview" };
    case "completed":
      return { kind: "hq" };
    case "failed":
      return { kind: "failed" };
  }
}

/** Whether a candidate has audio to play (a preview or the HQ render). */
export function isPlayable(status: CandidateStatus): boolean {
  return status.kind === "preview" || status.kind === "hq";
}

/**
 * Where candidate job events come from. `moreLike` exists only when the source can generate
 * more candidates seeded from one (07 §6); the bar hides "More like this" otherwise.
 */
export interface CandidateSource {
  /** Job events for the candidates of `group`, keyed by candidate (commit) id. */
  subscribe(group: string, listener: (candidateId: string, event: JobEvent) => void): () => void;
  readonly moreLike?: (candidateId: string) => void;
}
