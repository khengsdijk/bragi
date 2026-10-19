/**
 * Single-user mode (ADR-0014, specs/05-backend-and-jobs.md §8).
 *
 * Locally there is no sign-in: the API refuses to start on a reachable address
 * (anyone who could reach it would act as the owner) unless the override is set,
 * and it idempotently creates the one owner account every request resolves to.
 */
import type { Pool } from "pg";

import type { Config } from "../config.js";
import { newUserId } from "../ids.js";

/** The owner account single-user mode signs in as. */
export interface OwnerUser {
  id: string;
  email: string;
  name: string;
}

/** Where `assertSafeBinding` reports an accepted override. */
export interface BindingLogger {
  warn(message: string): void;
}

/**
 * True when `host` is a loopback address: `localhost`, `::1`/`[::1]`, or any
 * IPv4 in `127.0.0.0/8`. `0.0.0.0`, `::` and everything else are not.
 *
 * @param host a host name or address, as `API_HOST` (no port)
 */
export function isLoopbackHost(host: string): boolean {
  const bare = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (bare === "localhost" || bare === "::1") return true;
  const octets = /^127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(bare);
  if (octets === null) return false;
  return octets.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * Refuses a non-loopback bind in single-user mode unless the owner opted in.
 *
 * @param config the loaded configuration
 * @param log receives the override warning when `allowRemoteSingleUser` is set
 * @throws Error naming the host when single-user mode would be reachable
 */
export function assertSafeBinding(config: Config, log?: BindingLogger): void {
  if (config.authMode !== "single-user") return;
  if (isLoopbackHost(config.apiHost)) return;
  if (config.allowRemoteSingleUser) {
    log?.warn(
      `single-user mode is binding to ${config.apiHost}: anyone who can reach this API acts as the owner`,
    );
    return;
  }
  throw new Error(
    `single-user mode refuses to bind to ${config.apiHost}: anyone who can reach this API acts as the owner. ` +
      "Set API_HOST=127.0.0.1, or BRAGI_ALLOW_REMOTE_SINGLE_USER=1 if you really mean to expose it.",
  );
}

/**
 * Creates the owner account if it does not exist yet, and returns it.
 *
 * `ON CONFLICT (email) DO NOTHING` makes this idempotent across restarts; the
 * `SELECT` then reads the row whether it was just inserted or already there.
 *
 * @param pool the Postgres pool
 * @param config the loaded configuration (owner email and name)
 */
export async function ensureOwner(pool: Pool, config: Config): Promise<OwnerUser> {
  await pool.query(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, true, now(), now())
     ON CONFLICT (email) DO NOTHING`,
    [newUserId(), config.ownerName, config.ownerEmail],
  );
  const { rows } = await pool.query<OwnerUser>(
    `SELECT id, email, name FROM "user" WHERE email = $1`,
    [config.ownerEmail],
  );
  const owner = rows[0];
  if (owner === undefined) {
    throw new Error(`the owner account ${config.ownerEmail} disappeared during startup`);
  }
  return owner;
}
