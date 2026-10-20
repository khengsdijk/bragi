/**
 * Op batch builders for the section actions (07 §4.1–4.2, 02 §5.1).
 *
 * Every action is one batch with a plain-language label for the history panel (11 §2). Nothing
 * here changes the document: the caller commits the batch through the history store (or applies it
 * directly in the demo), exactly like the canvas gestures. Smart transitions are extra
 * `section.set_transition` ops in the same batch, so one undo restores the arrangement *and* the
 * joins.
 */
import type {
  Op,
  OpBatch,
  Project,
  SectionInstance,
  SectionKind,
  SectionResizeMode,
} from "@bragi/schemas";

import { type MessageKey, t } from "../../../i18n/index.js";
import { ulid } from "../../../lib/ulid.js";
import { newBatchId } from "./ops.js";

/** How the UI asks for smart transitions (the `smartTransitions` setting). */
export interface SmoothOptions {
  readonly smooth: boolean;
}

/** One beat, the smart-transition length (02 §5.1). */
export function smartTransitionTicks(doc: Project): number {
  return doc.arrangement.timebase.ppq;
}

interface MeterPoint {
  /** 0-based bar number. */
  readonly bar: number;
  readonly startTick: number;
  /** Ticks in a bar at this point. */
  readonly ticksPerBar: number;
}

/**
 * The bar containing `tick`, with that bar's length under the time signatures (02 §2.2).
 *
 * A time signature applies from its `bar` until the next signature, so a section that starts
 * after a meter change gets the meter it actually starts in.
 */
export function meterAt(doc: Project, tick: number): MeterPoint {
  const { ppq, timeSignatures } = doc.arrangement.timebase;
  const signatures = [...timeSignatures].sort((a, b) => a.bar - b.bar);
  let bar = 0;
  let startTick = 0;
  for (const [index, signature] of signatures.entries()) {
    const next = signatures[index + 1];
    const ticksPerBar = Math.round((ppq * 4 * signature.numerator) / signature.denominator);
    bar = signature.bar;
    if (next === undefined) {
      const bars = Math.floor(Math.max(0, tick - startTick) / ticksPerBar);
      return { bar: bar + bars, startTick: startTick + bars * ticksPerBar, ticksPerBar };
    }
    const segmentEndTick = startTick + (next.bar - signature.bar) * ticksPerBar;
    if (tick < segmentEndTick) {
      const bars = Math.floor(Math.max(0, tick - startTick) / ticksPerBar);
      return { bar: bar + bars, startTick: startTick + bars * ticksPerBar, ticksPerBar };
    }
    startTick = segmentEndTick;
  }
  return { bar: 0, startTick: 0, ticksPerBar: ppq * 4 };
}

/** The absolute tick a section starts at: the sum of the lengths before it (02 §3.5). */
export function sectionStartTick(doc: Project, index: number): number {
  let tick = 0;
  for (let earlier = 0; earlier < index; earlier += 1) {
    tick += doc.arrangement.sections[earlier]?.lengthTicks ?? 0;
  }
  return tick;
}

/** The bar length a section starts in, which resize and split use. */
export function sectionTicksPerBar(doc: Project, section: SectionInstance): number {
  const index = doc.arrangement.sections.findIndex((candidate) => candidate.id === section.id);
  return meterAt(doc, sectionStartTick(doc, Math.max(0, index))).ticksPerBar;
}

/** A section's length in whole bars (rounded, never below one). */
export function sectionBars(doc: Project, section: SectionInstance): number {
  const ticksPerBar = sectionTicksPerBar(doc, section);
  return Math.max(1, Math.round(section.lengthTicks / ticksPerBar));
}

function findSection(doc: Project, sectionId: string): SectionInstance | null {
  return doc.arrangement.sections.find((section) => section.id === sectionId) ?? null;
}

function batch(label: string, ops: Op[], now: Date): OpBatch {
  return {
    id: newBatchId(),
    author: { kind: "user" },
    label,
    ops: ops as [Op, ...Op[]],
    createdAt: now.toISOString(),
  };
}

