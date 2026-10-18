import type { JobEvent } from "@bragi/schemas";
import { describe, expect, it } from "vitest";

import { firstOutput, stageOf, toClientMessages, topicForSubject } from "../ws/messages.js";

function event(partial: Partial<JobEvent>): JobEvent {
  return { schemaVersion: 1, jobId: "job_01ABC", type: "progress", ...partial } as JobEvent;
}

describe("topicForSubject", () => {
  it("maps the 05 §4.1 subjects to 05 §3 topics", () => {
    expect(topicForSubject("events.job.job_01ABC")).toBe("job:job_01ABC");
    expect(topicForSubject("events.asset.sha256:deadbeef")).toBe("asset:sha256:deadbeef");
    expect(topicForSubject("events.project.prj_01ABC")).toBe("project:prj_01ABC");
  });

  it("ignores anything that is not a fan-out event", () => {
    expect(topicForSubject("jobs.echo.interactive")).toBeUndefined();
    expect(topicForSubject("events.job")).toBeUndefined();
    expect(topicForSubject("events.other.thing")).toBeUndefined();
  });
});

describe("stageOf", () => {
  it("is the last token of the capability", () => {
    expect(stageOf("analysis.loudness_energy")).toBe("loudness_energy");
    expect(stageOf("echo")).toBe("echo");
  });
});

describe("firstOutput", () => {
  it("prefers assets and falls back to blobs", () => {
    expect(firstOutput({ assets: { source: "sha256:aa" } })).toEqual({
      asset: "sha256:aa",
      kind: "source",
    });
    expect(firstOutput({ blobs: { manifest: "sha256:bb" } })).toEqual({
      asset: "sha256:bb",
      kind: "manifest",
    });
    expect(firstOutput({})).toBeUndefined();
    expect(firstOutput(undefined)).toBeUndefined();
  });
});

describe("toClientMessages", () => {
  it("maps progress to job.progress with the capability's stage", () => {
    const messages = toClientMessages(
      event({ type: "progress", pct: 0.42, etaSec: 18 }),
      "analysis.separation",
      0,
    );
    expect(messages).toEqual([
      { t: "job.progress", jobId: "job_01ABC", stage: "separation", pct: 0.42, etaSec: 18 },
    ]);
  });

  it("defaults a missing pct to 0 and omits a missing eta", () => {
    expect(toClientMessages(event({ type: "progress" }), "echo", 0)).toEqual([
      { t: "job.progress", jobId: "job_01ABC", stage: "echo", pct: 0 },
    ]);
  });

  it("maps partial, completed and failed", () => {
    expect(
      toClientMessages(
        event({ type: "partial", outputs: { blobs: { preview: "sha256:cc" } } }),
        "analysis.preview",
        2,
      ),
    ).toEqual([
      {
        t: "job.partial",
        jobId: "job_01ABC",
        index: 2,
        output: { asset: "sha256:cc", kind: "preview" },
      },
    ]);
    expect(
      toClientMessages(event({ type: "completed", outputs: { assets: {} } }), "echo", 0),
    ).toEqual([{ t: "job.completed", jobId: "job_01ABC", outputs: { assets: {} } }]);
    expect(
      toClientMessages(
        event({ type: "failed", error: { code: "MODEL_ERROR", message: "x", retryable: true } }),
        "echo",
        0,
      ),
    ).toEqual([{ t: "job.failed", jobId: "job_01ABC", code: "MODEL_ERROR", retryable: true }]);
  });

  it("drops started and a partial with no outputs", () => {
    expect(toClientMessages(event({ type: "started" }), "echo", 0)).toEqual([]);
    expect(toClientMessages(event({ type: "partial" }), "echo", 0)).toEqual([]);
  });
});
