/**
 * Structural expectations for the planner bench (06 §9).
 *
 * Everything here reads a returned `EditPlan` and the fixture document only: no model, no wasm,
 * no network. The runner adds the authoritative document diff for the over-reach metric; the
 * checks below are the ones a reviewer can read in `cases.json` and reason about offline.
 *
 * "Touched" means what an op *targets*, not what the canonical diff reports: a clip op touches its
 * section's span, a lane automation op touches its section, a track-level fx op touches its track
 * and a structural op is song-wide. That is deliberately conservative on the same side as the
 * validator (06 §7), so a check cannot pass by ignoring an op the dry run would reject.
 */
import type { EditPlan, PlanStep, PlanVariant, Project, Region } from "@bragi/schemas";

/** One case's structural expectations. Every field is optional and defaults to "no check". */
export interface Expectations {
  /** Minimum number of variants; a clarification has none. */
  minVariants?: number;
  maxVariants?: number;
  /** Every op's `op` name must be one of these. */
  onlyOpKinds?: string[];
  /** No op may have one of these `op` names. */
  forbiddenOpKinds?: string[];
  /** Every variant may touch only these tracks (a union across variants). */
  touchesOnlyTracks?: string[];
  /** Every touched tick span lies inside the request's region; structural changes fail. */
  insideRegion?: boolean;
  /** No bare track/master fx or mixer change without matching time-limited automation. */
  timeLimited?: boolean;
  /** Distinct lever families across all variants: fx, automation, mixer, clip, arrangement, song. */
  distinctLeverTypes?: number;
  /** The plan asks a clarification (and therefore has no variants). */
  asksClarification?: boolean;
  /** At least one variant declares `scope: "song"`. */
  scopeSong?: boolean;
  /** These section or track IDs may not appear in any op. */
  noTouch?: string[];
  /** Every string appears in at least one notice. */
  noticeContains?: string[];
  /** None of these strings appears in the plan body (notices are excluded on purpose). */
  forbiddenText?: string[];
  /** Every string appears somewhere in the plan (including notices). */
  containsText?: string[];
  /** The interpretation does not name a variant that validation dropped. */
  interpretationExcludesDropped?: boolean;
  /** At least one variant has a generate step (06 §3). */
  requiresGeneration?: boolean;
  /** No variant has a generate step: the request must be answered with ops (system prompt rule 1). */
  forbidsGeneration?: boolean;
  /** At most one variant may generate (system prompt rule 2). */
  atMostOneGenerativeVariant?: boolean;
  /** Every generate step's capability is one of these. */
  generationCapabilities?: string[];
  /** A generative variant without `scope: "song"` generates inside the request's region. */
  generationInsideRegion?: boolean;
}

/** One generate (or placement/smooth) step, in terms the checks understand. */
export interface GenerationTarget {
  readonly id: string;
  readonly capability: string;
  /** `generate` for the step itself, `apply_generated` for the placement that lands it. */
  readonly kind: "generate" | "apply_generated";
  readonly tracks: string[] | "all";
  readonly spans: Span[];
}

/** A tick span. */
export interface Span {
  startTick: number;
  endTick: number;
}

/** One lever family, used by {@link Expectations.distinctLeverTypes}. */
export type LeverType =
  | "fx"
  | "automation"
  | "mixer"
  | "clip"
  | "arrangement"
  | "song"
  | "generation";

/** What one variant targets, in terms the checks understand. */
export interface VariantTargets {
  tracks: Set<string>;
  sections: Set<string>;
  spans: Span[];
  songWide: boolean;
  opKinds: Set<string>;
  levers: Set<LeverType>;
  /** Lane automation target paths, e.g. `fx:fx_1/drive`. */
  automationTargets: string[];
  /** Fx IDs added or updated on a track/master chain (the levers that act for the whole song). */
  songFxIds: Set<string>;
  /** The variant's generate steps and the spans they need (06 §3). */
  generation: GenerationTarget[];
}

