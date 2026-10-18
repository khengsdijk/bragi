/**
 * Package identity and the small, stable surface other packages may import.
 *
 * The service itself runs from `server.js`/`orchestrator.js`; this entry point
 * exists so `@bragi/api` has a typed import surface (and so the scaffold test
 * from WP-0.1 keeps its meaning).
 */
export const PACKAGE_NAME = "@bragi/api";

export { type AppContext, type BuiltApp, buildApp } from "./app.js";
export { type Config, configSchema, loadConfig } from "./config.js";
export { ANALYSIS_DAG, type AnalysisProfile, readyStages, stagesForProfile } from "./jobs/dag.js";
