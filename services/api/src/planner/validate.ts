/**
 * Plan validation (06 §5, §7).
 *
 * The model's reply is data: JSON Schema first, then a dry run of every ops step through
 * `bragi-model` on a fresh handle, then region discipline over the diff between the document
 * before and after the dry run. In v1 a non-`ops` step is rejected because no generation
 * capability is offered yet. Invalid variants are dropped when at least one valid variant remains;
 * the planner's one repair round handles the rest.
 *
 * Region discipline is computed from the **document diff**, not from the ops alone: the diff knows
 * which tracks and section spans actually changed, including track-level fx chains (which have no
 * ticks of their own and inherit the requested region's track scope) and structural changes
 * (which are song-wide). The op-level targets would miss an op whose effect lands elsewhere.
 */
import {
  type PlanRequest,
  type PlanStep,
  type PlanVariant,
  type Project,
  type Region,
  type SectionInstance,
  type Track,
  validateEditPlan,
  validateProject,
} from "@bragi/schemas";

import { blockedNamesIn } from "./policy.js";

/** The slice of the model-wasm handle API the dry run needs. */
export interface DryRunModel {
  loadProject(json: string): number;
  assetAdd(handle: number, assetsJson: string): void;
  documentJson(handle: number): string;
  applyBatch(handle: number, batchJson: string): string;
  freeDoc(handle: number): boolean;
}

/** A variant that did not survive validation. */
export interface DroppedVariant {
  label: string;
  reason: string;
}

/** What validation found. */
export interface PlanValidation {
  ok: boolean;
  /** Human-readable reasons, suitable for the repair round. */
  errors: string[];
  /** The variants that passed, in the model's order. */
  variants: PlanVariant[];
  /** Variants that were dropped because another variant survived. */
  dropped: DroppedVariant[];
  /** Set when a generation prompt named a blocked artist or title (10 §7). */
  policyViolation?: string;
}

/** Options for {@link validateRawPlan}. */
export interface ValidateOptions {
  request: PlanRequest;
  model: DryRunModel;
  /** True when the prompt asked for the whole song (06 §7's classifier). */
  songWideIntent: boolean;
  /** Artist/title names from the pre-pass, blocked in generation prompts. */
  blockedNames: readonly string[];
}

/** A tag span in absolute ticks. */
interface Span {
  startTick: number;
  endTick: number;
}

/** Everything that changed between two documents, in terms the guardrail checks. */
export interface DocDiff {
  songWide: boolean;
  tracks: Set<string>;
  spans: Span[];
  locked: string[];
}

/**
 * Validates the model's raw plan.
 *
 * @param raw the parsed tool arguments or JSON reply (untrusted)
 * @param options the request, the model and the classifier results
 * @returns the surviving variants, or every error when none survive
 */
export async function validateRawPlan(
  raw: unknown,
  options: ValidateOptions,
): Promise<PlanValidation> {
  // The tool schema is `EditPlan` minus the server-owned fields (06 §4), so validate the reply
  // with those fields filled in. The values are overwritten in the final plan either way.
  const candidate =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? {
          ...raw,
          planId: "pln_00000000000000000000000000",
          estimatedCredits: 0,
          estimatedSeconds: 0,
        }
      : raw;
  if (!validateEditPlan(candidate)) {
    return {
      ok: false,
      errors: validationErrors(validateEditPlan.errors),
      variants: [],
      dropped: [],
    };
  }
  const plan = candidate;
  const kept: PlanVariant[] = [];
  const dropped: DroppedVariant[] = [];
  const errors: string[] = [];

  for (const variant of plan.variants) {
    const problems = inspectVariant(variant, options);
    if (problems.policyViolation !== undefined) {
      return {
        ok: false,
        errors: [problems.policyViolation],
        variants: [],
        dropped: [],
        policyViolation: problems.policyViolation,
      };
    }
    if (problems.errors.length === 0) {
      kept.push(variant);
    } else {
      errors.push(...problems.errors.map((error) => `Variant "${variant.label}": ${error}`));
      dropped.push({ label: variant.label, reason: problems.errors.join(" ") });
    }
  }

  if (kept.length === 0) {
    if (plan.variants.length === 0 && plan.clarification !== undefined) {
      return { ok: true, errors: [], variants: [], dropped: [] };
    }
    if (plan.variants.length === 0) {
      return {
        ok: false,
        errors: ["The plan has no variants and no clarification."],
        variants: [],
        dropped: [],
      };
    }
    return { ok: false, errors, variants: [], dropped };
  }

  return { ok: true, errors, variants: kept, dropped };
}

