# Bragi

> *Bragi: the Norse god of poetry and music.*

Bragi is an AI-native music editor for people who have never opened a DAW. You drop in a song, and Bragi **takes it apart**: it separates stems, finds sections, chords, key, tempo and energy, and labels everything in plain language. It then **shows** the music as something you can see and touch, and lets you **reshape it** by dragging, painting and describing what you want. Above the single song sits **the Universe**: your whole library mapped by sound, genre and mood. There you can see how songs relate, travel between them, fuse them, and generate new music that fills the empty spaces.

Bragi runs as a **desktop app (macOS, Windows, Linux)** and in the **browser**, from one codebase.

This repository currently contains **specifications only**. No code has been written yet. The specs are written so that humans or coding agents can implement Bragi one work package at a time.

## Reading order

| # | Document | What it answers |
|---|---|---|
| 00 | [Vision & principles](specs/00-vision.md) | What Bragi is, who it's for, what it is *not* |
| 01 | [System architecture](specs/01-architecture.md) | The stack, the components, how web and desktop share code |
| 02 | [Song model & versioning](specs/02-song-model.md) | The canonical data model everything else operates on |
| 03 | [Audio engine](specs/03-audio-engine.md) | The Rust core: decoding, playback, rendering, DSP, WASM vs native |
| 04 | [Analysis pipeline](specs/04-analysis-pipeline.md) | Stems, structure, chords, tags, embeddings |
| 05 | [Backend, jobs & sync](specs/05-backend-and-jobs.md) | API, event bus, GPU workers, storage, auth, sync |
| 06 | [AI intent planner](specs/06-ai-planner.md) | How "make this more aggressive" becomes concrete edits |
| 07 | [Song Canvas](specs/07-song-canvas.md) | The single-song visual editor and its interactions |
| 08 | [The Universe](specs/08-universe.md) | The library map, lenses, constellations, search, paths |
| 09 | [AI generation](specs/09-generation.md) | Extend, inpaint, stem generation, prompt-to-song, long-form |
| 10 | [Fusion](specs/10-fusion.md) | Mashups, style transfer, blending, plus content policy |
| 11 | [UX, design system & accessibility](specs/11-ux-and-accessibility.md) | Onboarding, visual language, a11y, beginner safety |
| 12 | [Roadmap & work packages](specs/12-roadmap.md) | Phases, ordered work packages, acceptance criteria |
| 13 | [Agent implementation guide](specs/13-agent-guide.md) | Conventions, repo layout, definition of done, how to change specs |
| 14 | [Glossary](specs/14-glossary.md) | Shared vocabulary |
| 15 | [Open questions](specs/15-open-questions.md) | Decisions still to make, and which work package needs them |

Architecture decisions are recorded in [`specs/decisions/`](specs/decisions/). Coding agents start at [`AGENTS.md`](AGENTS.md).

## Status

| Area | Status |
|---|---|
| Specs | Draft v0.1 (2026-10-18) |
| Code | Not started |
| Next step | Phase 0 work packages in [12-roadmap.md](specs/12-roadmap.md) |
