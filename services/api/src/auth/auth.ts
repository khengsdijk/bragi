/**
 * Better Auth (specs/05-backend-and-jobs.md §8).
 *
 * - **Email magic link** works fully locally: the link is emailed to Mailpit
 *   on `127.0.0.1:8025` and the integration test reads it from Mailpit's API.
 * - **GitHub OAuth** is wired the same way, but only when
 *   `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` are set. Without the owner's OAuth
 *   app it cannot be exercised here, and the acceptance test never tries.
 * - Session cookies are the web credential; a bearer token for the desktop
 *   PKCE flow is a later work package (05 §8).
 */
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import type { Pool } from "pg";

import type { Config } from "../config.js";
import { createMailer } from "./email.js";

/** Builds the Better Auth instance and its mailer. */
export function createAuth(config: Config, pool: Pool) {
  const mailer = createMailer(config);
  const auth = betterAuth({
    database: pool,
    secret: config.authSecret,
    baseURL: config.publicUrl,
    basePath: "/v1/auth",
    trustedOrigins: [config.publicUrl],
    // Magic link (and OAuth) only: no passwords in v1.
    emailAndPassword: { enabled: false },
    socialProviders: githubProviders(config),
    user: {
      additionalFields: {
        plan: { type: "string", required: false, defaultValue: "free" },
        settings: { type: "json", required: false },
      },
    },
    plugins: [
      magicLink({
        expiresIn: 15 * 60,
        sendMagicLink: async ({ email, url }) => {
          await mailer.send({
            to: email,
            subject: "Sign in to Bragi",
            text: `Open this link to sign in to Bragi:\n\n${url}\n\nIt expires in 15 minutes.`,
          });
        },
      }),
    ],
  });
  return { auth, mailer };
}

/** The concrete Better Auth instance, inferred from the options above. */
export type AuthInstance = ReturnType<typeof createAuth>["auth"];

function githubProviders(config: Config): {
  github?: { clientId: string; clientSecret: string };
} {
  if (config.githubClientId === "" || config.githubClientSecret === "") return {};
  return {
    github: { clientId: config.githubClientId, clientSecret: config.githubClientSecret },
  };
}
