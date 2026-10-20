/**
 * The OpenRouter chat-completions client (06 §4, ADR-0012).
 *
 * One POST to OpenRouter's OpenAI-compatible endpoint, with the standard library's `fetch` only.
 * The transport is injectable, so tests cover the request body, headers, data policy and error
 * mapping offline. The API key is read from the environment and is never logged, echoed in an
 * error, or stored anywhere but the request headers.
 *
 * Two output modes share the client:
 * - **plan**: OpenAI-format tool calling with one tool, `propose_edit_plan`, forced by
 *   `tool_choice`; a plain JSON reply is accepted and validated the same way (06 §4).
 * - **explain**: a JSON-schema `response_format` (ADR-0012 §4), degrading to `json_object` and then
 *   to no format when a model rejects the stronger level with HTTP 400.
 */
import { PLAN_TOOL_SCHEMA } from "@bragi/schemas";

/** The environment variable holding the OpenRouter key. */
export const API_KEY_ENV = "OPENROUTER_API_KEY";
/** Optional override of the API base URL (a proxy or a test server). */
export const BASE_URL_ENV = "OPENROUTER_BASE_URL";
/** `allow` or `deny`: whether OpenRouter may route to providers that retain or train on prompts. */
export const DATA_COLLECTION_ENV = "OPENROUTER_DATA_COLLECTION";

/** OpenRouter's production endpoint. */
export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
/** Recommended attribution headers (ADR-0012 §2). */
export const APP_REFERER = "https://github.com/bragi-music/bragi";
export const APP_TITLE = "Bragi";
/** The single planner tool (06 §4). */
export const PLAN_TOOL_NAME = "propose_edit_plan";

/** What the client hands the transport. */
export interface HttpRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

/** What the transport returns. Non-2xx statuses are returned, not thrown. */
export interface HttpResponse {
  status: number;
  body: string;
}

/** A blocking HTTP exchange; rejects on a network error or timeout. */
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/** The production transport: `fetch` with an abort-based timeout. */
export const fetchTransport: Transport = async (request) => {
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  return { status: response.status, body: await response.text() };
};

/** A chat message in OpenAI format. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** The JSON-schema response format for the explain path. */
export interface ResponseFormat {
  name: string;
  schema: Record<string, unknown>;
}

/** One completion request. */
export interface LlmRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  /** Send the forced `propose_edit_plan` tool. */
  tool?: boolean;
  /** Send a JSON-schema response format instead of a tool. */
  responseFormat?: ResponseFormat;
}

/** Token usage OpenRouter reports (`usage: { include: true }`); absent when a provider omits it. */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Charged cost in USD, when OpenRouter prices the model. */
  costUsd?: number;
}

/** A completion reply: text and, when the model used the tool, its JSON arguments. */
export interface LlmReply {
  text: string;
  /** Raw `arguments` string of the tool call; the caller parses and validates it. */
  toolArguments?: string;
  /** Optional usage and cost, requested for the bench (06 §9); the planner ignores it. */
  usage?: LlmUsage;
}

/** The seam the planner sees; tests implement it with a fake. */
export interface PlannerLlm {
  complete(request: LlmRequest): Promise<LlmReply>;
}

/** The planner cannot run here (no key). A permanent configuration error. */
export class PlannerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerUnavailableError";
  }
}

/** An OpenRouter failure, mapped like ADR-0012 §5. */
export class PlannerModelError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = "PlannerModelError";
    this.retryable = retryable;
    this.status = status;
  }
}

/** The tool definition sent to OpenRouter; the input schema is generated from `EditPlan`. */
export function planToolDefinition(): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: PLAN_TOOL_NAME,
      description:
        "Propose 1–3 ops-only edit-plan variants for the user's request, as a single JSON object.",
      parameters: PLAN_TOOL_SCHEMA,
    },
  };
}

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl?: string;
  dataCollection?: "allow" | "deny";
  transport?: Transport;
  timeoutMs?: number;
  /** Additional attempts after a retryable failure. Defaults to 2 (three attempts in total). */
  maxRetries?: number;
  /** Base delay between retries; tests pass 0 or a no-op sleep. */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** `OpenRouterClient` over the chat-completions endpoint. */
