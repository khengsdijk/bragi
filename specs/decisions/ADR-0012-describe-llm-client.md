# ADR-0012 — Claude client and grounding for the `describe` stage
- **Status:** Proposed
- **Date:** 2026-10-19

## Context
04 §6.3 has the `describe` stage call Claude with a fixed system prompt and a JSON output schema,
and guard the output with a post-check that removes instruments absent from the analysis. The
analysis workers have no LLM client yet. The planner (06 §4) will need the same client later.
The choice has to cover which SDK to use, where the model ID comes from, and how the post-check is
built.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **A. Official `anthropic` Python SDK** (MIT) | Maintained by Anthropic; typed errors, retries, timeouts; the repo's own code-generation habit is pydantic v2, which the SDK uses too | Adds about 5 small packages (`anthropic`, `jiter`, `docstring-parser`, `sniffio`, `httpx2` (BSD-3)); `pydantic` already present |
| B. Raw `httpx` calls to `POST /v1/messages` | No new dependency | Re-implements retries, error classes and the API surface; more code for us to keep correct |
| C. A provider-neutral wrapper (LiteLLM and similar) | Swappable providers | Extra major dependency; the spec says Claude only; a shim layer on top of the SDK we would still need |

The `anthropic` SDK's licence is MIT and every transitive package is MIT, Apache-2.0 or BSD-3-Clause.

## Decision
1. Use the **official `anthropic` SDK** (option A), pinned with `anthropic>=1.0` in
   `services/workers/analysis/pyproject.toml` and locked in `uv.lock` (1.15.0 at the time of writing).
   It is imported lazily inside `bragi_analysis.describe.llm.AnthropicClient`, so the rest of the
   package imports without it, and it is never installed into `bragi_common`.
2. **The model ID is configuration, not code.** `config/describe.toml` sets `model`
   (default `claude-sonnet-5-5`). `BRAGI_DESCRIBE_MODEL` and the job param `model` may override it.
   This follows 06 §4 (tiers in config, IDs not hard-coded).
3. **The client is a protocol** (`DescribeClient.complete(system, user, model, max_tokens) -> str`).
   Tests use a fake. The real API runs only in a test skipped without `ANTHROPIC_API_KEY`. No key is
   ever committed, logged or echoed.
4. **Grounding is a deterministic post-check**, not a second model call. It strips sentences and
   items that name instruments, keys or tempos the analysis does not support, and rejects the result
   when the summary is left empty. The checklist (04 §6.3, §8) is automated; the real eval set decides
   the gate.
5. **Content policy (10 §7).** The input is features and controlled labels only. No audio, no lyrics,
   no artist or title metadata is sent. The prompt forbids artist names and unsupported claims.

## Consequences
- **Positive:** a single well-known client, testable offline, the model can change without a code
  change, and the post-check is deterministic and unit-testable.
- **Negative:** one more runtime dependency family in the worker image (about 1 MB of pure Python).
  The worker image now makes outbound HTTPS calls to `api.anthropic.com` when `describe` runs. This
  is documented in 05 §privacy and needs an owner decision on the production key (Q71).
- **Mitigations:** the lazy import keeps the CPU gate fast; the key is read only from the environment;
  the capability fails with a clear message when no key is set (no silent fallback text).
- **Deferred:** the planner's client (06) can reuse the same protocol, but that is not in this ADR.
