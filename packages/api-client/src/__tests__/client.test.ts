import { describe, expect, it, vi } from "vitest";

import {
  ApiClientError,
  createApiClient,
  createRealtime,
  type RealtimeMessage,
  realtimeUrl,
  type SocketLike,
} from "../index.js";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(response: { status?: number; body?: unknown; text?: string }) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const text =
      response.text ?? (response.body === undefined ? "" : JSON.stringify(response.body));
    return new Response(text, { status: response.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("createApiClient", () => {
  it("reads the auth mode with the cookie credential (ADR-0014)", async () => {
    const body = {
      mode: "single-user",
      user: { id: "usr_1", email: "owner@bragi.local", name: "Owner" },
    };
    const { fetch, calls } = fakeFetch({ body });
    const client = createApiClient({ baseUrl: "https://api.test", fetch });

    await expect(client.getAuthMode()).resolves.toEqual(body);
    expect(calls[0]?.url).toBe("https://api.test/v1/auth/mode");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.credentials).toBe("include");
  });

  it("posts JSON with the cookie credential and a bearer token when given", async () => {
    const { fetch, calls } = fakeFetch({ body: { exists: true } });
    const client = createApiClient({ baseUrl: "https://api.test", fetch, token: "tok_1" });

    await client.presign({ hash: "sha256:aa", bytes: 10, mime: "audio/wav" });

    expect(calls[0]?.url).toBe("https://api.test/v1/assets/presign");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.credentials).toBe("include");
    expect(calls[0]?.init.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer tok_1",
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      hash: "sha256:aa",
      bytes: 10,
      mime: "audio/wav",
    });
  });

  it("encodes the asset hash in complete/url/analyses paths", async () => {
    const { fetch, calls } = fakeFetch({ body: { stages: [] } });
    const client = createApiClient({ baseUrl: "", fetch });
    await client.complete("sha256:aa", "audio/wav");
    await client.assetUrl("sha256:bb");
    await client.getAnalyses("sha256:cc");
    expect(calls.map((call) => call.url)).toEqual([
      "/v1/assets/sha256%3Aaa/complete",
      "/v1/assets/sha256%3Abb/url",
      "/v1/analyses/sha256%3Acc",
    ]);
  });

  it("maps the 05 §2 error envelope to ApiClientError", async () => {
    const { fetch } = fakeFetch({
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "asset not found" } },
    });
    const client = createApiClient({ baseUrl: "", fetch });
    const failure = client.assetUrl("sha256:aa");
    await expect(failure).rejects.toBeInstanceOf(ApiClientError);
    await expect(failure).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "asset not found",
      status: 404,
    });
  });

  it("requests a magic link", async () => {
    const { fetch, calls } = fakeFetch({ body: { status: true } });
    const client = createApiClient({ baseUrl: "", fetch });
    await client.signInWithEmail("a@b.test", "http://localhost:5173/");
    expect(calls[0]?.url).toBe("/v1/auth/sign-in/magic-link");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      email: "a@b.test",
      callbackURL: "http://localhost:5173/",
    });
  });
});

class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.({});
  }
  open(): void {
    this.onopen?.({});
  }
  emit(message: RealtimeMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

describe("createRealtime", () => {
  it("subscribes on open and resubscribes after a reconnect", () => {
    const sockets: FakeSocket[] = [];
    const timers: (() => void)[] = [];
    const statuses: string[] = [];
    const client = createRealtime({
      url: "ws://api.test/v1/ws",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeout: (handler) => {
        timers.push(handler);
        return timers.length;
      },
      clearTimeout: () => {},
      onStatus: (status) => statuses.push(status),
    });

    sockets[0]?.open();
    client.subscribe(["asset:sha256:aa", "job:job_1"]);
    expect(sockets[0]?.sent).toEqual([
      JSON.stringify({ t: "sub", topics: ["asset:sha256:aa", "job:job_1"] }),
    ]);
    expect(statuses).toEqual(["connecting", "open"]);

    // A drop schedules a reconnect; the wanted topics are re-sent on the new socket.
    sockets[0]?.close();
    expect(statuses.at(-1)).toBe("closed");
    expect(timers).toHaveLength(1);
    timers[0]?.();
    sockets[1]?.open();
    expect(sockets[1]?.sent).toEqual([
      JSON.stringify({ t: "sub", topics: ["asset:sha256:aa", "job:job_1"] }),
    ]);

    client.unsubscribe(["job:job_1"]);
    expect(sockets[1]?.sent.at(-1)).toBe(JSON.stringify({ t: "unsub", topics: ["job:job_1"] }));
  });

  it("delivers parsed messages and drops malformed ones", () => {
    const sockets: FakeSocket[] = [];
    const received: RealtimeMessage[] = [];
    const client = createRealtime({
      url: "ws://api.test/v1/ws",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    client.on((message) => received.push(message));
    sockets[0]?.open();
    sockets[0]?.emit({
      t: "analysis.partial",
      assetHash: "sha256:aa",
      stage: "rhythm",
      blob: "sha256:bb",
    });
    sockets[0]?.onmessage?.({ data: "not json" });
    expect(received).toEqual([
      { t: "analysis.partial", assetHash: "sha256:aa", stage: "rhythm", blob: "sha256:bb" },
    ]);
    client.close();
  });

  it("does not reconnect after close", () => {
    const factor = vi.fn(() => new FakeSocket());
    const timers: (() => void)[] = [];
    const client = createRealtime({
      url: "ws://api.test/v1/ws",
      socketFactory: factor,
      setTimeout: (handler) => {
        timers.push(handler);
        return timers.length;
      },
    });
    client.close();
    expect(timers).toHaveLength(0);
    expect(factor).toHaveBeenCalledTimes(1);
  });
});

describe("realtimeUrl", () => {
  it("uses same-origin ws/wss and the /v1/ws path", () => {
    expect(realtimeUrl("", { protocol: "http:", host: "127.0.0.1:5173" })).toBe(
      "ws://127.0.0.1:5173/v1/ws",
    );
    expect(realtimeUrl("https://api.test", { protocol: "https:", host: "x" })).toBe(
      "wss://api.test/v1/ws",
    );
  });
});
