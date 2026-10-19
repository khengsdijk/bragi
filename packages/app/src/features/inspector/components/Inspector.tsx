/**
 * The Inspector (07 §4.5): one track's level, pan, vibe sliders and expert fx chain, or the
 * master chain when no single track is selected.
 *
 * Everything shown comes from the Song Store's document (or its running gesture preview), so an
 * undo, a redo or a checkout moves every control back to the truth. Edits are op batches: a
 * pointer drag previews and commits once on release, while a keyboard step (and every button)
 * commits one edit immediately.
 */
import { Button, IconButton, Slider, VibeSlider } from "@bragi/design";
import type { Selection } from "@bragi/render-canvas";
import type { CatalogNumberParam, OpBatch, Project, Track } from "@bragi/schemas";
import { FX_CATALOG } from "@bragi/schemas";
import { useCallback, useRef, useState } from "react";
import { useStore } from "zustand";

import { t } from "../../../i18n/index.js";
import { type Gesture, startGesture } from "../../history/state/gesture.js";
import type { History } from "../../history/state/history.js";
import { trackToggleBatch } from "../../song/state/ops.js";
import type { ApplyOutcome, Commit, SongStore } from "../../song/state/song-store.js";
import { trackValueBatch } from "../api/batches.js";
import { formatDb, formatPan, formatVibe } from "../format.js";
import { macroPoles, vibeMacros } from "../labels.js";
import { type MacroScope, macroBatch, macroNameKey, macroValue } from "../macros.js";
import type { BatchBuilder, GestureEdit } from "../types.js";
import { ExpertDrawer } from "./ExpertDrawer.js";

export interface InspectorProps {
  readonly songStore: SongStore;
  readonly history?: History;
  /** Forwards gesture and commit deltas to the engine, exactly like the canvas does. */
  readonly onCommit: (commit: Commit, doc: Project) => void;
  readonly selection: Selection;
  readonly onClose: () => void;
  /** The workspace's polite live region. */
  readonly onAnnounce?: (message: string) => void;
}

interface ActiveGesture {
  readonly gesture: Gesture;
  lastValue: number;
  label: string;
}

/** The catalogue's `gain.db` range, which 02 §3.4 leaves unspecified for the track fader. */
function gainSpec(): CatalogNumberParam | null {
  const spec = FX_CATALOG.fx.gain?.params.db;
  return spec !== undefined && spec.type === "number" ? spec : null;
}

/** The one selected track, or `null` when the inspector is the master's. */
function selectedTrack(selection: Selection): string | null {
  return selection.kind === "tracks" && selection.ids.length === 1
    ? (selection.ids[0] ?? null)
    : null;
}

/** Ops that remove a focused control, so the panel restores focus afterwards. */
function isStructural(batch: OpBatch): boolean {
  return batch.ops.some(
    (op) => op.op === "fx.remove" || op.op === "fx.add" || op.op === "fx.reorder",
  );
}

