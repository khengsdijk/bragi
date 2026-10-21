/**
 * The warm-up ping of specs/09-generation.md §5.
 *
 * `POST /v1/generations/warmup` does not load anything itself: it submits the
 * internal `generate.warmup` job, whose capability asks the backend to load the
 * model (for ACE-Step, `POST /v1/init`). The endpoint stays cheap and idempotent:
 * while a warm-up is in flight it answers `warming` without queueing another, and
 * for a few minutes after one finished it answers `warm`.
 *
 * The state lives in `jobs`, not in this process, because the orchestrator — a
 * separate process — is what marks the job done. `disabled` means the environment
 * has no generation worker at all (`BRAGI_GENERATE_WORKERS`, set by
 * `pnpm dev:backend` when it starts one).
 */
import type { NatsConnection } from "nats";
import type { Pool } from "pg";

import type { Config } from "../config.js";
import { submitJob } from "./service.js";

/** The internal capability the warm-up route submits. */
export const WARMUP_CAPABILITY = "generate.warmup";
/** A queued/running warm-up older than this is treated as lost and re-submitted. */
export const WARMING_STALE_MS = 2 * 60_000;
/** How long a finished warm-up still counts as warm. */
export const WARM_TTL_MS = 5 * 60_000;

/** The contract of `POST /v1/generations/warmup` (docs/wp/2.7.md, task D). */
export type WarmupStatus = "warming" | "warm" | "disabled";

export interface WarmupDeps {
  readonly config: Config;
  readonly pool: Pool;
  readonly nc: NatsConnection;
}

interface WarmupRow {
  readonly status: string;
  readonly created_at: Date;
  readonly finished_at: Date | null;
}

export class WarmupService {
  /** Concurrent pings share one check, so two requests cannot queue two jobs. */
  private inFlight: Promise<WarmupStatus> | undefined;

  constructor(
    private readonly deps: WarmupDeps,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Answers the ping, submitting a warm-up job only when nothing is warm or warming.
   *
   * @param userId the requester; the job row records who asked
   */
  request(userId: string): Promise<WarmupStatus> {
    if (!this.deps.config.generateWorkers) return Promise.resolve("disabled");
    const running = this.inFlight;
    if (running !== undefined) return running;
    const pending = this.check(userId).finally(() => {
      if (this.inFlight === pending) this.inFlight = undefined;
    });
    this.inFlight = pending;
    return pending;
  }

  private async check(userId: string): Promise<WarmupStatus> {
    const last = await this.latest();
    if (last !== undefined) {
      const finished = last.finished_at ?? last.created_at;
      if (
        (last.status === "queued" || last.status === "running") &&
        this.ageMs(last.created_at) < WARMING_STALE_MS
      ) {
        return "warming";
      }
      if (last.status === "done" && this.ageMs(finished) < WARM_TTL_MS) return "warm";
    }
    await submitJob(this.deps, userId, {
      capability: WARMUP_CAPABILITY,
      priority: "interactive",
      assets: {},
      params: {},
      deadlineSec: 120,
      // A warm-up has no inputs, so its cache key would repeat forever (05 §4.3).
      cacheKeySalt: `warmup:${this.now().toISOString()}`,
    });
    return "warming";
  }

  private async latest(): Promise<WarmupRow | undefined> {
    const { rows } = await this.deps.pool.query<WarmupRow>(
      `SELECT status, created_at, finished_at FROM jobs
       WHERE capability = $1 ORDER BY created_at DESC LIMIT 1`,
      [WARMUP_CAPABILITY],
    );
    return rows[0];
  }

  private ageMs(at: Date): number {
    return this.now().getTime() - at.getTime();
  }
}
