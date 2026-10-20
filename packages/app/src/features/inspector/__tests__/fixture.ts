/**
 * Shared setup for the Inspector tests: the real `bragi-model`, the real history store over an
 * in-memory platform, and a demo song with four empty effect chains.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { EngineHost, EngineState, TransportCmd } from "@bragi/platform";
import { type Platform, parseMigrations } from "@bragi/platform";
import { createMemoryPlatform } from "@bragi/platform/testing";
import type { Project } from "@bragi/schemas";
import { vi } from "vitest";

import { createHistory, type History } from "../../history/state/history.js";
import { loadTestModel } from "../../song/__tests__/fixtures.js";
import { buildDemoProject, fakeAssetHash, SHORT_DEMO } from "../../song/api/demo-song.js";
import type { ModelApi } from "../../song/model/model-api.js";
import { createSongStore, type SongStore } from "../../song/state/song-store.js";

// jsdom implements the pointer events Radix's Slider reads but not the capture API it calls.
// The gesture test runs in Node, where there is no DOM at all.
if (typeof Element !== "undefined") {
  for (const method of ["setPointerCapture", "releasePointerCapture"] as const) {
    if (!(method in Element.prototype)) {
      Object.defineProperty(Element.prototype, method, {
        writable: true,
        configurable: true,
        value: () => {},
      });
    }
  }
  if (!("hasPointerCapture" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "hasPointerCapture", {
      writable: true,
      configurable: true,
      value: () => true,
    });
  }
  if (!("scrollIntoView" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      writable: true,
      configurable: true,
      value: () => {},
    });
  }
  if (!("ResizeObserver" in globalThis)) {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      writable: true,
      configurable: true,
      value: ResizeObserverStub,
    });
  }
}

// `import.meta.url` is not a file URL under jsdom, so resolve from this file's directory.
const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../../../../schemas/sqlite/migrations/");
const migrations = parseMigrations(
  Object.fromEntries(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => [name, readFileSync(resolve(MIGRATIONS_DIR, name), "utf8")]),
  ),
);

export const NOW = new Date("2026-10-19T12:00:00.000Z");
const PROJECT_ID = "prj_INSPECTORTEST00000000001";

export interface InspectorFixture {
  readonly platform: Platform;
  readonly model: ModelApi;
  readonly store: SongStore;
  readonly history: History;
  readonly project: Project;
}

/** Opens a demo song, its history root, and the stores the Inspector reads. */
export async function openInspectorFixture(): Promise<InspectorFixture> {
  const platform = await createMemoryPlatform(migrations);
  const model = await loadTestModel();
  const built = buildDemoProject(SHORT_DEMO, {
    assetFor: (key) => fakeAssetHash(`inspector:${key}`),
    projectId: PROJECT_ID.slice("prj_".length),
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
  return { platform, model, store, history, project: built.project };
}

/** The current document, or a failure when the fixture did not load one. */
export function liveDoc(fixture: InspectorFixture): Project {
  const doc = fixture.store.store.getState().doc;
  if (doc === null) throw new Error("the fixture has no document");
  return doc;
}

export interface FakeHost {
  readonly host: EngineHost;
  readonly commands: TransportCmd[];
  emit(state: Partial<EngineState>): void;
}

/** An EngineHost that records calls instead of making sound. */
export function fakeHost(): FakeHost {
  const commands: TransportCmd[] = [];
  const listeners = new Set<(state: EngineState) => void>();
  const host = {
    init: vi.fn(async () => {}),
    loadDocument: vi.fn(async () => {}),
    applyDelta: vi.fn(),
    setPreview: vi.fn(),
    transport: vi.fn((cmd: TransportCmd) => {
      commands.push(cmd);
    }),
    warm: vi.fn(async () => {}),
    release: vi.fn(),
    audition: vi.fn(),
    render: vi.fn(),
    peaks: vi.fn(),
    spectrogram: vi.fn(),
    onState: vi.fn((callback: (state: EngineState) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }),
    onEvent: vi.fn(() => () => {}),
    dispose: vi.fn(async () => {}),
  } satisfies EngineHost;
  const emit = (state: Partial<EngineState>): void => {
    for (const listener of listeners) {
      listener({
        transport: "stopped",
        playhead: 0,
        auditioning: false,
        planVersion: 1,
        underruns: 0,
        tracks: [],
        master: { peak: 0, rms: 0 },
        ...state,
      });
    }
  };
  return { host, commands, emit };
}
