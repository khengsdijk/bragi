/**
 * The planner service (06 §2–§5): policy pre-pass → classify → context → model → validate/repair
 * → `EditPlan` (or an `Explanation` for "Explain this").
 *
 * A plan is a menu of ops-only and (at most one) generative variants. `estimatedCredits` and
 * `estimatedSeconds` price its generate steps (06 §3), and an over-budget plan is sent back to the
 * model once before it fails (06 §5).
 */
import type { EditPlan, Explanation, PlanRequest, PlanVariant } from "@bragi/schemas";

import { ApiError } from "../errors.js";
import { newPlanId as createPlanId } from "../ids.js";
import { buildCatalogue } from "./catalogue.js";
import { classify } from "./classify.js";
import { loadPlannerConfig, type PlannerConfig } from "./config.js";
import { buildUserMessage, createWasmSummarizer, type Summarizer } from "./context.js";
import { explain } from "./explain.js";
import { normalizePlanEnvelope, parseModelJson } from "./json.js";
import {
  type ChatMessage,
  type LlmReply,
  OpenRouterClient,
  type PlannerLlm,
} from "./openrouter.js";
import { applyPolicy } from "./policy.js";
import { systemPrompt } from "./prompts.js";
import { type DryRunModel, type PlanValidation, validateRawPlan } from "./validate.js";
import { loadModelWasm } from "./wasm.js";

/** The seam the route sees; tests inject a fake client and summariser. */
export interface PlannerService {
  /**
   * @param request the planner request
   * @param budget what the user can spend, so an over-budget plan gets the repair round (06 §5)
   */
  plan(request: PlanRequest, budget?: PlanBudget): Promise<EditPlan | Explanation>;
}

/** What the caller knows about the user's credits (06 §5). */
export interface PlanBudget {
  /** Credits left today; absent means unlimited (single-user mode, 05 §9). */
  remainingCredits?: number | undefined;
}

/** Everything the planner needs; assembled once at boot or per test. */
export interface PlannerDeps {
  client: PlannerLlm;
  summarizer: Summarizer;
  model: DryRunModel;
  config: PlannerConfig;
  /** Override for tests (the default is `pln_` + ULID). */
  newPlanId?: () => string;
}

/** The parsed model reply. */
type ParsedPlan = { ok: true; value: unknown } | { ok: false; error: string };

/** The planner implementation. */
export class Planner implements PlannerService {
  private readonly deps: PlannerDeps;

  constructor(deps: PlannerDeps) {
    this.deps = deps;
  }

  async plan(request: PlanRequest, budget: PlanBudget = {}): Promise<EditPlan | Explanation> {
    const classification = classify(request);
    if (classification.explainIntent) {
      return explain(request, {
        client: this.deps.client,
        summarizer: this.deps.summarizer,
        config: this.deps.config,
      });
    }

    const maxCredits = creditLimit(request, budget);
    const policy = applyPolicy(request.prompt, request.libraryNames ?? []);
    const summary = await this.deps.summarizer.summarize(request.doc, {
      ...(request.region === undefined ? {} : { region: request.region }),
      selectedTrackIds: request.uiContext.selectedTrackIds,
      selectedSectionIds: request.uiContext.selectedSectionIds,
    });
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt() },
      {
        role: "user",
        content: buildUserMessage({
          summary,
          prompt: policy.prompt,
          catalogue: buildCatalogue(),
          ...(request.sectionFeatures === undefined
            ? {}
            : { sectionFeatures: request.sectionFeatures }),
        }),
      },
    ];
    const model = this.deps.config.models[classification.tier];
    const reasoning = this.deps.config.reasoning[classification.tier];

    const first = await this.deps.client.complete({
      model,
      reasoning,
      messages,
      maxTokens: this.deps.config.maxTokens,
      tool: true,
    });
    let parsed = parsePlan(first);
    let validation = parsed.ok
      ? await this.validate(
          parsed.value,
          request,
          classification.songWideIntent,
          policy.names,
          maxCredits,
        )
      : undefined;

    if (validation !== undefined && validation.policyViolation !== undefined) {
      throw new ApiError("PROMPT_POLICY", validation.policyViolation);
    }

    // One repair round (06 §5): send the concrete problems back and ask for the corrected plan.
    let firstAttempt: string[] | undefined;
    if (!parsed.ok || validation === undefined || !validation.ok) {
      const errors = parsed.ok ? (validation?.errors ?? []) : [parsed.error];
      firstAttempt = debugErrors(errors);
      messages.push(
        { role: "assistant", content: replyText(first) },
        {
          role: "user",
          content: [
            "That plan was rejected:",
            ...errors.map((error) => `- ${error}`),
            "",
            "Return only a corrected JSON object: the same shape as before, every step valid, inside the requested region, and away from locked sections. What the song cannot do is in the error list; do not repeat it.",
          ].join("\n"),
        },
      );
      const second = await this.deps.client.complete({
        model,
        reasoning,
        messages,
        maxTokens: this.deps.config.maxTokens,
        tool: true,
      });
      parsed = parsePlan(second);
      validation = parsed.ok
        ? await this.validate(
            parsed.value,
            request,
            classification.songWideIntent,
            policy.names,
            maxCredits,
          )
        : undefined;
      if (validation !== undefined && validation.policyViolation !== undefined) {
        throw new ApiError("PROMPT_POLICY", validation.policyViolation);
      }
    }

    if (!parsed.ok || validation === undefined || !validation.ok) {
      const repairAttempt = debugErrors(parsed.ok ? (validation?.errors ?? []) : [parsed.error]);
      throw new ApiError(
        "PLAN_INVALID",
        "I couldn't turn that into a valid edit plan. Try describing the change a little more specifically.",
        { firstAttempt: firstAttempt ?? [], repairAttempt },
      );
    }

    return this.toPlan(parsed.value, validation, policy.notices);
  }

  /** Validates a parsed reply against the schema, the dry run and the guardrails. */
  private validate(
    raw: unknown,
    request: PlanRequest,
    songWideIntent: boolean,
    blockedNames: readonly string[],
    maxCredits: number | undefined,
  ): Promise<PlanValidation> {
    return validateRawPlan(raw, {
      request,
      model: this.deps.model,
      songWideIntent,
      blockedNames,
      maxCredits,
    });
  }

  /** Fills the server-owned fields the model does not produce (06 §3). */
  private toPlan(raw: unknown, validation: PlanValidation, notices: string[]): EditPlan {
    const plan = raw as EditPlan;
    const dropped = validation.dropped.map(
      (variant) => `I left out the "${variant.label}" variant because it did not pass validation.`,
    );
    return {
      planId: (this.deps.newPlanId ?? createPlanId)(),
      interpretation: plan.interpretation,
      ...(plan.clarification === undefined ? {} : { clarification: plan.clarification }),
      variants: variantTuple(validation.variants),
      estimatedCredits: validation.estimate.estimatedCredits,
      estimatedSeconds: validation.estimate.estimatedSeconds,
      notices: [...notices, ...dropped],
    };
  }
}

