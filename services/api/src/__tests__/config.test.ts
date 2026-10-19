import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";

describe("loadConfig", () => {
  it("defaults every value so the API boots with no environment", () => {
    const config = loadConfig({});
    expect(config.apiPort).toBe(8080);
    expect(config.databaseUrl).toContain("postgres://");
    expect(config.natsUrl.startsWith("nats://")).toBe(true);
    expect(config.s3Bucket).toBe("bragi-blobs");
    expect(config.githubClientId).toBe("");
    expect(config.otelEnabled).toBe(true);
    expect(config.authMode).toBe("multi-user");
    expect(config.ownerEmail).toBe("owner@bragi.local");
    expect(config.ownerName).toBe("Owner");
    expect(config.allowRemoteSingleUser).toBe(false);
  });

  it("reads the single-user variables from the environment (WP-2.0)", () => {
    const config = loadConfig({
      BRAGI_AUTH_MODE: "single-user",
      BRAGI_OWNER_EMAIL: "me@example.com",
      BRAGI_OWNER_NAME: "Koen",
      BRAGI_ALLOW_REMOTE_SINGLE_USER: "1",
    });
    expect(config.authMode).toBe("single-user");
    expect(config.ownerEmail).toBe("me@example.com");
    expect(config.ownerName).toBe("Koen");
    expect(config.allowRemoteSingleUser).toBe(true);
  });

  it("rejects an unknown auth mode", () => {
    expect(() => loadConfig({ BRAGI_AUTH_MODE: "everyone" })).toThrow(/authMode/);
  });

  it("reads values from the environment variables named in the spec", () => {
    const config = loadConfig({
      API_PORT: "9090",
      NATS_URL: "nats://nats:4222",
      GITHUB_CLIENT_ID: "abc",
      OTEL_ENABLED: "false",
    });
    expect(config.apiPort).toBe(9090);
    expect(config.natsUrl).toBe("nats://nats:4222");
    expect(config.githubClientId).toBe("abc");
    expect(config.otelEnabled).toBe(false);
  });

  it.each(["true", "1", "yes"])("parses %s as true", (value) => {
    expect(loadConfig({ OTEL_ENABLED: value }).otelEnabled).toBe(true);
  });

  it("names the offending field when a value is invalid", () => {
    expect(() => loadConfig({ API_PORT: "not-a-port" })).toThrow(/apiPort/);
    expect(() => loadConfig({ DATABASE_URL: "" })).not.toThrow(); // empty → default
    expect(() => loadConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "nope" })).toThrow(/otelEndpoint/);
  });

  it("rejects a port above the TCP range", () => {
    expect(() => loadConfig({ API_PORT: "70000" })).toThrow(/apiPort/);
  });
});