export function Inspector({
  songStore,
  history,
  onCommit,
  selection,
  onClose,
  onAnnounce,
}: InspectorProps) {
  const doc = useStore(songStore.store, (state) => state.doc);
  const preview = useStore(songStore.store, (state) => state.preview);
  const view = preview ?? doc;

  const [expertOpen, setExpertOpen] = useState(false);
  const expertHeading = useRef<HTMLHeadingElement | null>(null);
  const interaction = useRef<ActiveGesture | null>(null);
  /** The value Radix has just committed from the keyboard; the following change is its echo. */
  const suppressed = useRef<number | null>(null);

  /**
   * Ignores the change event Radix emits after a keyboard commit. It is cleared on the next task,
   * so a later deliberate edit at the same value is not mistaken for an echo.
   */
  const suppressEcho = useCallback((value: number): void => {
    suppressed.current = value;
    setTimeout(() => {
      if (Object.is(suppressed.current, value)) suppressed.current = null;
    }, 0);
  }, []);

  const announce = useCallback(
    (message: string) => {
      onAnnounce?.(message);
    },
    [onAnnounce],
  );

  const currentDoc = useCallback(
    (): Project | null => songStore.store.getState().preview ?? songStore.store.getState().doc,
    [songStore],
  );

  /** One committed batch: through history when there is a project row, else straight in. */
  const applyBatch = useCallback(
    (batch: OpBatch | null): void => {
      if (batch === null) return;
      const run: Promise<ApplyOutcome> = history
        ? history.commit(batch)
        : Promise.resolve(songStore.apply(batch));
      void run
        .then((outcome) => {
          if (!outcome.ok) {
            announce(t("song.live.rejected"));
            return;
          }
          onCommit(outcome.commit, outcome.doc);
          announce(batch.label);
          if (isStructural(batch) && expertOpen) {
            // The clicked control may be gone (remove) or moved; the drawer heading is stable.
            setTimeout(() => expertHeading.current?.focus(), 0);
          }
        })
        .catch((cause: unknown) => {
          console.warn("could not commit the inspector edit", cause);
          announce(t("song.live.rejected"));
        });
    },
    [announce, expertOpen, history, onCommit, songStore],
  );

  const startDrag = useCallback((): Gesture | null => {
    const commit = history?.commit ?? ((batch: OpBatch) => Promise.resolve(songStore.apply(batch)));
    return startGesture({
      songStore,
      history: { commit },
      engine: (commitValue, nextDoc) => onCommit(commitValue, nextDoc),
    });
  }, [history, onCommit, songStore]);

  const finishGesture = useCallback(
    (state: ActiveGesture, value: number, build: BatchBuilder): void => {
      if (!Object.is(state.lastValue, value)) {
        const current = currentDoc();
        if (current !== null) {
          const batch = build(current);
          if (batch !== null) {
            const outcome = state.gesture.step(batch);
            if (outcome.ok) state.label = batch.label;
          }
        }
      }
      const label = state.label;
      void state.gesture.commit(label).then((outcome) => {
        if (outcome === null) return;
        if (outcome.ok) announce(label);
        else announce(t("song.live.rejected"));
      });
    },
    [announce, currentDoc],
  );

  const edit: GestureEdit = {
    step(value, build) {
      if (suppressed.current !== null) {
        if (Object.is(suppressed.current, value)) {
          suppressed.current = null;
          return;
        }
        suppressed.current = null;
      }
      let state = interaction.current;
      if (state === null) {
        const gesture = startDrag();
        if (gesture === null) return;
        state = { gesture, lastValue: Number.NaN, label: "" };
        interaction.current = state;
      }
      if (Object.is(state.lastValue, value)) return;
      const current = currentDoc();
      if (current === null) return;
      const batch = build(current);
      if (batch === null) return;
      const outcome = state.gesture.step(batch);
      if (outcome.ok) {
        state.lastValue = value;
        state.label = batch.label;
      }
    },
    finish(value, build) {
      const state = interaction.current;
      if (state === null) {
        // Radix reports a keyboard step as a commit without a drag. It is one immediate edit.
        suppressEcho(value);
        const current = currentDoc();
        if (current === null) return;
        applyBatch(build(current));
        return;
      }
      interaction.current = null;
      suppressEcho(value);
      finishGesture(state, value, build);
    },
  };

  const trackId = selectedTrack(selection);
  const track =
    trackId === null ? null : (view?.tracks.find((item) => item.id === trackId) ?? null);
  const scope: MacroScope =
    track === null ? { kind: "master" } : { kind: "track", trackId: track.id };
  const chain = track === null ? (view?.arrangement.master.fx ?? []) : track.fx;
  const master = track === null;

  if (view === null) {
    return (
      <aside aria-label={t("inspector.label")} data-testid="inspector-panel">
        <p>{t("song.canvas.loading")}</p>
      </aside>
    );
  }

  const title = track?.name ?? t("inspector.master");
  const gain = gainSpec();

  return (
    <aside
      aria-label={t("inspector.label")}
      data-testid="inspector-panel"
      style={{
        display: "grid",
        gap: "var(--space-3)",
        alignContent: "start",
        minWidth: 0,
        padding: "var(--space-3)",
        border: "1px solid var(--color-line)",
        borderRadius: "var(--radius-lg)",
        background: "var(--color-surface)",
        color: "var(--color-text)",
      }}
    >
      <header style={{ display: "flex", alignItems: "start", gap: "var(--space-2)" }}>
        <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              color: "var(--color-text-muted)",
              fontSize: "var(--text-xs)",
            }}
          >
            {master ? t("inspector.masterHint") : t("inspector.track")}
          </p>
          <h2
            style={{
              margin: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              fontSize: "var(--text-lg)",
            }}
          >
            {title}
          </h2>
        </div>
        <span style={{ flex: 1 }} />
        <IconButton label={t("inspector.close")} size="sm" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </IconButton>
      </header>

      {track === null ? null : (
        <TrackControls track={track} doc={view} edit={edit} apply={applyBatch} gain={gain} />
      )}

      <section
        aria-labelledby="inspector-vibe-heading"
        style={{ display: "grid", gap: "var(--space-2)" }}
      >
        <h3 id="inspector-vibe-heading" style={{ margin: 0, fontSize: "var(--text-base)" }}>
          {t("inspector.vibe.heading")}
        </h3>
        {vibeMacros().map((macro) => {
          const poles = macroPoles(macro);
          const labelKey = macroNameKey(macro.id);
          const label = labelKey === null ? macro.label : t(labelKey);
          const value = macroValue(view, scope, macro.id);
          return (
            <VibeSlider
              key={macro.id}
              label={label}
              endLabels={poles}
              value={value}
              getValueText={(next) => formatVibe(next, poles)}
              onValueChange={(next) =>
                edit.step(next, (current) => macroBatch(current, scope, macro.id, next))
              }
              onValueCommit={(next) =>
                edit.finish(next, (current) => macroBatch(current, scope, macro.id, next))
              }
            />
          );
        })}
      </section>

      <ExpertDrawer
        scope={master ? { kind: "master" } : { kind: "track", trackId: track?.id ?? "" }}
        chain={chain}
        tracks={view.tracks}
        trackId={track?.id ?? null}
        edit={edit}
        apply={applyBatch}
        open={expertOpen}
        onToggle={() => setExpertOpen((open) => !open)}
        headingRef={expertHeading}
        contentId="inspector-expert-content"
      />
    </aside>
  );
}

