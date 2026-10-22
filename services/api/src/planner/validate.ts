/**
 * Plan validation (06 §5, §7).
 *
 * The model's reply is data: JSON Schema first, then a dry run of every ops step through
 * `bragi-model` on a fresh handle, then region discipline over the diff between the document
 * before and after the dry run. Generation steps are checked against their capability's schema,
 * their `ContextSpec` (inside the song, on whole bars, not on a locked section) and the placement
 * they feed; the server fills the parts of `params.context` the song already knows
 * (`generation.ts`). Invalid variants are dropped when at least one valid variant remains; the
 * planner's one repair round handles the rest.
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

import { type CreditsConfig, creditsConfig } from "../jobs/credits.js";
import {
  estimatePlan,
  extendScopeErrors,
  type GenerationInput,
  generationRegionErrors,
  generationStep,
  hasGeneration,
  type PlanEstimate,
  placementErrors,
  smoothErrors,
} from "./generation.js";
import { opShapeErrors } from "./opErrors.js";
import { blockedNamesIn } from "./policy.js";

/** The slice of the model-wasm handle API the dry run needs. */
export interface DryRunModel {
  loadProject(json: string): number;
  assetAdd(handle: number, assetsJson: string): void;
  documentJson(handle: number): string;
  applyBatch(handle: number, batchJson: string): string;
  /** Tick-accurate changed spans between two loaded documents, as JSON (`ChangedSpan[]`). */
  changedSpans(prev: number, next: number): string;
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
  /** The variants that passed, in the model's order, with their generation context filled. */
  variants: PlanVariant[];
  /** Variants that were dropped because another variant survived. */
  dropped: DroppedVariant[];
  /** Set when a generation prompt named a blocked artist or title (10 §7). */
  policyViolation?: string;
  /** What the surviving variants cost and how long they take (06 §3); zero when none survive. */
  estimate: PlanEstimate;
}

/** Options for {@link validateRawPlan}. */
export interface ValidateOptions {
  request: PlanRequest;
  model: DryRunModel;
  /** True when the prompt asked for the whole song (06 §7's classifier). */
  songWideIntent: boolean;
  /** Artist/title names from the pre-pass, blocked in generation prompts. */
  blockedNames: readonly string[];
  /**
   * The most credits the user can spend on this plan: the remaining daily allowance and
   * `preferences.maxCredits`, whichever is lower (06 §5). Absent means unlimited.
   */
  maxCredits?: number | undefined;
  /** The credit table, so the estimate is the price the execute route will charge. */
  credits?: CreditsConfig;
}

/** A span in absolute ticks, optionally a cut's fade only (06 §7). */
interface Span {
  startTick: number;
  endTick: number;
  edgeFadeOnly?: boolean;
}

/** One tick-accurate changed interval the model reports between two documents (06 §7). */
export interface ChangedSpan {
  trackId: string;
  sectionId: string;
  startTick: number;
  endTick: number;
  edgeFadeOnly?: boolean;
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
  const empty: PlanValidation = {
    ok: false,
    errors: [],
    variants: [],
    dropped: [],
    estimate: { estimatedCredits: 0, estimatedSeconds: 0 },
  };
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
  // The plan is data: a generation prompt that names an artist is refused before anything else is
  // looked at, so a malformed step cannot hide the policy violation (10 §7).
  const violation = rawPolicyViolation(candidate, options.blockedNames);
  if (violation !== undefined) {
    return { ...empty, errors: [violation], policyViolation: violation };
  }
  // Ops are checked one schema at a time first: the plan-level `Op` union would otherwise report
  // every branch's missing properties at once (opErrors.ts). The plan check that follows then only
  // needs to report envelope problems.
  const shapes = opShapeErrors(candidate);
  const planValid = validateEditPlan(candidate);
  if (!planValid || shapes.errors.length > 0) {
    const envelope = planValid ? [] : validationErrors(validateEditPlan.errors, shapes.paths);
    return { ...empty, errors: [...shapes.errors, ...envelope].slice(0, 12) };
  }
  const plan = candidate;
  const kept: PlanVariant[] = [];
  const dropped: DroppedVariant[] = [];
  const errors: string[] = [];
  const generationInput: GenerationInput = {
    doc: options.request.doc,
    ...(options.request.region === undefined ? {} : { region: options.request.region }),
    ...(options.request.sectionFeatures === undefined
      ? {}
      : { features: options.request.sectionFeatures }),
  };

