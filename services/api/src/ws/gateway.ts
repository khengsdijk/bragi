/**
 * The WebSocket gateway (specs/05 §3).
 *
 * One NATS core subscription on `events.>` is fanned out to every connected,
 * authenticated client that subscribed to the matching topic. Subscribing is
 * authorised against the same ownership rules as REST, so a client cannot
 * listen to somebody else's job.
 */

import type { IncomingHttpHeaders } from "node:http";
import { type JobEvent, validateJobEvent } from "@bragi/schemas";
import type { WebSocket } from "@fastify/websocket";
import type { Subscription } from "nats";

import type { AppContext } from "../app.js";
import { EVENTS_STREAM } from "../nats/client.js";
import { recordOutputs } from "../orchestrator/handler.js";
import {
  analysisMessages,
  jobReplayMessages,
  replayMessages,
  type ServerMessage,
  toClientMessages,
  topicForSubject,
} from "./messages.js";

const decoder = new TextDecoder();

interface ClientMessage {
  t?: string;
  topics?: unknown;
}

export class WsGateway {
  private readonly topicsBySocket = new Map<WebSocket, Set<string>>();
  private readonly capabilityByJob = new Map<string, string>();
  private readonly ownerByJob = new Map<string, string>();
  private readonly partialCounters = new Map<string, number>();
  private subscription: Subscription | undefined;

  constructor(private readonly ctx: AppContext) {}

  /** Subscribes to `events.>` and starts fanning out. */
  start(): void {
    this.subscription = this.ctx.nc.subscribe("events.>");
    void this.consume();
  }

  /** Stops the NATS subscription and closes every client. */
  async stop(): Promise<void> {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    for (const socket of this.topicsBySocket.keys()) socket.close(1001, "server shutting down");
    this.topicsBySocket.clear();
  }

  /** Handles one upgraded connection. */
  async handle(socket: WebSocket, request: IncomingHttpHeaders): Promise<void> {
    // The session lookup is asynchronous, and a client may send `sub` the moment the
    // socket opens. The listener is therefore attached *before* the lookup and waits
    // for it; attaching it afterwards drops every message sent in that window.
    const pending = this.ctx.sessions.resolve(request);
    socket.on("message", (raw: unknown) => {
      void pending.then((session) => {
        if (session) return this.onMessage(socket, session.user.id, raw);
        return undefined;
      });
    });
    socket.on("close", () => {
      this.topicsBySocket.delete(socket);
    });
    const session = await pending;
    if (!session) {
      socket.close(4401, "AUTH_REQUIRED");
      return;
    }
    this.topicsBySocket.set(socket, new Set());
    socket.send(JSON.stringify({ t: "hello", userId: session.user.id }));
  }

  private async consume(): Promise<void> {
    const subscription = this.subscription;
    if (!subscription) return;
    for await (const message of subscription) {
      void this.dispatch(message.subject, message.data);
    }
  }

