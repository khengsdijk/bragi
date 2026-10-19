/**
 * Opens a stored project's snapshot in the Song Canvas (01 §5–§6).
 *
 * The document comes back from the BlobCache through `library-repo`; the view
 * data (energy, chords, ribbons, peaks) is rebuilt from the analysis blobs the
 * document points at, so a reload shows the same song without re-analysing it.
 * Everything still goes through `bragi-model`: the snapshot is loaded, not
 * parsed by hand.
 */

import type { BlobHash, Platform } from "@bragi/platform";
import { decodeSelection, encodeSelection, type Selection } from "@bragi/render-canvas";
import type { AssetMeta, Project } from "@bragi/schemas";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { t } from "../../../i18n/index.js";
import { usePlatform } from "../../../platform-context.js";
import {
  artifactsForStage,
  mergeArtifacts,
  type StageArtifacts,
} from "../../analysis/api/analysis-view.js";
import { apiFor, realtimeFor } from "../../analysis/api/host.js";
import { createUploadFlow } from "../../analysis/state/flow.js";
import { listCommits, readCommitSnapshot } from "../../history/api/history-repo.js";
import { createHistory, type History } from "../../history/state/history.js";
import { getProjectRow, getProjectSnapshot } from "../../library/api/library-repo.js";
import { progressText } from "../../library/components/progress.js";
import { loadModel } from "../model/model-api.js";
import { createEngineController, type EngineController } from "../state/engine-controller.js";
import { createSongStore, type SongStore } from "../state/song-store.js";
import { type AnalysisData, SongWorkspace } from "./SongWorkspace.js";

const SAMPLE_RATE = 48_000;

interface Session {
  readonly store: SongStore;
  readonly controller: EngineController;
  readonly history: History;
  readonly analysis: AnalysisData | null;
}

/** `#/song/<id>?e2e=1` exposes the canvas on `window.__bragi` for the end-to-end tests. */
function wantsTestHooks(search: Record<string, unknown>): boolean {
  return search.e2e === "1" || search.e2e === 1;
}

/** The AssetIndex metadata for every asset the document references. */
function assetMetasFor(doc: Project): AssetMeta[] {
  const durationSamples = doc.sources[0]?.durationSamples ?? 1;
  const metas = new Map<string, AssetMeta>();
  const add = (hash: string): void => {
    if (metas.has(hash)) return;
    metas.set(hash, {
      hash,
      mime: "audio/flac",
      bytes: 0,
      sampleRate: SAMPLE_RATE,
      channels: 2,
      durationSamples,
    });
  };
  for (const source of doc.sources) {
    add(source.originalAsset);
    add(source.workingAsset);
  }
  for (const ref of Object.values(doc.analyses)) {
    for (const hash of Object.values(ref.stems ?? {})) add(hash);
  }
  for (const section of doc.arrangement.sections) {
    for (const lane of Object.values(section.lanes)) {
      for (const clip of lane.clips) add(clip.asset);
    }
  }
  return [...metas.values()];
}

/** Rebuilds the canvas view data from the blobs the document records (07 §8). */
async function analysisFromSnapshot(
  platform: Platform,
  doc: Project,
): Promise<AnalysisData | null> {
  const tracks = doc.tracks.map((track) => ({ id: track.id, role: track.role }));
  let view: StageArtifacts = {};
  let found = false;
  for (const ref of Object.values(doc.analyses)) {
    for (const [stage, hash] of Object.entries(ref.blobs)) {
      const bytes = await platform.blobCache.get(hash as BlobHash);
      if (bytes === null) continue;
      const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
      view = mergeArtifacts(view, artifactsForStage(stage, json, { tracks }));
      found = true;
    }
  }
  return found ? (view as AnalysisData) : null;
}

