/**
 * The planner prompt's controller (07 §4.3, 06): the lasso/selection target, the request, the
 * clarification, and the hand-off to the Audition bar.
 *
 * It owns no document. A plan's variants become candidate commits through the history store, the
 * Audition store warms them, and Accept commits through the existing flow (02 §7, 07 §6). Only one
 * candidate group is open at a time, so a second request while the bar is open reports that
 * instead of stacking ideas. The Explain path stores its answer and highlights here; the workspace
 * draws them on the canvas until the popover closes (06 §8).
 */
import type { ApiClient } from "@bragi/api-client";
import { PlannerApiError } from "@bragi/api-client";
import type { Selection, Region as SelectionRegion } from "@bragi/render-canvas";
import type { Explanation, Project, Region } from "@bragi/schemas";
import { createStore, type StoreApi } from "zustand/vanilla";

import { type MessageKey, t } from "../../../i18n/index.js";
import { ulid } from "../../../lib/ulid.js";
import type { Audition } from "../../audition/state/audition.js";
import type { History } from "../../history/state/history.js";
import { secondsAtTicks, ticksAtSeconds } from "../../song/api/section-time.js";
import type { ModelApi } from "../../song/model/model-api.js";
import { meterAt } from "../../song/state/section-ops.js";
import type { SongStore } from "../../song/state/song-store.js";
import { candidateBatches, isExplanation, isGenerativeVariant } from "../candidates.js";
import type { PlannerGeneration } from "../planner-generation.js";
import { buildPlanRequest } from "../request.js";
import type { PlannerAnalysis } from "../section-features.js";
import { snapLassoRegion } from "../snap.js";
import { suggestionChips } from "../suggestions.js";

/** What the prompt bar targets, in ticks and in seconds (the overlay and auto-loop use seconds). */
export interface PlannerTarget {
  readonly region: Region;
  readonly startSec: number;
  readonly endSec: number;
  readonly trackIds: readonly string[];
  readonly label: string;
  /** Nothing selected: the prompt acts on the whole song, labelled as such (07 §8). */
  readonly wholeSong: boolean;
  readonly chips: readonly MessageKey[];
}

export interface ExplanationHighlight {
  readonly region: Region;
  readonly label: string;
}

export interface ExplanationState {
  readonly status: "waiting" | "done" | "error";
  readonly anchor: { readonly x: number; readonly y: number };
  readonly text: string;
  readonly learnMore: string | null;
  readonly message: string | null;
  readonly highlights: readonly ExplanationHighlight[];
}

export type PlannerPhase = "idle" | "waiting" | "done" | "clarify" | "error";

export interface PlannerState {
  readonly open: boolean;
  readonly phase: PlannerPhase;
  readonly prompt: string;
  readonly target: PlannerTarget | null;
  /** The planner's plain-language reading of the request ("I'll…"). */
  readonly interpretation: string | null;
  readonly notices: readonly string[];
  readonly clarification: { readonly question: string; readonly options: readonly string[] } | null;
  /** A plain-language error or status note, shown inline in the prompt bar. */
  readonly message: string | null;
  /** How many candidate ideas landed in the Audition bar. */
  readonly candidates: number;
  readonly explanation: ExplanationState | null;
}

export interface PlannerOptions {
  /** The planner API; tests pass a fake with the same signature. */
  readonly client: Pick<ApiClient, "plan">;
  readonly songStore: SongStore;
  readonly model: ModelApi;
  readonly analysis: () => PlannerAnalysis | null;
  readonly history?: History;
  readonly audition?: Audition;
  /** The controller that executes a plan's generate steps (06 §5); absent on hosts without a backend. */
  readonly generation?: PlannerGeneration;
  readonly onAnnounce: (message: string) => void;
  readonly now?: () => Date;
  readonly newGroupId?: () => string;
}

