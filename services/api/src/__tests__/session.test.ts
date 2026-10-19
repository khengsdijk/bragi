import { describe, expect, it, vi } from "vitest";

import {
  createSessionResolver,
  type SessionResolverOptions,
  SINGLE_USER_SESSION_ID,
} from "../auth/session.js";

type AuthApi = SessionResolverOptions["authApi"];

const OWNER = { id: "usr_1", email: "owner@bragi.local", name: "Owner" };

describe("createSessionResolver", () => {
  it("returns the owner for empty headers in single-user mode", async () => {
    const resolver = createSessionResolver({
      mode: "single-user",
      authApi: {} as AuthApi,
      owner: OWNER,
    });
    const session = await resolver.resolve({});
    expect(session?.user).toEqual(OWNER);
    expect(session?.session.id).toBe(SINGLE_USER_SESSION_ID);
    expect(session?.session.expiresAt.getUTCFullYear()).toBe(9999);
  });

  it("requires an owner in single-user mode", () => {
    expect(() => createSessionResolver({ mode: "single-user", authApi: {} as AuthApi })).toThrow(
      /needs an owner/,
    );
  });

  it("delegates to Better Auth in multi-user mode and returns undefined when signed out", async () => {
    const getSession = vi.fn(async () => null);
    const resolver = createSessionResolver({
      mode: "multi-user",
      authApi: { getSession } as unknown as AuthApi,
    });
    expect(await resolver.resolve({ cookie: "x" })).toBeUndefined();
    expect(getSession).toHaveBeenCalledOnce();
  });

  it("returns the Better Auth session in multi-user mode", async () => {
    const session = { user: OWNER, session: { id: "s1", expiresAt: new Date() } };
    const resolver = createSessionResolver({
      mode: "multi-user",
      authApi: { getSession: async () => session } as unknown as AuthApi,
    });
    expect((await resolver.resolve({}))?.user).toEqual(OWNER);
  });
});