/** Validates one variant, returning its region, lock, dry-run and structural problems. */
function inspectVariant(
  variant: PlanVariant,
  options: ValidateOptions,
): { errors: string[]; policyViolation?: string } {
  const errors: string[] = [];
  const ops: PlanStep[] = variant.steps;

  for (const step of ops) {
    if (step.kind === "ops") continue;
    if (step.kind === "generate") {
      const prompt = step.params.prompt;
      if (typeof prompt === "string") {
        const names = blockedNamesIn(prompt, options.blockedNames);
        if (names.length > 0) {
          return {
            errors: [],
            policyViolation: `The plan named "${names[0]}" in a generation prompt; artist and song names are not allowed (10 §7).`,
          };
        }
      }
    }
    errors.push(
      `A ${step.kind} step is not available in v1; this build offers ops-only plans. Use { "kind": "ops", "ops": [...] }.`,
    );
  }
  if (errors.length > 0) return { errors };

  let before: Project;
  let after: Project;
  try {
    ({ before, after } = dryRun(variant, options.request, options.model));
  } catch (error) {
    return {
      errors: [
        `The ops were rejected by the song model: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }

  const diff = diffDocuments(before, after);
  return {
    errors: regionErrors(diff, variant, options.request, options.songWideIntent),
  };
}

/** Applies a variant's ops to a fresh handle and returns the canonical before/after documents. */
function dryRun(
  variant: PlanVariant,
  request: PlanRequest,
  model: DryRunModel,
): { before: Project; after: Project } {
  const ops = variant.steps.flatMap((step) => (step.kind === "ops" ? step.ops : []));
  const handle = model.loadProject(JSON.stringify(request.doc));
  try {
    // The request carries no asset index; the model needs metadata for every referenced asset.
    // Stubs with a long enough duration keep the dry run about op structure and region, which is
    // all the planner checks (06 §5: generated assets are stubbed).
    model.assetAdd(handle, JSON.stringify(stubAssets(request.doc)));
    // Read the document back through the model so both sides of the diff come from the same
    // serialiser; comparing the request's JS object with the model's output would report field
    // order and default normalisation as edits.
    const before = parseDocument(model.documentJson(handle));
    const batch = {
      id: "bat_planner",
      author: { kind: "system", reason: "planner dry run" },
      intent: request.prompt.slice(0, 200),
      label: variant.label.slice(0, 200),
      ops,
      createdAt: new Date().toISOString(),
    };
    const after = parseDocument(model.applyBatch(handle, JSON.stringify(batch)));
    return { before, after };
  } finally {
    model.freeDoc(handle);
  }
}

/** Parses and validates one document coming out of the model. */
function parseDocument(text: string): Project {
  const parsed: unknown = JSON.parse(text);
  if (!validateProject(parsed)) {
    throw new Error("the dry run produced a document that does not validate");
  }
  return parsed;
}

/**
 * Stub `AssetMeta` for every asset the document references.
 *
 * The planner request has no asset index (the server holds no projects), but `bragi-model` checks
 * clip assets during apply. The duration covers every clip's `srcEnd`, so a dry run validates op
 * structure without pretending to know the real media.
 */
function stubAssets(doc: Project): {
  hash: string;
  mime: string;
  bytes: number;
  sampleRate: number;
  channels: number;
  durationSamples: number;
}[] {
  const durations = new Map<string, number>();
  const note = (hash: string, samples: number) => {
    durations.set(hash, Math.max(durations.get(hash) ?? 0, samples));
  };
  for (const source of doc.sources) {
    note(source.originalAsset, source.durationSamples);
    note(source.workingAsset, source.durationSamples);
  }
  for (const section of doc.arrangement.sections) {
    for (const lane of Object.values(section.lanes)) {
      for (const clip of lane.clips) note(clip.asset, clip.srcEnd);
    }
  }
  return [...durations].map(([hash, samples]) => ({
    hash,
    mime: "audio/wav",
    bytes: 0,
    sampleRate: 48000,
    channels: 2,
    durationSamples: Math.max(48_000, samples),
  }));
}

/** Compares the document before and after the dry run.
 *
 * A structural change (timebase, metadata, sources, the track or section set, section order or a
 * section length) is song-wide. A track-level change (fx chain, mixer fields) touches that track
 * without a span. A section or lane change touches that section's absolute span and the lanes that
 * differ. Locked sections are recorded separately and always rejected.
 *
 * @param before the request's document
 * @param after the dry-run result
 * @returns the diff the guardrail reads
 */
export function diffDocuments(before: Project, after: Project): DocDiff {
  const diff: DocDiff = { songWide: false, tracks: new Set(), spans: [], locked: [] };

  if (
    json(before.meta) !== json(after.meta) ||
    json(before.analyses) !== json(after.analyses) ||
    json(before.arrangement.timebase) !== json(after.arrangement.timebase) ||
    json(before.arrangement.master) !== json(after.arrangement.master) ||
    json(before.sources) !== json(after.sources)
  ) {
    diff.songWide = true;
  }

  diffTracks(before.tracks, after.tracks, diff);
  diffSections(before, after, diff);
  return diff;
}

/** Track-level changes: added/removed tracks are structural, changed ones are touched tracks. */
function diffTracks(before: Track[], after: Track[], diff: DocDiff): void {
  const beforeById = new Map(before.map((track) => [track.id, track]));
  const afterById = new Map(after.map((track) => [track.id, track]));
  if (before.length !== after.length || [...beforeById.keys()].some((id) => !afterById.has(id))) {
    diff.songWide = true;
  }
  for (const [id, track] of afterById) {
    const previous = beforeById.get(id);
    if (previous !== undefined && json(previous) !== json(track)) diff.tracks.add(id);
  }
}

/** Section and lane changes, with their absolute spans. */
function diffSections(before: Project, after: Project, diff: DocDiff): void {
  const beforeSpans = sectionSpans(before);
  const afterSpans = sectionSpans(after);
  const beforeOrder = [...beforeSpans.keys()];
  const afterOrder = [...afterSpans.keys()];
  if (beforeOrder.join("\n") !== afterOrder.join("\n")) diff.songWide = true;

  const beforeById = new Map(beforeSpans);
  const afterById = new Map(afterSpans);

  for (const [id, previous] of beforeById) {
    const next = afterById.get(id);
    if (next === undefined) {
      diff.songWide = true;
      if (previous.section.locked === true) diff.locked.push(id);
      continue;
    }
    if (previous.section.lengthTicks !== next.section.lengthTicks) {
      diff.songWide = true;
    }
    const locked = previous.section.locked === true || next.section.locked === true;
    const sectionChanged = sectionHead(previous.section) !== sectionHead(next.section);
    const laneChanges = changedLanes(previous.section, next.section);
    if (sectionChanged || laneChanges.size > 0) {
      if (locked) diff.locked.push(id);
      if (sectionChanged) diff.spans.push(spanOf(next));
      for (const track of laneChanges) {
        diff.tracks.add(track);
        diff.spans.push(spanOf(next));
      }
    }
  }
}

/** The section's own fields, without its lanes, so a lane-only change is attributed to its track. */
function sectionHead(section: SectionInstance): string {
  return JSON.stringify([
    section.id,
    section.kind,
    section.label,
    section.lengthTicks,
    section.transitionIn,
    section.derivedFrom,
    section.energyTarget,
    section.locked,
  ]);
}

/** The track IDs whose lane content differs. */
function changedLanes(before: SectionInstance, after: SectionInstance): Set<string> {
  const changed = new Set<string>();
  const beforeLanes = before.lanes as Record<string, unknown>;
  const afterLanes = after.lanes as Record<string, unknown>;
  for (const track of new Set([...Object.keys(beforeLanes), ...Object.keys(afterLanes)])) {
    if (json(beforeLanes[track]) !== json(afterLanes[track])) changed.add(track);
  }
  return changed;
}

/** The absolute span of every section, in order. */
function sectionSpans(project: Project): Map<string, { section: SectionInstance; span: Span }> {
  const out = new Map<string, { section: SectionInstance; span: Span }>();
  let tick = 0;
  for (const section of project.arrangement.sections) {
    out.set(section.id, {
      section,
      span: { startTick: tick, endTick: tick + section.lengthTicks },
    });
    tick += section.lengthTicks;
  }
  return out;
}

/** The span field of a section entry. */
function spanOf(entry: { span: Span }): Span {
  return entry.span;
}

/** Region and lock discipline for one variant (06 §7). */
function regionErrors(
  diff: DocDiff,
  variant: PlanVariant,
  request: PlanRequest,
  songWideIntent: boolean,
): string[] {
  const errors: string[] = [];
  if (diff.locked.length > 0) {
    errors.push("It would change a locked section.");
  }

  if (variant.scope === "song") {
    if (!songWideIntent) {
      errors.push('It declares scope "song", but the prompt did not ask for a whole-song change.');
    }
    return errors;
  }

  const region = request.region;
  if (region === undefined) return errors;

  if (diff.songWide) {
    errors.push('It changes the song structure, which needs a song-wide request (scope "song").');
  }

  const allowedTracks = region.tracks;
  if (allowedTracks !== "all") {
    for (const track of diff.tracks) {
      if (!allowedTracks.includes(track)) {
        errors.push(`It touches track ${track}, which is outside the selected region.`);
      }
    }
  }
  for (const span of diff.spans) {
    if (span.startTick < region.startTick || span.endTick > region.endTick) {
      errors.push(
        `It touches ticks ${span.startTick}–${span.endTick}, which are outside the selected region ${region.startTick}–${region.endTick}.`,
      );
    }
  }
  return errors;
}

/** Checks a region is inside a song, including its track IDs (06 §8 highlights). */
export function regionInsideSong(project: Project, region: Region): string[] {
  const errors: string[] = [];
  const total = project.arrangement.sections.reduce((sum, section) => sum + section.lengthTicks, 0);
  if (region.startTick < 0 || region.endTick > total || region.startTick >= region.endTick) {
    errors.push(
      `the region ${region.startTick}–${region.endTick} is outside the song (0–${total})`,
    );
  }
  if (region.tracks !== "all") {
    const known = new Set(project.tracks.map((track) => track.id));
    for (const track of region.tracks) {
      if (!known.has(track)) errors.push(`unknown track ${track}`);
    }
  }
  return errors;
}

/** Turns Ajv errors into short, plain strings for the repair round. */
function validationErrors(
  errors: { instancePath?: string; message?: string }[] | null | undefined,
): string[] {
  if (errors === null || errors === undefined || errors.length === 0) {
    return ["The reply was not a valid EditPlan."];
  }
  return errors
    .slice(0, 12)
    .map(
      (error) =>
        `${error.instancePath === "" ? "/" : error.instancePath}: ${error.message ?? "invalid"}`,
    );
}

/** Stable JSON for comparison. */
function json(value: unknown): string {
  return JSON.stringify(value);
}
