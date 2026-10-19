/**
 * The typed browser/desktop client for the v1 REST API (specs/05 §2).
 *
 * This package is deliberately small and framework-free: `packages/app` owns
 * React and TanStack Query, this owns request building, error mapping and the
 * WebSocket transport. Nothing here knows about a song document, Zustand or the
 * DOM, so it can be unit-tested with a fake `fetch` and a fake socket.
 *
 * Sessions are cookie-based on web (`credentials: "include"`) and may carry a
 * bearer token on desktop (05 §8); both are expressed by the options.
 */

/** The error envelope of 05 §2, as an exception. */
export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export type AnalysisProfile = "quick" | "standard" | "deep";

export interface AnalysisStageStatus {
  readonly stage: string;
  readonly status: string;
  readonly blob?: string;
}

export interface AnalysisResponse {
  readonly assetHash: string;
  readonly profile?: AnalysisProfile;
  readonly stages: readonly AnalysisStageStatus[];
}

export interface PresignRequest {
  readonly hash: string;
  readonly bytes: number;
  readonly mime?: string;
}

export type PresignResponse =
  | { readonly exists: true }
  | {
      readonly exists: false;
      readonly uploadUrl: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly expiresIn: number;
    };

export interface AssetUrl {
  readonly url: string;
  readonly expiresIn: number;
}

export interface LibraryItem {
  readonly id: string;
  readonly assetHash: string;
  readonly filename: string;
  readonly title?: string;
  readonly artist?: string;
  readonly album?: string;
  readonly importedAt: string;
  readonly projectId?: string;
  readonly stages: readonly AnalysisStageStatus[];
}

export interface LibraryPage {
  readonly items: readonly LibraryItem[];
  readonly nextCursor: string | null;
}

export interface ImportItem {
  readonly assetHash: string;
  readonly filename: string;
  readonly title?: string;
  readonly artist?: string;
  readonly album?: string;
}

export interface Meta {
  readonly apiVersion: string;
  readonly minClientVersion: string;
  readonly features: Readonly<Record<string, boolean>>;
}

/** How the API authenticates requests (ADR-0014). */
export type AuthMode = "single-user" | "multi-user";

/** `GET /v1/auth/mode`: the mode and, when signed in, the current user. */
export interface AuthModeResponse {
  readonly mode: AuthMode;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
  } | null;
}

export interface ApiClientOptions {
  /** API origin, e.g. `https://api.bragi.app`; `""` means same origin. */
  readonly baseUrl?: string;
  /** Injectable for tests. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** `"include"` for the cookie session (web), `"omit"` when using a bearer token. */
  readonly credentials?: RequestCredentials;
  /** Desktop bearer token (05 §8). Sent as `Authorization: Bearer …`. */
  readonly token?: string;
}

export interface ApiClient {
  readonly baseUrl: string;
  meta(): Promise<Meta>;
  /** The API's auth mode; the welcome page hides sign-in in single-user mode (ADR-0014). */
  getAuthMode(): Promise<AuthModeResponse>;
  /** Requests a magic link (05 §8). The email is sent by the API, not here. */
  signInWithEmail(email: string, callbackURL?: string): Promise<void>;
  presign(request: PresignRequest): Promise<PresignResponse>;
  complete(
    hash: string,
    mime?: string,
  ): Promise<{ hash: string; bytes: number; mime: string | null }>;
  assetUrl(hash: string): Promise<AssetUrl>;
  postAnalyses(assetHash: string, profile: AnalysisProfile): Promise<AnalysisResponse>;
  getAnalyses(assetHash: string): Promise<AnalysisResponse>;
  library(cursor?: string): Promise<LibraryPage>;
  importLibrary(items: readonly ImportItem[]): Promise<{
    items: readonly string[];
    enqueuedStages: readonly string[];
  }>;
}