  private async onMessage(socket: WebSocket, userId: string, raw: unknown): Promise<void> {
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(toText(raw)) as ClientMessage;
    } catch {
      return;
    }
    if (parsed.t !== "sub" && parsed.t !== "unsub") return;
    const topics = Array.isArray(parsed.topics)
      ? parsed.topics.filter((topic): topic is string => typeof topic === "string")
      : [];
    const subscribed = this.topicsBySocket.get(socket);
    if (!subscribed) return;
    for (const topic of topics) {
      if (parsed.t === "sub") {
        if (await this.canSubscribe(userId, topic)) {
          subscribed.add(topic);
          await this.replay(socket, topic);
        } else {
          socket.send(JSON.stringify({ t: "error", code: "FORBIDDEN", topic }));
        }
      } else {
        subscribed.delete(topic);
      }
    }
  }

  /**
   * Replays what a late subscriber missed (finding 6, Q25): the finished analysis stages of an
   * `asset:` topic from Postgres, and a `job:` topic's events from the `EVENTS` stream (24 h).
   * A live event can arrive while a replay is sent, so clients dedupe partials by candidate.
   * A `project:` topic only ever hears new events (05 §3).
   */
  private async replay(socket: WebSocket, topic: string): Promise<void> {
    if (topic.startsWith("job:")) {
      const jobId = topic.slice("job:".length);
      const payloads = await this.storedJobEvents(jobId);
      if (payloads.length === 0) return;
      const capability = await this.capabilityFor(jobId);
      for (const payload of payloads) {
        if (validateJobEvent(payload)) await this.ownOutputs(payload as JobEvent);
      }
      for (const message of jobReplayMessages(payloads, capability)) {
        socket.send(JSON.stringify(message));
      }
      return;
    }
    if (!topic.startsWith("asset:")) return;
    const assetHash = topic.slice("asset:".length);
    const { rows } = await this.ctx.pool.query<{
      stage: string;
      status: string;
      blob_hash: string | null;
      error: unknown;
    }>("SELECT stage, status, blob_hash, error FROM analyses WHERE asset_hash = $1", [assetHash]);
    for (const message of replayMessages(assetHash, rows)) {
      socket.send(JSON.stringify(message));
    }
  }

  /** The job's events still in the `EVENTS` stream, oldest first; none when the stream is gone. */
  private async storedJobEvents(jobId: string): Promise<unknown[]> {
    try {
      const consumer = await this.ctx.nc
        .jetstream()
        .consumers.get(EVENTS_STREAM, { filterSubjects: [`events.job.${jobId}`] });
      // Checked first: a fetch on an empty subject would wait for its expiry.
      const pending = (await consumer.info()).num_pending;
      if (pending === 0) return [];
      const payloads: unknown[] = [];
      const batch = await consumer.fetch({ max_messages: pending, expires: 2_000 });
      for await (const message of batch) {
        try {
          payloads.push(JSON.parse(decoder.decode(message.data)));
        } catch {
          // skip a payload that is not JSON
        }
        if (payloads.length >= pending) break;
      }
      return payloads;
    } catch {
      return [];
    }
  }

  private async canSubscribe(userId: string, topic: string): Promise<boolean> {
    const separator = topic.indexOf(":");
    if (separator < 0) return false;
    const kind = topic.slice(0, separator);
    const id = topic.slice(separator + 1);
    if (kind === "job") {
      return this.exists("SELECT 1 FROM jobs WHERE id = $1 AND user_id = $2", [id, userId]);
    }
    if (kind === "asset") {
      return this.exists("SELECT 1 FROM user_assets WHERE hash = $1 AND user_id = $2", [
        id,
        userId,
      ]);
    }
    if (kind === "project") {
      return this.exists("SELECT 1 FROM projects WHERE id = $1 AND user_id = $2", [id, userId]);
    }
    return false;
  }

  private async exists(sql: string, params: unknown[]): Promise<boolean> {
    const { rowCount } = await this.ctx.pool.query(sql, params);
    return rowCount !== null && rowCount > 0;
  }

  private async capabilityFor(jobId: string): Promise<string> {
    const cached = this.capabilityByJob.get(jobId);
    if (cached !== undefined) return cached;
    const { rows } = await this.ctx.pool.query<{ capability: string; user_id: string }>(
      "SELECT capability, user_id FROM jobs WHERE id = $1",
      [jobId],
    );
    const capability = rows[0]?.capability ?? "";
    this.capabilityByJob.set(jobId, capability);
    if (rows[0] !== undefined) this.ownerByJob.set(jobId, rows[0].user_id);
    return capability;
  }

  /**
   * Records a job event's outputs for the job's user before the client hears of them. The
   * orchestrator does the same, but it consumes the event in parallel: a client that asks for a
   * partial's URL the moment it arrives would otherwise race it and get a 404 (09 §5).
   */
  private async ownOutputs(event: JobEvent): Promise<void> {
    if (event.type !== "partial" && event.type !== "completed") return;
    if (event.outputs === undefined) return;
    await this.capabilityFor(event.jobId);
    const owner = this.ownerByJob.get(event.jobId);
    if (owner === undefined) return;
    await recordOutputs(this.ctx.pool, owner, event.outputs);
  }

  private async dispatch(subject: string, data: Uint8Array): Promise<void> {
    const topic = topicForSubject(subject);
    if (topic === undefined) return;
    const recipients = [...this.topicsBySocket].filter(([, topics]) => topics.has(topic));
    if (recipients.length === 0) return;

    const messages = await this.messagesFor(topic, data);
    if (messages.length === 0) return;
    for (const [socket] of recipients) {
      for (const message of messages) socket.send(JSON.stringify(message));
    }
  }

  private async messagesFor(topic: string, data: Uint8Array): Promise<ServerMessage[]> {
    let payload: unknown;
    try {
      payload = JSON.parse(decoder.decode(data));
    } catch {
      return [];
    }
    if (topic.startsWith("job:")) {
      if (!validateJobEvent(payload)) return [];
      const event = payload as JobEvent;
      const capability = await this.capabilityFor(event.jobId);
      await this.ownOutputs(event);
      const prior = this.partialCounters.get(event.jobId) ?? 0;
      const index = event.type === "partial" ? prior + 1 : prior;
      if (event.type === "partial") this.partialCounters.set(event.jobId, index);
      return toClientMessages(event, capability, index);
    }
    if (topic.startsWith("asset:")) {
      return analysisMessages(payload);
    }
    return [];
  }
}

function toText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return decoder.decode(raw);
  return String(raw);
}
