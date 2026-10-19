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
import type { AssetMeta, Project } from "@bragi/schemas";
import { useEffect, useRef, useState } from "react";

import { t } from "../../../i18n/index.js";
import { usePlatform } from "../../../platform-context.js";
import {
  artifactsForStage,
  mergeArtifacts,
  type StageArtifacts,
} from "../../analysis/api/analysis-view.js";
import { getProjectSnapshot } from "../../library/api/library-repo.js";
import { loadModel } from "../model/model-api.js";
import { createEngineController, type EngineController } from "../state/engine-controller.js";
import { createSongStore, type SongStore } from "../state/song-store.js";
import { type AnalysisData, SongWorkspace } from "./SongWorkspace.js";

const SAMPLE_RATE = 48_000;

interface Session {
  readonly store: SongStore;
  readonly controller: EngineController;
  readonly analysis: AnalysisData | null;
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
  const [session, setSession] = useState<Session | null>(null);
  const [failed, setFailed] = useState(false);
  const dispose = useRef<(() => void)[]>([]);

  useEffect(() => {
    let live = true;
    const cleanup: (() => void)[] = [];
    dispose.current = cleanup;
    (async () => {
      const snapshot = await getProjectSnapshot(platform, projectId);
      if (snapshot === null) return;
      const model = await loadModel();
      const store = createSongStore(model);
      store.load(snapshot, assetMetasFor(snapshot));
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
      setSession({ store, controller, analysis });
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
    <SongWorkspace
      songStore={session.store}
      controller={session.controller}
      analysis={session.analysis}
      selection={{ kind: "none" }}
      onSelectionChange={() => {}}
    />
  );
}
