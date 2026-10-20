/**
 * "Explain this" (06 §8): a grounded answer plus canvas highlights, no ops.
 *
 * Uses the same summary and the same user-message escaping as a plan, but asks for the
 * `Explanation` JSON schema through `response_format` instead of the tool. One repair round is
 * allowed, exactly like a plan; highlights are checked against the song's span and track IDs.
 */
import {
  EXPLAIN_RESPONSE_SCHEMA,
  type Explanation,
  type PlanRequest,
  type Project,
  validateExplanation,
} from "@bragi/schemas";

import type { PlannerConfig } from "./config.js";
import { buildUserMessage, type Summarizer, type SummaryFocus } from "./context.js";
import { parseModelJson } from "./json.js";
import {
  type ChatMessage,
  type LlmReply,
  type PlannerLlm,
  PlannerModelError,
} from "./openrouter.js";
import { explainPrompt, systemPrompt } from "./prompts.js";
import { regionInsideSong } from "./validate.js";

/** The dependencies the explain path needs. */
export interface ExplainDeps {
  client: PlannerLlm;
  summarizer: Summarizer;
  config: PlannerConfig;
}

/** The parsed result of one model reply. */
type ParseResult = { ok: true; value: Explanation } | { ok: false; errors: string[] };

/**
 * Produces an `Explanation` for a request.
 *
 * @param request the validated PlanRequest
 * @param deps the model client, summariser and config
 * @returns the Explanation, validated against the schema and the song
 * @throws PlannerModelError when OpenRouter fails irrecoverably
 * @throws Error with a plain message when the reply is still invalid after one repair
 */
export async function explain(request: PlanRequest, deps: ExplainDeps): Promise<Explanation> {
  const focus: SummaryFocus = {
    ...(request.region === undefined ? {} : { region: request.region }),
    selectedTrackIds: request.uiContext.selectedTrackIds,
    selectedSectionIds: request.uiContext.selectedSectionIds,
  };
  const summary = await deps.summarizer.summarize(request.doc, focus);
  const user = buildUserMessage({
    summary,
    prompt: request.prompt,
    ...(request.sectionFeatures === undefined ? {} : { sectionFeatures: request.sectionFeatures }),
  });
  const system = `${systemPrompt()}\n\n${explainPrompt()}`;
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const first = await deps.client.complete({
    model: deps.config.models.explain,
    messages,
    maxTokens: deps.config.maxTokens,
    responseFormat: { name: "Explanation", schema: EXPLAIN_RESPONSE_SCHEMA },
  });

  let parsed = parseExplanation(first, request.doc);
  if (parsed.ok) return parsed.value;

  messages.push(
    { role: "assistant", content: first.text },
    {
      role: "user",
      content: [
        "That reply was not a valid Explanation:",
        ...parsed.errors.map((error) => `- ${error}`),
        "Return only the corrected JSON object.",
      ].join("\n"),
    },
  );
  const second = await deps.client.complete({
    model: deps.config.models.explain,
    messages,
    maxTokens: deps.config.maxTokens,
    responseFormat: { name: "Explanation", schema: EXPLAIN_RESPONSE_SCHEMA },
  });
  parsed = parseExplanation(second, request.doc);
  if (parsed.ok) return parsed.value;

  throw new PlannerModelError("I couldn't produce a valid explanation from that request.", false);
}

/** Parses and validates one reply against the schema and the song. */
function parseExplanation(reply: LlmReply, doc: Project): ParseResult {
  let raw: unknown;
  try {
    raw = parseModelJson(reply.text);
  } catch {
    return {
      ok: false,
      errors: ["the reply was not JSON (return exactly one JSON object)"],
    };
  }
  if (!validateExplanation(raw)) {
    return {
      ok: false,
      errors: (validateExplanation.errors ?? [])
        .slice(0, 8)
        .map(
          (error) =>
            `${error.instancePath === "" ? "/" : error.instancePath}: ${error.message ?? "invalid"}`,
        ),
    };
  }
  const errors = raw.highlights.flatMap((highlight, index) =>
    regionInsideSong(doc, highlight.region).map((error) => `highlights[${index}]: ${error}`),
  );
  return errors.length === 0 ? { ok: true, value: raw } : { ok: false, errors };
}
