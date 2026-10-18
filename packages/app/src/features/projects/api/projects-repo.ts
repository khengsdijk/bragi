/**
 * The projects repository: the only place that reads or writes the `projects`
 * table (05 §5, minus `user_id`: the local database belongs to one person).
 *
 * Rows are plain SQL against `LocalDB`, so the identical statements run on
 * sqlite-wasm on OPFS in the browser and through rusqlite on the desktop
 * (01 §3). A project's card — a small, canonical JSON blob — is content
 * addressed in the `BlobCache`, which is what makes "the project survived the
 * reload, together with what we stored for it" checkable.
 */
import { blobHashOf, type LocalDB, type Platform, type Row } from "@bragi/platform";

import { t } from "../../../i18n/index.js";
import { ulid } from "../../../lib/ulid.js";

/** A locally created project. */
export interface Project {
  readonly id: string;
  /** `prj_` + ULID (02 §2.1). */
  readonly title: string;
  /** ISO 8601 UTC. */
  readonly createdAt: string;
  /** ISO 8601 UTC. */
  readonly updatedAt: string;
}

/** The longest title the local schema and the UI accept. */
export const MAX_TITLE_LENGTH = 200;

/** The shape of a project's card blob. Bump {@link CARD_VERSION} on a change. */
const CARD_VERSION = 1;

const COLUMNS = "id, title, created_at, updated_at";

/** A title the user must fix before the project can exist. */
export class ProjectTitleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectTitleError";
  }
}

/** `prj_` + a fresh ULID. */
export function newProjectId(): string {
  return `prj_${ulid()}`;
}

/** The canonical bytes stored under a project's card hash. */
export function projectCard(project: Project): Uint8Array {
  // Key order is fixed here, not left to the caller's object literal: the bytes,
  // and therefore the hash, must not depend on how the object was built.
  const card = JSON.stringify({
    v: CARD_VERSION,
    id: project.id,
    title: project.title,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  });
  return new TextEncoder().encode(card);
}

function toProject(row: Row): Project {
  const text = (column: string): string => {
    const value = row[column];
    if (typeof value !== "string") {
      throw new TypeError(`projects.${column} should be TEXT, got ${JSON.stringify(value)}`);
    }
    return value;
  };
  return {
    id: text("id"),
    title: text("title"),
    createdAt: text("created_at"),
    updatedAt: text("updated_at"),
  };
}

/**
 * Creates a project with `title`, storing its card first so that a project row
 * without a card cannot come out of this function.
 *
 * @throws {ProjectTitleError} when the trimmed title is empty or too long.
 */
export async function createProject(
  platform: Platform,
  title: string,
  now: Date = new Date(),
): Promise<Project> {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw new ProjectTitleError(t("projects.titleRequired"));
  if (trimmed.length > MAX_TITLE_LENGTH) throw new ProjectTitleError(t("projects.titleTooLong"));

  const timestamp = now.toISOString();
  const project: Project = {
    id: newProjectId(),
    title: trimmed,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await platform.blobCache.put(projectCard(project));
  await platform.localDb.transaction([
    {
      sql: "INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      params: [project.id, project.title, project.createdAt, project.updatedAt],
    },
  ]);
  return project;
}

/** The project with `id`, or `null` when it does not exist (or was deleted). */
export async function getProject(db: LocalDB, id: string): Promise<Project | null> {
  const rows = await db.query(
    `SELECT ${COLUMNS} FROM projects WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  const row = rows[0];
  return row ? toProject(row) : null;
}

/** Every live project, newest first. */
export async function listProjects(db: LocalDB): Promise<Project[]> {
  const rows = await db.query(
    `SELECT ${COLUMNS} FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC`,
  );
  return rows.map(toProject);
}

/**
 * Whether the project's row and its stored card agree with each other.
 *
 * `false` means the project was never stored, its card is missing, or the two
 * have drifted apart — exactly the question the reload acceptance test asks.
 */
export async function verifyProjectCard(platform: Platform, project: Project): Promise<boolean> {
  const stored = await platform.blobCache.get(await blobHashOf(projectCard(project)));
  if (stored === null) return false;
  const row = await getProject(platform.localDb, project.id);
  return (
    row !== null &&
    row.title === project.title &&
    row.createdAt === project.createdAt &&
    row.updatedAt === project.updatedAt
  );
}