  // At most one variant may generate (06 §4 rule 1, system prompt v4). A plan that offers three
  // generative ideas is three model calls the user did not ask for; the ops-only variants are the
  // cheap ones and are always allowed. Step ids are plan-wide because execute keys the rendered
  // context by step id (06 §5).
  const generative = plan.variants.filter(hasGeneration);
  const stepIds = new Map<string, number>();
  for (const variant of plan.variants) {
    for (const step of variant.steps) {
      if (step.kind === "generate") stepIds.set(step.id, (stepIds.get(step.id) ?? 0) + 1);
    }
  }
  const duplicates = [...stepIds].filter(([, count]) => count > 1).map(([id]) => id);
  const planErrors = [
    ...(generative.length > 1
      ? [
          `${generative.length} variants generate audio; at most one variant per plan may use a generate step.`,
        ]
      : []),
    ...(duplicates.length === 0
      ? []
      : [
          `the generate step id "${duplicates[0]}" is used twice in the plan; ids must be unique across variants.`,
        ]),
  ];

  for (const variant of plan.variants) {
    const problems = inspectVariant(variant, options, generationInput);
    if (problems.policyViolation !== undefined) {
      return {
        ...empty,
        errors: [problems.policyViolation],
        policyViolation: problems.policyViolation,
      };
    }
    if (problems.errors.length === 0 && planErrors.length === 0) {
      kept.push(problems.variant ?? variant);
    } else {
      errors.push(...problems.errors.map((error) => `Variant "${variant.label}": ${error}`));
      dropped.push({ label: variant.label, reason: problems.errors.join(" ") });
    }
  }

  if (kept.length === 0) {
    if (plan.variants.length === 0 && plan.clarification !== undefined) {
      return { ...empty, ok: true };
    }
    if (plan.variants.length === 0) {
      return { ...empty, errors: ["The plan has no variants and no clarification."] };
    }
    return { ...empty, errors: [...planErrors, ...errors], dropped };
  }

  const credits = options.credits ?? creditsConfig();
  const estimate = estimatePlan(kept, credits);
  if (options.maxCredits !== undefined && estimate.estimatedCredits > options.maxCredits) {
    return {
      ...empty,
      errors: [
        `That plan needs ${estimate.estimatedCredits} credits, but only ${options.maxCredits} are available today.`,
      ],
      dropped,
    };
  }

  return { ok: true, errors, variants: kept, dropped, estimate };
}

