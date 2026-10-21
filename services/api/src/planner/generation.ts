/**
 * Generation steps in planner plans (06 §2–§3, §5; 09 §2, §4.2–4.4).
 *
 * Three generation capabilities are offered, the ones this build can run:
 * `generate.extend`, `generate.inpaint` and `generate.transition`. Everything here is
 * derived from the schemas in `packages/schemas/jobs/capabilities/`, so the shape the model
 * is shown (`generationCatalogue`) and the checks the server runs (`generationStep`,
 * `placementErrors`, `smoothErrors`) cannot drift from the contract the worker validates.
 *
 * **What the model writes vs what the server fills.** The model writes the musical
 * intent (capability, bars/gap/length, prompt, tier, n) and the context ranges it can
 * know from the user's focus. The server fills `params.context` from the song: bpm and
 * time signature at the target tick, the analysed key, descriptors from the tags, a
 * deterministic seed, and the section kind and energy where a section is known — and
 * an inpaint's `gapBars` from the selected gap. That keeps generation prompts short and
 * makes the tempo impossible to get wrong; 06 §3 and §5 say so.
 */
import {
  type ApplyGeneratedStep,
  CAPABILITY_PARAMS_SCHEMAS,
  type ContextSpec,
  type GenerateStep,
  type PlanVariant,
  type Project,
  type Region,
  type SectionFeatures,
  type SectionInstance,
  type SmoothStep,
} from "@bragi/schemas";

import { capabilityParamsError } from "../jobs/capabilities.js";
import { type CreditsConfig, creditCharge } from "../jobs/credits.js";

/** One generation capability the planner may use, with when-to-use prose for the catalogue. */
export interface GenerationOffer {
  readonly capability: string;
  /** One line for the prompt: when this lever is worth its credits. */
  readonly when: string;
}

/** The offered capabilities, cheapest lever last (06 §4 rule 1). */
export const GENERATION_OFFERS: readonly GenerationOffer[] = [
  {
    capability: "generate.extend",
    when: "the song must get longer or gain an intro; repeating a section is usually cheaper",
  },
  {
    capability: "generate.inpaint",
    when: "a silent, erased or empty stretch inside the song must be filled",
  },
  {
    capability: "generate.transition",
    when: "a section boundary does not flow and a crossfade is not enough",
  },
];

/** The capability ids the planner offers, in catalogue order. */
export const GENERATION_CAPABILITIES: readonly string[] = GENERATION_OFFERS.map(
  (offer) => offer.capability,
);

/** True when the planner may propose this capability. */
export function isGenerationCapability(capability: string): boolean {
  return GENERATION_CAPABILITIES.includes(capability);
}

/** One capability in the prompt catalogue. */
export interface GenerationCatalogueEntry {
  readonly use: string;
  readonly cost: string;
  readonly params: Record<string, unknown>;
}

/** The catalogue's generation section: one entry per offered capability. */
export interface GenerationCatalogue {
  readonly capabilities: Record<string, GenerationCatalogueEntry>;
}

/** Prompt values for the sample params; the schema decides which keys appear. */
const SAMPLE_VALUES: Record<string, unknown> = {
  bars: 8,
  gapBars: 4,
  lengthBars: 2,
  overlapBars: 2,
  direction: "forward",
  prompt: "half-time drums",
  seed: 1234,
  tier: "preview",
  n: 3,
};

/** The part of the shared `MusicalContext` the model writes; the server fills the rest. */
function contextSample(): Record<string, unknown> {
  return { key: { tonic: "A", mode: "minor" } };
}

/**
 * A compact param sample of one capability, generated from its schema.
 *
 * The keys (and their order) come from the schema, so a new param shows up in the prompt
 * without a prompt edit; the values are prompt-friendly placeholders.
 */
function paramsSample(capability: string): Record<string, unknown> | undefined {
  const schema = CAPABILITY_PARAMS_SCHEMAS[capability];
  if (schema === undefined) return undefined;
  const properties = schema.properties;
  if (!isRecord(properties)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    out[key] = key === "context" ? contextSample() : (SAMPLE_VALUES[key] ?? "text");
  }
  return out;
}

/** The price of one capability in words, from `config/credits.toml` (09 §2). */
export function creditsText(capability: string, config: CreditsConfig): string {
  const cost = config.capabilities[capability];
  if (cost === undefined) return "free";
  if ("flat" in cost) return `${cost.flat}/job`;
  if ("perCandidate" in cost) return `${cost.perCandidate}/candidate`;
  return `${cost.per30s}/${config.windowSec}s per candidate`;
}

