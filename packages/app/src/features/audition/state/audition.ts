/**
 * The audition group on screen (07 §6, §7 Compare): up to three alternatives of the song, each in
 * a warm engine slot, switched at the same playhead with a 30 ms crossfade (03 §5.4).
 *
 * Two kinds share the machinery:
 * - **candidates**: an AI action's candidate commits (02 §7). Accept commits one of them and moves
 *   HEAD, Discard marks the group discarded and returns to HEAD.
 * - **compare**: two versions picked in the History panel. Nothing is committed; `A`/`B` switch
 *   and closing returns to HEAD.
 *
 * Only one group is open at a time. Slot 0 is always HEAD ("Original").
 */
import type { AuditionSlot, CandidateSlot } from "@bragi/platform";
import type { Project } from "@bragi/schemas";
import { createStore, type StoreApi } from "zustand/vanilla";

import { type MessageKey, t } from "../../../i18n/index.js";
import type { History } from "../../history/state/history.js";
import type { EngineController } from "../../song/state/engine-controller.js";
import { meterAt } from "../../song/state/section-ops.js";
import type { ApplyOutcome } from "../../song/state/song-store.js";
import {
  type CandidateSource,
  type CandidateStatus,
  isPlayable,
  statusFromJobEvent,
} from "./candidate-status.js";

/** The candidate slots in order; a group holds at most this many alternatives. */
export const CANDIDATE_SLOTS: readonly CandidateSlot[] = [1, 2, 3];

/** Bars of context the auto-loop adds on each side of the affected region (07 §6). */
export const CONTEXT_BARS = 2;

/** After a switch away, a slot is still fading for 30 ms; release it once that is over. */
const RELEASE_DELAY_MS = 200;

export interface AuditionCandidate {
  /** The candidate commit (or, in a comparison, the version) this slot plays. */
  readonly id: string;
  readonly label: string;
  readonly slot: CandidateSlot;
  readonly status: CandidateStatus;
  /** The document the slot plays; `null` until its snapshot is read. */
  readonly doc: Project | null;
}

export interface AuditionGroup {
  /** The candidate group id, or a synthetic id for a comparison. */
  readonly id: string;
  readonly kind: "candidates" | "compare";
  /** What the user asked for ("Half-time drums in Verse 2"), or the comparison's title. */
  readonly prompt: string;
  readonly candidates: readonly AuditionCandidate[];
}

export interface AuditionState {
  readonly group: AuditionGroup | null;
  /** The audible slot: 0 is the original (HEAD). */
  readonly selected: AuditionSlot;
  /** Slots whose plan the engine holds. */
  readonly warm: readonly CandidateSlot[];
  /** An accept or discard is running. */
  readonly busy: boolean;
}

export interface OpenCandidatesOptions {
  /** The candidate group (02 §7). Its candidate commits fill slots 1–3 in creation order. */
  readonly group: string;
  readonly prompt: string;
  /** The affected region in seconds; the auto-loop adds {@link CONTEXT_BARS} on each side. */
  readonly region?: { readonly startSec: number; readonly endSec: number };
  /**
   * The badge before the source reports anything. Candidates that already have audio (a
   * finished job) start as `hq`; candidates still being generated start as `queued`.
   */
  readonly initialStatus?: CandidateStatus;
}

export interface AuditionOptions {
  readonly controller: EngineController;
  readonly history: History;
  /** The song now, for the context-bar length. */
  readonly document: () => Project | null;
  /** Job events for candidates; absent until the planner/generator exist (WP-2.6/2.7). */
  readonly source?: CandidateSource;
  /** The accepted candidate's Song Store outcome; the workspace forwards it to the engine. */
  readonly onOutcome: (outcome: ApplyOutcome | null, message: string) => void;
  readonly onAnnounce: (message: string) => void;
  /** Injected in tests. */
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
}

export interface Audition {
  readonly store: StoreApi<AuditionState>;
  /** Opens an AI candidate group. `false` when another group is open (07 §6: one at a time). */
  openCandidates(options: OpenCandidatesOptions): Promise<boolean>;
  /** Opens a comparison of two versions from the History panel (07 §7). */
  openCompare(a: string, b: string): Promise<boolean>;
  /** Switches the audible slot. `false` when that slot has nothing to play yet. */
  select(slot: AuditionSlot): boolean;
  /** Commits the selected candidate (02 §7) and closes the bar. */
  accept(): Promise<boolean>;
  /** Discards a candidate group (or closes a comparison) and returns to the original. */
  discard(): Promise<void>;
  /** Whether "More like this" can be offered. */
  canMoreLike(): boolean;
  /** Asks the source for a new group seeded from the selected candidate. */
  moreLike(): void;
  dispose(): void;
}

