/**
 * The pure translation from NATS subjects and `JobEvent`s to the WebSocket
 * messages of specs/05 §3. Keeping it free of sockets and databases is what
 * makes it unit-testable (`__tests__/ws.test.ts`).
 */
import type { JobEvent } from "@bragi/schemas";

/** A message the server sends to an authenticated client (05 §3). */
export type ServerMessage =
  | { t: "job.progress"; jobId: string; stage: string; pct: number; etaSec?: number }
  | {
      t: "job.partial";
      jobId: string;
      index: number;
      output: { asset: string; kind: string };
      /** The worker's partial outputs verbatim (05 §3, 09 §5): `candidate_0` asset + blob. */
      outputs: { assets?: Record<string, string>; blobs?: Record<string, string> };
    }
  | { t: "job.completed"; jobId: string; outputs: unknown }
  | { t: "job.failed"; jobId: string; code: string; retryable: boolean }
  | { t: "analysis.partial"; assetHash: string; stage: string; blob: string }
  | {
      t: "analysis.failed";
      assetHash: string;
      stage: string;
      code: string;
      message: string;
      retryable: boolean;
    }
  | { t: "sync.remote"; projectId: string; commits: string[] };

/**
 * Maps an event subject to the client topic that receives it (05 §3).
 *
 * @param subject e.g. `events.job.job_01H…` or `events.asset.sha256:…`
 * @returns the topic, or `undefined` when the subject is not fanned out
 */
export function topicForSubject(subject: string): string | undefined {
  const [root, kind, ...rest] = subject.split(".");
  if (root !== "events" || kind === undefined) return undefined;
  const id = rest.join(".");
  if (id === "") return undefined;
  if (kind === "job" || kind === "asset" || kind === "project") return `${kind}:${id}`;
  return undefined;
}

/**
 * Translates the JSON published on `events.asset.<assetHash>` into the client
 * messages of 05 §3 (a partial when it carries a blob, a failure when it carries
 * an error). Keeping it pure is what makes the gateway and the replay share one
 * shape.
 */
export function analysisMessages(payload: unknown): ServerMessage[] {
  if (typeof payload !== "object" || payload === null) return [];
  const { assetHash, stage, blob, error } = payload as {
    assetHash?: unknown;
    stage?: unknown;
    blob?: unknown;
    error?: unknown;
  };
  if (typeof assetHash !== "string" || typeof stage !== "string") return [];
  if (typeof blob === "string") {
    return [{ t: "analysis.partial", assetHash, stage, blob }];
  }
  if (typeof error === "object" && error !== null) {
    const source = error as { code?: unknown; message?: unknown; retryable?: unknown };
    return [
      {
        t: "analysis.failed",
        assetHash,
        stage,
        code: typeof source.code === "string" ? source.code : "MODEL_ERROR",
        message: typeof source.message === "string" ? source.message : "analysis stage failed",
        retryable: source.retryable === true,
      },
    ];
  }
  return [];
}

/** One `analyses` row, as the replay reads it (05 §5). */
export interface AnalysisReplayRow {
  readonly stage: string;
  readonly status: string;
  readonly blob_hash: string | null;
  readonly error?: unknown;
}

/**
 * The snapshot a late subscriber gets for `asset:<hash>` (Q25, finding 6).
 *
 * The WebSocket is a fan-out, not a log: a client that connects after a stage
 * finished would never hear about it. Subscribing therefore replays the finished
 * stages from `analyses`, which is a snapshot of the current state and safe to
 * send more than once.
 */
export function replayMessages(
  assetHash: string,
  rows: readonly AnalysisReplayRow[],
): ServerMessage[] {
  const messages: ServerMessage[] = [];
  for (const row of rows) {
    if (row.status === "done" && row.blob_hash !== null) {
      messages.push({ t: "analysis.partial", assetHash, stage: row.stage, blob: row.blob_hash });
    } else if (row.status === "failed") {
      messages.push(...analysisMessages({ assetHash, stage: row.stage, error: row.error ?? {} }));
    }
  }
  return messages;
}

export function stageOf(capability: string): string {
  const parts = capability.split(".");
  return parts[parts.length - 1] ?? capability;
}

/** The first output of an event, as `{ asset, kind }` (05 §3 `job.partial`). */
export function firstOutput(
  outputs: { assets?: Record<string, string>; blobs?: Record<string, string> } | undefined,
): { asset: string; kind: string } | undefined {
  for (const source of [outputs?.assets, outputs?.blobs]) {
    if (!source) continue;
    const entry = Object.entries(source)[0];
    if (entry) return { asset: entry[1], kind: entry[0] };
  }
  return undefined;
}

/**
 * Translates one `JobEvent` into the messages a client gets.
 *
 * `stage` cannot come from the envelope — the WP-0.2 `JobEvent` has no stage
 * field — so the caller supplies the job's capability. `partialIndex` is the
 * caller's per-job counter, matching 05 §3's `index`.
 */
export function toClientMessages(
  event: JobEvent,
  capability: string,
  partialIndex: number,
): ServerMessage[] {
  const stage = stageOf(capability);
  switch (event.type) {
    case "progress":
      return [
        {
          t: "job.progress",
          jobId: event.jobId,
          stage,
          pct: event.pct ?? 0,
          ...(event.etaSec === undefined ? {} : { etaSec: event.etaSec }),
        },
      ];
    case "partial": {
      const output = firstOutput(event.outputs);
      return output === undefined
        ? []
        : [
            {
              t: "job.partial",
              jobId: event.jobId,
              index: partialIndex,
              output,
              outputs: event.outputs ?? {},
            },
          ];
    }
    case "completed":
      return [{ t: "job.completed", jobId: event.jobId, outputs: event.outputs ?? {} }];
    case "failed":
      return [
        {
          t: "job.failed",
          jobId: event.jobId,
          code: event.error?.code ?? "MODEL_ERROR",
          retryable: event.error?.retryable ?? false,
        },
      ];
    case "started":
      return [];
    default:
      return [];
  }
}
