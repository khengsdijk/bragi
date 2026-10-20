/**
 * The planner service (06 §2–§5): policy pre-pass → classify → context → model → validate/repair
 * → `EditPlan` (or an `Explanation` for "Explain this").
 *
 * v1 offers ops-only plans: `estimatedCredits` and `estimatedSeconds` are zero because every ops
 * step applies instantly. Generation steps are part of the schema but rejected by validation until
 * WP-2.7 registers a capability.
 */
import type { EditPlan, Explanation, PlanRequest, PlanVariant } from "@bragi/schemas";

import { ApiError } from "../errors.js";
import { newPlanId as createPlanId } from "../ids.js";
import { buildCatalogue } from "./catalogue.js";
import { classify } from "./classify.js";
import { loadPlannerConfig, type PlannerConfig } from "./config.js";
import { buildUserMessage, createWasmSummarizer, type Summarizer } from "./context.js";
import { explain } from "./explain.js";
import { parseModelJson } from "./json.js";
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
  plan(request: PlanRequest): Promise<EditPlan | Explanation>;
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

  async plan(request: PlanRequest): Promise<EditPlan | Explanation> {
    const classification = classify(request);
    if (classification.explainIntent) {
      return explain(request, {
        client: this.deps.client,
        summarizer: this.deps.summarizer,
        config: this.deps.config,
      });
    }

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
      ? await this.validate(parsed.value, request, classification.songWideIntent, policy.names)
      : undefined;

    if (validation !== undefined && validation.policyViolation !== undefined) {
      throw new ApiError("PROMPT_POLICY", validation.policyViolation);
    }

    // One repair round (06 §5): send the concrete problems back and ask for the corrected plan.
    if (!parsed.ok || validation === undefined || !validation.ok) {
      const errors = parsed.ok ? (validation?.errors ?? []) : [parsed.error];
      messages.push(
        { role: "assistant", content: replyText(first) },
        {
          role: "user",
          content: [
            "That plan was rejected:",
            ...errors.map((error) => `- ${error}`),
            "",
            'Return only a corrected JSON object. Every step must be { "kind": "ops", "ops": [...] }, stay inside the requested region, and leave locked sections alone.',
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
        ? await this.validate(parsed.value, request, classification.songWideIntent, policy.names)
        : undefined;
      if (validation !== undefined && validation.policyViolation !== undefined) {
        throw new ApiError("PROMPT_POLICY", validation.policyViolation);
      }
    }

    if (!parsed.ok || validation === undefined || !validation.ok) {
      throw new ApiError(
        "PLAN_INVALID",
        "I couldn't turn that into a valid edit plan. Try describing the change a little more specifically.",
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
  ): Promise<PlanValidation> {
    return validateRawPlan(raw, {
      request,
      model: this.deps.model,
      songWideIntent,
      blockedNames,
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
      estimatedCredits: 0,
      estimatedSeconds: 0,
      notices: [...notices, ...dropped],
    };
  }
}

/** Parses the tool arguments or the plain-text JSON reply. */
function parsePlan(reply: LlmReply): ParsedPlan {
  // Prefer the tool call, but try the content too: a provider can return truncated tool arguments
  // and still include the object in `content`, and a prose reply is not worth a repair round when
  // the JSON is right there.
  for (const candidate of [reply.toolArguments, reply.text]) {
    if (candidate === undefined || candidate.trim() === "") continue;
    try {
      return { ok: true, value: parseModelJson(candidate) };
    } catch {
      // try the next representation
    }
  }
  return { ok: false, error: "the reply was not JSON (return exactly one JSON object)" };
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