/** The result of one check. */
export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/** Everything {@link evaluateExpectations} needs. */
export interface EvaluationInput {
  plan: EditPlan;
  doc: Project;
  expectations: Expectations;
  region?: Region;
  /** Labels of variants the validator dropped, for `interpretationExcludesDropped`. */
  dropped?: readonly string[];
}

/** The outcome for one plan. */
export interface Evaluation {
  passed: boolean;
  checks: CheckResult[];
  targets: VariantTargets[];
}

/** A document index: where clips, sections and fx live. */
interface DocumentIndex {
  sections: Map<string, Span>;
  clips: Map<string, { trackId: string; sectionId: string; span: Span }>;
  fx: Map<string, FxPlacement>;
}

/** Where an fx instance lives. */
type FxPlacement =
  | { kind: "track"; trackId: string }
  | { kind: "clip"; trackId: string; sectionId: string; span: Span }
  | { kind: "master" };

/**
 * Evaluates a case's expectations against one returned plan.
 *
 * @param input the plan, the fixture and the optional region and dropped labels
 * @returns one result per configured expectation plus the per-variant targets
 */
export function evaluateExpectations(input: EvaluationInput): Evaluation {
  const { plan, region } = input;
  const index = buildIndex(input.doc);
  const targets = plan.variants.map((variant) => targetsOf(variant, index));
  const checks: CheckResult[] = [];
  const check = (name: keyof Expectations, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
  };
  const expectations = input.expectations;

  if (expectations.minVariants !== undefined) {
    check(
      "minVariants",
      plan.variants.length >= expectations.minVariants,
      `${plan.variants.length} variant(s), expected at least ${expectations.minVariants}`,
    );
  }
  if (expectations.maxVariants !== undefined) {
    check(
      "maxVariants",
      plan.variants.length <= expectations.maxVariants,
      `${plan.variants.length} variant(s), expected at most ${expectations.maxVariants}`,
    );
  }
  if (expectations.onlyOpKinds !== undefined) {
    const allowed = new Set(expectations.onlyOpKinds);
    const outside = [...targets.flatMap((target) => [...target.opKinds])].filter(
      (kind) => !allowed.has(kind),
    );
    check(
      "onlyOpKinds",
      outside.length === 0,
      outside.length === 0 ? "all ops allowed" : `outside: ${unique(outside).join(", ")}`,
    );
  }
  if (expectations.forbiddenOpKinds !== undefined) {
    const forbidden = new Set(expectations.forbiddenOpKinds);
    const used = [...targets.flatMap((target) => [...target.opKinds])].filter((kind) =>
      forbidden.has(kind),
    );
    check(
      "forbiddenOpKinds",
      used.length === 0,
      used.length === 0 ? "none used" : `used: ${unique(used).join(", ")}`,
    );
  }
  if (expectations.touchesOnlyTracks !== undefined) {
    const allowed = new Set(expectations.touchesOnlyTracks);
    const outside = targets.flatMap((target) =>
      [...target.tracks].filter((track) => !allowed.has(track)),
    );
    check(
      "touchesOnlyTracks",
      outside.length === 0,
      outside.length === 0 ? "inside the allowed tracks" : `outside: ${unique(outside).join(", ")}`,
    );
  }
  if (expectations.insideRegion !== undefined && expectations.insideRegion) {
    const problems = targets.flatMap((target, index) =>
      plan.variants[index]?.scope === "song" ? [] : outsideRegion(target, region),
    );
    check(
      "insideRegion",
      problems.length === 0,
      problems.length === 0 ? "inside the region" : problems.join("; "),
    );
  }
  if (expectations.timeLimited !== undefined && expectations.timeLimited) {
    const problems = plan.variants.flatMap((variant, index) =>
      variant.scope === "song" ? [] : bareLevers(variant, targets[index]),
    );
    check(
      "timeLimited",
      problems.length === 0,
      problems.length === 0 ? "time-limited levers only" : problems.join("; "),
    );
  }
  if (expectations.distinctLeverTypes !== undefined) {
    const levers = new Set(targets.flatMap((target) => [...target.levers]));
    check(
      "distinctLeverTypes",
      levers.size >= expectations.distinctLeverTypes,
      `${levers.size} lever type(s): ${[...levers].join(", ") || "none"}`,
    );
  }
  if (expectations.asksClarification !== undefined) {
    const asked = plan.clarification !== undefined;
    check("asksClarification", asked === expectations.asksClarification, asked ? "asked" : "none");
  }
  if (expectations.scopeSong !== undefined) {
    const song = plan.variants.some((variant) => variant.scope === "song");
    check("scopeSong", song === expectations.scopeSong, song ? "declared" : "not declared");
  }
  if (expectations.noTouch !== undefined) {
    const text = JSON.stringify(plan.variants);
    const found = expectations.noTouch.filter((id) => text.includes(id));
    check(
      "noTouch",
      found.length === 0,
      found.length === 0 ? "untouched" : `touched: ${found.join(", ")}`,
    );
  }
  if (expectations.noticeContains !== undefined) {
    const notices = (plan.notices ?? []).join("\n");
    const missing = expectations.noticeContains.filter((needle) => !notices.includes(needle));
    check(
      "noticeContains",
      missing.length === 0,
      missing.length === 0 ? "all present" : `missing: ${missing.join(", ")}`,
    );
  }
  if (expectations.forbiddenText !== undefined) {
    const body = bodyText(plan);
    const found = expectations.forbiddenText.filter((needle) =>
      body.toLowerCase().includes(needle.toLowerCase()),
    );
    check(
      "forbiddenText",
      found.length === 0,
      found.length === 0 ? "none present" : `present: ${found.join(", ")}`,
    );
  }
  if (expectations.containsText !== undefined) {
    const text = JSON.stringify({ interpretation: plan.interpretation, variants: plan.variants });
    const missing = expectations.containsText.filter((needle) => !text.includes(needle));
    check(
      "containsText",
      missing.length === 0,
      missing.length === 0 ? "all present" : `missing: ${missing.join(", ")}`,
    );
  }
  if (expectations.interpretationExcludesDropped === true && (input.dropped ?? []).length > 0) {
    const interpretation = plan.interpretation.toLowerCase();
    const named = (input.dropped ?? []).filter(
      (label) => label.length >= 4 && interpretation.includes(label.toLowerCase()),
    );
    // "a third option warms the whole song" describes a variant the user never sees, which is the
    // failure the tuning is meant to remove even when the label itself is not quoted.
    const optionReference =
      /\b(?:first|second|third|other|last) option\b|\boption \d+\b|\bvariants?\b/.test(
        interpretation,
      );
    check(
      "interpretationExcludesDropped",
      named.length === 0 && !optionReference,
      named.length > 0
        ? `names dropped: ${named.join(", ")}`
        : optionReference
          ? "refers to options or variants"
          : "variant-agnostic",
    );
  }
  if (expectations.requiresGeneration !== undefined) {
    const generative = plan.variants.filter(hasGeneration);
    check(
      "requiresGeneration",
      generative.length > 0 === expectations.requiresGeneration,
      generative.length > 0 ? `${generative.length} generative variant(s)` : "ops-only",
    );
  }
  if (expectations.forbidsGeneration === true) {
    const used = plan.variants.filter((variant) => hasGeneration(variant)).map((v) => v.label);
    check(
      "forbidsGeneration",
      used.length === 0,
      used.length === 0 ? "ops-only" : `generates: ${used.join(", ")}`,
    );
  }
  if (expectations.atMostOneGenerativeVariant === true) {
    const count = plan.variants.filter((variant) => hasGeneration(variant)).length;
    check(
      "atMostOneGenerativeVariant",
      count <= 1,
      `${count} generative variant(s), expected at most 1`,
    );
  }
  if (expectations.generationCapabilities !== undefined) {
    const allowed = new Set(expectations.generationCapabilities);
    const used = targets.flatMap((target) =>
      target.generation
        .filter((entry) => entry.kind === "generate")
        .map((entry) => entry.capability),
    );
    const outside = used.filter((capability) => !allowed.has(capability));
    check(
      "generationCapabilities",
      outside.length === 0,
      used.length === 0
        ? "no generation"
        : outside.length === 0
          ? used.join(", ")
          : `outside: ${unique(outside).join(", ")}`,
    );
  }
  if (expectations.generationInsideRegion === true && region !== undefined) {
    const problems = plan.variants.flatMap((variant, index) =>
      variant.scope === "song"
        ? []
        : (targets[index]?.generation ?? []).flatMap((entry) =>
            generationOutsideRegion(entry, region),
          ),
    );
    check(
      "generationInsideRegion",
      problems.length === 0,
      problems.length === 0 ? "inside the region" : problems.join("; "),
    );
  }

  return { passed: checks.every((result) => result.ok), checks, targets };
}

