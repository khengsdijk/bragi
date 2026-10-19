/** Helpers shared by the integration tests. */
import { expect } from "vitest";

export const API_URL = process.env.API_URL ?? "http://127.0.0.1:8080";
export const MAILPIT_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:8025";

/** Requests a magic link, reads it from Mailpit, and returns the session cookie. */
export async function loginViaMagicLink(email: string): Promise<string> {
  const request = await fetch(`${API_URL}/v1/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, callbackURL: `${API_URL}/v1/meta` }),
  });
  expect(request.ok).toBe(true);

  const verifyUrl = await waitFor(
    async () => {
      const listing = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=50`);
      const body = (await listing.json()) as {
        messages?: { ID: string; To?: { Address: string }[] }[];
      };
      const message = body.messages?.find((candidate) =>
        candidate.To?.some((to) => to.Address === email),
      );
      if (!message) return undefined;
      const detail = await fetch(`${MAILPIT_URL}/api/v1/message/${message.ID}`);
      const text = ((await detail.json()) as { Text?: string }).Text ?? "";
      return /https?:\/\/\S+/.exec(text)?.[0];
    },
    15_000,
    "the magic link email",
  );
  expect(verifyUrl).toContain("/v1/auth/magic-link/verify");

  const verified = await fetch(verifyUrl, { redirect: "manual" });
  const cookies = verified.headers.getSetCookie();
  const session = cookies.find((value) => value.startsWith("better-auth.session_token="));
  if (!session) throw new Error("no session cookie from the magic-link verification");
  return session.split(";")[0] ?? "";
}

/** Polls `fn` until it returns a value, or fails after `timeoutMs`. */
export async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