export class OpenRouterClient implements PlannerLlm {
  private readonly apiKey: string;
  private readonly url: string;
  private readonly dataCollection: "allow" | "deny";
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** 0 = json_schema, 1 = json_object, 2 = none; remembered for the client's lifetime. */
  private formatLevel = 0;

  constructor(options: OpenRouterOptions) {
    this.apiKey = options.apiKey;
    this.url = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
    this.dataCollection = options.dataCollection ?? "deny";
    this.transport = options.transport ?? fetchTransport;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Reads `OPENROUTER_API_KEY` and the optional overrides (ADR-0012 §2). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, timeoutMs?: number): OpenRouterClient {
    const apiKey = env[API_KEY_ENV];
    if (keyMissing(apiKey)) {
      throw new PlannerUnavailableError(
        `${API_KEY_ENV} is not set, so the planner cannot run. Add it to .env or the environment.`,
      );
    }
    return new OpenRouterClient({
      apiKey,
      baseUrl: env[BASE_URL_ENV] ?? DEFAULT_BASE_URL,
      dataCollection: env[DATA_COLLECTION_ENV] === "allow" ? "allow" : "deny",
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  async complete(request: LlmRequest): Promise<LlmReply> {
    let attempt = 0;
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.transport({
          url: this.url,
          headers: this.headers(),
          body: JSON.stringify(this.body(request)),
          timeoutMs: this.timeoutMs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "network error";
        if (attempt < this.maxRetries) {
          await this.backoff(attempt);
          attempt += 1;
          continue;
        }
        throw new PlannerModelError(`OpenRouter request failed: ${message}`, true);
      }

      // A model that rejects the JSON schema is retried weaker, exactly like the describe client;
      // this is a capability probe, not a transient failure, so it does not consume an attempt.
      if (response.status === 400 && request.responseFormat !== undefined && this.formatLevel < 2) {
        this.formatLevel += 1;
        continue;
      }

      const reply = this.reply(response);
      if (reply.retryable && attempt < this.maxRetries) {
        await this.backoff(attempt);
        attempt += 1;
        continue;
      }
      if (reply.error !== undefined) throw reply.error;
      if (reply.value === undefined) {
        throw new PlannerModelError("OpenRouter returned an empty reply", true);
      }
      return reply.value;
    }
  }

  /** The headers, including the key; never logged. */
  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": APP_REFERER,
      "X-Title": APP_TITLE,
    };
  }

  /** The request body. Provider data policy is deny unless the owner relaxed it. */
  private body(request: LlmRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens,
      messages: request.messages,
      provider: { data_collection: this.dataCollection },
      // OpenRouter's usage accounting (06 §9): token counts and, where priced, cost in USD.
      // Optional by contract: a provider that omits `usage` leaves the reply without it.
      usage: { include: true },
    };
    if (request.tool === true) {
      body.tools = [planToolDefinition()];
      body.tool_choice = { type: "function", function: { name: PLAN_TOOL_NAME } };
    } else if (request.responseFormat !== undefined) {
      const format = this.responseFormat(request.responseFormat);
      if (format !== undefined) body.response_format = format;
    }
    return body;
  }

  /** The response format at the current fallback level. */
  private responseFormat(format: ResponseFormat): Record<string, unknown> | undefined {
    if (this.formatLevel === 0) {
      return {
        type: "json_schema",
        json_schema: { name: format.name, strict: false, schema: format.schema },
      };
    }
    if (this.formatLevel === 1) return { type: "json_object" };
    return undefined;
  }

