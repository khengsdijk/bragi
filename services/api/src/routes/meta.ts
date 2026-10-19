/**
 * `/v1/meta` and the container health probe (specs/05 §2, 01 §9).
 *
 * `minClientVersion` is what the desktop app compares itself against on boot
 * (01 §9); `features` lets a client hide UI for a capability the server has off.
 */
import type { FastifyInstance } from "fastify";

import type { Config } from "../config.js";

/** The API version (`MAJOR.MINOR.PATCH`, 01 §9). */
export const API_VERSION = "0.7.0";
/** Oldest client this API still serves. */
export const MIN_CLIENT_VERSION = "0.1.0";

export interface MetaDeps {
  config: Config;
}

/** Registers `/v1/meta` and `/v1/health`. */
export function registerMeta(app: FastifyInstance, deps: MetaDeps): void {
  app.get("/v1/meta", async () => ({
    apiVersion: API_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    features: {
      magicLink: true,
      githubOAuth: deps.config.githubClientId !== "",
      echo: true,
      singleUser: deps.config.authMode === "single-user",
    },
  }));

  app.get("/v1/health", async () => ({ status: "ok" }));
}
