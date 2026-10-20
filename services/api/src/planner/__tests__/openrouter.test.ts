import { describe, expect, it } from "vitest";

import {
  type HttpRequest,
  type HttpResponse,
  OpenRouterClient,
  PlannerModelError,
  PlannerUnavailableError,
  type Transport,
} from "../openrouter.js";

/** A scripted transport: each call returns the next response, or throws the next error. */
function scripted(responses: (HttpResponse | Error)[]) {
  const requests: HttpRequest[] = [];
  const transport: Transport = async (request) => {
    requests.push(request);
    const next = responses[requests.length - 1];
    if (next === undefined) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  };
  return { requests, transport };
}

/** A client over a scripted transport with no retry delay. */
function client(
  responses: (HttpResponse | Error)[],
  options: { dataCollection?: "allow" | "deny" } = {},
) {
  const script = scripted(responses);
  const instance = new OpenRouterClient({
    apiKey: "test-key",
    transport: script.transport,
    sleep: async () => {},
    retryDelayMs: 0,
    maxRetries: 2,
    ...options,
  });
  return { client: instance, requests: script.requests };
}

/** A 200 reply with tool-call arguments. */
function toolReply(argumentsJson: string): HttpResponse {
  return {
    status: 200,
    body: JSON.stringify({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                type: "function",
                function: { name: "propose_edit_plan", arguments: argumentsJson },
              },
            ],
          },
        },
      ],
    }),
  };
}

/** A 200 reply with plain content. */
function contentReply(content: string): HttpResponse {
  return { status: 200, body: JSON.stringify({ choices: [{ message: { content } }] }) };
}

const MESSAGES = [
  { role: "system" as const, content: "system" },
  { role: "user" as const, content: "user" },
];

describe("OpenRouterClient request shape", () => {
  it("sends the plan tool, the data policy and the attribution headers", async () => {
    const { client: openrouter, requests } = client([toolReply('{"ok":true}')]);
    const reply = await openrouter.complete({
      model: "vendor/model",
      messages: MESSAGES,
      maxTokens: 2048,
      tool: true,
    });

    expect(reply.toolArguments).toBe('{"ok":true}');
    const request = requests[0];
    if (request === undefined) throw new Error("no request");
    expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(request.headers).toEqual({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/bragi-music/bragi",
      "X-Title": "Bragi",
    });

    const body = JSON.parse(request.body) as {
      model: string;
      max_tokens: number;
      provider: { data_collection: string };
      usage: { include: boolean };
      tools: { function: { name: string; parameters: Record<string, unknown> } }[];
      tool_choice: { function: { name: string } };
      messages: unknown;
    };
    expect(body.model).toBe("vendor/model");
    expect(body.max_tokens).toBe(2048);
    expect(body.provider).toEqual({ data_collection: "deny" });
    expect(body.usage).toEqual({ include: true });
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]?.function.name).toBe("propose_edit_plan");
    expect(body.tool_choice.function.name).toBe("propose_edit_plan");
    expect(body.messages).toEqual(MESSAGES);

    // The tool schema is the generated EditPlan minus the server-owned fields (06 §4).
    const parameters = body.tools[0]?.function.parameters as {
      properties: Record<string, unknown>;
      required: string[];
      $defs: Record<string, unknown>;
    };
    expect(parameters.$defs.Op).toBeDefined();
    expect(parameters.properties.planId).toBeUndefined();
    expect(parameters.required).toEqual(["interpretation", "variants"]);
  });

  it("relaxes the data policy only when asked", async () => {
    const { client: openrouter, requests } = client([contentReply("{}")], {
      dataCollection: "allow",
    });
    await openrouter.complete({ model: "m", messages: MESSAGES, maxTokens: 1, tool: true });
    const body = JSON.parse(requests[0]?.body ?? "{}") as {
      provider: { data_collection: string };
    };
    expect(body.provider.data_collection).toBe("allow");
  });

  it("reports token usage and cost when OpenRouter returns them", async () => {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { type: "function", function: { name: "propose_edit_plan", arguments: "{}" } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, cost: 0.0004 },
    });
    const { client: openrouter } = client([{ status: 200, body }]);
    const reply = await openrouter.complete({
      model: "m",
      messages: MESSAGES,
      maxTokens: 1,
      tool: true,
    });
    expect(reply.usage).toEqual({
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
      costUsd: 0.0004,
    });
  });

  it("leaves usage undefined when the provider omits it", async () => {
    const { client: openrouter } = client([toolReply('{"ok":true}')]);
    const reply = await openrouter.complete({
      model: "m",
      messages: MESSAGES,
      maxTokens: 1,
      tool: true,
    });
    expect(reply.usage).toBeUndefined();
  });

  it("sends the explanation as a JSON-schema response format", async () => {
    const { client: openrouter, requests } = client([contentReply('{"text":"hi"}')]);
    await openrouter.complete({
      model: "explain/model",
      messages: MESSAGES,
      maxTokens: 512,
      responseFormat: { name: "Explanation", schema: { type: "object" } },
    });
    const body = JSON.parse(requests[0]?.body ?? "{}") as {
      response_format: { type: string; json_schema: { name: string } };
      tools?: unknown;
    };
    expect(body.tools).toBeUndefined();
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("Explanation");
  });

  it("falls back from json_schema to json_object to no format on HTTP 400", async () => {
    const { client: openrouter, requests } = client([
      { status: 400, body: "{}" },
      { status: 400, body: "{}" },
      contentReply('{"text":"hi"}'),
    ]);
    await openrouter.complete({
      model: "explain/model",
      messages: MESSAGES,
      maxTokens: 512,
      responseFormat: { name: "Explanation", schema: { type: "object" } },
    });
    const formats = requests.map((request) => {
      const body = JSON.parse(request.body) as { response_format?: { type: string } };
      return body.response_format?.type;
    });
    expect(formats).toEqual(["json_schema", "json_object", undefined]);
  });
});

