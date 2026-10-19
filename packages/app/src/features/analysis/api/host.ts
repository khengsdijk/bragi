/**
 * Builds the API and realtime clients from the host's `Platform.api` seam
 * (01 §3, 05 §2–§3). The app never reads `window.location` for the API itself:
 * the web host reports the same origin, the desktop host its compute server.
 */
import {
  type ApiClient,
  createApiClient,
  createRealtime,
  type RealtimeClient,
  realtimeUrl,
} from "@bragi/api-client";
import type { Platform } from "@bragi/platform";

/** The REST client for this host. */
export function apiFor(platform: Platform): ApiClient {
  return createApiClient({
    baseUrl: platform.api?.baseUrl ?? "",
    credentials: platform.api?.credential === "bearer" ? "omit" : "include",
  });
}

/**
 * The one WebSocket connection for this host (13 §3). Callers that keep a store
 * across navigations should memoise it; the library flow opens one per upload and
 * closes it on dispose.
 */
export function realtimeFor(platform: Platform): RealtimeClient {
  return createRealtime({ url: realtimeUrl(platform.api?.baseUrl ?? "") });
}