/**
 * The catalogue's generation section, rendered from the capability schemas.
 *
 * @param config the credit table, so the prompt prices a lever the way the API charges it
 * @returns one entry per offered capability
 */
export function generationCatalogue(config: CreditsConfig): GenerationCatalogue {
  const capabilities: Record<string, GenerationCatalogueEntry> = {};
  for (const offer of GENERATION_OFFERS) {
    const params = paramsSample(offer.capability);
    if (params === undefined) continue;
    capabilities[offer.capability] = {
      use: offer.when,
      cost: creditsText(offer.capability, config),
      params,
    };
  }
  return { capabilities };
}

/** A span of absolute ticks. */
interface Span {
  readonly startTick: number;
  readonly endTick: number;
}

/** A section with its absolute span. */
interface PlacedSection {
  readonly section: SectionInstance;
  readonly span: Span;
}

/** What the step checks need from the request. */
export interface GenerationInput {
  readonly doc: Project;
  readonly features?: readonly SectionFeatures[] | undefined;
  /** The lasso, from which an inpaint's gap and a transition's boundary are derived. */
  readonly region?: Region | undefined;
}

/** The outcome for one generate step: the problems and the step with its context filled. */
export interface CheckedGenerateStep {
  readonly errors: string[];
  readonly step: GenerateStep;
}

/**
 * Checks one generate step and fills what the song already knows: `params.context`, the gap
 * of an inpaint, its `gapBars`, and the context ranges of a step that left them out.
 *
 * @param step the model's step
 * @param input the document, the request's analysis features and its lasso
 * @returns the errors (empty when it passes) and the normalised step
 */
export function generationStep(step: GenerateStep, input: GenerationInput): CheckedGenerateStep {
  if (!isGenerationCapability(step.capability)) {
    return { errors: generationContractErrors(step), step };
  }
  const ranges = resolvedContext(step, input);
  const resolved: GenerateStep = { ...step, context: ranges.context };
  const target = targetSpan(resolved);
  const tick = target?.startTick ?? 0;
  const params = withFilledParams(resolved, input, tick, ranges.errors);
  const normalised: GenerateStep = { ...resolved, params };
  const errors = [
    ...ranges.errors,
    ...generationContractErrors(normalised),
    ...contextErrors(normalised, input.doc),
    ...targetErrors(normalised, input.doc, target),
  ];
  return { errors, step: normalised };
}

/**
 * The checks that need only the step: the capability, its params schema and the shape of
 * the context ranges (06 §5).
 *
 * Execute re-runs these on the stored plan, where the document is no longer at hand; the
 * document-dependent checks (`contextErrors`, `targetErrors`, `placementErrors`) ran when the
 * plan was proposed.
 *
 * @param step a generate step with `params` already validated
 * @returns the problems, empty when the step is contract-valid
 */
export function generationContractErrors(step: GenerateStep): string[] {
  if (!isGenerationCapability(step.capability)) {
    return [
      `The planner cannot generate with "${step.capability}"; the offered capabilities are ${GENERATION_CAPABILITIES.join(", ")}.`,
    ];
  }
  const errors: string[] = [];
  const paramsError = capabilityParamsError(step.capability, step.params);
  if (paramsError !== undefined) errors.push(paramsError);
  for (const key of ["before", "after"] as const) {
    const range = step.context[key];
    if (range !== undefined && range.startTick >= range.endTick) {
      errors.push(`context.${key} is empty (${range.startTick}–${range.endTick}).`);
    }
  }
  const before = step.context.before;
  const after = step.context.after;
  if (step.capability === "generate.inpaint") {
    if (before === undefined || after === undefined) {
      errors.push("An inpaint needs context.before and context.after around the gap.");
    } else if (before.endTick > after.startTick) {
      errors.push("An inpaint's context.before must end at or before context.after starts.");
    }
  } else if (step.capability === "generate.transition") {
    if (before === undefined || after === undefined) {
      errors.push(
        "A transition needs context.before (end of the outgoing section) and context.after (start of the incoming one).",
      );
    } else if (before.endTick !== after.startTick) {
      errors.push(
        "A transition's context.after must start where context.before ends: the one boundary it bridges.",
      );
    }
  }
  return errors;
}

/**
 * The span the generated audio replaces or joins, in absolute ticks.
 *
 * @returns the gap for an inpaint, the boundary for a transition, or `undefined` for an
 *   extend (which joins the song edge, so there is no span to check)
 */
