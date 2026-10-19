import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type Platform, parseMigrations } from "@bragi/platform";
import { createMemoryPlatform } from "@bragi/platform/testing";
import type { OpBatch } from "@bragi/schemas";
import { beforeEach, describe, expect, it } from "vitest";

import { t } from "../../../i18n/index.js";
import { buildDemoProject, fakeAssetHash, SHORT_DEMO } from "../../song/api/demo-song.js";
import { loadModel, type ModelApi } from "../../song/model/model-api.js";
import {
  BranchNameError,
  branchRef,
  CommitSnapshotError,
  deleteRef,
  getDeviceId,
  getRef,
  headRef,
  insertCommit,
  listCommits,
  listRefs,
  MAX_BRANCH_NAME_LENGTH,
  makeCommitId,
  putCommitSnapshot,
  readCommitSnapshot,
  type StoredCommit,
  setCommitState,
  setRef,
  starRef,
} from "../api/history-repo.js";

const MIGRATIONS_DIR = new URL("../../../../../schemas/sqlite/migrations/", import.meta.url);
const migrations = parseMigrations(
  Object.fromEntries(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => [name, readFileSync(new URL(name, MIGRATIONS_DIR), "utf8")]),
  ),
);

// The real model wasm, loaded from bytes in Node like the song-store tests. The repository's
// commit ids and snapshots are only meaningful against the shipped canonical JSON.
const WASM = resolve(
  import.meta.dirname,
  "../../../../../model-wasm/generated/bragi_model_wasm_bg.wasm",
);

const PROJECT_ID = "prj_HISTORY000000000000000001";
const NOW = new Date("2026-10-19T12:00:00.000Z");
const EMPTY_HASH = `sha256:${"0".repeat(64)}`;