/** The order after `section.move` (remove at `from`, insert at `to`). */
function orderAfterMove(
  sections: readonly SectionInstance[],
  from: number,
  to: number,
): SectionInstance[] {
  const next = [...sections];
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

/**
 * Appends the crossfade that smart transitions add (02 §5.1): a section that now has a
 * predecessor and was cut becomes a one-beat crossfade, in the same batch as the move.
 */
function smoothJoin(
  sections: readonly SectionInstance[],
  sectionId: string,
  ops: Op[],
  ppq: number,
): void {
  const index = sections.findIndex((section) => section.id === sectionId);
  const section = sections[index];
  // The first section has no join to smooth.
  if (section === undefined || index <= 0 || section.transitionIn.kind !== "cut") return;
  ops.push({
    op: "section.set_transition",
    sectionId,
    transition: { kind: "crossfade", lengthTicks: ppq },
  });
}

/**
 * `section.move` with its smart joins. Returns `null` when the move changes nothing (same index)
 * or the target is out of range.
 */
export function moveSectionBatch(
  doc: Project,
  sectionId: string,
  toIndex: number,
  options: SmoothOptions,
  now: Date = new Date(),
): OpBatch | null {
  const sections = doc.arrangement.sections;
  const from = sections.findIndex((section) => section.id === sectionId);
  if (from < 0 || !Number.isInteger(toIndex) || toIndex < 0 || toIndex >= sections.length) {
    return null;
  }
  if (toIndex === from) return null;

  const moved = sections[from];
  if (moved === undefined) return null;
  const final = orderAfterMove(sections, from, toIndex);
  const predecessor = toIndex === 0 ? undefined : final[toIndex - 1];
  const label =
    predecessor === undefined
      ? t("song.batch.moveStart", { label: moved.label })
      : t("song.batch.moveAfter", { label: moved.label, after: predecessor.label });

  const ops: Op[] = [{ op: "section.move", sectionId, toIndex }];
  if (options.smooth) {
    const ppq = smartTransitionTicks(doc);
    smoothJoin(final, sectionId, ops, ppq);
    // The section that now follows the moved section's old position.
    const follower = sections[from + 1];
    if (follower !== undefined) smoothJoin(final, follower.id, ops, ppq);
  }
  return batch(label, ops, now);
}

/** `section.duplicate`, inserted at `toIndex` (the copy's index after insertion). */
export function duplicateSectionBatch(
  doc: Project,
  sectionId: string,
  toIndex: number,
  newId: string = `sec_${ulid()}`,
  now: Date = new Date(),
): OpBatch | null {
  const sections = doc.arrangement.sections;
  const source = findSection(doc, sectionId);
  if (source === null || !Number.isInteger(toIndex) || toIndex < 0 || toIndex > sections.length) {
    return null;
  }
  return batch(
    t("song.batch.duplicate", { label: source.label }),
    [{ op: "section.duplicate", sectionId, toIndex, newId }],
    now,
  );
}

/** `section.remove` with the smart join on the part that closes the gap (02 §5.1). */
export function removeSectionBatch(
  doc: Project,
  sectionId: string,
  options: SmoothOptions,
  now: Date = new Date(),
): OpBatch | null {
  const sections = doc.arrangement.sections;
  const index = sections.findIndex((section) => section.id === sectionId);
  const section = sections[index];
  if (index < 0 || section === undefined) return null;

  const ops: Op[] = [{ op: "section.remove", sectionId, closeGap: true }];
  if (options.smooth && index > 0) {
    const follower = sections[index + 1];
    if (follower !== undefined) {
      const after = [...sections.slice(0, index), ...sections.slice(index + 1)];
      smoothJoin(after, follower.id, ops, smartTransitionTicks(doc));
    }
  }
  return batch(t("song.batch.remove", { label: section.label }), ops, now);
}

/** `section.update` with a new label; `null` for an empty or unchanged name. */
export function renameSectionBatch(
  doc: Project,
  sectionId: string,
  label: string,
  now: Date = new Date(),
): OpBatch | null {
  const section = findSection(doc, sectionId);
  const name = label.trim();
  if (section === null || name === "" || name === section.label) return null;
  return batch(
    t("song.batch.rename", { old: section.label, name }),
    [{ op: "section.update", sectionId, patch: { label: name } }],
    now,
  );
}

/** `section.update` with a new kind; `null` when it is already that kind. */
export function setSectionKindBatch(
  doc: Project,
  sectionId: string,
  kind: SectionKind,
  now: Date = new Date(),
): OpBatch | null {
  const section = findSection(doc, sectionId);
  if (section === null || section.kind === kind) return null;
  return batch(
    t("song.batch.kind", {
      label: section.label,
      kind: t(`song.sectionKind.${kind}` as MessageKey),
    }),
    [{ op: "section.update", sectionId, patch: { kind } }],
    now,
  );
}

/** `section.update` with the AI lock; `null` when it is already in that state. */
export function lockSectionBatch(
  doc: Project,
  sectionId: string,
  locked: boolean,
  now: Date = new Date(),
): OpBatch | null {
  const section = findSection(doc, sectionId);
  if (section === null || (section.locked === true) === locked) return null;
  const key = locked ? "song.batch.lock" : "song.batch.unlock";
  return batch(
    t(key, { label: section.label }),
    [{ op: "section.update", sectionId, patch: { locked } }],
    now,
  );
}

/**
 * `section.resize` to `bars` whole bars at the section's own meter (02 §5.2). The UI offers
 * loop/stretch when it grows and trim when it shrinks, but the model also allows the others.
 */
export function resizeSectionBatch(
  doc: Project,
  sectionId: string,
  bars: number,
  mode: SectionResizeMode,
  now: Date = new Date(),
): OpBatch | null {
  const section = findSection(doc, sectionId);
  if (section === null || !Number.isInteger(bars) || bars < 1) return null;
  const lengthTicks = bars * sectionTicksPerBar(doc, section);
  if (lengthTicks === section.lengthTicks) return null;
  const grew = lengthTicks > section.lengthTicks;
  const key = grew ? "song.batch.resizeLonger" : "song.batch.resizeShorter";
  return batch(
    t(key, { label: section.label, mode: t(`song.resize.mode.${mode}` as MessageKey) }),
    [{ op: "section.resize", sectionId, lengthTicks, mode }],
    now,
  );
}

/** Where a split lands: the bar line relative to the section start, and its absolute bar number. */
export interface SplitPoint {
  /** Ticks from the section start, a whole number of bars. */
  readonly atTick: number;
  /** 1-based bar number in the arrangement, for the label and the announcement. */
  readonly bar: number;
}

/**
 * The bar line nearest to `atTick` that is strictly inside the section (07 §3 "Split"), or
 * `null` when the section is shorter than two bars. A playhead near the end snaps to the last
 * bar line inside, never to the section's end boundary.
 */
export function splitPoint(doc: Project, sectionId: string, atTick: number): SplitPoint | null {
  const sections = doc.arrangement.sections;
  const index = sections.findIndex((section) => section.id === sectionId);
  const section = sections[index];
  if (index < 0 || section === undefined || !Number.isFinite(atTick)) return null;

  const startTick = sectionStartTick(doc, index);
  const meter = meterAt(doc, startTick);
  // Bar lines strictly inside: 1 .. floor((length - 1) / ticksPerBar).
  const lastInside = Math.floor((section.lengthTicks - 1) / meter.ticksPerBar);
  if (lastInside < 1) return null;
  const relativeBars = Math.min(
    lastInside,
    Math.max(1, Math.round((atTick - startTick) / meter.ticksPerBar)),
  );
  return {
    atTick: relativeBars * meter.ticksPerBar,
    bar: meter.bar + relativeBars + 1,
  };
}

/** `section.split` at the bar line {@link splitPoint} chooses. */
export function splitSectionBatch(
  doc: Project,
  sectionId: string,
  atTick: number,
  now: Date = new Date(),
): OpBatch | null {
  const section = findSection(doc, sectionId);
  const point = splitPoint(doc, sectionId, atTick);
  if (section === null || point === null) return null;

  return batch(
    t("song.batch.split", { label: section.label, bar: point.bar }),
    [{ op: "section.split", sectionId, atTick: point.atTick, newId: `sec_${ulid()}` }],
    now,
  );
}