export function targetSpan(step: GenerateStep): Span | undefined {
  const before = step.context.before;
  const after = step.context.after;
  if (step.capability === "generate.inpaint" && before !== undefined && after !== undefined) {
    return { startTick: before.endTick, endTick: after.startTick };
  }
  if (step.capability === "generate.transition" && before !== undefined) {
    return { startTick: before.endTick, endTick: before.endTick };
  }
  return undefined;
}

/** The step's context after the ranges the song can derive have been filled in. */
interface ResolvedContext {
  readonly context: ContextSpec;
  readonly errors: string[];
}

/**
 * Resolves the step's `ContextSpec` (06 §3).
 *
 * The summary carries no tick grid, so a two-sided capability takes its ranges from the user's
 * lasso when it leaves them out: the selection *is* the gap for an inpaint and contains the
 * boundary for a transition. Ranges the model did write are kept and validated, because a
 * song-view request without a region has to spell them out. An extend needs no ranges (the client
 * renders the song edge); a partial pair is an error rather than a guess.
 */
function resolvedContext(step: GenerateStep, input: GenerationInput): ResolvedContext {
  const errors: string[] = [];
  const before = step.context.before;
  const after = step.context.after;
  const region = input.region;
  if (step.capability === "generate.extend") {
    return { context: step.context, errors };
  }
  if (before !== undefined && after !== undefined) {
    return { context: step.context, errors };
  }
  if (before !== undefined || after !== undefined) {
    return {
      context: step.context,
      errors: [
        `A ${step.capability} needs context.before and context.after together; write both or neither.`,
      ],
    };
  }
  if (region === undefined) {
    return {
      context: step.context,
      errors: [
        `A ${step.capability} needs the lasso around the ${
          step.capability === "generate.inpaint" ? "gap" : "boundary"
        } (or context.before and context.after in ticks).`,
      ],
    };
  }
  const total = totalTicks(input.doc);
  if (step.capability === "generate.inpaint") {
    const gap = snappedSelection(input.doc, region);
    if (gap.endTick <= gap.startTick) {
      return {
        context: step.context,
        errors: [
          "The selection does not cover a whole bar; select at least one whole bar to fill.",
        ],
      };
    }
    const bars = CONTEXT_BARS;
    const beforeRange = {
      startTick: Math.max(0, gap.startTick - bars * barTicksAt(input.doc, gap.startTick)),
      endTick: gap.startTick,
    };
    const afterRange = {
      startTick: gap.endTick,
      endTick: Math.min(total, gap.endTick + bars * barTicksAt(input.doc, gap.endTick)),
    };
    if (
      beforeRange.startTick >= beforeRange.endTick ||
      afterRange.startTick >= afterRange.endTick
    ) {
      errors.push(
        "An inpaint needs audio on both sides of the gap; select a gap inside the song, not its edge.",
      );
    }
    return { context: { ...step.context, before: beforeRange, after: afterRange }, errors };
  }
  const boundary = nearestBoundary(input.doc, (region.startTick + region.endTick) / 2);
  const bars = CONTEXT_BARS;
  const barTicks = barTicksAt(input.doc, boundary);
  return {
    context: {
      ...step.context,
      before: { startTick: Math.max(0, boundary - bars * barTicks), endTick: boundary },
      after: { startTick: boundary, endTick: Math.min(total, boundary + bars * barTicks) },
    },
    errors,
  };
}

/** Bars of rendered context on each side of a derived gap or boundary (09 §2: up to 8). */
const CONTEXT_BARS = 4;

/**
 * Fills the params the song can answer: the shared musical context, an inpaint's `gapBars`, the
 * overlap default and a transition's default length.
 */
function withFilledParams(
  step: GenerateStep,
  input: GenerationInput,
  tick: number,
  errors: string[],
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    ...step.params,
    context: composedContext(step, input, tick),
  };
  if (step.capability === "generate.inpaint") {
    const target = targetSpan(step);
    if (target !== undefined && target.endTick > target.startTick) {
      const barTicks = barTicksAt(input.doc, target.startTick);
      const bars = (target.endTick - target.startTick) / barTicks;
      if (Number.isInteger(bars)) {
        params.gapBars = bars;
      } else {
        errors.push(
          `The gap ${target.startTick}–${target.endTick} does not span whole bars at this tempo.`,
        );
      }
    }
    params.overlapBars ??= 1;
  } else if (step.capability === "generate.extend") {
    params.overlapBars ??= 2;
  } else if (step.capability === "generate.transition") {
    params.lengthBars ??= 2;
  }
  return params;
}