/** True when a variant has a generate step (06 §3). */
function hasGeneration(variant: PlanVariant): boolean {
  return variant.steps.some((step) => step.kind === "generate");
}

/** The reasons one generation target falls outside the region. */
function generationOutsideRegion(entry: GenerationTarget, region: Region): string[] {
  const problems: string[] = [];
  if (region.tracks !== "all" && entry.tracks !== "all") {
    for (const track of entry.tracks) {
      if (!region.tracks.includes(track)) {
        problems.push(`${entry.capability} renders ${track}, outside the region`);
      }
    }
  }
  for (const span of entry.spans) {
    if (span.startTick < region.startTick || span.endTick > region.endTick) {
      problems.push(
        `${entry.capability} touches ${span.startTick}–${span.endTick}, outside the region`,
      );
    }
  }
  return problems;
}

/**
 * Over-reach through generation: a variant without `scope: "song"` whose generate or placement
 * spans lie outside the requested region (06 §7, §9).
 *
 * The runner calls this next to the document diff, because a generate step changes nothing in the
 * dry run but still edits the song when its audio lands.
 *
 * @param variant the returned variant
 * @param region the request's region
 * @returns true when the variant generates outside the region
 */
export function reachesOutsideRegion(variant: PlanVariant, region: Region | undefined): boolean {
  if (variant.scope === "song" || region === undefined) return false;
  return targetsOf(variant, EMPTY_INDEX).generation.some(
    (entry) => generationOutsideRegion(entry, region).length > 0,
  );
}

