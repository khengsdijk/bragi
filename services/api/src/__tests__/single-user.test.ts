import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { assertSafeBinding, ensureOwner, isLoopbackHost } from "../auth/single-user.js";
import { loadConfig } from "../config.js";

describe("isLoopbackHost", () => {
  it.each(["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]"])(
    "accepts %s",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(["0.0.0.0", "::", "192.168.1.10", "example.com", "10.0.0.1", "128.0.0.1"])(
    "rejects %s",
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

describe("assertSafeBinding", () => {
  it("refuses a non-loopback host in single-user mode", () => {
    const config = loadConfig({ BRAGI_AUTH_MODE: "single-user", API_HOST: "0.0.0.0" });
    expect(() => assertSafeBinding(config)).toThrow(/refuses to bind to 0\.0\.0\.0/);
    expect(() => assertSafeBinding(config)).toThrow(/acts as the owner/);
    expect(() => assertSafeBinding(config)).toThrow(/BRAGI_ALLOW_REMOTE_SINGLE_USER=1/);
  });

  it("allows the override and warns about it", () => {
    const config = loadConfig({
      BRAGI_AUTH_MODE: "single-user",
      API_HOST: "0.0.0.0",
      BRAGI_ALLOW_REMOTE_SINGLE_USER: "1",
    });
    const warn = vi.fn();
    expect(() => assertSafeBinding(config, { warn })).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("0.0.0.0");
  });

  it("allows loopback without a warning in single-user mode", () => {
    const config = loadConfig({ BRAGI_AUTH_MODE: "single-user", API_HOST: "127.0.0.1" });
    const warn = vi.fn();
    expect(() => assertSafeBinding(config, { warn })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("is a no-op in multi-user mode", () => {
    const config = loadConfig({ BRAGI_AUTH_MODE: "multi-user", API_HOST: "0.0.0.0" });
    const warn = vi.fn();
    expect(() => assertSafeBinding(config, { warn })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("ensureOwner", () => {
  it("upserts by email then selects, and returns the row", async () => {
    const queries: { sql: string; params: unknown[] | undefined }[] = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.startsWith("SELECT")) {
          return {
            rows: [{ id: "usr_1", email: "owner@bragi.local", name: "Owner" }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
    } as unknown as Pool;

    const owner = await ensureOwner(pool, loadConfig({ BRAGI_OWNER_EMAIL: "owner@bragi.local" }));

    expect(owner).toEqual({ id: "usr_1", email: "owner@bragi.local", name: "Owner" });
    expect(queries).toHaveLength(2);
    expect(queries[0]?.sql).toContain('INSERT INTO "user"');
    expect(queries[0]?.sql).toContain("ON CONFLICT (email) DO NOTHING");
    expect(queries[0]?.params?.[1]).toBe("Owner");
    expect(queries[0]?.params?.[2]).toBe("owner@bragi.local");
    expect(queries[1]?.sql).toContain('SELECT id, email, name FROM "user"');
    expect(queries[1]?.params).toEqual(["owner@bragi.local"]);
  });

  it("fails loudly when the owner row cannot be read back", async () => {
    const pool = {
      query: async (sql: string) =>
        sql.startsWith("SELECT") ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 },
    } as unknown as Pool;
    await expect(ensureOwner(pool, loadConfig({}))).rejects.toThrow(/disappeared/);
  });
});
