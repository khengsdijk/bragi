import { readdirSync, readFileSync } from "node:fs";
import { type Platform, parseMigrations } from "@bragi/platform";
import { createMemoryPlatform } from "@bragi/platform/testing";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createProject,
  getProject,
  listProjects,
  ProjectTitleError,
  verifyProjectCard,
} from "../api/projects-repo.js";

const MIGRATIONS_DIR = new URL("../../../../../schemas/sqlite/migrations/", import.meta.url);
const migrations = parseMigrations(
  Object.fromEntries(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => [name, readFileSync(new URL(name, MIGRATIONS_DIR), "utf8")]),
  ),
);

describe("projects repository", () => {
  let platform: Platform;

  beforeEach(async () => {
    platform = await createMemoryPlatform(migrations);
  });

  it("stores a project and reads it back", async () => {
    const now = new Date("2026-10-18T12:00:00.000Z");
    const created = await createProject(platform, "  First song ", now);
    expect(created).toMatchObject({
      title: "First song",
      createdAt: "2026-10-18T12:00:00.000Z",
      updatedAt: "2026-10-18T12:00:00.000Z",
    });
    expect(created.id).toMatch(/^prj_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await getProject(platform.localDb, created.id)).toEqual(created);
  });

  it("returns null for an unknown project", async () => {
    expect(await getProject(platform.localDb, "prj_01JZZZZZZZZZZZZZZZZZZZZZZZ")).toBeNull();
  });

  it("lists projects newest first", async () => {
    const a = await createProject(platform, "A", new Date("2026-01-01T00:00:00Z"));
    const b = await createProject(platform, "B", new Date("2026-02-01T00:00:00Z"));
    expect((await listProjects(platform.localDb)).map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it("refuses empty and over-long titles", async () => {
    await expect(createProject(platform, "   ")).rejects.toBeInstanceOf(ProjectTitleError);
    await expect(createProject(platform, "x".repeat(201))).rejects.toBeInstanceOf(
      ProjectTitleError,
    );
    expect(await listProjects(platform.localDb)).toEqual([]);
  });

  it("stores a project card in the blob cache and verifies it", async () => {
    const project = await createProject(platform, "Card");
    expect(await verifyProjectCard(platform, project)).toBe(true);
  });

  it("reports a missing or different project card", async () => {
    const project = await createProject(platform, "Card");
    expect(await verifyProjectCard(platform, { ...project, title: "Other" })).toBe(false);
  });
});