/**
 * Over-reach, as 06 §9 defines it: a variant without `scope: "song"` that changes a track or tick
 * outside the requested region. The runner feeds this the authoritative `diffDocuments` result.
 *
 * @param diff the document diff of the variant's dry run
 * @param variant the returned variant
 * @param region the request's region
 * @returns true when the variant reaches outside the region
 */
export function overReaches(
  diff: { songWide: boolean; tracks: Iterable<string>; spans: readonly Span[] },
  variant: PlanVariant,
  region: Region | undefined,
): boolean {
  if (variant.scope === "song" || region === undefined) return false;
  if (diff.songWide) return true;
  if (region.tracks !== "all") {
    for (const track of diff.tracks) {
      if (!region.tracks.includes(track)) return true;
    }
  }
  return diff.spans.some(
    (span) => span.startTick < region.startTick || span.endTick > region.endTick,
  );
}

/** Builds the clip/section/fx index for one document. */
export function buildIndex(doc: Project): DocumentIndex {
  const index: DocumentIndex = { sections: new Map(), clips: new Map(), fx: new Map() };
  let tick = 0;
  for (const section of doc.arrangement.sections) {
    const span = { startTick: tick, endTick: tick + section.lengthTicks };
    index.sections.set(section.id, span);
    tick = span.endTick;
    for (const [trackId, lane] of Object.entries(section.lanes)) {
      for (const clip of lane.clips) {
        index.clips.set(clip.id, { trackId, sectionId: section.id, span });
        for (const fx of clip.fx ?? []) {
          index.fx.set(fx.id, { kind: "clip", trackId, sectionId: section.id, span });
        }
      }
    }
  }
  for (const track of doc.tracks) {
    for (const fx of track.fx) index.fx.set(fx.id, { kind: "track", trackId: track.id });
  }
  for (const fx of doc.arrangement.master.fx) index.fx.set(fx.id, { kind: "master" });
  return index;
}

