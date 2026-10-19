# ADR-0012 — OpenRouter LLM client and grounding for the `describe` stage
- **Status:** Accepted (owner decision, 2026-10-19). Originally proposed the same day with the Anthropic SDK; superseded by this version.
- **Date:** 2026-10-19

## Context
04 §6.3 has the `describe` stage call an LLM with a fixed system prompt and a JSON output schema,
and guard the output with a post-check that removes instruments absent from the analysis. The
analysis workers have no LLM client yet. The planner (06 §4) will need the same client later.
The owner wants to choose models freely and control cost, so Bragi must not be tied to one vendor.
The choice covers the provider, the HTTP client, where the model ID comes from, what data leaves
the system, and how the post-check is built.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| A. Anthropic API directly (official `anthropic` SDK) | Typed errors, retries, first-class prompt caching and tool use | One vendor, one price list, no cheap open-weight models; adds about 5 packages |
| **B. OpenRouter** (OpenAI-compatible chat completions, `https://openrouter.ai/api/v1`) | One key and one API for hundreds of models; the owner picks the model and the cost per call; JSON `response_format` and tool calling are widely supported; provider routing preferences control data handling | An extra hop (OpenRouter plus the routed provider see the request); features such as prompt caching depend on the model and provider; model slugs change over time |
| C. Self-hosted open model (vLLM or similar) | Data never leaves our infrastructure | GPU cost and operations for a stage that runs a few hundred tokens per song; deferred until volume justifies it |

The OpenRouter API is plain JSON over HTTPS, so no SDK is needed (the `openai` SDK would be a large
dependency for one POST). The client uses the standard library (`urllib`, run on a worker thread);
`httpx` is not in the worker's dependency tree and is not added.

## Decision
1. **All LLM calls go through OpenRouter.** Bragi does not call a vendor API directly. The key is
   `OPENROUTER_API_KEY`; `OPENROUTER_BASE_URL` optionally overrides the endpoint (proxy, test server).
2. **No new dependency.** `bragi_analysis.describe.llm.OpenRouterClient` posts to
   `/chat/completions` with the standard library. The `anthropic` dependency is removed. The
   transport is injectable, so tests cover the request body, headers and error mapping offline.
   Requests carry the recommended attribution headers `HTTP-Referer` and `X-Title: Bragi`.
3. **The model is configuration, not code.** Model IDs are OpenRouter slugs (`vendor/model`).
   `config/describe.toml` sets `model` (default **`deepseek/deepseek-v4.1-flash`**, a cheap model
   with `response_format` support, checked on OpenRouter's model list on 2026-10-19).
   `BRAGI_DESCRIBE_MODEL` and the job param `model` override it. The owner may change the default at
   any time; this follows 06 §4 (tiers in config, IDs not hard-coded).
4. **Structured output.** The request asks for `response_format: json_schema` (the `DescriptionResult`
   contract, non-strict). A model that rejects it with HTTP 400 is retried with `json_object`, then
   with no response format, and the weaker level is remembered for the client's lifetime. The
   reply is always parsed and validated by the pipeline, with one repair retry, as before.
5. **Error mapping.** HTTP 400, 401, 403 and other 4xx are non-retryable `JobFailure`s (`MODEL_ERROR`).
   408, 429, 5xx, timeouts, network errors, provider errors inside a 200 body and empty replies are
   retryable. A missing `OPENROUTER_API_KEY` is a non-retryable `JobFailure` with a clear message.
6. **The client is a protocol** (`DescribeClient.complete(system, user, model, max_tokens) -> str`).
   Tests use a fake. The real API runs only in a test skipped without `OPENROUTER_API_KEY`. No key is
   ever committed, logged or echoed.
7. **Grounding is a deterministic post-check**, not a second model call. It strips sentences and
   items that name instruments, keys or tempos the analysis does not support, and rejects the result
   when the summary is left empty.
8. **Content policy (10 §7).** The input is features and controlled labels only. No audio, no lyrics,
   no artist or title metadata is sent. The prompt forbids artist names and unsupported claims.
9. **Provider data policy.** Every request sets OpenRouter provider preferences
   `provider: {"data_collection": "deny"}` by default, so OpenRouter only routes to providers that
   do not retain or train on prompts. `OPENROUTER_DATA_COLLECTION=allow` relaxes this when the owner
   accepts a wider provider pool (usually cheaper). If a model has no provider that satisfies
   `deny`, OpenRouter returns an error (non-retryable 404), which tells the owner to pick another
   model or relax the setting.

## Consequences
- **Positive:** the owner controls model and cost with one key; no vendor SDK; no new dependency;
  the client is testable offline; the model can change without a code change.
- **Negative:** the derived features (never audio, lyrics or titles) go to OpenRouter and the routed
  provider. This is documented in 05 §privacy. Provider features differ per model: prompt caching
  and tool calling must be treated as optional capabilities of the chosen model (06 §4).
  OpenRouter slugs may be renamed or retired, so the configured default needs an occasional check.
- **Mitigations:** `data_collection: deny` by default; the key is read only from the environment;
  the capability fails with a clear message when no key is set (no silent fallback text); the
  `DescribeClient` seam keeps the provider replaceable (for example by option C) without touching the
  pipeline.
- **Deferred:** the planner's client (06) can reuse the same transport and add OpenAI-format tool
  calling, but that is not in this ADR.
