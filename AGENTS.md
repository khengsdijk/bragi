# AGENTS.md

You are working on **Bragi**, an AI-native music editor (desktop + web). Before doing anything:

1. Read [`specs/13-agent-guide.md`](specs/13-agent-guide.md): the rules, conventions and Definition of Done.
2. Pick a work package from [`specs/12-roadmap.md`](specs/12-roadmap.md) whose dependencies are Done.
3. Read every spec that the work package lists.

Key rules, in short:
- The specs are the source of truth. Update them in the same PR if you must deviate.
- Change JSON Schemas in `packages/schemas` first, then regenerate. Never hand-edit generated code.
- Song documents change only through `bragi-model` ops.
- No allocation, locks or I/O on the audio thread.
- No new major dependency or framework without an ADR in `specs/decisions/`.
- No copyrighted audio or secrets in the repo. Follow the content policy in `specs/10-fusion.md §7`.