const INITIAL: AuditionState = { group: null, selected: 0, warm: [], busy: false };

/** A store that never opens, for views without a version tree (the demo page). */
export const EMPTY_AUDITION_STORE: StoreApi<AuditionState> = createStore<AuditionState>(
  () => INITIAL,
);

/** The length of {@link CONTEXT_BARS} bars at the start of `doc`, in seconds. */
export function contextSeconds(doc: Project): number {
  const { ppq, tempoMap } = doc.arrangement.timebase;
  const bpm = tempoMap[0]?.bpm ?? 120;
  const beatsPerBar = meterAt(doc, 0).ticksPerBar / ppq;
  return (CONTEXT_BARS * beatsPerBar * 60) / bpm;
}

/** "Original" for slot 0, the candidate's label otherwise. */
export function slotLabel(group: AuditionGroup | null, slot: AuditionSlot): string {
  if (slot === 0) return t("audition.original");
  return group?.candidates.find((candidate) => candidate.slot === slot)?.label ?? "";
}

export function createAudition(options: AuditionOptions): Audition {
  const store = createStore<AuditionState>(() => INITIAL);
  const later = options.setTimeout ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  let unsubscribe: (() => void) | null = null;
  /** The loop before the bar opened, restored when it closes. */
  let previousLoop: { loop: boolean; range: { startSec: number; endSec: number } | null } | null =
    null;
  /** Bumped on every open/close, so a slow warm from an older group is ignored. */
  let generation = 0;

  const setCandidate = (id: string, patch: Partial<AuditionCandidate>): void => {
    const group = store.getState().group;
    if (group === null) return;
    store.setState({
      group: {
        ...group,
        candidates: group.candidates.map((candidate) =>
          candidate.id === id ? { ...candidate, ...patch } : candidate,
        ),
      },
    });
  };

  /** Warms `candidate`'s document in its slot; a re-warm (preview → HQ) replaces the plan. */
  const warm = async (candidate: AuditionCandidate, ticket: number): Promise<void> => {
    if (candidate.doc === null || !isPlayable(candidate.status)) return;
    // A slot cannot be replaced while it is audible; the HQ swap waits for the next switch.
    if (
      store.getState().selected === candidate.slot &&
      store.getState().warm.includes(candidate.slot)
    )
      return;
    const ok = await options.controller.warm(candidate.slot, candidate.doc);
    if (!ok || ticket !== generation) return;
    const current = store.getState().warm;
    if (!current.includes(candidate.slot)) store.setState({ warm: [...current, candidate.slot] });
  };

  const announceReady = (group: AuditionGroup): void => {
    const ready = group.candidates.filter((candidate) => isPlayable(candidate.status)).length;
    const selected = store.getState().selected;
    const playing = selected === 0 ? t("audition.original") : slotLabel(group, selected);
    options.onAnnounce(
      t(ready === 1 ? "audition.live.ready.one" : "audition.live.ready.other", {
        count: ready,
        playing,
      }),
    );
  };

  const begin = async (group: AuditionGroup): Promise<boolean> => {
    generation += 1;
    const ticket = generation;
    store.setState({ group, selected: 0, warm: [], busy: false });
    const transport = options.controller.store.getState();
    previousLoop = { loop: transport.loop, range: transport.loopRange };
    await Promise.all(group.candidates.map((candidate) => warm(candidate, ticket)));
    if (ticket !== generation) return false;
    // Start on the first idea that can play (07 §6: "playing idea 1").
    const first = CANDIDATE_SLOTS.find((slot) => store.getState().warm.includes(slot));
    if (first !== undefined) audition.select(first);
    announceReady(store.getState().group ?? group);
    return true;
  };

  /** Back to HEAD (unless the engine already crossfades there itself) and release every slot. */
  const close = (returnToHead: boolean): void => {
    const warmSlots = store.getState().warm;
    generation += 1;
    unsubscribe?.();
    unsubscribe = null;
    if (returnToHead) options.controller.audition(0);
    else options.controller.store.setState({ auditionSlot: 0 });
    if (previousLoop !== null) {
      if (previousLoop.range !== null) options.controller.setLoopRange(previousLoop.range);
      else options.controller.setLoop(previousLoop.loop);
      previousLoop = null;
    }
    store.setState(INITIAL);
    // A slot that was just audible is still fading out; the engine refuses to release it before.
    later(() => {
      for (const slot of warmSlots) options.controller.release(slot);
    }, RELEASE_DELAY_MS);
  };

  const audition: Audition = {
    store,
    async openCandidates(open) {
      if (store.getState().group !== null) return false;
      const commits = [...options.history.store.getState().commits.values()]
        .filter((commit) => commit.state === "candidate" && commit.candidateGroup === open.group)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, CANDIDATE_SLOTS.length);
      if (commits.length === 0) return false;
      const docs = await Promise.all(
        commits.map((commit) => options.history.readSnapshot(commit.id)),
      );
      const status = open.initialStatus ?? { kind: "hq" };
      const group: AuditionGroup = {
        id: open.group,
        kind: "candidates",
        prompt: open.prompt,
        candidates: commits.map((commit, index) => ({
          id: commit.id,
          label: commit.label,
          slot: CANDIDATE_SLOTS[index] ?? 3,
          status,
          doc: docs[index] ?? null,
        })),
      };
      const doc = options.document();
      if (open.region !== undefined && doc !== null) {
        const context = contextSeconds(doc);
        options.controller.setLoopRange({
          startSec: Math.max(0, open.region.startSec - context),
          endSec: open.region.endSec + context,
        });
      }
      if (options.source !== undefined) {
        const ticket = generation + 1;
        unsubscribe = options.source.subscribe(open.group, (candidateId, event) => {
          if (ticket !== generation) return;
          const before = store.getState().group?.candidates.find((c) => c.id === candidateId);
          if (before === undefined) return;
          const next = statusFromJobEvent(event);
          setCandidate(candidateId, { status: next });
          const after = store.getState().group?.candidates.find((c) => c.id === candidateId);
          // New audio (the first preview, or the HQ render replacing it) is warmed again.
          if (after !== undefined && isPlayable(next) && next.kind !== before.status.kind) {
            void warm(after, ticket).then(() => {
              const group = store.getState().group;
              if (group !== null && next.kind === "preview" && !isPlayable(before.status)) {
                announceReady(group);
              }
            });
          }
        });
      }
      const opened = await begin(group);
      if (opened) void options.controller.play();
      return opened;
    },
    async openCompare(a, b) {
      if (store.getState().group !== null) return false;
      const commits = options.history.store.getState().commits;
      const [docA, docB] = await Promise.all([
        options.history.readSnapshot(a),
        options.history.readSnapshot(b),
      ]);
      const group: AuditionGroup = {
        id: `compare:${a}:${b}`,
        kind: "compare",
        prompt: t("audition.compareTitle"),
        candidates: [
          { id: a, label: commits.get(a)?.label ?? a, slot: 1, status: { kind: "hq" }, doc: docA },
          { id: b, label: commits.get(b)?.label ?? b, slot: 2, status: { kind: "hq" }, doc: docB },
        ],
      };
      return begin(group);
    },
    select(slot) {
      const state = store.getState();
      if (state.group === null) return false;
      if (slot !== 0 && !state.warm.includes(slot)) return false;
      if (slot === state.selected) return true;
      options.controller.audition(slot);
      store.setState({ selected: slot });
      options.onAnnounce(t("audition.live.playing", { label: slotLabel(state.group, slot) }));
      return true;
    },
    async accept() {
      const state = store.getState();
      const group = state.group;
      if (group === null || group.kind !== "candidates" || state.selected === 0 || state.busy) {
        return false;
      }
      const candidate = group.candidates.find((entry) => entry.slot === state.selected);
      if (candidate === undefined) return false;
      store.setState({ busy: true });
      const outcome = await options.history.accept(candidate.id);
      const message = t("audition.live.accepted", { label: candidate.label });
      // The new HEAD reaches the engine through the workspace; installing it while a candidate
      // is audible crossfades to it (03 §5.4), so playback continues without a gap.
      options.onOutcome(outcome, message);
      close(outcome === null || !outcome.ok);
      return outcome?.ok === true;
    },
    async discard() {
      const group = store.getState().group;
      if (group === null || store.getState().busy) return;
      if (group.kind === "candidates") {
        store.setState({ busy: true });
        await options.history.discardGroup(group.id);
      }
      close(true);
      options.onAnnounce(
        t(
          (group.kind === "candidates"
            ? "audition.live.discarded"
            : "audition.live.compareClosed") satisfies MessageKey,
        ),
      );
    },
    canMoreLike() {
      const group = store.getState().group;
      return group?.kind === "candidates" && options.source?.moreLike !== undefined;
    },
    moreLike() {
      const state = store.getState();
      const candidate = state.group?.candidates.find((entry) => entry.slot === state.selected);
      if (candidate === undefined || state.group?.kind !== "candidates") return;
      options.source?.moreLike?.(candidate.id);
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = null;
      generation += 1;
    },
  };
  return audition;
}