export function StoredSongCanvas({ projectId }: { readonly projectId: string }) {
  const platform = usePlatform();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  // The selection lives in the URL, as on the demo page (01 §1).
  const sel = typeof search.sel === "string" ? search.sel : undefined;
  const selection = useMemo(() => decodeSelection(sel), [sel]);
  const onSelectionChange = (next: Selection): void => {
    const encoded = encodeSelection(next);
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => {
        const { sel: _drop, ...rest } = previous;
        return encoded === "" ? rest : { ...rest, sel: encoded };
      },
      replace: true,
    });
  };
  const [session, setSession] = useState<Session | null>(null);
  const [failed, setFailed] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const dispose = useRef<(() => void)[]>([]);

  useEffect(() => {
    let live = true;
    const cleanup: (() => void)[] = [];
    dispose.current = cleanup;
    (async () => {
      const model = await loadModel();
      const store = createSongStore(model);
      const history = createHistory({ platform, songStore: store, model, projectId });
      // A project with commits opens at HEAD, not at the project row's pointer
      // (which only mirrors HEAD). A pre-2.1 project keeps today's path and lets
      // `load()` create the "Imported" root from the stored snapshot.
      const commits = await listCommits(platform.localDb, projectId);
      let snapshot: Project | null = null;
      if (commits.length > 0) {
        await history.load();
        const state = history.store.getState();
        const head = state.head === null ? undefined : state.commits.get(state.head);
        if (head !== undefined) {
          try {
            snapshot = await readCommitSnapshot(platform, head.snapshotHash);
          } catch {
            // A missing commit blob falls back to the project row's snapshot.
          }
        }
      }
      snapshot ??= await getProjectSnapshot(platform, projectId);
      if (snapshot === null) return;
      store.load(snapshot, assetMetasFor(snapshot));
      await history.load();
      const durationSec = (snapshot.sources[0]?.durationSamples ?? 0) / SAMPLE_RATE;
      const controller = createEngineController({
        ...(platform.createEngine === undefined ? {} : { createEngine: platform.createEngine }),
        document: () => store.store.getState().doc,
        durationSec: () => durationSec,
      });
      const analysis = await analysisFromSnapshot(platform, snapshot);
      if (!live) {
        void controller.dispose();
        store.dispose();
        return;
      }
      cleanup.push(
        () => void controller.dispose(),
        () => store.dispose(),
      );
      setSession({ store, controller, history, analysis });

      // An analysis that was still running when this page opened (a reload, or the hand-over
      // from the drop zone) keeps merging into this document (Q82).
      const row = await getProjectRow(platform.localDb, projectId);
      if (!live || row?.assetHash == null || !platform.api) return;
      const realtime = realtimeFor(platform);
      const flow = createUploadFlow({
        platform,
        api: apiFor(platform),
        realtime,
        songStore: store,
        history,
        onState: (state) => {
          if (live) setProgress(state.phase === "ready" ? null : progressText(state));
        },
        onAnalysis: (data) => {
          if (live)
            setSession((current) => (current === null ? current : { ...current, analysis: data }));
        },
        onCommit: (commit, doc) => controller.commit(commit, doc),
      });
      cleanup.push(
        () => flow.dispose(),
        () => realtime.close(),
      );
      try {
        await flow.resume(
          analysis === null
            ? { assetHash: row.assetHash }
            : { assetHash: row.assetHash, view: analysis },
        );
      } catch (cause) {
        // Offline or signed out: the stored song stays usable, it just stops growing.
        console.warn("could not resume the analysis", cause);
      }
    })().catch((cause: unknown) => {
      console.error("could not open the stored song", cause);
      if (live) setFailed(true);
    });
    return () => {
      live = false;
      for (const fn of cleanup) fn();
    };
  }, [platform, projectId]);

  if (failed) return <p role="alert">{t("song.canvas.failed")}</p>;
  if (session === null) {
    return <p data-testid="stored-canvas-loading">{t("song.canvas.loading")}</p>;
  }
  return (
    <>
      {progress === null ? null : (
        <p role="status" data-testid="analysis-progress">
          {progress}
        </p>
      )}
      <SongWorkspace
        songStore={session.store}
        controller={session.controller}
        history={session.history}
        analysis={session.analysis}
        selection={selection}
        testHooks={wantsTestHooks(search)}
        onSelectionChange={onSelectionChange}
      />
    </>
  );
}