/** Collects one variant's ops and the tracks, sections, spans and levers they target. */
function targetsOf(variant: PlanVariant, index: DocumentIndex): VariantTargets {
  const targets: VariantTargets = {
    tracks: new Set(),
    sections: new Set(),
    spans: [],
    songWide: false,
    opKinds: new Set(),
    levers: new Set(),
    automationTargets: [],
    songFxIds: new Set(),
    generation: [],
  };
  const addedFx = new Map<string, FxPlacement>();

  for (const step of variant.steps) {
    if (step.kind === "generate") {
      targets.levers.add("generation");
      targets.generation.push({
        id: step.id,
        capability: step.capability,
        kind: "generate",
        tracks: step.context.tracks === "all" ? "all" : [...step.context.tracks],
        // The context ranges are read-only conditioning; the edit is the gap or the boundary.
        spans: editedSpan(step),
      });
      continue;
    }
    if (step.kind === "apply_generated") {
      const region = step.placement.region;
      targets.generation.push({
        id: step.from,
        capability: "apply_generated",
        kind: "apply_generated",
        tracks: region.tracks === "all" ? "all" : region.tracks,
        spans: [{ startTick: region.startTick, endTick: region.endTick }],
      });
      continue;
    }
    if (step.kind === "smooth") {
      targets.levers.add("automation");
      targets.spans.push({ startTick: step.region.startTick, endTick: step.region.endTick });
      if (step.region.tracks !== "all") {
        for (const track of step.region.tracks) targets.tracks.add(track);
      }
      continue;
    }
    for (const op of step.ops) {
      const raw = asRecord(op);
      if (raw === undefined) continue;
      const kind = typeof raw.op === "string" ? raw.op : "unknown";
      targets.opKinds.add(kind);
      targets.levers.add(leverOf(kind));
      applyOp(raw, kind, index, targets, addedFx);
    }
  }
  return targets;
}

/** The span a generate step edits: the gap of an inpaint, the boundary of a transition. */
function editedSpan(step: Extract<PlanStep, { kind: "generate" }>): Span[] {
  const before = step.context.before;
  const after = step.context.after;
  if (before === undefined) return [];
  if (step.capability === "generate.inpaint" && after !== undefined) {
    return [{ startTick: before.endTick, endTick: after.startTick }];
  }
  if (step.capability === "generate.transition") {
    return [{ startTick: before.endTick, endTick: before.endTick }];
  }
  return [];
}

/** An empty document index, for checks that only read generation steps. */
const EMPTY_INDEX: DocumentIndex = { sections: new Map(), clips: new Map(), fx: new Map() };