/**
 * The lasso snapped inward to whole bars: the gap must lie inside the selection, so a
 * bar-aligned lasso is unchanged and a free one loses its partial bar.
 */
function snappedSelection(doc: Project, region: Region): Span {
  const total = totalTicks(doc);
  const start = barCeil(doc, Math.max(0, Math.min(total, region.startTick)));
  const end = barFloor(doc, Math.max(0, Math.min(total, region.endTick)));
  return { startTick: start, endTick: end };
}

/** The first bar line at or after `tick`. */
function barCeil(doc: Project, tick: number): number {
  const bar = barBounds(doc, tick);
  return bar.startTick === tick ? tick : bar.endTick;
}

/** The last bar line at or before `tick`. */
function barFloor(doc: Project, tick: number): number {
  return barBounds(doc, tick).startTick;
}

/** The section boundary nearest `tick` (a section's start, ignoring 0 and the song end). */
function nearestBoundary(doc: Project, tick: number): number {
  const total = totalTicks(doc);
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (const boundary of placedSections(doc).map((entry) => entry.span.startTick)) {
    if (boundary <= 0 || boundary >= total) continue;
    const next = Math.abs(boundary - tick);
    if (next < distance) {
      best = boundary;
      distance = next;
    }
  }
  return best;
}

/** The bar containing `tick`. */
export function barBounds(doc: Project, tick: number): Span {
  const total = totalTicks(doc);
  let start = 0;
  let length = barTicksAt(doc, 0);
  while (start + length <= tick && start < total) {
    start += length;
    length = barTicksAt(doc, start);
  }
  return { startTick: start, endTick: start + length };
}

/** The context the model wrote, with everything the server can read from the song filled in. */
function composedContext(
  step: GenerateStep,
  input: GenerationInput,
  tick: number,
): Record<string, unknown> {
  const given = isRecord(step.params.context) ? step.params.context : {};
  const placed = sectionAt(input.doc, tick);
  const feature =
    placed === undefined
      ? undefined
      : input.features?.find((entry) => entry.sectionId === placed.section.id);
  const energy = feature?.energy ?? placed?.section.energyTarget;
  return {
    bpm: bpmAt(input.doc, tick),
    timeSignature: timeSignatureAt(input.doc, tick),
    // The analysis summary carries the key; the document's effects do not (02 §6, docs/wp/2.6.md A).
    key: given.key ?? analysedKey(input.doc),
    ...(given.chords === undefined ? {} : { chords: given.chords }),
    ...(placed === undefined ? {} : { sectionKind: placed.section.kind }),
    ...(energy === undefined ? {} : { energy }),
    descriptors: descriptorsOf(input.doc),
    seed: typeof given.seed === "number" ? given.seed : derivedSeed(input.doc.id, step),
  };
}

/**
 * The song's key from its analysis summary, as `MusicalContext.key`.
 *
 * The summary's `key` is human-readable ("F# minor", 02 §3.3); an unanalysed song has none, and
 * generation cannot be key-checked without it (09 §6), so the server reports the missing key rather
 * than inventing one.
 */
