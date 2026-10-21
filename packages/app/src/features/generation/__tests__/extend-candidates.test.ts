/**
 * Extend candidates → placement → generated analysis, with the real `bragi-model` wasm and the
 * history store (`specs/09-generation.md` §4.2, `specs/02-song-model.md` §7).
 *
 * The job is fake: partials carry only an asset and a gate result, exactly the shape the worker
 * will emit. Every document change still goes through the model and a history commit.
 */
import { readdirSync, readFileSync } from "node:fs";

import { type Platform, parseMigrations } from "@bragi/platform";
import { createMemoryPlatform } from "@bragi/platform/testing";
import type { Project, SeparationResult } from "@bragi/schemas";
import { describe, expect, it } from "vitest";

import { createHistory, type History } from "../../history/state/history.js";
import { loadTestModel } from "../../song/__tests__/fixtures.js";
import { buildDemoProject, fakeAssetHash, SHORT_DEMO } from "../../song/api/demo-song.js";
import { createSongStore, type SongStore } from "../../song/state/song-store.js";
import {
  addExtendCandidates,
  type ExtendCandidatePartial,
  type ExtendJob,
} from "../state/extend-candidates.js";
import { applyGeneratedAnalysis, generatedSourceFor } from "../state/generated-analysis.js";

const MIGRATIONS_DIR = new URL("../../../../../schemas/sqlite/migrations/", import.meta.url);
const migrations = parseMigrations(
  Object.fromEntries(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => [name, readFileSync(new URL(name, MIGRATIONS_DIR), "utf8")]),
  ),
);

const NOW = new Date("2026-10-21T12:00:00.000Z");
/** `generate.extend` asks for `bars + 2` bars; the asset is four bars. */
const ASSET_SAMPLES = 4 * 96_000;
/** The demo is 16 bars: the context ends on its last bar line. */
const TOTAL_TICKS = 16 * 3_840;

interface Fixture {
  readonly platform: Platform;
  readonly store: SongStore;
  readonly history: History;
  readonly project: Project;
}