export interface PlannerController {
  readonly store: StoreApi<PlannerState>;
  /** Opens the prompt bar on a tick region (the lasso, or a caller's selection). */
  openRegion(region: Region, label: string, wholeSong?: boolean): void;
  /** Opens on the current selection, or on the whole song when nothing is selected (07 §5). */
  openForSelection(selection: Selection): void;
  /** Snaps a canvas lasso and opens the prompt bar on it (07 §4.3). */
  openForLasso(lasso: {
    startSec: number;
    endSec: number;
    trackIds: readonly string[];
    altKey: boolean;
  }): void;
  setPrompt(prompt: string): void;
  /** Sends the prompt; `text` overrides the field for a clarification resubmit. */
  submit(text?: string): Promise<void>;
  chooseClarification(option: string): Promise<void>;
  /** Aborts the request in flight and stays open with the typed prompt. */
  cancel(): void;
  close(): void;
  /** Asks for an Explanation of one part, anchored at the click (07 §4.9). */
  explainAt(sectionId: string, anchor: { x: number; y: number }): Promise<void>;
  closeExplanation(): void;
  dispose(): void;
}

const INITIAL: PlannerState = {
  open: false,
  phase: "idle",
  prompt: "",
  target: null,
  interpretation: null,
  notices: [],
  clarification: null,
  message: null,
  candidates: 0,
  explanation: null,
};

/** The canvas selection's region has readonly tracks; the schema wants a mutable list. */
function toSchemaRegion(region: SelectionRegion): Region {
  return {
    startTick: region.startTick,
    endTick: region.endTick,
    tracks: region.tracks === "all" ? "all" : [...region.tracks],
  };
}

/** Absolute start tick of every section, in arrangement order. */
function sectionStarts(doc: Project): number[] {
  const starts: number[] = [];
  let tick = 0;
  for (const section of doc.arrangement.sections) {
    starts.push(tick);
    tick += section.lengthTicks;
  }
  return starts;
}

function totalTicks(doc: Project): number {
  return doc.arrangement.sections.reduce((sum, section) => sum + section.lengthTicks, 0);
}

function fmtTracks(names: readonly string[]): string {
  if (names.length === 1) return names[0] ?? "";
  const last = names.at(-1) ?? "";
  return t("brush.tracks.and", { list: names.slice(0, -1).join(", "), last });
}

/** "Drums and Bass · bars 9–12", or the "Whole song" label (07 §8). */
function regionLabel(doc: Project, region: Region, wholeSong: boolean): string {
  if (wholeSong) return t("song.selection.whole");
  const ids = region.tracks === "all" ? doc.tracks.map((track) => track.id) : region.tracks;
  const names = doc.tracks.filter((track) => ids.includes(track.id)).map((track) => track.name);
  const fromBar = meterAt(doc, region.startTick).bar + 1;
  const toBar = meterAt(doc, Math.max(region.startTick, region.endTick - 1)).bar + 1;
  const bars = fromBar === toBar ? String(fromBar) : `${fromBar}–${toBar}`;
  return t("planner.target.region", {
    tracks: fmtTracks(names.length === 0 ? [t("song.selection.whole")] : names),
    bars,
  });
}

function tracksCovered(doc: Project, region: Region): string[] {
  return region.tracks === "all"
    ? doc.tracks.filter((track) => !track.hidden).map((track) => track.id)
    : [...region.tracks];
}

function sectionsCovered(doc: Project, region: Region): number {
  const starts = sectionStarts(doc);
  return doc.arrangement.sections.filter((section, index) => {
    const start = starts[index] ?? 0;
    return start + section.lengthTicks > region.startTick && start < region.endTick;
  }).length;
}

/** The error message for anything the typed planner errors do not cover. */
function errorMessage(error: unknown): string {
  if (error instanceof PlannerApiError) return error.message;
  return t("planner.error.generic");
}

