/**
 * The local library: library rows plus the project documents they point at
 * (05 §5, §7; finding 8).
 *
 * Documents are content-addressed blobs in the BlobCache; `projects.snapshot_hash`
 * is the pointer. A snapshot is written after every `analysis.apply`, so a reload
 * (or a second visit) opens exactly what the analysis had produced so far.
 */

import type { LocalDB, Platform, Row } from "@bragi/platform";
import type { Project } from "@bragi/schemas";

import { ulid } from "../../../lib/ulid.js";

export interface LibraryItem {
  readonly id: string;
  readonly assetHash: string;
  readonly filename: string;
  readonly title: string | null;
  readonly artist: string | null;
  readonly album: string | null;
  readonly importedAt: string;
  readonly projectId: string | null;
  readonly hidden: boolean;
}

export interface ProjectRow {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly snapshotHash: string | null;
  readonly assetHash: string | null;
}

/** `prj_` + ULID (02 §2.1). */
export function newProjectId(): string {
  return `prj_${ulid()}`;
}

/** `lib_` + ULID. */
export function newLibraryItemId(): string {
  return `lib_${ulid()}`;
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function requiredText(row: Row, key: string): string {
  const value = text(row, key);
  if (value === null) throw new TypeError(`library.${key} should be TEXT`);
  return value;
}

function toProjectRow(row: Row): ProjectRow {
  return {
    id: requiredText(row, "id"),
    title: requiredText(row, "title"),
    createdAt: requiredText(row, "created_at"),
    updatedAt: requiredText(row, "updated_at"),
    snapshotHash: text(row, "snapshot_hash"),
    assetHash: text(row, "asset_hash"),
  };
}

function toLibraryItem(row: Row): LibraryItem {
  const projectId = text(row, "project_id");
  return {
    id: requiredText(row, "id"),
    assetHash: requiredText(row, "asset_hash"),
    filename: requiredText(row, "filename"),
    title: text(row, "title"),
    artist: text(row, "artist"),
    album: text(row, "album"),
    importedAt: requiredText(row, "imported_at"),
    projectId,
    hidden: row.hidden === 1,
  };
}

/** Stores the document and returns its content address. */
export async function putSnapshot(
  platform: Platform,
  project: Project,
): Promise<{ hash: string; bytes: Uint8Array }> {
  const bytes = new TextEncoder().encode(JSON.stringify(project));
  const hash = await platform.blobCache.put(bytes);
  return { hash, bytes };
}

/** The document behind a project id, or `null` when there is no snapshot. */
export async function getProjectSnapshot(
  platform: Platform,
  projectId: string,
): Promise<Project | null> {
  const rows = await platform.localDb.query(
    "SELECT snapshot_hash FROM projects WHERE id = ? AND deleted_at IS NULL",
    [projectId],
  );
  const hash = text(rows[0] ?? {}, "snapshot_hash");
  if (hash === null) return null;
  const bytes = await platform.blobCache.get(hash as `sha256:${string}`);
  if (bytes === null) return null;
  return JSON.parse(new TextDecoder().decode(bytes)) as Project;
}

/** The project row (snapshot and asset pointers included), or `null`. */
export async function getProjectRow(db: LocalDB, id: string): Promise<ProjectRow | null> {
  const rows = await db.query(
    `SELECT id, title, created_at, updated_at, snapshot_hash, asset_hash
     FROM projects WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] ? toProjectRow(rows[0]) : null;
}

/**
 * Creates a project row and its first snapshot in one step.
 *
 * The snapshot is stored before the row, so a row always points at a document
 * that exists.
 */
export async function createProjectWithSnapshot(
  platform: Platform,
  input: {
    readonly project: Project;
    readonly assetHash: string;
    readonly filename: string;
    readonly title?: string;
    readonly now?: Date;
  },
): Promise<{ projectId: string; snapshotHash: string }> {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const { hash } = await putSnapshot(platform, input.project);
  await platform.localDb.transaction([
    {
      sql: `INSERT INTO projects (id, title, created_at, updated_at, snapshot_hash, asset_hash)
            VALUES (?, ?, ?, ?, ?, ?)`,
      params: [
        input.project.id,
        input.project.meta.title,
        input.project.meta.createdAt,
        timestamp,
        hash,
        input.assetHash,
      ],
    },
    {
      sql: `INSERT INTO library_items
              (id, asset_hash, filename, title, imported_at, project_id)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING`,
      params: [
        newLibraryItemId(),
        input.assetHash,
        input.filename,
        input.title ?? null,
        timestamp,
        input.project.id,
      ],
    },
  ]);
  return { projectId: input.project.id, snapshotHash: hash };
}

/** Replaces a project's snapshot (after an analysis stage) and touches `updated_at`. */
export async function saveProjectSnapshot(
  platform: Platform,
  project: Project,
  now: Date = new Date(),
): Promise<string> {
  const { hash } = await putSnapshot(platform, project);
  await platform.localDb.run("UPDATE projects SET snapshot_hash = ?, updated_at = ? WHERE id = ?", [
    hash,
    now.toISOString(),
    project.id,
  ]);
  return hash;
}

/** Every visible library item, newest first. */
export async function listLibraryItems(db: LocalDB): Promise<LibraryItem[]> {
  const rows = await db.query(
    `SELECT id, asset_hash, filename, title, artist, album, imported_at, project_id, hidden
     FROM library_items WHERE hidden = 0 ORDER BY imported_at DESC, id DESC`,
  );
  return rows.map(toLibraryItem);
}

/** Marks a library item hidden (the asset itself is GC'd later, 05 §6). */
export async function hideLibraryItem(db: LocalDB, id: string): Promise<void> {
  await db.run("UPDATE library_items SET hidden = 1 WHERE id = ?", [id]);
}