/** Records one op's target in `targets`. */
function applyOp(
  raw: Record<string, unknown>,
  kind: string,
  index: DocumentIndex,
  targets: VariantTargets,
  addedFx: Map<string, FxPlacement>,
): void {
  const scope = asRecord(raw.scope);
  switch (kind) {
    case "fx.add": {
      const placement = placementOf(scope, index);
      const fx = asRecord(raw.fx);
      const fxId = fx === undefined ? undefined : stringField(fx, "id");
      if (placement !== undefined && fxId !== undefined) addedFx.set(fxId, placement);
      if (fxId !== undefined && (placement?.kind === "track" || placement?.kind === "master")) {
        targets.songFxIds.add(fxId);
      }
      applyPlacement(placement, targets);
      return;
    }
    case "fx.update":
    case "fx.remove":
    case "fx.reorder": {
      const fxId = stringField(raw, "fxId");
      const placement = fxId === undefined ? undefined : (addedFx.get(fxId) ?? index.fx.get(fxId));
      if (fxId !== undefined && (placement?.kind === "track" || placement?.kind === "master")) {
        targets.songFxIds.add(fxId);
      }
      applyPlacement(placement, targets);
      return;
    }
    case "automation.set":
    case "automation.clear": {
      const target = stringField(raw, "target");
      if (target !== undefined) targets.automationTargets.push(target);
      if (scope?.kind === "lane") {
        const sectionId = stringField(scope, "sectionId");
        const trackId = stringField(scope, "trackId");
        if (trackId !== undefined) targets.tracks.add(trackId);
        if (sectionId !== undefined) addSection(sectionId, index, targets);
        return;
      }
      targets.songWide = true;
      return;
    }
    case "track.update": {
      const trackId = stringField(raw, "trackId");
      if (trackId !== undefined) targets.tracks.add(trackId);
      return;
    }
    case "track.add":
    case "track.remove":
    case "tempo.set":
    case "key.transpose":
    case "project.set_meta":
    case "analysis.apply":
    case "region.adopt": {
      targets.songWide = true;
      return;
    }
    case "region.clear": {
      const region = regionOf(raw.region);
      if (region !== undefined) {
        for (const track of region.tracks === "all" ? [] : region.tracks) targets.tracks.add(track);
        targets.spans.push({ startTick: region.startTick, endTick: region.endTick });
      }
      return;
    }
    case "clip.add": {
      const trackId = stringField(raw, "trackId");
      if (trackId !== undefined) targets.tracks.add(trackId);
      const sectionId = stringField(raw, "sectionId");
      if (sectionId !== undefined) addSection(sectionId, index, targets);
      return;
    }
    case "clip.update":
    case "clip.remove":
    case "clip.split":
    case "clip.replace": {
      const clipId = stringField(raw, "clipId");
      const clip = clipId === undefined ? undefined : index.clips.get(clipId);
      if (clip !== undefined) {
        targets.tracks.add(clip.trackId);
        addSection(clip.sectionId, index, targets);
      }
      return;
    }
    case "section.update":
    case "section.set_transition": {
      const sectionId = stringField(raw, "sectionId");
      if (sectionId !== undefined) addSection(sectionId, index, targets);
      return;
    }
    case "section.resize":
    case "section.duplicate":
    case "section.move":
    case "section.remove":
    case "section.split":
    case "section.merge":
    case "section.insert": {
      targets.songWide = true;
      return;
    }
    default: {
      targets.songWide = true;
    }
  }
}

/** Applies an fx placement to the touched tracks/spans. */
function applyPlacement(placement: FxPlacement | undefined, targets: VariantTargets): void {
  if (placement === undefined) return;
  if (placement.kind === "master") {
    targets.songWide = true;
    return;
  }
  targets.tracks.add(placement.trackId);
  if (placement.kind === "clip") {
    targets.sections.add(placement.sectionId);
    targets.spans.push(placement.span);
  }
}

/** Records one section's span and track-agnostic identity. */
function addSection(sectionId: string, index: DocumentIndex, targets: VariantTargets): void {
  targets.sections.add(sectionId);
  const span = index.sections.get(sectionId);
  if (span !== undefined) targets.spans.push(span);
}

/** The placement named by an fx op's `scope`. */
function placementOf(
  scope: Record<string, unknown> | undefined,
  index: DocumentIndex,
): FxPlacement | undefined {
  if (scope === undefined) return undefined;
  if (scope.kind === "track") {
    const trackId = stringField(scope, "trackId");
    return trackId === undefined ? undefined : { kind: "track", trackId };
  }
  if (scope.kind === "clip") {
    const clipId = stringField(scope, "clipId");
    const clip = clipId === undefined ? undefined : index.clips.get(clipId);
    return clip === undefined
      ? undefined
      : { kind: "clip", trackId: clip.trackId, sectionId: clip.sectionId, span: clip.span };
  }
  if (scope.kind === "master") return { kind: "master" };
  return undefined;
}

