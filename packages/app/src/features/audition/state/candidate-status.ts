/**
 * What an audition candidate's badge says (07 §6): `queued`, `waiting` for a free generator,
 * `generating n%`, `preview` or `HQ`.
 *
 * The status comes from job events (`JobEvent`, 05 §4.3) through a {@link CandidateSource}. The
 * planner (WP-2.6) and the generator (WP-2.7) plug real jobs in; until then the tests drive it.
 */
import type { JobEvent } from "@bragi/schemas";

export type CandidateStatus =
  | { readonly kind: "queued"; readonly etaSec?: number }
  | { readonly kind: "generating"; readonly pct: number }
  | { readonly kind: "preview" }
  | { readonly kind: "hq" }
  | { readonly kind: "failed" };

/**
 * Maps one job event onto the candidate's badge.
 *
 * A `progress` report that has not started any work yet (pct 0) with an `etaSec` is the queue
 * estimate of 09 §5, so it reads "Waiting for a free generator… (~N s)" rather than "Generating
 * 0%". Once work starts the percentage takes over.
 */
export function statusFromJobEvent(event: JobEvent): CandidateStatus {
  switch (event.type) {
    case "started":
      return event.etaSec === undefined
        ? { kind: "queued" }
        : { kind: "queued", etaSec: event.etaSec };
    case "progress": {
      const pct = Math.max(0, Math.min(1, event.pct ?? 0));
      if (pct === 0 && event.etaSec !== undefined) return { kind: "queued", etaSec: event.etaSec };
      return { kind: "generating", pct };
    }
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
  /**
   * The candidate's quality warning, when the source has one (09 §6). Pulled after every event
   * and when a candidate is added, because the warning arrives with the result blob rather than
   * with the job event.
   */
  readonly warning?: (candidateId: string) => string | undefined;
}
