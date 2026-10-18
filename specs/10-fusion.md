# 10 — Fusion (combining music)

Status: Draft v0.1 · Code: `packages/app/src/features/fusion/`, `services/workers/generate/fusion/`

Fusion combines songs, sections and stems the user has into something new: mashups, stem collages, style transfers and blends. All fusion results are ordinary projects, editable in the Song Canvas.

## 1. Entry points

- **Fusion desk** (route `/fuse`): a workspace with 2–4 drop slots. Users drag songs, sections or stems from the Universe, the library list, or the Song Canvas ("Use in Fusion").
- **Universe lasso → "Fuse these"** ([08 §7](08-universe.md)).
- **Planner prompts** in a song: "Put the vocals of *Song B* over this", resolved via library search.

The Fusion desk shows each input as a compact song strip (section blocks + key/BPM chips), and below them a **compatibility panel** and **proposals**.

## 2. Alignment (`fusion.align`)

The job computes how inputs can share one tempo and key.

**Tempo:**
- Candidate target BPMs: each input's BPM, the geometric mean, and half/double-time variants.
- Cost = Σ |log(target/bpmᵢ)| weighted by how much of each input is used. Pick the minimum, subject to a **max stretch of ±12%** per input (beyond that, the quality warning "may sound stretched" is shown).

**Key:**
- For each input, find the transposition t ∈ [−3, +3] semitones that lands its key on the same key, the relative key, or a Camelot neighbour of the target key. Minimise Σ|tᵢ|.
- Transposing vocals beyond ±2 semitones shows a quality warning (formant shift).

**Output:** `AlignmentResult { targetBpm, targetKey, perInput: [{ stretchRatio, semitones, warnings[] }] }`. The user can override the target BPM and key with chips.

## 3. Compatibility and mashup proposals (`fusion.mashup_plan`)

For two inputs A and B, build a **section compatibility matrix** (A sections × B sections):

| Factor | Weight | Computation |
|---|---|---|
| Harmonic fit | 0.35 | After transposition: beat-synchronous chord overlap (shared chord tones per beat, from harmony analysis) |
| Energy fit | 0.20 | 1 − |meanEnergyA − meanEnergyB| |
| Length fit | 0.15 | Bar counts equal, or one a multiple of the other |
| Role complementarity | 0.20 | One section vocal-heavy and the other instrumental-heavy scores high (from `stem_activity`) |
| Groove fit | 0.10 | Drum-stem embedding similarity (higher = less rhythmic clash) |

**Proposal templates**, ranked by aggregate score, top 3 shown as candidates:
1. **"A vocals over B"**: A's vocal stem placed over B's instrumental stems (all of B except vocals), using the best-matching section pairs throughout B's structure.
2. **"Trade sections"**: alternate between A and B sections with beat-matched transitions (verse A → chorus B → …).
3. **"A into B"**: A's first half, a generated transition, then B's second half (a DJ-style blend).
4. **"Best of both"**: B's drums and bass under A's harmonic stems and vocals.

Each proposal compiles into a **Mix project** (a project with multiple sources, [02 §3](02-song-model.md)). Each section's lanes reference clips from different sources, with warp and pitch set from the alignment. Proposals appear in the Audition bar like any AI candidate. Accepting one opens it in the Song Canvas, where everything can be edited further.

**Clash repair** (optional per proposal, "✨ Make it blend"): for harmonically weak spots (beats where chord overlap is below threshold), the planner offers per-region fixes: mute the clashing stem for those beats, `generate.variation` at low strength on the instrumental, or `transform.stem_resynth` to re-voice.

## 4. Stem collage

- A blank Mix project where the user drags individual stems from any library songs onto tracks.
- On drop, each stem is auto-conformed to the project tempo and key (alignment as in §2, with the first dropped stem's song as the master by default).
- The user arranges stems section by section with the normal canvas tools.
- **✨ Glue**: one action that runs `generate.variation` at low strength (0.15–0.25) over the whole mix, so the collage sounds like one production (shared room, cohesive tone). It produces candidates, and the original collage is always kept.

## 5. Style transfer ("this song, in the style of that song")

- Inputs: **content song A** (melody, structure and lyrics are kept) and **style reference B** (one of the user's own library items or creations).
- Style extraction: B's tags/descriptors, CLAP embedding, BPM feel, and, if the backend supports audio conditioning, B's preview snippet as a style reference.
- Run `transform.style` on A section by section (strength slider 0.3–0.8, default 0.5). Vocals are kept by default: the vocal stem is muted during transformation and re-mixed afterwards.
- The UI phrases it as **"Restyle with the sound of …"**, showing B's descriptors ("warm tape, boom-bap drums, jazzy chords") so the user can edit them before running.

## 6. Blend slider

- Inputs A and B. A slider t ∈ [0, 1].
- `e(t) = slerp(e_A, e_B, t)` on song embeddings. Descriptors come from zero-shot scoring of `e(t)` against the taxonomy. BPM and key are interpolated (BPM geometrically, key toward the nearest compatible key).
- **Blend strip:** Bragi generates three short previews (30 s) at t = 0.25, 0.5 and 0.75 with `generate.text2music` (+ dual audio style references if supported). The user picks a point and generates a full song there (long-form or text2music).
- **Honest UX copy:** "A new song inspired by both, not a literal mix." For literal mixing, use mashups (§3).

## 7. Content and rights policy (normative)

This section applies to fusion **and** all generation. It is enforced in the planner, the API, and the workers.

1. **User-supplied audio only.** Bragi never sources music for the user. Uploading requires a one-time acknowledgement: "Only upload audio you have the right to use. Bragi keeps it private to you."
2. **Private by default, no publishing in v1.** There is no public sharing of projects or exports. Exports are files on the user's device.
3. **No artist imitation by name.** Generation prompts must not target named artists, bands or songs. The planner translates names into sonic descriptors ("in the style of [artist]" → "breathy vocals, analog synth pads, 80s gated drums") and tells the user it did so. Direct generation API calls whose prompt matches the artist blocklist (metadata of the user's library + a curated list) are rejected with `PROMPT_POLICY`.
4. **Audio style references come only from the user's own uploads or creations**, never from fetched or third-party audio.
5. **No voice cloning.** No generation of new vocals in the voice of a real person, including the user's uploaded vocal stems used as a "voice prompt". Reusing an existing vocal stem *as-is* (mashups, remixes) is allowed. Generated vocals use the model's synthetic voices.
6. **Provenance is always recorded** and embedded in exports ([09 §8](09-generation.md)).
7. **No training on user audio.**
8. **Before any commercial launch:** legal review of the ToS, model licences (non-commercial weights must be replaced, [04 §9](04-analysis-pipeline.md)), and the takedown process. This spec is not legal advice.

## 8. Acceptance checks

1. Two fixture songs at 100 and 128 BPM in keys 5A and 8B: alignment picks a target within ±12% stretch for both and transpositions ≤ 3 semitones, with warnings set correctly.
2. "A vocals over B" produces a Mix project where vocal clips come from A, other stems from B, and section boundaries are bar-aligned with no clip gaps.
3. Blocked prompts: 20 test prompts containing artist names are all either rewritten (planner) or refused (direct API). 20 prompts without names pass.
4. Every fusion proposal is fully undoable and appears in the version tree as candidates.
