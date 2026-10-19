/**
 * The version DAG repository: the only place that reads or writes `commits`,
 * `refs`, `local_settings` and `outbox` (02 §7; 05 §5, §7).
 *
 * A commit is one op batch plus a content-addressed snapshot of the document
 * after it. The snapshot is the canonical JSON from `bragi-model`, stored
 * uncompressed in the `BlobCache` (Q85): documents are small, and the browser
 * has no zstd yet. Rows are plain SQL against `LocalDB`, so the identical
 * statements run on sqlite-wasm in the browser and through rusqlite on the
 * desktop (01 §3).
 *
 * Refs are just names in `refs`: `head:<deviceId>`, `branch:<name>` and
 * `star:<commitId>` (05 §5). Branch names are user-facing, so they are trimmed
 * and validated here rather than in the UI.
 */
import type { BlobHash, LocalDB, Platform, Row } from "@bragi/platform";
import type { CommitState, OpBatch, Project } from "@bragi/schemas";

import { t } from "../../../i18n/index.js";
import { ulid } from "../../../lib/ulid.js";
import type { ModelApi } from "../../song/model/model-api.js";

/** How a batch was authored, denormalised onto the row for the history panel. */
export type CommitAuthorKind = OpBatch["author"]["kind"];

/** A commit as the local database stores it. */
export interface StoredCommit {
  /** `cmt_` + 26 base32 characters (02 §2.1). */
  readonly id: string;
  readonly projectId: string;
  /** The parent commit, or `null` for a root. v1 has at most one. */
  readonly parent: string | null;
  readonly batch: OpBatch;
  readonly label: string;
  readonly authorKind: CommitAuthorKind;
  /** `sha256:` content address of the snapshot in the BlobCache. */
  readonly snapshotHash: string;
  readonly state: CommitState;
  readonly candidateGroup: string | null;
  readonly deviceId: string;
  /** ISO 8601 UTC. */
  readonly createdAt: string;
  /** The server's sequence number after sync (WP-2.9); `null` until then. */
  readonly seq: number | null;
}

/** A named pointer into the DAG. */
export interface StoredRef {
  readonly name: string;
  readonly commitId: string;
  /** ISO 8601 UTC. */
  readonly updatedAt: string;
}

/** Extra work {@link insertCommit} can do in the same transaction. */
export interface InsertCommitOptions {
  /**
   * Point `projects.snapshot_hash` and `updated_at` at this commit, so project
   * open (`getProjectSnapshot`) keeps working. Callers set this for HEAD only.
   */
  readonly mirrorProject?: boolean;
}

/** The longest branch name, after trimming. */
export const MAX_BRANCH_NAME_LENGTH = 64;

/** The `local_settings` key that holds this device's identity. */
export const DEVICE_ID_KEY = "deviceId";

const COLUMNS =
  "id, project_id, parent, batch, label, author_kind, snapshot_hash, state, " +
  "candidate_group, device_id, created_at, seq";

/** A branch name the user must fix before the branch can be named. */
export class BranchNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BranchNameError";
  }
}

/** A snapshot that the commit row points at but the BlobCache does not hold. */
export class CommitSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommitSnapshotError";
  }
}