export function analysedKey(doc: Project): { tonic: string; mode: "major" | "minor" } | undefined {
  for (const ref of Object.values(doc.analyses)) {
    const key = ref.summary?.key;
    if (typeof key !== "string") continue;
    const match = /^([A-Ga-g][#b]?)\s+(major|minor)$/.exec(key.trim());
    const tonic = match?.[1];
    const mode = match?.[2];
    if (tonic === undefined || (mode !== "major" && mode !== "minor")) continue;
    return { tonic: tonic.charAt(0).toUpperCase() + tonic.slice(1), mode };
  }
  return undefined;
}

/** `ContextSpec` shape and range checks against the song (06 §5). */
function contextErrors(step: GenerateStep, doc: Project): string[] {
  const errors: string[] = [];
  const total = totalTicks(doc);
  for (const key of ["before", "after"] as const) {
    const range = step.context[key];
    if (range === undefined) continue;
    if (range.startTick < 0 || range.endTick > total || range.startTick >= range.endTick) {
      errors.push(
        `context.${key} (${range.startTick}–${range.endTick}) is outside the song (0–${total}).`,
      );
    }
  }
  errors.push(...regionTracksErrors(step.context.tracks, doc));
  for (const track of step.context.conditioningStems ?? []) {
    if (!knownTrack(doc, track)) {
      errors.push(`context.conditioningStems names unknown track ${track}.`);
    }
  }
  const before = step.context.before;
  const after = step.context.after;
  if (step.capability === "generate.extend") {
    const direction = step.params.direction;
    if (direction === "forward" && before !== undefined && before.endTick !== total) {
      errors.push("A forward extend's context.before must end at the end of the song.");
    }
    if (direction === "backward" && after !== undefined && after.startTick !== 0) {
      errors.push("A backward extend's context.after must start at the start of the song.");
    }
  }
  return errors;
}

/** The target-span checks: whole bars where it matters, and never a locked section. */
function targetErrors(step: GenerateStep, doc: Project, target: Span | undefined): string[] {
  if (target === undefined) return [];
  const errors: string[] = [];
  if (step.capability === "generate.inpaint") {
    const barTicks = barTicksAt(doc, target.startTick);
    const length = target.endTick - target.startTick;
    const bars = step.params.gapBars;
    if (length <= 0) {
      errors.push("An inpaint's gap is empty: context.after must start after context.before ends.");
    } else if (typeof bars === "number" && length !== bars * barTicks) {
      errors.push(
        `params.gapBars is ${bars}, but the gap is ${length} ticks (${
          length / barTicks
        } bars at this tempo); make both match.`,
      );
    }
    if (lockedIn(doc, target).length > 0) errors.push("The gap would change a locked section.");
    return errors;
  }
  // A transition lands on the incoming section, which must accept a new transition (02 §3.5).
  const incoming = sectionAt(doc, target.startTick);
  if (incoming !== undefined && incoming.section.locked === true) {
    errors.push(`The transition would change the locked section "${incoming.section.label}".`);
  }
  return errors;
}

/**
 * Checks one `apply_generated` step against the generate step it names (06 §3, §5).
 *
 * @param step the placement step
 * @param generated the earlier generate step it takes its audio from
 * @param doc the request's document
 * @returns the problems, empty when the placement is valid
 */
export function placementErrors(
  step: ApplyGeneratedStep,
  generated: GenerateStep,
  doc: Project,
): string[] {
  const errors: string[] = [];
  const region = step.placement.region;
  if (region.startTick >= region.endTick) {
    errors.push("The placement region is empty.");
  }
  errors.push(...regionTracksErrors(region.tracks, doc));
  if (region.startTick < 0) errors.push("The placement region starts before the song.");

  const total = totalTicks(doc);
  const params = generated.params;
  if (generated.capability === "generate.extend") {
    const bars = typeof params.bars === "number" ? params.bars : 1;
    const newTicks = bars * barTicksAt(doc, total);
    const direction = params.direction;
    if (direction === "backward") {
      if (region.startTick !== 0 || region.endTick > newTicks) {
        errors.push(
          `A backward extend is placed at the start of the song (0–${newTicks}), not ${region.startTick}–${region.endTick}.`,
        );
      }
    } else if (
      region.startTick < total - barTicksAt(doc, total) ||
      region.endTick > total + newTicks
    ) {
      errors.push(
        `A forward extend is placed at the end of the song (${total}–${total + newTicks}), not ${region.startTick}–${region.endTick}.`,
      );
    }
  } else {
    if (region.endTick > total) {
      errors.push(`The placement region ends after the song (${total} ticks).`);
    }
    const target = targetSpan(generated);
    if (target !== undefined) {
      if (generated.capability === "generate.inpaint") {
        if (region.startTick !== target.startTick || region.endTick !== target.endTick) {
          errors.push(
            `An inpaint fills its gap (${target.startTick}–${target.endTick}), not ${region.startTick}–${region.endTick}.`,
          );
        }
      } else if (region.startTick > target.startTick || region.endTick < target.startTick) {
        errors.push(`A transition's placement must contain its boundary at ${target.startTick}.`);
      }
    }
  }

  if (step.placement.trackId !== undefined && !knownTrack(doc, step.placement.trackId)) {
    errors.push(`The placement names unknown track ${step.placement.trackId}.`);
  }
  if (
    step.placement.mode !== "insert" &&
    step.placement.trackId === undefined &&
    step.placement.newTrack === undefined
  ) {
    errors.push("A replaced or layered placement needs a trackId or a newTrack.");
  }
  return errors;
}

/**
 * Checks one `smooth` step (06 §3, 03 §8.2).
 *
 * Smoothing compiles to ops on the region, so it must not touch a locked section.
 */
export function smoothErrors(step: SmoothStep, doc: Project): string[] {
  const errors: string[] = [];
  const region = step.region;
  if (region.startTick >= region.endTick) errors.push("The smooth region is empty.");
  if (region.startTick < 0 || region.endTick > totalTicks(doc)) {
    errors.push(`The smooth region ${region.startTick}–${region.endTick} is outside the song.`);
  }
  errors.push(...regionTracksErrors(region.tracks, doc));
  if (lockedIn(doc, region).length > 0)
    errors.push("The smooth region would change a locked section.");
  return errors;
}

/**
 * The generation-specific region discipline (06 §7).
 *
 * An extend adds a section, so its variant is song-wide and is exempt. An inpaint or a
 * transition is an in-place edit of the span it targets, so inside a lasso that span
 * must lie inside the lasso.
 */
export function generationRegionErrors(
  variant: PlanVariant,
  requestRegion: Region | undefined,
): string[] {
  if (requestRegion === undefined || variant.scope === "song") return [];
  const errors: string[] = [];
  for (const step of variant.steps) {
    if (step.kind !== "generate" || step.capability === "generate.extend") continue;
    const target = targetSpan(step);
    if (target === undefined) continue;
    if (target.startTick < requestRegion.startTick || target.endTick > requestRegion.endTick) {
      errors.push(
        `Its ${step.capability} targets ${target.startTick}–${target.endTick}, outside the selected region ${requestRegion.startTick}–${requestRegion.endTick}.`,
      );
    }
    if (
      requestRegion.tracks !== "all" &&
      step.context.tracks !== "all" &&
      step.context.tracks.some((track) => !requestRegion.tracks.includes(track))
    ) {
      errors.push(`Its ${step.capability} renders tracks outside the selected region.`);
    }
  }
  return errors;
}

/**
 * A generative variant needs `scope: "song"` when it extends the arrangement.
 *
 * Adding a section is structural, and 06 §7 requires a song-wide declaration so the UI can
 * warn before the song gets longer.
 */
export function extendScopeErrors(variant: PlanVariant): string[] {
  const extendsSong = variant.steps.some(
    (step) => step.kind === "generate" && step.capability === "generate.extend",
  );
  return extendsSong && variant.scope !== "song"
    ? ['An extend adds a section, so the variant needs scope "song".']
    : [];
}

/** What a plan costs and how long its generation takes (06 §3). */
export interface PlanEstimate {
  /** Sum over every variant's generate steps: the cost of trying the whole plan. */
  readonly estimatedCredits: number;
  /** The longest single variant, which is what the user waits for. */
  readonly estimatedSeconds: number;
}

/**
 * Estimates one plan (06 §3).
 *
 * Credits are summed over all variants because the allowance check must keep the whole
 * menu affordable (06 §5); seconds are the longest variant because a user tries one at a
 * time. Candidates of one job run one after another, so a step takes `n × per-candidate`.
 *
 * @param variants the surviving variants
 * @param config the credit table
 * @returns the plan's estimates
 */
export function estimatePlan(
  variants: readonly PlanVariant[],
  config: CreditsConfig,
): PlanEstimate {
  let estimatedCredits = 0;
  let estimatedSeconds = 0;
  for (const variant of variants) {
    let variantSeconds = 0;
    for (const step of generateSteps(variant)) {
      estimatedCredits += creditCharge(step.capability, step.params, config).credits;
      variantSeconds += generationSeconds(step);
    }
    estimatedSeconds = Math.max(estimatedSeconds, variantSeconds);
  }
  return { estimatedCredits, estimatedSeconds };
}

/** The 09 §5 latency targets: the first preview is ≤ 15 s, an HQ render ≤ 60 s. */
const SECONDS_PER_CANDIDATE: Readonly<Record<string, number>> = { preview: 15, hq: 60 };

/** The expected wall time of one generate step, in seconds. */
export function generationSeconds(step: GenerateStep): number {
  const tier = typeof step.params.tier === "string" ? step.params.tier : "preview";
  const n = typeof step.params.n === "number" && step.params.n > 0 ? step.params.n : 1;
  return (SECONDS_PER_CANDIDATE[tier] ?? 15) * n;
}

/** The generate steps of a variant. */
export function generateSteps(variant: PlanVariant): GenerateStep[] {
  return variant.steps.filter((step): step is GenerateStep => step.kind === "generate");
}

/** True when a variant needs generated audio. */
export function hasGeneration(variant: PlanVariant): boolean {
  return variant.steps.some((step) => step.kind === "generate");
}

/** The document's total length in ticks. */
export function totalTicks(doc: Project): number {
  return doc.arrangement.sections.reduce((sum, section) => sum + section.lengthTicks, 0);
}

/** Every section with its absolute span, in arrangement order. */
function placedSections(doc: Project): PlacedSection[] {
  const out: PlacedSection[] = [];
  let tick = 0;
  for (const section of doc.arrangement.sections) {
    out.push({ section, span: { startTick: tick, endTick: tick + section.lengthTicks } });
    tick += section.lengthTicks;
  }
  return out;
}

/** The section whose span contains `tick`, or the last one at the very end. */
function sectionAt(doc: Project, tick: number): PlacedSection | undefined {
  const sections = placedSections(doc);
  return (
    sections.find((entry) => tick >= entry.span.startTick && tick < entry.span.endTick) ??
    sections[sections.length - 1]
  );
}

/** The sections that a span overlaps and that are locked. */
function lockedIn(doc: Project, span: Span): string[] {
  return placedSections(doc)
    .filter(
      (entry) =>
        entry.section.locked === true &&
        entry.span.startTick < Math.max(span.endTick, span.startTick + 1) &&
        entry.span.endTick > span.startTick,
    )
    .map((entry) => entry.section.id);
}

/** The bpm in force at `tick`, from the tempo map. */
export function bpmAt(doc: Project, tick: number): number {
  const points = doc.arrangement.timebase.tempoMap;
  let bpm = points[0]?.bpm ?? 120;
  for (const point of points) {
    if (point.tick <= tick) bpm = point.bpm;
  }
  return bpm;
}

/** The time signature in force at `tick`, from the bar-keyed list. */
export function timeSignatureAt(doc: Project, tick: number): [number, number] {
  const ppq = doc.arrangement.timebase.ppq;
  let bar = 0;
  let barTick = 0;
  let current: [number, number] = [4, 4];
  for (const signature of doc.arrangement.timebase.timeSignatures) {
    while (bar < signature.bar) {
      barTick += (ppq * 4 * current[0]) / current[1];
      bar += 1;
    }
    if (barTick <= tick) current = [signature.numerator, signature.denominator];
  }
  return current;
}

/** The ticks in one bar at `tick`. */
export function barTicksAt(doc: Project, tick: number): number {
  const [numerator, denominator] = timeSignatureAt(doc, tick);
  return (doc.arrangement.timebase.ppq * 4 * numerator) / denominator;
}

/** The song's tags as style descriptors (09 §2.1: no artist names). */
function descriptorsOf(doc: Project): string[] {
  return doc.meta.tags.slice(0, 8);
}

/** True when the document has this track. */
function knownTrack(doc: Project, trackId: string): boolean {
  return doc.tracks.some((track) => track.id === trackId);
}

/** Known-track checks for a `ContextSpec`/`Region` track selection. */
function regionTracksErrors(tracks: readonly string[] | "all", doc: Project): string[] {
  if (tracks === "all") return [];
  const errors: string[] = [];
  for (const track of tracks) {
    if (!knownTrack(doc, track)) errors.push(`unknown track ${track}`);
  }
  return errors;
}

/**
 * A stable 32-bit seed for a generate step.
 *
 * Deterministic in (song, capability, step id), so the same request gives the same audio
 * without the model inventing a seed. FNV-1a, because a hash is the only thing a prompt
 * cannot get wrong.
 */
export function derivedSeed(songId: string, step: GenerateStep): number {
  let hash = 0x811c9dc5;
  for (const char of `${songId}\u0000${step.capability}\u0000${step.id}`) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Compact JSON for the prompt. */
function compact(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

/** A plain object, not an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The step envelope a generative variant is written in. */
export function generationShapesText(): string {
  return [
    'GENERATION STEPS (params under CAPABILITIES.generation; the server fills params.context from the song, an inpaint\'s gapBars and the tick ranges from the lasso; an extend variant needs scope "song"):',
    `  ${compact({ kind: "generate", id: "g1", capability: "generate.inpaint", params: "<capability params>", context: { tracks: "all" } })}`,
    `  ${compact({ kind: "apply_generated", from: "g1", placement: { region: { startTick: 0, endTick: 15360, tracks: ["trk_1"] }, trackId: "trk_1", mode: "replace" } })}`,
    `  ${compact({ kind: "smooth", region: { startTick: 0, endTick: 15360, tracks: ["trk_1"] }, tools: ["crossfade", "loudness_match"] })}`,
  ].join("\n");
}

/** The smoothing tools a `smooth` step may name (03 §8.2). */
export const SMOOTH_TOOLS: readonly string[] = [
  "crossfade",
  "loudness_match",
  "spectral_match",
  "beat_align",
];

/**
 * Shape checks for a `generate` step, before its params and context are resolved.
 *
 * The plan-level `PlanStep` union reports a malformed step as "must have required property
 * 'ops'" (the first branch), so every step kind is checked here by its own keys; the repair
 * round then gets `variant 1, step 2 (generate): missing "capability"` (06 §5).
 *
 * @param raw the model's step
 * @returns short problems, without the variant/step prefix `opErrors.ts` adds
 */
export function generateStepShapeErrors(raw: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (typeof raw.id !== "string" || raw.id === "") errors.push('missing "id"');
  if (typeof raw.capability !== "string") {
    errors.push(`missing "capability"; use one of ${GENERATION_CAPABILITIES.join(", ")}`);
  } else if (!isGenerationCapability(raw.capability)) {
    errors.push(
      `"${raw.capability}" is not offered; use one of ${GENERATION_CAPABILITIES.join(", ")}`,
    );
  }
  if (!isRecord(raw.params)) errors.push('"params" must be an object');
  errors.push(...contextShapeErrors(raw.context, "context"));
  return errors;
}

/**
 * Shape checks for an `apply_generated` step (06 §3).
 *
 * @param raw the model's step
 * @returns short problems
 */
export function applyStepShapeErrors(raw: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (typeof raw.from !== "string" || raw.from === "") {
    errors.push('missing "from"; name the generate step it places');
  }
  const placement = isRecord(raw.placement) ? raw.placement : undefined;
  if (placement === undefined) {
    errors.push('missing "placement" { region, mode }');
    return errors;
  }
  errors.push(...regionShapeErrors(placement.region, "placement.region"));
  const mode = placement.mode;
  if (mode !== "replace" && mode !== "layer" && mode !== "insert") {
    errors.push('placement.mode must be one of "replace", "layer", "insert"');
  }
  if (placement.trackId !== undefined && typeof placement.trackId !== "string") {
    errors.push("placement.trackId must be a track id");
  }
  if (placement.newTrack !== undefined) {
    const track = isRecord(placement.newTrack) ? placement.newTrack : undefined;
    if (track === undefined || typeof track.name !== "string" || typeof track.role !== "string") {
      errors.push('placement.newTrack needs { "name", "role" }');
    }
  }
  return errors;
}

/**
 * Shape checks for a `smooth` step (06 §3, 03 §8.2).
 *
 * @param raw the model's step
 * @returns short problems
 */
export function smoothStepShapeErrors(raw: Record<string, unknown>): string[] {
  const errors = regionShapeErrors(raw.region, "region");
  const tools = raw.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    errors.push(`tools needs at least one of ${SMOOTH_TOOLS.join(", ")}`);
  } else {
    const outside = tools.filter(
      (tool) => typeof tool !== "string" || !SMOOTH_TOOLS.includes(tool),
    );
    if (outside.length > 0) {
      errors.push(
        `${outside.map((tool) => String(tool)).join(", ")} is not a smoothing tool; use ${SMOOTH_TOOLS.join(", ")}`,
      );
    }
  }
  return errors;
}

/** A `ContextSpec`'s shape (the ranges' place in the song is checked later). */
function contextShapeErrors(value: unknown, name: string): string[] {
  if (!isRecord(value)) return [`missing "${name}" { tracks }`];
  const errors = regionTracksShapeErrors(value.tracks, `${name}.tracks`);
  for (const key of ["before", "after"] as const) {
    const range = value[key];
    if (range === undefined) continue;
    errors.push(...tickRangeShapeErrors(range, `${name}.${key}`));
  }
  return errors;
}

/** A `Region`'s shape. */
function regionShapeErrors(value: unknown, name: string): string[] {
  if (!isRecord(value)) return [`missing "${name}" { startTick, endTick, tracks }`];
  const errors: string[] = [];
  if (!Number.isInteger(value.startTick) || !Number.isInteger(value.endTick)) {
    errors.push(`${name} needs integer startTick and endTick`);
  }
  errors.push(...regionTracksShapeErrors(value.tracks, `${name}.tracks`));
  return errors;
}

/** A `TickRange`'s shape. */
function tickRangeShapeErrors(value: unknown, name: string): string[] {
  if (!isRecord(value) || !Number.isInteger(value.startTick) || !Number.isInteger(value.endTick)) {
    return [`${name} needs integer startTick and endTick`];
  }
  return [];
}

/** `tracks` as a track-id array or `"all"`. */
function regionTracksShapeErrors(value: unknown, name: string): string[] {
  if (value === "all") return [];
  if (Array.isArray(value) && value.every((track) => typeof track === "string")) return [];
  return [`${name} must be "all" or a list of track ids`];
}