/** Creates the client. No request is made until a method is called. */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch = options.fetch ?? globalThis.fetch;
  const credentials = options.credentials ?? "include";

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    init: { readonly redirect?: RequestRedirect } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (options.token !== undefined && options.token !== "") {
      headers.authorization = `Bearer ${options.token}`;
    }
    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers,
      credentials,
      redirect: init.redirect ?? "follow",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const payload: unknown = text === "" ? undefined : safeJson(text);
    if (!response.ok) {
      const error = (
        payload as { error?: { code?: unknown; message?: unknown; details?: unknown } }
      )?.error;
      throw new ApiClientError(
        typeof error?.code === "string" ? error.code : "INTERNAL",
        typeof error?.message === "string" ? error.message : `HTTP ${response.status}`,
        response.status,
        error?.details,
      );
    }
    return payload as T;
  }

  return {
    baseUrl,
    meta: () => request<Meta>("GET", "/v1/meta"),
    getAuthMode: () => request<AuthModeResponse>("GET", "/v1/auth/mode"),
    async signInWithEmail(email, callbackURL) {
      await request<unknown>("POST", "/v1/auth/sign-in/magic-link", {
        email,
        ...(callbackURL === undefined ? {} : { callbackURL }),
      });
    },
    presign: (presign) => request<PresignResponse>("POST", "/v1/assets/presign", presign),
    complete: (hash, mime) =>
      request("POST", `/v1/assets/${encodeURIComponent(hash)}/complete`, {
        ...(mime === undefined ? {} : { mime }),
      }),
    assetUrl: (hash) => request<AssetUrl>("GET", `/v1/assets/${encodeURIComponent(hash)}/url`),
    postAnalyses: (assetHash, profile) =>
      request<AnalysisResponse>("POST", "/v1/analyses", { assetHash, profile }),
    getAnalyses: (assetHash) =>
      request<AnalysisResponse>("GET", `/v1/analyses/${encodeURIComponent(assetHash)}`),
    library: (cursor) =>
      request<LibraryPage>(
        "GET",
        cursor === undefined ? "/v1/library" : `/v1/library?cursor=${encodeURIComponent(cursor)}`,
      ),
    importLibrary: (items) => request("POST", "/v1/library/import", { items }),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// --- WebSocket transport -----------------------------------------------------

/** The subset of `WebSocket` the client needs, so a fake can stand in. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** A server -> client message (05 §3, plus the analysis events of 05 §4). */
export type RealtimeMessage =
  | { readonly t: "hello"; readonly userId: string }
  | { readonly t: "error"; readonly code: string; readonly topic?: string }
  | {
      readonly t: "analysis.partial";
      readonly assetHash: string;
      readonly stage: string;
      readonly blob: string;
    }
  | {
      readonly t: "analysis.failed";
      readonly assetHash: string;
      readonly stage: string;
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    }
  | {
      readonly t: "job.progress";
      readonly jobId: string;
      readonly stage: string;
      readonly pct: number;
      readonly etaSec?: number;
    }
  | { readonly t: "job.completed"; readonly jobId: string; readonly outputs: unknown }
  | {
      readonly t: "job.failed";
      readonly jobId: string;
      readonly code: string;
      readonly retryable: boolean;
    };

export type RealtimeStatus = "connecting" | "open" | "closed";

export interface RealtimeOptions {
  /** Absolute `ws://`/`wss://` URL, see {@link realtimeUrl}. */
  readonly url: string;
  /** Injectable for tests; defaults to `new WebSocket(url)`. */
  readonly socketFactory?: (url: string) => SocketLike;
  /** Initial reconnect delay in ms (default 500), doubled up to `maxMs`. */
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  /** `setTimeout`/`clearTimeout` are injectable so tests do not wait. */
  readonly setTimeout?: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** Called on every status change. */
  readonly onStatus?: (status: RealtimeStatus) => void;
}

export interface RealtimeClient {
  /** Adds topics and sends `sub` now if the socket is open, else on reconnect. */
  subscribe(topics: readonly string[]): void;
  unsubscribe(topics: readonly string[]): void;
  /** Registers a message handler; returns an unsubscribe. */
  on(handler: (message: RealtimeMessage) => void): () => void;
  /** The topics currently wanted (not necessarily acknowledged). */
  topics(): readonly string[];
  status(): RealtimeStatus;
  close(): void;
}

/**
 * The single WebSocket connection of 13 §3. It reconnects with exponential
 * backoff and re-subscribes every wanted topic, so a dropped connection heals
 * without the caller doing anything. Messages are handed to every listener; the
 * app's `realtime` feature is the only listener and fans them into TanStack
 * Query and the Song Store.
 */
export function createRealtime(options: RealtimeOptions): RealtimeClient {
  const factory = options.socketFactory ?? ((url: string) => new WebSocket(url) as SocketLike);
  const initial = options.initialDelayMs ?? 500;
  const maximum = options.maxDelayMs ?? 15_000;
  const schedule = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
  const cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle as number));

  const listeners = new Set<(message: RealtimeMessage) => void>();
  const wanted = new Set<string>();
  let socket: SocketLike | null = null;
  let current: RealtimeStatus = "closed";
  let delay = initial;
  let timer: unknown = null;
  let closed = false;

  function setStatus(status: RealtimeStatus): void {
    current = status;
    options.onStatus?.(status);
  }

  function deliver(message: RealtimeMessage): void {
    for (const listener of listeners) listener(message);
  }

  function sendSub(topics: readonly string[], type: "sub" | "unsub"): void {
    if (socket === null || current !== "open" || topics.length === 0) return;
    socket.send(JSON.stringify({ t: type, topics }));
  }

  function connect(): void {
    if (closed) return;
    setStatus("connecting");
    const next = factory(options.url);
    socket = next;
    next.onopen = () => {
      delay = initial;
      setStatus("open");
      sendSub([...wanted], "sub");
    };
    next.onmessage = (event) => {
      const data = typeof event.data === "string" ? event.data : String(event.data);
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { t?: unknown }).t === "string"
      ) {
        deliver(parsed as RealtimeMessage);
      }
    };
    next.onclose = () => {
      if (socket === next) socket = null;
      setStatus("closed");
      scheduleReconnect();
    };
    next.onerror = () => {
      // `onclose` follows; closing here would double the reconnect.
    };
  }

  function scheduleReconnect(): void {
    if (closed) return;
    timer = schedule(() => {
      timer = null;
      delay = Math.min(delay * 2, maximum);
      connect();
    }, delay);
  }

  connect();

  return {
    subscribe(topics) {
      const fresh = topics.filter((topic) => !wanted.has(topic));
      for (const topic of fresh) wanted.add(topic);
      sendSub(fresh, "sub");
    },
    unsubscribe(topics) {
      const known = topics.filter((topic) => wanted.has(topic));
      for (const topic of known) wanted.delete(topic);
      sendSub(known, "unsub");
    },
    on(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    topics: () => [...wanted],
    status: () => current,
    close() {
      closed = true;
      if (timer !== null) cancel(timer);
      timer = null;
      socket?.close();
      socket = null;
      setStatus("closed");
    },
  };
}

/**
 * Turns the API base URL into the WebSocket URL of 05 §3.
 *
 * @param baseUrl `""`/`"/"` for same origin, or an absolute `http(s)://` URL
 * @param location the current location when `baseUrl` is relative
 */
export function realtimeUrl(
  baseUrl: string,
  location: { readonly protocol: string; readonly host: string } = globalThis.location,
): string {
  const base = baseUrl === "" ? `${location.protocol}//${location.host}` : baseUrl;
  const url = new URL("/v1/ws", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
