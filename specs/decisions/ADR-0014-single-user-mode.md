# ADR-0014 — Single-user mode for local use

- **Status:** Accepted
- **Date:** 2026-10-19
- **Decider:** Koen
- **Work package:** WP-2.0

## Context

Bragi is a personal-use project ([ADR-0013](ADR-0013-personal-use-only.md)). Phase 1 shipped
Better Auth with an email magic link, and locally that link only arrives in the Mailpit inbox
(`http://127.0.0.1:8025`). Every local session therefore starts with a detour through Mailpit, the
desktop app cannot authenticate at all (Q81: the API resolves only session cookies), and the
end-to-end tests spend their first steps signing in. None of that protects anything when the only
user is the owner on their own machine.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Keep magic link everywhere | One code path | Mailpit detour on every local session; desktop blocked on PKCE |
| Remove auth entirely | Simplest | Loses ownership rows (`user_assets`, library, jobs) and the future hosted path |
| Auto-login: issue a real Better Auth session on first visit | Uses the existing cookie path | Still needs cookies, so the desktop webview (cross-site) is still blocked; a hidden login endpoint is easy to expose by accident |
| **Single-user mode: every request resolves to one owner user** | No sign-in on web or desktop; ownership checks unchanged because there is still a user; one switch at the session-resolution seam | Anyone who can reach the API acts as the owner, so binding must be restricted (below) |

## Decision

`BRAGI_AUTH_MODE = single-user | multi-user`.

- **single-user** (the default for `pnpm dev:backend` and the local stack): at startup the API
  idempotently creates one owner user (`BRAGI_OWNER_EMAIL`, default `owner@bragi.local`;
  `BRAGI_OWNER_NAME`, default `Owner`). Every HTTP request and WebSocket connection resolves to
  that user without a cookie or bearer token. The switch lives in the single session resolver
  (`services/api/src/auth/session.ts`), not in individual routes.
- **multi-user** (the default for compose and any hosted deployment): today's Better Auth flow
  (magic link, GitHub OAuth; desktop PKCE in WP-2.9).
- `GET /v1/auth/mode` returns `{ mode, user }` so clients can hide the sign-in form.

**Safety:** in single-user mode the API refuses to start when `API_HOST` is not a loopback
address, because anyone who could reach it would act as the owner. `BRAGI_ALLOW_REMOTE_SINGLE_USER=1`
overrides this (needed inside a container, which binds `0.0.0.0`) and is logged as a warning.

## Consequences

- Positive: no sign-in locally on web or desktop; the integration and e2e suites skip Mailpit by
  default; Q81 is resolved for local use.
- Negative: two auth modes to keep working. Mitigation: the WP-0.7 magic-link acceptance test runs
  against a multi-user stack, so the multi-user path is still exercised.
- Negative: single-user mode on a reachable interface would hand the account to the network.
  Mitigation: the loopback guard and an explicit, logged override.
- Desktop PKCE and bearer tokens (WP-2.9) apply only to multi-user (hosted) mode.