function requiredText(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new TypeError(`commits.${column} should be TEXT, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalText(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new TypeError(`commits.${column} should be TEXT or NULL, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalInteger(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(
      `commits.${column} should be INTEGER or NULL, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function parseAuthorKind(value: string): CommitAuthorKind {
  if (value === "user" || value === "ai" || value === "system") return value;
  throw new TypeError(`commits.author_kind has an unknown value ${JSON.stringify(value)}`);
}

function parseState(value: string): CommitState {
  if (value === "committed" || value === "candidate" || value === "discarded") return value;
  throw new TypeError(`commits.state has an unknown value ${JSON.stringify(value)}`);
}

function parseBatch(value: string, id: string): OpBatch {
  try {
    return JSON.parse(value) as OpBatch;
  } catch (cause) {
    throw new TypeError(`commits.batch for ${id} is not JSON: ${String(cause)}`);
  }
}

function toStoredCommit(row: Row): StoredCommit {
  const id = requiredText(row, "id");
  return {
    id,
    projectId: requiredText(row, "project_id"),
    parent: optionalText(row, "parent"),
    batch: parseBatch(requiredText(row, "batch"), id),
    label: requiredText(row, "label"),
    authorKind: parseAuthorKind(requiredText(row, "author_kind")),
    snapshotHash: requiredText(row, "snapshot_hash"),
    state: parseState(requiredText(row, "state")),
    candidateGroup: optionalText(row, "candidate_group"),
    deviceId: requiredText(row, "device_id"),
    createdAt: requiredText(row, "created_at"),
    seq: optionalInteger(row, "seq"),
  };
}

/**
 * This device's identity, creating `dev_<ulid>` once.
 *
 * Concurrent first calls cannot produce two ids: every caller inserts with
 * `OR IGNORE` and then reads back whichever row won.
 */
export async function getDeviceId(db: LocalDB): Promise<string> {
  const candidate = `dev_${ulid()}`;
  await db.run("INSERT OR IGNORE INTO local_settings (key, value) VALUES (?, ?)", [
    DEVICE_ID_KEY,
    candidate,
  ]);
  const rows = await db.query("SELECT value FROM local_settings WHERE key = ?", [DEVICE_ID_KEY]);
  const value = rows[0]?.value;
  if (typeof value !== "string" || !value.startsWith("dev_")) {
    throw new TypeError("local_settings.deviceId should be a `dev_` id");
  }
  return value;
}

/**
 * Stores the handle's canonical JSON in the BlobCache and returns its content
 * address. Uncompressed: see Q85.
 */
export async function putCommitSnapshot(
  platform: Platform,
  model: Pick<ModelApi, "canonicalJson">,
  handle: number,
): Promise<{ hash: string; bytes: Uint8Array }> {
  const bytes = new TextEncoder().encode(model.canonicalJson(handle));
  const hash = await platform.blobCache.put(bytes);
  return { hash, bytes };
}

/** The document behind a snapshot hash. */
export async function readCommitSnapshot(platform: Platform, hash: string): Promise<Project> {
  const bytes = await platform.blobCache.get(hash as BlobHash);
  if (bytes === null) throw new CommitSnapshotError(t("history.snapshotMissing"));
  return JSON.parse(new TextDecoder().decode(bytes)) as Project;
}

/** The `cmt_` id for `(parent, batch, snapshotHash)`, via `bragi-model` (02 §2.1). */
export function makeCommitId(
  model: Pick<ModelApi, "commitId">,
  parent: string | null,
  batch: OpBatch,
  snapshotHash: string,
): string {
  const parents = parent === null ? [] : [parent];
  return model.commitId(JSON.stringify(parents), JSON.stringify(batch), snapshotHash);
}

/**
 * Inserts `commit` and queues it in `outbox`, atomically.
 *
 * A duplicate commit id is ignored, as is its duplicate outbox row, so a
 * retried write is safe. With {@link InsertCommitOptions.mirrorProject} the
 * project row's snapshot pointer follows this commit.
 */
export async function insertCommit(
  db: LocalDB,
  commit: StoredCommit,
  options: InsertCommitOptions = {},
): Promise<void> {
  const steps = [
    {
      sql: `INSERT OR IGNORE INTO commits
              (${COLUMNS})
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        commit.id,
        commit.projectId,
        commit.parent,
        JSON.stringify(commit.batch),
        commit.label,
        commit.authorKind,
        commit.snapshotHash,
        commit.state,
        commit.candidateGroup,
        commit.deviceId,
        commit.createdAt,
        commit.seq,
      ],
    },
    {
      sql: "INSERT OR IGNORE INTO outbox (commit_id) VALUES (?)",
      params: [commit.id],
    },
  ];
  if (options.mirrorProject === true) {
    steps.push({
      sql: "UPDATE projects SET snapshot_hash = ?, updated_at = ? WHERE id = ?",
      params: [commit.snapshotHash, commit.createdAt, commit.projectId],
    });
  }
  await db.transaction(steps);
}