async function openFixture(): Promise<Fixture> {
  const platform = await createMemoryPlatform(migrations);
  const model = await loadTestModel();
  const built = buildDemoProject(SHORT_DEMO, {
    assetFor: (key) => fakeAssetHash(`generation:${key}`),
    projectId: "GENERATIONTEST0000000001",
  });
  await platform.localDb.run(
    `INSERT OR IGNORE INTO projects (id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    [built.project.id, built.project.meta.title, built.project.meta.createdAt, NOW.toISOString()],
  );
  const store = createSongStore(model);
  store.load(built.project, built.assets);
  const history = createHistory({
    platform,
    songStore: store,
    model,
    projectId: built.project.id,
    now: () => NOW,
  });
  await history.load();
  return { platform, store, history, project: built.project };
}

function job(group = "extend-1"): ExtendJob {
  return {
    group,
    direction: "forward",
    bars: 2,
    contextRange: { startTick: 0, endTick: TOTAL_TICKS },
    crossfadeTicks: 480,
    prompt: "dreamy outro",
    model: "ace-step",
    modelVersion: "1.5.0",
    jobId: "job_01JAB4X2C3D4E5F6G7H8J9KMNP",
  };
}

function partial(seed: string, spliceOffsetSamples = -48_000): ExtendCandidatePartial {
  return {
    asset: {
      hash: fakeAssetHash(`candidate:${seed}`),
      durationSamples: ASSET_SAMPLES,
      channels: 2,
    },
    result: { spliceOffsetSamples },
  };
}

function document(store: SongStore): Project {
  const doc = store.store.getState().doc;
  if (doc === null) throw new Error("no document");
  return doc;
}

/** Accepts the first candidate so the generated source is the live document. */
async function acceptFirstCandidate(
  fixture: Fixture,
): Promise<{ sourceId: string; sectionId: string; assetHash: string }> {
  const [candidate] = await addExtendCandidates(
    { songStore: fixture.store, history: fixture.history, now: () => NOW },
    job(),
    [partial("a"), partial("b")],
  );
  if (candidate === undefined) throw new Error("no candidate");
  const outcome = await fixture.history.accept(candidate.id);
  if (outcome === null || !outcome.ok) throw new Error("candidate did not accept");

  const doc = document(fixture.store);
  const source = doc.sources.find(
    (entry) => entry.kind === "generated" && entry.placement !== undefined,
  );
  if (source === undefined || source.placement === undefined) {
    throw new Error("the accepted candidate has no placed source");
  }
  return {
    sourceId: source.id,
    sectionId: source.placement.sectionId,
    assetHash: source.workingAsset,
  };
}

describe("extend candidates", () => {
  it("turns job partials into one candidate commit per candidate", async () => {
    const fixture = await openFixture();
    const head = fixture.history.store.getState().head;
    const candidates = await addExtendCandidates(
      { songStore: fixture.store, history: fixture.history, now: () => NOW },
      job(),
      [partial("a"), partial("b")],
    );

    expect(candidates).toHaveLength(2);
    const state = fixture.history.store.getState();
    expect(state.head).toBe(head);
    for (const candidate of candidates) {
      expect(candidate.state).toBe("candidate");
      expect(candidate.candidateGroup).toBe("extend-1");
      expect(candidate.batch.ops[0]?.op).toBe("source.add");
      const snapshot = await fixture.history.readSnapshot(candidate.id);
      expect(snapshot?.arrangement.sections).toHaveLength(
        fixture.project.arrangement.sections.length + 1,
      );
      expect(snapshot?.sources[0]?.kind).toBe("generated");
    }

    // The clip starts at the context edge: the gate's −48 000 sample splice skips the overlap.
    const snapshot = await fixture.history.readSnapshot(candidates[0]?.id ?? "");
    const section = snapshot?.arrangement.sections.at(-1);
    const generated = snapshot?.tracks.find((track) => track.role === "generated");
    expect(section?.kind).toBe("chorus");
    expect(section?.transitionIn.kind).toBe("crossfade");
    const clip = generated === undefined ? undefined : section?.lanes[generated.id]?.clips[0];
    expect(clip?.srcStart).toBe(48_000);
    expect(clip?.fadeInTicks).toBe(480);
    expect(clip?.provenance.kind).toBe("generation");

    // The index knows the candidate's asset, which candidate validation needs.
    expect(fixture.store.assets().some((asset) => asset.hash === partial("a").asset.hash)).toBe(
      true,
    );
  });

  it("does nothing for an empty partial list", async () => {
    const fixture = await openFixture();
    const candidates = await addExtendCandidates(
      { songStore: fixture.store, history: fixture.history, now: () => NOW },
      job(),
      [],
    );
    expect(candidates).toEqual([]);
    expect(fixture.history.store.getState().commits.size).toBe(1);
  });
});

describe("generated analysis", () => {
  it("maps separation stems onto matching tracks as one history batch", async () => {
    const fixture = await openFixture();
    const accepted = await acceptFirstCandidate(fixture);
    const before = fixture.history.store.getState().commits.size;

    const separation: SeparationResult = {
      schemaVersion: 1,
      model: "htdemucs_6s-1",
      stems: [
        { role: "drums", asset: fakeAssetHash("stem:drums") },
        { role: "vocals", asset: fakeAssetHash("stem:vocals") },
      ],
      residual: fakeAssetHash("stem:residual"),
    };
    const outcome = await applyGeneratedAnalysis(
      { songStore: fixture.store, history: fixture.history, now: () => NOW },
      {
        assetHash: accepted.assetHash,
        stage: "separation",
        blob: fakeAssetHash("blob:separation"),
        json: separation,
      },
    );
    expect(outcome.ok).toBe(true);

    const doc = document(fixture.store);
    const section = doc.arrangement.sections.find((entry) => entry.id === accepted.sectionId);
    const generated = doc.tracks.find((track) => track.role === "generated");
    expect(generated).toBeUndefined();
    expect(doc.sources.some((source) => source.id === accepted.sourceId)).toBe(true);

    for (const [role, asset] of [
      ["drums", fakeAssetHash("stem:drums")],
      ["vocals", fakeAssetHash("stem:vocals")],
      ["residual", fakeAssetHash("stem:residual")],
    ] as const) {
      const track = doc.tracks.find((entry) => entry.role === role);
      expect(track, role).toBeDefined();
      const lanes = section?.lanes ?? {};
      const lane = track === undefined ? undefined : lanes[track.id];
      expect(lane?.clips[0]?.asset, role).toBe(asset);
    }

    // One commit, labelled for the History panel.
    expect(fixture.history.store.getState().commits.size).toBe(before + 1);
    const head = fixture.history.store.getState().head;
    expect(
      head === null ? undefined : fixture.history.store.getState().commits.get(head)?.label,
    ).toBe("Generated audio: separation");
  });

  it("leaves the generated lane when separation has not reported", async () => {
    const fixture = await openFixture();
    const accepted = await acceptFirstCandidate(fixture);
    const tag = {
      schemaVersion: 1,
      genres: [{ label: "synthwave", score: 0.8 }],
      moods: [],
      instruments: [],
      descriptors: [],
    };
    const outcome = await applyGeneratedAnalysis(
      { songStore: fixture.store, history: fixture.history, now: () => NOW },
      {
        assetHash: accepted.assetHash,
        stage: "tag",
        blob: fakeAssetHash("blob:tag"),
        json: tag,
      },
    );
    expect(outcome.ok).toBe(true);

    const doc = document(fixture.store);
    const generated = doc.tracks.find((track) => track.role === "generated");
    expect(generated).toBeDefined();
    const section = doc.arrangement.sections.find((entry) => entry.id === accepted.sectionId);
    const lane = generated === undefined ? undefined : section?.lanes[generated.id];
    expect(lane?.clips).toHaveLength(1);
    expect(doc.meta.tags).toContain("synthwave");
  });

  it("routes by asset hash and rejects an unknown asset", async () => {
    const fixture = await openFixture();
    const accepted = await acceptFirstCandidate(fixture);
    const doc = document(fixture.store);
    expect(generatedSourceFor(doc, accepted.assetHash)?.id).toBe(accepted.sourceId);
    expect(generatedSourceFor(doc, fakeAssetHash("nope"))).toBeUndefined();

    await expect(
      applyGeneratedAnalysis(
        { songStore: fixture.store, history: fixture.history, now: () => NOW },
        {
          assetHash: fakeAssetHash("nope"),
          stage: "tag",
          blob: fakeAssetHash("blob:tag"),
          json: {},
        },
      ),
    ).rejects.toThrow("no generated source");
  });
});