/** The lever family of an op name. */
export function leverOf(kind: string): LeverType {
  if (kind.startsWith("fx.")) return "fx";
  if (kind.startsWith("automation.")) return "automation";
  if (kind.startsWith("track.")) return "mixer";
  if (kind.startsWith("clip.")) return "clip";
  if (kind.startsWith("section.") || kind.startsWith("region.")) return "arrangement";
  return "song";
}

/** A span outside the region, or a song-wide change, as plain reasons. */
function outsideRegion(target: VariantTargets, region: Region | undefined): string[] {
  if (region === undefined) return [];
  const problems: string[] = [];
  if (target.songWide) problems.push("changes the song structure");
  if (region.tracks !== "all") {
    for (const track of target.tracks) {
      if (!region.tracks.includes(track)) problems.push(`touches ${track} outside the region`);
    }
  }
  for (const span of target.spans) {
    if (span.startTick < region.startTick || span.endTick > region.endTick) {
      problems.push(`touches ${span.startTick}–${span.endTick} outside the region`);
    }
  }
  return unique(problems);
}

/**
 * Track/master levers that act for the whole song unless lane automation confines them.
 *
 * A track fx is allowed when the variant automates that fx (`fx:<id>/…`) on a lane; a mixer change
 * is allowed when it automates the track (`track:<id>/…`) there. This is the "never a bare
 * track-level fx change" rule from the tuning in `docs/wp/2.6.md`.
 */
function bareLevers(variant: PlanVariant, target: VariantTargets | undefined): string[] {
  if (target === undefined) return [];
  const problems: string[] = [];
  const automated = target.automationTargets;

  for (const fxId of target.songFxIds) {
    if (!automates(automated, `fx:${fxId}/`)) {
      problems.push(`bare track/master fx ${fxId}`);
    }
  }
  const allOps = variant.steps.flatMap((step) => (step.kind === "ops" ? step.ops : []));
  for (const op of allOps) {
    const raw = asRecord(op);
    if (raw === undefined) continue;
    const kind = stringField(raw, "op");
    if (kind === "track.update") {
      const trackId = stringField(raw, "trackId");
      if (trackId === undefined || !automates(automated, `track:${trackId}/`)) {
        problems.push(`bare track.update on ${trackId ?? "?"}`);
      }
    } else if (kind === "automation.set" || kind === "automation.clear") {
      if (asRecord(raw.scope)?.kind === "master") problems.push(`master ${kind}`);
    }
  }
  return problems;
}

/** True when some automation target starts with `prefix`. */
function automates(targets: readonly string[], prefix: string): boolean {
  return targets.some((target) => target.startsWith(prefix));
}

/** The plan body without notices: what the planner says it will do. */
function bodyText(plan: EditPlan): string {
  return JSON.stringify({
    interpretation: plan.interpretation,
    clarification: plan.clarification,
    variants: plan.variants,
  });
}

/** A region object from JSON. */
function regionOf(value: unknown): Region | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const startTick = numberField(record.startTick);
  const endTick = numberField(record.endTick);
  const tracks = record.tracks;
  if (startTick === undefined || endTick === undefined) return undefined;
  if (tracks === "all") return { startTick, endTick, tracks: "all" };
  if (Array.isArray(tracks) && tracks.every((track) => typeof track === "string")) {
    return { startTick, endTick, tracks: tracks as string[] };
  }
  return undefined;
}

/** A plain object, not an array or null. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A string field. */
function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** A finite number field. */
function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Stable de-duplication for reasons. */
function unique(values: string[]): string[] {
  return [...new Set(values)];
}