/** Every commit of a project, oldest first. One query (02 §7 history panel). */
export async function listCommits(db: LocalDB, projectId: string): Promise<StoredCommit[]> {
  const rows = await db.query(
    `SELECT ${COLUMNS} FROM commits WHERE project_id = ? ORDER BY created_at, id`,
    [projectId],
  );
  return rows.map(toStoredCommit);
}

/** The commit a ref points at, or `null` when it does not exist. */
export async function getRef(db: LocalDB, projectId: string, name: string): Promise<string | null> {
  const rows = await db.query("SELECT commit_id FROM refs WHERE project_id = ? AND name = ?", [
    projectId,
    name,
  ]);
  const value = rows[0]?.commit_id;
  return typeof value === "string" ? value : null;
}

/**
 * Moves a ref to `commitId`, creating it when needed.
 *
 * Branch refs are canonicalised through {@link branchRef}, so a caller cannot
 * store an untrimmed or invalid branch name.
 */
export async function setRef(
  db: LocalDB,
  projectId: string,
  name: string,
  commitId: string,
  now: Date = new Date(),
): Promise<void> {
  const canonical = canonicalRefName(name);
  await db.run(
    `INSERT INTO refs (project_id, name, commit_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (project_id, name)
     DO UPDATE SET commit_id = excluded.commit_id, updated_at = excluded.updated_at`,
    [projectId, canonical, commitId, now.toISOString()],
  );
}

/** Removes a ref. Removing an absent ref is a no-op. */
export async function deleteRef(db: LocalDB, projectId: string, name: string): Promise<void> {
  await db.run("DELETE FROM refs WHERE project_id = ? AND name = ?", [projectId, name]);
}

/** Every ref of a project, by name. */
export async function listRefs(db: LocalDB, projectId: string): Promise<StoredRef[]> {
  const rows = await db.query(
    "SELECT name, commit_id, updated_at FROM refs WHERE project_id = ? ORDER BY name",
    [projectId],
  );
  return rows.map((row) => ({
    name: requiredText(row, "name"),
    commitId: requiredText(row, "commit_id"),
    updatedAt: requiredText(row, "updated_at"),
  }));
}

/** The ref name for this device's HEAD (`head:<deviceId>`, 05 §5). */
export function headRef(deviceId: string): string {
  return `head:${deviceId}`;
}

/**
 * The ref name for a named branch (`branch:<name>`, 05 §5).
 *
 * @throws {BranchNameError} when the trimmed name is empty, longer than
 * {@link MAX_BRANCH_NAME_LENGTH}, or contains a `:`.
 */
export function branchRef(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new BranchNameError(t("history.branchRequired"));
  if (trimmed.length > MAX_BRANCH_NAME_LENGTH) {
    throw new BranchNameError(t("history.branchTooLong"));
  }
  if (trimmed.includes(":")) throw new BranchNameError(t("history.branchInvalid"));
  return `branch:${trimmed}`;
}

/** The ref name for a starred commit (`star:<commitId>`, 05 §5). */
export function starRef(commitId: string): string {
  return `star:${commitId}`;
}

function canonicalRefName(name: string): string {
  return name.startsWith("branch:") ? branchRef(name.slice("branch:".length)) : name;
}

/** Sets the state of every commit in `ids`. An empty list is a no-op. */
export async function setCommitState(
  db: LocalDB,
  ids: readonly string[],
  state: CommitState,
): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  await db.run(`UPDATE commits SET state = ? WHERE id IN (${placeholders})`, [state, ...ids]);
}