interface TrackControlsProps {
  readonly track: Track;
  readonly doc: Project;
  readonly edit: GestureEdit;
  readonly apply: (batch: OpBatch | null) => void;
  readonly gain: CatalogNumberParam | null;
}

function TrackControls({ track, doc, edit, apply, gain }: TrackControlsProps) {
  const name = track.name;
  const gainMin = gain?.min ?? -60;
  const gainMax = gain?.max ?? 12;

  return (
    <section
      aria-labelledby="inspector-mixer-heading"
      style={{ display: "grid", gap: "var(--space-2)" }}
    >
      <h3 id="inspector-mixer-heading" style={{ margin: 0, fontSize: "var(--text-base)" }}>
        {t("inspector.mixer.heading")}
      </h3>
      <div style={{ display: "flex", gap: "var(--space-1)" }}>
        <Button
          variant={track.solo ? "primary" : "secondary"}
          size="sm"
          aria-pressed={track.solo}
          onClick={() => apply(trackToggleBatch(doc, track.id, "solo", !track.solo))}
        >
          {t(track.solo ? "song.track.unsolo" : "song.track.solo", { name })}
        </Button>
        <Button
          variant={track.mute ? "primary" : "secondary"}
          size="sm"
          aria-pressed={track.mute}
          onClick={() => apply(trackToggleBatch(doc, track.id, "mute", !track.mute))}
        >
          {t(track.mute ? "song.track.unmute" : "song.track.mute", { name })}
        </Button>
      </div>
      <Slider
        label={t("inspector.volume")}
        min={gainMin}
        max={gainMax}
        step={0.1}
        value={track.gainDb}
        showValue
        formatValue={formatDb}
        onValueChange={(next) =>
          edit.step(next, (current) => trackValueBatch(current, track.id, "gainDb", next))
        }
        onValueCommit={(next) =>
          edit.finish(next, (current) => trackValueBatch(current, track.id, "gainDb", next))
        }
      />
      <VibeSlider
        label={t("inspector.pan")}
        endLabels={[t("inspector.pan.leftLabel"), t("inspector.pan.rightLabel")]}
        value={track.pan}
        getValueText={formatPan}
        onValueChange={(next) =>
          edit.step(next, (current) => trackValueBatch(current, track.id, "pan", next))
        }
        onValueCommit={(next) =>
          edit.finish(next, (current) => trackValueBatch(current, track.id, "pan", next))
        }
      />
    </section>
  );
}
