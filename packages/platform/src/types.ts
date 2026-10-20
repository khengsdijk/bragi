/**
 * The platform seam (specs/01-architecture.md §2, §3). `@bragi/app` only ever
 * sees these interfaces; the web and Tauri adapters implement them.
 */
import type { EngineHost } from "./engine/types.js";

/**
 * A value that crosses the LocalDB boundary in either direction.
 *
 * Deliberately narrow so that both adapters represent it identically: the Tauri
 * adapter sends it through JSON IPC to rusqlite. Integers outside the JS safe
 * range and binary columns are not supported yet; large binary data belongs in
 * the {@link BlobCache}, and i64 tick values arrive with the song model (WP-0.3).
 */
export type SqlValue = string | number | null;

/** One result row, keyed by column name. */
export type Row = Readonly<Record<string, SqlValue>>;

/** A single SQL statement with positional (`?`) parameters. */
export interface Statement {
  readonly sql: string;
  readonly params?: readonly SqlValue[];
}

/** What a write statement did. */
export interface RunResult {
  /** Rows inserted, updated or deleted by this statement (`sqlite3_changes`). */
  readonly changes: number;
}

/**
 * The local SQLite database: sqlite-wasm on OPFS in the browser, rusqlite on
 * desktop (01 §3). Both run the same SQL, including the shared migrations from
 * `packages/schemas/sqlite/migrations`.
 */
export interface LocalDB {
  /** Runs one statement and returns every row it yields. */
  query(sql: string, params?: readonly SqlValue[]): Promise<Row[]>;
  /** Runs one write statement. */
  run(sql: string, params?: readonly SqlValue[]): Promise<RunResult>;
  /**
   * Runs the steps atomically on the database side: all of them, or none.
   *
   * A step without `params` may contain several `;`-separated statements (a
   * migration script). A step with `params` must be a single statement.
   */
  transaction(steps: readonly Statement[]): Promise<void>;
  /** Releases the database. Further calls reject. */
  close(): Promise<void>;
}

/** `sha256:<64 lowercase hex>` — the asset/blob identifier from 02 §2.1. */
export type BlobHash = `sha256:${string}`;

/**
 * Content-addressed local blob storage: OPFS in the browser, the app data
 * directory on desktop (01 §3). The key is always the SHA-256 of the bytes, so a
 * caller can never store content under the wrong name.
 */
export interface BlobCache {
  /** Stores the bytes and returns their hash. Storing the same bytes twice is a no-op. */
  put(bytes: Uint8Array): Promise<BlobHash>;
  /** The stored bytes, or `null` when the blob is absent (or failed its integrity check). */
  get(hash: BlobHash): Promise<Uint8Array | null>;
  has(hash: BlobHash): Promise<boolean>;
  /** Removes the blob. Removing an absent blob is a no-op. */
  delete(hash: BlobHash): Promise<void>;
}

/** A file the user picked. Bytes are read lazily. */
export interface PickedFile {
  readonly name: string;
  readonly size: number;
  bytes(): Promise<Uint8Array>;
}

export interface PickFilesOptions {
  /** `accept` list, e.g. `["audio/*", ".flac"]`. Empty or absent means any file. */
  readonly accept?: readonly string[];
  readonly multiple?: boolean;
}

/**
 * User-mediated file access (01 §3 "Library import"). The webview never gets
 * blanket filesystem access (01 §10): files arrive only because the user picked
 * them.
 */
export interface FileAccess {
  /** Resolves with the picked files, or an empty list when the user cancels. */
  pickFiles(options?: PickFilesOptions): Promise<PickedFile[]>;
}

/** Which adapter set is active. For diagnostics only — the app must not branch on it. */
export type PlatformKind = "web" | "desktop" | "memory";

/**
 * Where the app reaches the Bragi API and how it authenticates (01 §3, 05 §8).
 * `baseUrl: ""` means the same origin (the web build is proxied by Vite in dev
 * and by the CDN in production); the desktop webview uses an absolute URL.
 */
export interface PlatformApi {
  readonly baseUrl: string;
  /** `"cookie"` on web; `"bearer"` for a desktop client that cannot hold a session cookie. */
  readonly credential: "cookie" | "bearer";
}

/** Everything the app gets from its host. */
export interface Platform {
  readonly kind: PlatformKind;
  readonly localDb: LocalDB;
  readonly blobCache: BlobCache;
  readonly fileAccess: FileAccess;
  /**
   * Starts this host's audio engine (03 §3). Absent when the host cannot play audio (the
   * in-memory test platform), in which case the transport bar is disabled. Call from a user
   * gesture on the web, so the browser lets the audio context start.
   */
  readonly createEngine?: () => Promise<EngineHost>;
  /**
   * Synchronously creates or resumes the audio context. Browsers only start audio inside a user
   * gesture, and the engine factory has to `await` its worklet module, so the Play handler calls
   * this before any `await`. Absent on hosts without browser autoplay rules.
   */
  readonly primeEngine?: () => void;
  /** The API endpoint and credential mode (05 §2). Omitted by in-memory/test hosts. */
  readonly api?: PlatformApi;
}

/** One file from `packages/schemas/sqlite/migrations`, named `NNN_name.sql` (05 §7). */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}
