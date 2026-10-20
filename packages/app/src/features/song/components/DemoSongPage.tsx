/**
 * `/demo`: opens a generated demo song in the Song Canvas.
 *
 * The URL carries the view state (01 §1: "zoom level and selection live in the URL"): `sel` is the
 * selection (07 §5). The other search params choose *which* demo to open and exist for the
 * end-to-end tests and the performance runs: `renderer` forces the GPU backend, `minutes` and
 * `tracks` pick the benchmark song, `stages` shows the progressive states of 07 §8, `audio`
 * switches the synthesised audio off.
 */
import type { AnalysisStageName, Selection } from "@bragi/render-canvas";
import { decodeSelection, encodeSelection } from "@bragi/render-canvas";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { t } from "../../../i18n/index.js";
import { usePlatform } from "../../../platform-context.js";
import { createSettingsStore } from "../../settings/state/settings-store.js";
import { createDemoSession, type DemoSession } from "../api/demo-session.js";
import { SongWorkspace } from "./SongWorkspace.js";

export interface DemoSearch {
  readonly sel?: string;
  readonly renderer?: "webgpu" | "webgl";
  readonly minutes?: number;
  readonly tracks?: number;
  readonly audio?: "0" | "1";
  readonly stages?: string;
  readonly e2e?: "1";
}

const STAGE_NAMES: readonly AnalysisStageName[] = [
  "ingest",
  "rhythm",
  "loudness_energy",
  "structure",
  "separation",
  "harmony",
  "tag",
  "describe",
];

/** Search validation for the route: unknown or malformed values are dropped, never thrown. */
export function validateDemoSearch(search: Record<string, unknown>): DemoSearch {
  const out: { -readonly [K in keyof DemoSearch]: DemoSearch[K] } = {};
  if (typeof search.sel === "string" && search.sel.length > 0) out.sel = search.sel;
  if (search.renderer === "webgpu" || search.renderer === "webgl") out.renderer = search.renderer;
  const minutes = Number(search.minutes);
  if (Number.isFinite(minutes) && minutes > 0 && minutes <= 60) out.minutes = minutes;
  const tracks = Number(search.tracks);
  if (Number.isInteger(tracks) && tracks >= 1 && tracks <= 24) out.tracks = tracks;
  if (search.audio === "0" || search.audio === "1" || search.audio === 0 || search.audio === 1) {
    out.audio = String(search.audio) as "0" | "1";
  }
  if (typeof search.stages === "string") out.stages = search.stages;
  if (search.e2e === "1" || search.e2e === 1) out.e2e = "1";
  return out;
}

function parseStages(text: string | undefined): AnalysisStageName[] | undefined {
  if (text === undefined) return undefined;
  const wanted = new Set(text.split(",").map((part) => part.trim()));
  return STAGE_NAMES.filter((stage) => wanted.has(stage));
}

export function DemoSongPage() {
  const platform = usePlatform();
  const search = useSearch({ from: "/demo" });
  const navigate = useNavigate({ from: "/demo" });
  const [session, setSession] = useState<DemoSession | null>(null);
  const [failed, setFailed] = useState(false);
  const settings = useMemo(() => createSettingsStore(platform.localDb), [platform.localDb]);
  useEffect(() => {
    void settings.load();
  }, [settings]);

  const params = useMemo(
    () => ({
      audio: search.audio !== "0" && search.minutes === undefined,
      minutes: search.minutes,
      tracks: search.tracks,
      stages: parseStages(search.stages),
    }),
    [search.audio, search.minutes, search.tracks, search.stages],
  );

  useEffect(() => {
    let alive = true;
    let opened: DemoSession | null = null;
    setSession(null);
    createDemoSession(platform, params).then(
      (next) => {
        if (!alive) {
          next.songStore.dispose();
          return;
        }
        opened = next;
        setSession(next);
      },
      (error: unknown) => {
        console.error("could not open the demo song", error);
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
      if (opened) {
        void opened.controller.dispose();
        opened.songStore.dispose();
      }
    };
  }, [platform, params]);

  const selection = useMemo(() => decodeSelection(search.sel), [search.sel]);
  const onSelectionChange = (next: Selection): void => {
    const encoded = encodeSelection(next);
    void navigate({
      search: (previous) => {
        const { sel: _drop, ...rest } = previous;
        return encoded === "" ? rest : { ...rest, sel: encoded };
      },
      replace: true,
    });
  };

  if (failed) return <p role="alert">{t("song.canvas.failed")}</p>;
  if (session === null) return <p data-testid="song-loading">{t("song.canvas.loading")}</p>;
  return (
    <section className="song-page" aria-label={t("song.demo.heading")}>
      {params.audio ? null : <p data-testid="demo-audio-off">{t("song.demo.audioOff")}</p>}
      <SongWorkspace
        songStore={session.songStore}
        controller={session.controller}
        settings={settings}
        analysis={session.analysis}
        selection={selection}
        onSelectionChange={onSelectionChange}
        {...(search.renderer === undefined ? {} : { renderer: search.renderer })}
        testHooks={search.e2e === "1"}
      />
    </section>
  );
}
