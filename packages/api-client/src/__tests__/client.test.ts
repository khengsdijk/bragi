import type { PlanRequest } from "@bragi/schemas";
import { describe, expect, it, vi } from "vitest";

import {
  ApiClientError,
  createApiClient,
  createRealtime,
  PlannerApiError,
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

  it("submits a generate.extend job with the generated params untouched", async () => {
    const accepted = {
      jobId: "job_01JEXTEND",
      status: "queued",
      createdAt: "2026-10-21T12:00:00Z",
      estimatedCredits: 2,
    };
    const { fetch, calls } = fakeFetch({ status: 202, body: accepted });
    const client = createApiClient({ baseUrl: "https://api.test", fetch });
    const body = {
      capability: "generate.extend" as const,
      priority: "interactive" as const,
      projectId: "prj_01J",
      assets: { context: "sha256:aa" },
      params: {
        context: {
          bpm: 120,
          timeSignature: [4, 4] as [number, number],
          key: { tonic: "A", mode: "minor" as const },
          descriptors: ["dreamy"],
          seed: 1234,
        },
        bars: 8,
        overlapBars: 2,
        direction: "forward" as const,
        tier: "preview" as const,
        n: 3,
      },
    };

    await expect(client.submitJob(body)).resolves.toEqual(accepted);
    expect(calls[0]?.url).toBe("https://api.test/v1/jobs");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(body);
  });

  it("cancels a job and pings the warm-up endpoint", async () => {
    const cancelled = fakeFetch({ status: 200 });
    const client = createApiClient({ baseUrl: "", fetch: cancelled.fetch });
    await client.cancelJob("job_01J");
    expect(cancelled.calls[0]?.url).toBe("/v1/jobs/job_01J");
    expect(cancelled.calls[0]?.init.method).toBe("DELETE");

    const warmed = fakeFetch({ status: 202, body: { status: "warming" } });
    const warmClient = createApiClient({ baseUrl: "", fetch: warmed.fetch });
    await expect(warmClient.warmupGeneration()).resolves.toEqual({ status: "warming" });
    expect(warmed.calls[0]?.url).toBe("/v1/generations/warmup");
  });

  it("maps INSUFFICIENT_CREDITS and GENERATION_BUSY to ApiClientError", async () => {
    for (const [status, code] of [
      [402, "INSUFFICIENT_CREDITS"],
      [503, "GENERATION_BUSY"],
    ] as const) {
      const { fetch } = fakeFetch({ status, body: { error: { code, message: "nope" } } });
      const client = createApiClient({ baseUrl: "", fetch });
      await expect(client.warmupGeneration()).rejects.toMatchObject({ code, status });
    }
  });

  it("posts a plan request and returns the EditPlan", async () => {
    const plan = {
      planId: "pln_01",
      interpretation: "I'll make the drums quieter.",
      variants: [],
      estimatedCredits: 0,
      estimatedSeconds: 0,
    };
    const { fetch, calls } = fakeFetch({ body: plan });
    const client = createApiClient({ baseUrl: "https://api.test", fetch });
    const request = {
      doc: { id: "prj_1" },
      prompt: "quieter drums",
      uiContext: { view: "song", selectedTrackIds: ["trk_d"], selectedSectionIds: [] },
      variantCount: 3,
    } as unknown as PlanRequest;

    await expect(client.plan(request)).resolves.toEqual(plan);
    expect(calls[0]?.url).toBe("https://api.test/v1/plans");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(request);
  });

  it("maps the planner error codes to plain-language typed errors", async () => {
    const cases = [
      ["PLANNER_UNAVAILABLE", "The AI planner isn't set up on this computer yet."],
      [
        "PLAN_INVALID",
        "I couldn't turn that into a plan. Try describing the change a little more specifically.",
      ],
      ["PROMPT_POLICY", "I can't use artist or song names here. Describe the sound instead."],
    ] as const;
    for (const [code, message] of cases) {
      const { fetch } = fakeFetch({
        status: 503,
        body: { error: { code, message: "server wording" } },
      });
      const client = createApiClient({ baseUrl: "", fetch });
      const failure = client.plan({} as PlanRequest);
      await expect(failure).rejects.toBeInstanceOf(PlannerApiError);
      await expect(failure).rejects.toMatchObject({
        code,
        plannerCode: code,
        message,
        serverMessage: "server wording",
        status: 503,
      });
    }
  });

  it("leaves other failures as the generic API error", async () => {
    const { fetch } = fakeFetch({
      status: 502,
      body: { error: { code: "MODEL_ERROR", message: "The planner model is unavailable." } },
    });
    const client = createApiClient({ baseUrl: "", fetch });
    await expect(client.plan({} as PlanRequest)).rejects.toMatchObject({
      code: "MODEL_ERROR",
      message: "The planner model is unavailable.",
    });
  });

  it("posts a plan execute request with the rendered context assets (06 §5)", async () => {
    const response = {
      jobs: [
        {
          variant: 1,
          stepId: "g1",
          jobId: "job_01",
          capability: "generate.inpaint",
          status: "queued",
          estimatedCredits: 2,
        },
      ],
    };
    const { fetch, calls } = fakeFetch({ body: response });
    const client = createApiClient({ baseUrl: "https://api.test", fetch });
    const request = {
      contexts: { g1: { before: "sha256:aa", after: "sha256:bb" } },
    };

    await expect(client.executePlan("pln_01/a", request)).resolves.toEqual(response);
    expect(calls[0]?.url).toBe("https://api.test/v1/plans/pln_01%2Fa/execute");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(request);
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