/** Creates the prompt bar's controller for one song. */
export function createPlanner(options: PlannerOptions): PlannerController {
  const store = createStore<PlannerState>(() => INITIAL);
  const now = options.now ?? (() => new Date());
  let abortController: AbortController | null = null;
  let explainController: AbortController | null = null;
  /** Bumped on every request so a late answer from a cancelled prompt is ignored. */
  let generation = 0;

  function document(): Project | null {
    return options.songStore.store.getState().doc;
  }

  function handle(): number | null {
    return options.songStore.handle();
  }

  function targetFor(
    doc: Project,
    region: Region,
    label?: string,
    wholeSong = false,
  ): PlannerTarget {
    const covered = tracksCovered(doc, region);
    const trackIds = region.tracks === "all" ? covered : [...region.tracks];
    const roles = doc.tracks
      .filter((track) => covered.includes(track.id))
      .map((track) => track.role);
    return {
      region,
      startSec: secondsAtTicks(options.model, handle() ?? 0, region.startTick),
      endSec: secondsAtTicks(options.model, handle() ?? 0, region.endTick),
      trackIds,
      label: label ?? regionLabel(doc, region, wholeSong),
      wholeSong,
      chips: suggestionChips({
        roles,
        trackCount: covered.length,
        sectionCount: sectionsCovered(doc, region),
        wholeSong,
      }),
    };
  }

  function openTarget(target: PlannerTarget): void {
    abortController?.abort();
    abortController = null;
    generation += 1;
    store.setState({
      ...INITIAL,
      open: true,
      target,
      explanation: store.getState().explanation,
    });
  }

  function abortPrompt(): void {
    abortController?.abort();
    abortController = null;
    generation += 1;
  }

  const controller: PlannerController = {
    store,

    openRegion(region, label, wholeSong = false) {
      const doc = document();
      if (doc === null) return;
      openTarget(targetFor(doc, region, label, wholeSong));
    },

    openForSelection(selection) {
      const doc = document();
      if (doc === null) return;
      const starts = sectionStarts(doc);
      switch (selection.kind) {
        case "region": {
          openTarget(targetFor(doc, toSchemaRegion(selection.region)));
          return;
        }
        case "sections": {
          const chosen = selection.ids
            .map((id) => doc.arrangement.sections.findIndex((section) => section.id === id))
            .filter((index) => index >= 0)
            .sort((a, b) => a - b);
          const first = chosen[0];
          const last = chosen.at(-1);
          if (first === undefined || last === undefined) {
            const region: Region = { startTick: 0, endTick: totalTicks(doc), tracks: "all" };
            openTarget(targetFor(doc, region, undefined, true));
            return;
          }
          const startTick = starts[first] ?? 0;
          const endSection = doc.arrangement.sections[last];
          const endTick = (starts[last] ?? 0) + (endSection?.lengthTicks ?? 0);
          const region: Region = { startTick, endTick, tracks: "all" };
          const label =
            chosen.length === 1
              ? (doc.arrangement.sections[first]?.label ?? undefined)
              : t("song.selection.parts", { count: chosen.length });
          openTarget(targetFor(doc, region, label));
          return;
        }
        case "tracks": {
          if (selection.ids.length === 0) {
            const region: Region = { startTick: 0, endTick: totalTicks(doc), tracks: "all" };
            openTarget(targetFor(doc, region, undefined, true));
            return;
          }
          const region: Region = {
            startTick: 0,
            endTick: totalTicks(doc),
            tracks: [...selection.ids],
          };
          openTarget(
            targetFor(
              doc,
              region,
              t("song.selection.instruments", { count: selection.ids.length }),
            ),
          );
          return;
        }
        default: {
          const region: Region = { startTick: 0, endTick: totalTicks(doc), tracks: "all" };
          openTarget(targetFor(doc, region, undefined, true));
        }
      }
    },

    openForLasso(lasso) {
      const doc = document();
      const songHandle = handle();
      if (doc === null || songHandle === null) return;
      const beatsPerBar = meterAt(doc, 0).ticksPerBar / doc.arrangement.timebase.ppq;
      const bpm = doc.arrangement.timebase.tempoMap[0]?.bpm ?? 120;
      const snapped = snapLassoRegion({
        ...lasso,
        bpm,
        beatsPerBar,
        ppq: doc.arrangement.timebase.ppq,
        totalTicks: totalTicks(doc),
        ticksAtSeconds: (sec) => ticksAtSeconds(options.model, songHandle, sec),
        secondsAtTicks: (tick) => secondsAtTicks(options.model, songHandle, tick),
      });
      openTarget(targetFor(doc, snapped.region));
    },

    setPrompt(prompt) {
      store.setState({ prompt });
    },

    async submit(text) {
      const state = store.getState();
      const doc = document();
      if (!state.open || state.target === null || doc === null) return;
      const prompt = (text ?? state.prompt).trim();
      if (prompt === "") {
        store.setState({ message: t("planner.error.promptRequired"), phase: "error" });
        return;
      }
      if (options.audition?.store.getState().group != null) {
        store.setState({ message: t("planner.error.auditionOpen"), phase: "error" });
        return;
      }
      const target = state.target;
      abortPrompt();
      const ticket = generation;
      const requestController = new AbortController();
      abortController = requestController;
      store.setState({
        prompt,
        phase: "waiting",
        message: null,
        interpretation: null,
        notices: [],
        clarification: null,
        candidates: 0,
      });
      try {
        const result = await options.client.plan(
          buildPlanRequest({
            doc,
            prompt,
            region: target.region,
            analysis: options.analysis(),
            secondsAtTick: (tick) =>
              secondsAtTicks(options.model, options.songStore.handle() ?? 0, tick),
          }),
          { signal: requestController.signal },
        );
        if (ticket !== generation) return;
        if (isExplanation(result)) {
          store.setState({
            phase: "done",
            interpretation: result.text,
            message: t("planner.explainShown"),
          });
          return;
        }
        if (result.clarification !== undefined) {
          store.setState({
            phase: "clarify",
            interpretation: result.interpretation,
            notices: result.notices ?? [],
            clarification: {
              question: result.clarification.question,
              options: result.clarification.options,
            },
          });
          return;
        }
        const batches = candidateBatches(result, { prompt, now: now() });
        const generative = result.variants.some((variant) => isGenerativeVariant(variant));
        if (batches.length === 0 && !generative) {
          store.setState({
            phase: "error",
            interpretation: result.interpretation,
            notices: result.notices ?? [],
            message: t("planner.error.noIdea"),
          });
          return;
        }
        if (generative) {
          // A generative variant executes server-side: the client renders each step's context,
          // then the plan's jobs stream into the same Audition group as the ops-only variants.
          const controller = options.generation;
          if (controller === undefined) {
            store.setState({
              phase: "done",
              interpretation: result.interpretation,
              notices: result.notices ?? [],
              message: t("planner.demo.noCandidates"),
            });
            return;
          }
          if (options.audition?.store.getState().group !== null) {
            store.setState({ phase: "error", message: t("planner.error.auditionOpen") });
            return;
          }
          const started = await controller.execute({
            plan: result,
            prompt,
            region: target.region,
            opsBatches: batches,
          });
          if (ticket !== generation) return;
          if (!started) {
            store.setState({
              phase: "error",
              interpretation: result.interpretation,
              notices: result.notices ?? [],
              message: t("planner.error.noIdea"),
            });
            return;
          }
          store.setState({
            phase: "done",
            interpretation: result.interpretation,
            notices: result.notices ?? [],
            candidates: batches.length + 1,
          });
          options.onAnnounce(t("planner.live.ready", { count: batches.length + 1 }));
          return;
        }
        const history = options.history;
        const audition = options.audition;
        if (history === undefined || audition === undefined) {
          store.setState({
            phase: "done",
            interpretation: result.interpretation,
            notices: result.notices ?? [],
            message: t("planner.demo.noCandidates"),
          });
          return;
        }
        if (audition.store.getState().group !== null) {
          store.setState({ phase: "error", message: t("planner.error.auditionOpen") });
          return;
        }
        const group = (options.newGroupId ?? (() => `grp_${ulid()}`))();
        await history.addCandidates(batches, group);
        const opened = await audition.openCandidates({
          group,
          prompt,
          region: { startSec: target.startSec, endSec: target.endSec },
          initialStatus: { kind: "hq" },
        });
        if (ticket !== generation) return;
        if (!opened) {
          store.setState({ phase: "error", message: t("planner.error.auditionOpen") });
          return;
        }
        store.setState({
          phase: "done",
          interpretation: result.interpretation,
          notices: result.notices ?? [],
          candidates: batches.length,
        });
        options.onAnnounce(t("planner.live.ready", { count: batches.length }));
      } catch (error) {
        if (requestController.signal.aborted) {
          if (ticket === generation) store.setState({ phase: "idle" });
          return;
        }
        if (ticket !== generation) return;
        // Anything but a planner API error is a bug or a network failure; keep the cause.
        if (!(error instanceof PlannerApiError)) console.warn("the planner request failed", error);
        const message = errorMessage(error);
        store.setState({ phase: "error", message });
        options.onAnnounce(message);
      } finally {
        if (abortController === requestController) abortController = null;
      }
    },

    async chooseClarification(option) {
      const base = store.getState().prompt.trim();
      const prompt = base === "" ? option : `${base}\n${option}`;
      store.setState({ prompt, clarification: null });
      await controller.submit(prompt);
    },

    cancel() {
      abortPrompt();
      store.setState({ phase: "idle", message: t("planner.cancelled") });
      options.onAnnounce(t("planner.cancelled"));
    },

    close() {
      abortPrompt();
      store.setState((state) => ({ ...INITIAL, explanation: state.explanation }));
    },

    async explainAt(sectionId, anchor) {
      const doc = document();
      const songHandle = handle();
      if (doc === null || songHandle === null) return;
      const starts = sectionStarts(doc);
      const index = doc.arrangement.sections.findIndex((section) => section.id === sectionId);
      const section = doc.arrangement.sections[index];
      if (section === undefined) return;
      const startTick = starts[index] ?? 0;
      const region: Region = { startTick, endTick: startTick + section.lengthTicks, tracks: "all" };

      explainController?.abort();
      const requestController = new AbortController();
      explainController = requestController;
      store.setState({
        explanation: {
          status: "waiting",
          anchor,
          text: "",
          learnMore: null,
          message: null,
          highlights: [],
        },
      });
      try {
        const result = await options.client.plan(
          buildPlanRequest({
            doc,
            prompt: t("planner.explainPrompt"),
            region,
            analysis: options.analysis(),
            explain: true,
            secondsAtTick: (tick) => secondsAtTicks(options.model, songHandle, tick),
          }),
          { signal: requestController.signal },
        );
        if (requestController.signal.aborted) return;
        if (!isExplanation(result)) {
          store.setState({
            explanation: {
              status: "error",
              anchor,
              text: "",
              learnMore: null,
              message: t("planner.error.explainInvalid"),
              highlights: [],
            },
          });
          return;
        }
        store.setState({ explanation: explanationState(result, anchor) });
        options.onAnnounce(t("planner.live.explained"));
      } catch (error) {
        if (requestController.signal.aborted) return;
        store.setState({
          explanation: {
            status: "error",
            anchor,
            text: "",
            learnMore: null,
            message: errorMessage(error),
            highlights: [],
          },
        });
      } finally {
        if (explainController === requestController) explainController = null;
      }
    },

    closeExplanation() {
      explainController?.abort();
      explainController = null;
      store.setState({ explanation: null });
    },

    dispose() {
      abortPrompt();
      explainController?.abort();
      explainController = null;
      store.setState(INITIAL);
    },
  };

  return controller;
}

function explanationState(
  explanation: Explanation,
  anchor: { readonly x: number; readonly y: number },
): ExplanationState {
  return {
    status: "done",
    anchor,
    text: explanation.text,
    learnMore: explanation.learnMore ?? null,
    message: null,
    highlights: explanation.highlights.map((highlight) => ({
      region: highlight.region,
      label: highlight.label,
    })),
  };
}
