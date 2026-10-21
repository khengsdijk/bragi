/**
 * The Bragi cross-language contracts (specs/01-architecture.md §7).
 *
 * This package holds the JSON Schemas that define the song document, the v1 ops, the analysis
 * blobs, the job envelopes and the API error codes. Everything exported here is generated from
 * them by `pnpm schemas:gen`; see `packages/schemas/README.md`. Generated code is never edited by
 * hand (specs/13-agent-guide.md §1).
 *
 * The validators are precompiled rather than built with `new Function` at runtime, because the UI
 * runs under a strict CSP (specs/01-architecture.md §10).
 */

export * from "./generated/capabilities.js";
export * from "./generated/fx-catalog.js";
export * from "./generated/macros.js";
export * from "./generated/planner.js";
export * from "./generated/types.js";
export * from "./generated/validators.js";