/**
 * The plan's credit ceiling: the remaining daily allowance and `preferences.maxCredits`,
 * whichever is lower (06 §5).
 */
function creditLimit(request: PlanRequest, budget: PlanBudget): number | undefined {
  const preference = request.preferences?.maxCredits;
  const remaining = budget.remainingCredits;
  if (preference === undefined) return remaining;
  if (remaining === undefined) return preference;
  return Math.min(preference, remaining);
}

/** Parses the tool arguments or the plain-text JSON reply. */
function parsePlan(reply: LlmReply): ParsedPlan {
  // Prefer the tool call, but try the content too: a provider can return truncated tool arguments
  // and still include the object in `content`, and a prose reply is not worth a repair round when
  // the JSON is right there.
  for (const candidate of [reply.toolArguments, reply.text]) {
    if (candidate === undefined || candidate.trim() === "") continue;
    try {
      return { ok: true, value: normalizePlanEnvelope(parseModelJson(candidate)) };
    } catch {
      // try the next representation
    }
  }
  return { ok: false, error: "the reply was not JSON (return exactly one JSON object)" };
}

/**
 * Caps a round's validation messages for the `PLAN_INVALID` details, so a verbose model cannot
 * bloat the response: at most 20 messages of at most 500 characters each. Only the messages are
 * kept, never the prompt or the model's reply.
 */
function debugErrors(errors: readonly string[]): string[] {
  return errors.slice(0, 20).map((error) => error.slice(0, 500));
}

/** The assistant turn sent back in the repair round. */
function replyText(reply: LlmReply): string {
  return reply.toolArguments ?? reply.text;
}

/** Narrows 0–3 variants (the schema's tuple union) without an unchecked assertion. */
function variantTuple(variants: PlanVariant[]): EditPlan["variants"] {
  if (variants.length === 0) return [];
  if (variants.length === 1 && variants[0]) return [variants[0]];
  if (variants.length === 2 && variants[0] && variants[1]) return [variants[0], variants[1]];
  if (variants.length === 3 && variants[0] && variants[1] && variants[2]) {
    return [variants[0], variants[1], variants[2]];
  }
  throw new Error("the validation result exceeded the schema's three variants");
}

/**
 * Builds the production planner from the environment.
 *
 * @param env environment to read (defaults to `process.env`)
 * @returns a planner whose client has a key and whose dry run uses the real wasm
 * @throws PlannerUnavailableError when `OPENROUTER_API_KEY` is unset
 */
export async function createPlannerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlannerService> {
  const config = loadPlannerConfig(env);
  const client = OpenRouterClient.fromEnv(env, config.timeoutMs);
  const model = await loadModelWasm();
  return new Planner({
    client,
    summarizer: createWasmSummarizer(),
    model,
    config,
  });
}