  /** Maps one HTTP response to a reply, a retryable failure or an error. */
  private reply(response: HttpResponse): {
    value?: LlmReply;
    error?: PlannerModelError;
    retryable: boolean;
  } {
    if (response.status < 200 || response.status >= 300) {
      return {
        error: new PlannerModelError(
          errorMessage(response.status, response.body),
          retryableStatus(response.status),
          response.status,
        ),
        retryable: retryableStatus(response.status),
      };
    }

    let data: unknown;
    try {
      data = JSON.parse(response.body);
    } catch {
      return {
        error: new PlannerModelError("OpenRouter returned a non-JSON body", true),
        retryable: true,
      };
    }
    if (!isRecord(data)) {
      return {
        error: new PlannerModelError("OpenRouter returned an unexpected body", true),
        retryable: true,
      };
    }
    // OpenRouter can report a provider failure inside a 200 body.
    if (isRecord(data.error)) {
      const code = data.error.code;
      const status = typeof code === "number" ? code : 502;
      return {
        error: new PlannerModelError(
          errorMessage(status, response.body),
          retryableStatus(status),
          status,
        ),
        retryable: retryableStatus(status),
      };
    }

    const message = firstMessage(data);
    if (message === undefined) {
      return {
        error: new PlannerModelError("OpenRouter returned an empty reply", true),
        retryable: true,
      };
    }
    const toolArguments = toolCallArguments(message);
    const text = typeof message.content === "string" ? message.content : "";
    if (toolArguments === undefined && text.trim() === "") {
      return {
        error: new PlannerModelError("OpenRouter returned an empty reply", true),
        retryable: true,
      };
    }
    const usage = usageOf(data);
    const value: LlmReply = {
      text,
      ...(toolArguments === undefined ? {} : { toolArguments }),
      ...(usage === undefined ? {} : { usage }),
    };
    return { value, retryable: false };
  }

  /** Exponential backoff between retryable attempts. */
  private async backoff(attempt: number): Promise<void> {
    const delay = this.retryDelayMs * 2 ** attempt;
    if (delay > 0) await this.sleep(delay);
  }
}

/** True when the key is absent or blank. */
function keyMissing(value: string | undefined): value is undefined | "" {
  return value === undefined || value.trim() === "";
}

/** 408, 429 and 5xx are transient (ADR-0012 §5). */
function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** A short reason from OpenRouter's error body; never includes the prompt or the key. */
function errorMessage(status: number, body: string): string {
  let detail = "";
  try {
    const data: unknown = JSON.parse(body);
    if (isRecord(data) && isRecord(data.error) && typeof data.error.message === "string") {
      detail = data.error.message.slice(0, 200);
    }
  } catch {
    detail = "";
  }
  return `OpenRouter returned HTTP ${status}${detail === "" ? "" : `: ${detail}`}`;
}

/** The first choice's message object. */
function firstMessage(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const choice: unknown = choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return undefined;
  return choice.message;
}

/** The `arguments` string of the first tool call, when there is one. */
function toolCallArguments(message: Record<string, unknown>): string | undefined {
  const calls = message.tool_calls;
  if (!Array.isArray(calls)) return undefined;
  let first: string | undefined;
  for (const call of calls) {
    if (!isRecord(call) || !isRecord(call.function)) continue;
    const argumentsJson = call.function.arguments;
    if (typeof argumentsJson !== "string") continue;
    first ??= argumentsJson;
    // Some providers return more than one call; prefer a well-formed one over the first.
    if (parses(argumentsJson)) return argumentsJson;
  }
  return first;
}

/** True when `text` is JSON. */
function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The usage object OpenRouter reports at the top level (not per choice).
 *
 * `cost` is documented for usage accounting and `total_cost` appears in some responses; either
 * is accepted so the bench reports a cost when the provider prices the model.
 */
function usageOf(data: Record<string, unknown>): LlmUsage | undefined {
  if (!isRecord(data.usage)) return undefined;
  const promptTokens = numberField(data.usage.prompt_tokens);
  const completionTokens = numberField(data.usage.completion_tokens);
  const totalTokens = numberField(data.usage.total_tokens);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  const prompt = promptTokens ?? 0;
  const completion = completionTokens ?? 0;
  const cost = numberField(data.usage.cost) ?? numberField(data.usage.total_cost);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: totalTokens ?? prompt + completion,
    ...(cost === undefined ? {} : { costUsd: cost }),
  };
}

/** A finite number, or undefined. */
function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A plain object, not an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