describe("OpenRouterClient error mapping", () => {
  it("does not retry a 401 and never echoes the key", async () => {
    const { client: openrouter, requests } = client([
      { status: 401, body: JSON.stringify({ error: { message: "bad key" } }) },
    ]);
    const failure = openrouter.complete({
      model: "m",
      messages: MESSAGES,
      maxTokens: 1,
      tool: true,
    });
    await expect(failure).rejects.toBeInstanceOf(PlannerModelError);
    await expect(failure).rejects.toMatchObject({ retryable: false, status: 401 });
    await expect(failure).rejects.not.toThrow(/test-key/);
    expect(requests).toHaveLength(1);
  });

  it("retries 5xx up to the bound, then reports retryable", async () => {
    const { client: openrouter, requests } = client([
      { status: 500, body: "{}" },
      { status: 503, body: "{}" },
      { status: 502, body: "{}" },
    ]);
    const failure = openrouter.complete({
      model: "m",
      messages: MESSAGES,
      maxTokens: 1,
      tool: true,
    });
    await expect(failure).rejects.toMatchObject({ retryable: true });
    expect(requests).toHaveLength(3);
  });

  it("retries 429 and a network timeout", async () => {
    const { client: openrouter, requests } = client([
      { status: 429, body: "{}" },
      new DOMException("timed out", "TimeoutError"),
      contentReply('{"ok":true}'),
    ]);
    const reply = await openrouter.complete({
      model: "m",
      messages: MESSAGES,
      maxTokens: 1,
      tool: true,
    });
    expect(reply.text).toBe('{"ok":true}');
    expect(requests).toHaveLength(3);
  });

  it("retries a provider error inside a 200 body", async () => {
    const { client: openrouter, requests } = client([
      { status: 200, body: JSON.stringify({ error: { code: 502, message: "provider down" } }) },
      contentReply('{"ok":true}'),
    ]);
    const reply = await openrouter.complete({
      model: "m",
      messages: MESSAGES,
      maxTokens: 1,
      tool: true,
    });
    expect(reply.text).toBe('{"ok":true}');
    expect(requests).toHaveLength(2);
  });

  it("retries an empty reply", async () => {
    const { client: openrouter, requests } = client([
      contentReply(""),
      contentReply('{"ok":true}'),
    ]);
    const reply = await openrouter.complete({
      model: "m",
      messages: MESSAGES,
      maxTokens: 1,
      tool: true,
    });
    expect(reply.text).toBe('{"ok":true}');
    expect(requests).toHaveLength(2);
  });

  it("accepts a plain JSON content reply", async () => {
    const { client: openrouter } = client([contentReply('{"interpretation":"x","variants":[]}')]);
    const reply = await openrouter.complete({
      model: "m",
      messages: MESSAGES,
      maxTokens: 1,
      tool: true,
    });
    expect(reply).toEqual({ text: '{"interpretation":"x","variants":[]}' });
  });

  it("requires a key", () => {
    expect(() => OpenRouterClient.fromEnv({})).toThrow(PlannerUnavailableError);
    expect(() => OpenRouterClient.fromEnv({ OPENROUTER_API_KEY: "  " })).toThrow(
      /OPENROUTER_API_KEY/,
    );
  });
});
