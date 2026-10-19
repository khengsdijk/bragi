import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import type { AppContext } from "../app.js";
import { WsGateway } from "../ws/gateway.js";

class FakeSocket extends EventEmitter {
  readonly sent: Record<string, unknown>[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {}
}

describe("WsGateway.handle", () => {
  it("honours a sub sent before the session lookup has finished", async () => {
    let resolveSession: (session: unknown) => void = () => {};
    const sessionLookup = new Promise((resolve) => {
      resolveSession = resolve;
    });
    const queries: string[] = [];
    const ctx = {
      sessions: { resolve: () => sessionLookup },
      pool: {
        query: async (sql: string) => {
          queries.push(sql);
          return {
            rows: [{ stage: "rhythm", status: "done", blob_hash: "sha256:bb" }],
            rowCount: 1,
          };
        },
      },
    } as unknown as AppContext;
    const gateway = new WsGateway(ctx);
    const socket = new FakeSocket();

    const handled = gateway.handle(socket as unknown as WebSocket, {});
    // The client sends `sub` the moment the socket opens, before `hello`.
    socket.emit("message", JSON.stringify({ t: "sub", topics: ["asset:sha256:aa"] }));
    resolveSession({ user: { id: "usr_1" }, session: { id: "s", expiresAt: new Date() } });
    await handled;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(socket.sent[0]).toEqual({ t: "hello", userId: "usr_1" });
    expect(socket.sent).toContainEqual({
      t: "analysis.partial",
      assetHash: "sha256:aa",
      stage: "rhythm",
      blob: "sha256:bb",
    });
  });
});