describe("history repository", () => {
  let platform: Platform;
  let model: ModelApi;
  let userBatch: OpBatch;

  beforeEach(async () => {
    platform = await createMemoryPlatform(migrations);
    const timestamp = NOW.toISOString();
    await platform.localDb.run(
      "INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [PROJECT_ID, "History", timestamp, timestamp],
    );
    model = await loadModel(readFileSync(WASM));
    userBatch = {
      id: "bat_HISTORY00000000000000001",
      author: { kind: "user" },
      label: "Mute Bass",
      ops: [{ op: "project.set_meta", title: "Renamed" }],
      createdAt: timestamp,
    };
  });

  function commit(overrides: Partial<StoredCommit> = {}): StoredCommit {
    const batch = overrides.batch ?? userBatch;
    return {
      id: "cmt_00000000000000000000000001",
      projectId: PROJECT_ID,
      parent: null,
      batch,
      label: batch.label,
      authorKind: batch.author.kind,
      snapshotHash: fakeAssetHash("snapshot"),
      state: "committed",
      candidateGroup: null,
      deviceId: "dev_HISTORY000000000000000001",
      createdAt: NOW.toISOString(),
      seq: null,
      ...overrides,
    };
  }

  it("creates one stable device id, even for concurrent callers", async () => {
    const first = await getDeviceId(platform.localDb);
    const second = await getDeviceId(platform.localDb);
    expect(first).toMatch(/^dev_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second).toBe(first);

    // Both calls generate their own candidate, but only the first INSERT wins.
    const [left, right] = await Promise.all([
      getDeviceId(platform.localDb),
      getDeviceId(platform.localDb),
    ]);
    expect(left).toBe(first);
    expect(right).toBe(first);

    const rows = await platform.localDb.query(
      "SELECT value FROM local_settings WHERE key = 'deviceId'",
    );
    expect(rows).toEqual([{ value: first }]);
  });

  it("lists commits by created_at and id, with their batches", async () => {
    const aiBatch: OpBatch = {
      ...userBatch,
      id: "bat_HISTORY00000000000000002",
      author: { kind: "ai", planId: "pln_HISTORY00000000000000001", model: "test-model" },
      label: "Make it dreamy",
    };
    await insertCommit(
      platform.localDb,
      commit({ id: "cmt_zzz", createdAt: "2026-10-19T12:00:02Z" }),
    );
    await insertCommit(
      platform.localDb,
      commit({ id: "cmt_bbb", createdAt: "2026-10-19T12:00:02Z" }),
    );
    await insertCommit(
      platform.localDb,
      commit({ id: "cmt_aaa", batch: aiBatch, createdAt: "2026-10-19T12:00:01Z" }),
    );

    const commits = await listCommits(platform.localDb, PROJECT_ID);
    expect(commits.map((it) => it.id)).toEqual(["cmt_aaa", "cmt_bbb", "cmt_zzz"]);
    expect(commits[0]?.authorKind).toBe("ai");
    expect(commits[0]?.batch).toEqual(aiBatch);
    expect(commits[0]?.label).toBe("Make it dreamy");
    expect(commits[0]?.seq).toBeNull();
  });

  it("ignores a duplicate commit but still leaves one outbox row", async () => {
    const stored = commit({ id: "cmt_idempotent" });
    await insertCommit(platform.localDb, stored);
    await insertCommit(platform.localDb, stored);

    expect(await listCommits(platform.localDb, PROJECT_ID)).toEqual([stored]);
    expect(await platform.localDb.query("SELECT commit_id FROM outbox ORDER BY commit_id")).toEqual(
      [{ commit_id: stored.id }],
    );
  });

  it("mirrors the project snapshot pointer for a HEAD commit", async () => {
    const stored = commit({ id: "cmt_head", snapshotHash: fakeAssetHash("head") });
    await insertCommit(platform.localDb, stored, { mirrorProject: true });

    expect(
      await platform.localDb.query("SELECT snapshot_hash, updated_at FROM projects WHERE id = ?", [
        PROJECT_ID,
      ]),
    ).toEqual([{ snapshot_hash: stored.snapshotHash, updated_at: stored.createdAt }]);
  });

  it("upserts, lists and deletes refs by their 05 §5 names", async () => {
    const deviceId = await getDeviceId(platform.localDb);
    const first = commit({ id: "cmt_ref_first" });
    const second = commit({ id: "cmt_ref_second" });
    await insertCommit(platform.localDb, first);
    await insertCommit(platform.localDb, second);

    await setRef(platform.localDb, PROJECT_ID, headRef(deviceId), first.id, NOW);
    await setRef(platform.localDb, PROJECT_ID, branchRef("  Club  "), first.id, NOW);
    await setRef(platform.localDb, PROJECT_ID, starRef(first.id), first.id, NOW);
    expect(headRef(deviceId)).toBe(`head:${deviceId}`);
    expect(starRef(first.id)).toBe(`star:${first.id}`);
    expect(await getRef(platform.localDb, PROJECT_ID, "branch:Club")).toBe(first.id);

    const later = new Date("2026-10-19T13:00:00.000Z");
    await setRef(platform.localDb, PROJECT_ID, branchRef("Club"), second.id, later);
    expect(await getRef(platform.localDb, PROJECT_ID, "branch:Club")).toBe(second.id);

    expect((await listRefs(platform.localDb, PROJECT_ID)).map((ref) => ref.name)).toEqual([
      "branch:Club",
      `head:${deviceId}`,
      `star:${first.id}`,
    ]);

    await deleteRef(platform.localDb, PROJECT_ID, branchRef("Club"));
    expect(await getRef(platform.localDb, PROJECT_ID, "branch:Club")).toBeNull();
    // Deleting an absent ref is a no-op.
    await deleteRef(platform.localDb, PROJECT_ID, branchRef("Missing"));
  });

  it("rejects blank, over-long and colon-bearing branch names", async () => {
    expect(() => branchRef("   ")).toThrow(BranchNameError);
    expect(() => branchRef("   ")).toThrow(t("history.branchRequired"));
    expect(() => branchRef("x".repeat(MAX_BRANCH_NAME_LENGTH + 1))).toThrow(
      t("history.branchTooLong"),
    );
    expect(() => branchRef("club:version")).toThrow(t("history.branchInvalid"));
    expect(branchRef("  Club  ")).toBe("branch:Club");
    expect(branchRef("x".repeat(MAX_BRANCH_NAME_LENGTH))).toBe(
      `branch:${"x".repeat(MAX_BRANCH_NAME_LENGTH)}`,
    );

    await expect(
      setRef(platform.localDb, PROJECT_ID, "branch:   ", "cmt_any", NOW),
    ).rejects.toBeInstanceOf(BranchNameError);
  });

  it("round-trips a canonical snapshot through the blob cache", async () => {
    const built = buildDemoProject(SHORT_DEMO, {
      assetFor: (key) => fakeAssetHash(`snapshot:${key}`),
    });
    const handle = model.loadProject(JSON.stringify(built.project));
    try {
      const { hash, bytes } = await putCommitSnapshot(platform, model, handle);
      expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(new TextDecoder().decode(bytes)).toBe(model.canonicalJson(handle));
      expect(await readCommitSnapshot(platform, hash)).toEqual(built.project);
    } finally {
      model.freeDoc(handle);
    }

    await expect(readCommitSnapshot(platform, EMPTY_HASH)).rejects.toBeInstanceOf(
      CommitSnapshotError,
    );
  });

  it("derives a deterministic `cmt_` id from parent, batch and snapshot", async () => {
    const root = makeCommitId(model, null, userBatch, EMPTY_HASH);
    expect(root).toMatch(/^cmt_[0-9A-Za-z]{1,64}$/);
    expect(root).toBe(makeCommitId(model, null, userBatch, EMPTY_HASH));
    expect(makeCommitId(model, "cmt_parent", userBatch, EMPTY_HASH)).not.toBe(root);
    expect(makeCommitId(model, null, userBatch, fakeAssetHash("other"))).not.toBe(root);

    const child = makeCommitId(model, root, userBatch, EMPTY_HASH);
    expect(child).not.toBe(root);
  });

  it("stores a candidate group and changes state for several commits", async () => {
    const first = commit({
      id: "cmt_candidate_one",
      state: "candidate",
      candidateGroup: "grp_ai_request",
    });
    const second = commit({ id: "cmt_candidate_two", state: "candidate" });
    await insertCommit(platform.localDb, first);
    await insertCommit(platform.localDb, second);

    expect((await listCommits(platform.localDb, PROJECT_ID))[0]?.candidateGroup).toBe(
      "grp_ai_request",
    );
    await setCommitState(platform.localDb, [first.id, second.id], "discarded");
    expect((await listCommits(platform.localDb, PROJECT_ID)).map((it) => it.state)).toEqual([
      "discarded",
      "discarded",
    ]);
    await setCommitState(platform.localDb, [], "committed");
  });

  it("lists 1 000 commits in under 200 ms", async () => {
    const base = Date.parse("2026-10-19T00:00:00.000Z");
    for (let index = 0; index < 1000; index += 1) {
      await insertCommit(
        platform.localDb,
        commit({
          id: `cmt_${String(index).padStart(8, "0")}`,
          createdAt: new Date(base + index * 1000).toISOString(),
        }),
      );
    }

    const started = performance.now();
    const commits = await listCommits(platform.localDb, PROJECT_ID);
    const elapsed = performance.now() - started;
    console.info(`listCommits for 1 000 commits: ${elapsed.toFixed(2)} ms`);
    expect(commits).toHaveLength(1000);
    // The WP budget is 200 ms (docs/wp/2.1.md); the query alone is well under it.
    expect(elapsed).toBeLessThan(200);
  });
});