/** Validates one variant, returning its step, region, lock, dry-run and structural problems. */
function inspectVariant(
  variant: PlanVariant,
  options: ValidateOptions,
  input: GenerationInput,
): { errors: string[]; variant?: PlanVariant; policyViolation?: string } {
  const errors: string[] = [];
  const steps: PlanStep[] = [];
  const generated = new Map<string, PlanStep & { kind: "generate" }>();
  const placed = new Set<string>();

  for (const [index, step] of variant.steps.entries()) {
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
      if (generated.has(step.id)) {
        errors.push(`step ${index + 1} reuses the generate step id "${step.id}".`);
      }
      const checked = generationStep(step, input);
      errors.push(...checked.errors);
      generated.set(step.id, checked.step);
      steps.push(checked.step);
      continue;
    }
    if (step.kind === "apply_generated") {
      const source = generated.get(step.from);
      if (source === undefined) {
        errors.push(
          `step ${index + 1} takes its audio from "${step.from}", which is not an earlier generate step.`,
        );
      } else {
        errors.push(...placementErrors(step, source, options.request.doc));
        placed.add(source.id);
      }
      steps.push(step);
      continue;
    }
    if (step.kind === "smooth") {
      errors.push(...smoothErrors(step, options.request.doc));
      steps.push(step);
      continue;
    }
    steps.push(step);
  }

  for (const id of generated.keys()) {
    if (!placed.has(id)) {
      errors.push(
        `generate step "${id}" is never placed: add an apply_generated step with from "${id}".`,
      );
    }
  }

  const normalised: PlanVariant = { ...variant, steps: stepList(steps) };
  errors.push(...extendScopeErrors(normalised));
  errors.push(...generationRegionErrors(normalised, options.request.region));
  if (errors.length > 0) return { errors, variant: normalised };

  let before: Project;
  let after: Project;
  let spans: ChangedSpan[];
  try {
    ({ before, after, spans } = dryRunVariant(normalised, options.request, options.model));
  } catch (error) {
    return {
      errors: [
        `The ops were rejected by the song model: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
      variant: normalised,
    };
  }

  const diff = diffDocuments(before, after, spans);
  return {
    errors: regionErrors(diff, normalised, options.request, options.songWideIntent),
    variant: normalised,
  };
}

/**
 * The validated steps as the schema's non-empty list.
 *
 * A variant always has at least one step and inspection maps one to one, so this can only fail
 * on a programming error.
 */
function stepList(steps: PlanStep[]): PlanVariant["steps"] {
  const [first, ...rest] = steps;
  if (first === undefined) throw new Error("a variant lost all of its steps in validation");
  return [first, ...rest];
}

/**
 * Applies a variant's ops to a fresh handle and returns the canonical before/after documents plus
 * the model's tick-accurate changed spans (06 §7).
 */
export function dryRunVariant(
  variant: PlanVariant,
  request: PlanRequest,
  model: DryRunModel,
): { before: Project; after: Project; spans: ChangedSpan[] } {
  const ops = variant.steps.flatMap((step) => (step.kind === "ops" ? step.ops : []));
  const handle = model.loadProject(JSON.stringify(request.doc));
  try {
    // The request carries no asset index; the model needs metadata for every referenced asset.
    // Stubs with a long enough duration keep the dry run about op structure and region, which is
    // all the planner checks (06 §5: generated assets are stubbed).
    const assets = JSON.stringify(stubAssets(request.doc));
    model.assetAdd(handle, assets);
    // Read the document back through the model so both sides of the diff come from the same
    // serialiser; comparing the request's JS object with the model's output would report field
    // order and default normalisation as edits.
    const before = parseDocument(model.documentJson(handle));
    // A variant made only of generation steps changes the document when its audio is placed,
    // which is the client's job; there is nothing to dry-run.
    if (ops.length === 0) return { before, after: before, spans: [] };
    const batch = {
      id: "bat_planner",
      author: { kind: "system", reason: "planner dry run" },
      intent: request.prompt.slice(0, 200),
      label: variant.label.slice(0, 200),
      ops,
      createdAt: new Date().toISOString(),
    };
    const after = parseDocument(model.applyBatch(handle, JSON.stringify(batch)));
    // `changedSpans` reads two handles, so the before side is a second handle loaded from the
    // canonical `before` JSON. The diff itself stays on the one handle: a second parse of the
    // request would give the document's hash maps a different iteration order and report
    // unchanged maps (analyses, lanes, fx params) as edits.
    const previous = model.loadProject(JSON.stringify(before));
    try {
      model.assetAdd(previous, assets);
      return {
        before,
        after,
        spans: parseChangedSpans(model.changedSpans(previous, handle)),
      };
    } finally {
      model.freeDoc(previous);
    }
  } finally {
    model.freeDoc(handle);
  }
}

/** The model's changed-span JSON as typed intervals, rejecting anything malformed. */
function parseChangedSpans(text: string): ChangedSpan[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("the model returned malformed changed spans");
  return parsed.map((value: unknown) => {
    if (typeof value !== "object" || value === null) {
      throw new Error("the model returned malformed changed spans");
    }
    const span = value as Record<string, unknown>;
    if (
      typeof span.trackId !== "string" ||
      typeof span.sectionId !== "string" ||
      typeof span.startTick !== "number" ||
      typeof span.endTick !== "number"
    ) {
      throw new Error("the model returned malformed changed spans");
    }
    return {
      trackId: span.trackId,
      sectionId: span.sectionId,
      startTick: span.startTick,
      endTick: span.endTick,
      ...(span.edgeFadeOnly === true ? { edgeFadeOnly: true } : {}),
    };
  });
}

/**
 * The first artist or song name any generation prompt names, before validation (10 §7).
 *
 * Every prompt is checked here, even in a plan that would fail its schema: the content policy is
 * not a repair-round detail.
 */
function rawPolicyViolation(raw: unknown, blockedNames: readonly string[]): string | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.variants)) return undefined;
  for (const variant of raw.variants) {
    if (!isRecord(variant) || !Array.isArray(variant.steps)) continue;
    for (const step of variant.steps) {
      if (!isRecord(step) || step.kind !== "generate") continue;
      const prompt = isRecord(step.params) ? step.params.prompt : undefined;
      if (typeof prompt !== "string") continue;
      const names = blockedNamesIn(prompt, blockedNames);
      if (names.length > 0) {
        return `The plan named "${names[0]}" in a generation prompt; artist and song names are not allowed (10 §7).`;
      }
    }
  }
  return undefined;
}

/** A plain object, not an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * @param changed the model's tick-accurate changed spans (06 §7); when absent, a lane change
 *   counts the whole section span
 * @returns the diff the guardrail reads
 */
export function diffDocuments(
  before: Project,
  after: Project,
  changed?: readonly ChangedSpan[],
): DocDiff {
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
  diffSections(before, after, diff, changed);
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
function diffSections(
  before: Project,
  after: Project,
  diff: DocDiff,
  changed?: readonly ChangedSpan[],
): void {
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
      // A section's own fields have no finer granularity than the section (06 §7).
      if (sectionChanged) diff.spans.push(spanOf(next));
      const byTrack = spansByTrack(changed, id);
      for (const track of laneChanges) {
        diff.tracks.add(track);
        if (changed === undefined) {
          // A pure document diff has no tick-accurate answer; keep the conservative section span.
          diff.spans.push(spanOf(next));
        } else {
          // The model reports no span for a lane whose change is not audible (an fx added to an
          // otherwise unchanged clip bites only where the automation moves).
          for (const span of byTrack.get(track) ?? []) diff.spans.push(span);
        }
      }
    }
  }
}

/** The model's changed spans for one section, keyed by track. */
function spansByTrack(
  changed: readonly ChangedSpan[] | undefined,
  sectionId: string,
): Map<string, Span[]> {
  const out = new Map<string, Span[]>();
  for (const span of changed ?? []) {
    if (span.sectionId !== sectionId) continue;
    const list = out.get(span.trackId) ?? [];
    list.push({
      startTick: span.startTick,
      endTick: span.endTick,
      ...(span.edgeFadeOnly === true ? { edgeFadeOnly: true } : {}),
    });
    out.set(span.trackId, list);
  }
  return out;
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
  if (region === undefined) {
    // Without a region there is no tick boundary to check, but a structural or master change is
    // still song-wide: declare it so the UI can warn before the user applies it (06 §7).
    if (diff.songWide && variant.scope !== "song") {
      errors.push('It changes the song structure, which needs a song-wide variant (scope "song").');
    }
    return errors;
  }

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
    // A cut's short fade lands just outside the region by construction (02 §5.4); it is allowed
    // when it touches or overlaps the selection (06 §7).
    if (span.edgeFadeOnly === true && touchesRegion(span, region)) continue;
    if (span.startTick < region.startTick || span.endTick > region.endTick) {
      errors.push(
        `It touches ticks ${span.startTick}–${span.endTick}, which are outside the selected region ${region.startTick}–${region.endTick}.`,
      );
    }
  }
  return errors;
}

/** Whether a span touches or overlaps the region's tick range. */
function touchesRegion(span: Span, region: Region): boolean {
  return (
    span.endTick === region.startTick ||
    span.startTick === region.endTick ||
    (span.startTick < region.endTick && span.endTick > region.startTick)
  );
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
  opPaths: ReadonlySet<string> = new Set(),
): string[] {
  const kept = (errors ?? []).filter((error) => {
    const path = error.instancePath ?? "";
    return ![...opPaths].some((op) => path === op || path.startsWith(`${op}/`));
  });
  if (kept.length === 0) {
    return ["The reply was not a valid EditPlan."];
  }
  return kept
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
