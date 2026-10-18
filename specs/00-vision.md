# 00 — Vision & Principles

## 1. The one-sentence pitch

**Bragi lets anyone see, understand and reshape music. You point at the part you want to change and say what you want, and you never have to learn what a compressor is.**

## 2. The problem

Today's audio editors (Ableton, Logic, FL Studio, Audacity) are built around waveforms, grids, mixers and plugin chains. They're powerful, but:

- A finished song is opaque. You can't see its *structure*, its instruments or *why* it works.
- Editing requires technical vocabulary: EQ, sidechain, automation, warp markers.
- AI music tools (prompt-to-song generators) go the other way. They're accessible but **uncontrollable**: you get a black-box audio file, and if 90% is great and 10% is wrong, you start over.
- No tool shows a person's *collection* of music as a connected space you can explore and create from.

## 3. The bet

1. **Music should look like what it sounds like.** If structure, instruments, energy and harmony are visible, people can edit by pointing at them.
2. **AI should be an editing tool, not a slot machine.** Every AI action targets a region, produces auditionable variations, and lands as a normal, reversible edit in the song's history.
3. **Your library is a place.** Songs, sections and stems live in a navigable map. Relationships between songs are first-class and can be explored, traversed and generated from.

## 4. Three zoom levels, one space

The whole product is one continuous zoomable space. The three levels are **not** separate apps:

| Level | Name | What you see | What you do |
|---|---|---|---|
| L1 | **The Universe** | Your whole library as a galaxy of songs, clustered by sound/genre/mood | Explore, search, find relationships, draw paths, generate into empty space, pick songs to fuse |
| L2 | **The Song** | One song as section blocks, instrument ribbons, an energy skyline and a harmony strip | Rearrange, extend, reshape energy, swap instruments, prompt edits on regions |
| L3 | **The Moment** | A few bars, with per-stem detail, waveform/spectrum and note-level info | Fine sculpting: paint effects, inpaint gaps, edit a fill, regenerate a phrase |

Zooming in on a star in the Universe smoothly becomes the Song view. Zooming in on a section becomes the Moment view.

## 5. Target users

| Persona | Description | What they need from Bragi |
|---|---|---|
| **The Listener-Tinkerer** (primary) | Loves music, no production skills. Wants to make an extended mix of a favourite song, remove vocals for karaoke, or "make this calmer". | Zero jargon, can't break anything, instant gratification |
| **The Bedroom Creator** (primary) | Makes beats or songs casually, maybe uses GarageBand. Wants ideas, arrangements, and to finish tracks. | Generation that's controllable, stems, arrangement help |
| **The Curator / DJ** (secondary) | Big library, cares about how songs connect: keys, tempos, vibes, transitions. | The Universe, harmonic lenses, paths, mashups |
| **The Learner** (secondary) | Wants to understand *why* music works. | "Explain this", visible structure and harmony |
| **The Producer** (tertiary) | Already uses a DAW. Wants stems, fast idea generation and analysis. | Export stems/MIDI/project to their DAW. Bragi is *not* trying to replace their DAW. |

## 6. Product principles

These are tie-breakers. When a design decision is unclear, apply them in order.

1. **Nothing is destructive.** Every change, human or AI, is a version in a tree. The original is always one click away. Experimenting must feel risk-free.
2. **Audition before commit.** AI edits produce *candidates* (default 3) you listen to before accepting.
3. **Plain language first, power second.** Every control has a plain-language label ("Brighter", "More space"). Technical detail is available on hover or in an "Expert" panel, never required.
4. **Show, then explain.** Bragi visualises first and can explain anything it shows ("Why does this chorus hit hard?").
5. **Progressive, alive feedback.** Long operations (analysis, generation) stream partial results. The song "comes alive" piece by piece and never sits behind a blank spinner.
6. **Local-first editing.** Editing, playback and the version tree work offline. The cloud provides compute (AI) and optional sync, not the editing loop.
7. **Respect artists.** Bragi helps people play with music they have, not impersonate artists. See [10-fusion.md §7](10-fusion.md) for the content policy.
8. **Performance is a feature.** 60 fps canvases, instant playback start (< 100 ms), and edits that feel immediate (preview first, high-quality render later).

## 7. Scope: what Bragi IS

- An analyser that turns a stereo mix into a structured, labelled, editable song.
- A visual editor for arrangement, energy, timbre and effects, aimed at non-experts.
- An AI co-editor: extend, inpaint, replace, add stems, restyle, generate.
- A generator of new songs that are immediately editable in the same canvas.
- A library explorer that maps music by similarity and relationships.
- A fusion tool for combining songs the user owns or created.
- An exporter: mixdown (WAV/FLAC/MP3), stems, MIDI (where available), and a DAW-friendly bundle.

## 8. Non-goals (for v1)

- **Not a full DAW.** No arbitrary plugin hosting (VST/AU) or MIDI sequencer piano roll as a primary workflow, and no multi-track recording studio. (Simple voice/instrument recording *into* a song is a later, optional feature.)
- **Not a streaming service or music store.** Bragi never sources copyrighted music for the user.
- **No voice cloning of real, identifiable people.**
- **No social network or publishing platform** in v1. Sharing is limited to private links and exported files.
- **No real-time collaborative editing** in v1. The data model is designed so it can be added later (see [02-song-model.md §9](02-song-model.md)).
- **No mobile apps** in v1. The web app should be usable on a tablet, but phone layouts are out of scope.

## 9. Success criteria

For a side project, "success" means these demos work end-to-end and feel magical:

1. **"See your song"**: Drop a 4-minute pop song. Within 60 s a playable, labelled canvas appears (sections, stems, chords, key, BPM, mood tags, a one-paragraph description). Each stem can be soloed.
2. **"Make it longer"**: Drag the song's end handle out by 2 minutes. You get 3 continuations that sound like the song, with no audible seam.
3. **"Reshape energy"**: Drag the energy skyline down over the bridge and up over the last chorus. The arrangement changes to match.
4. **"Lasso + prompt"**: Lasso the drums in verse 2 and type "half-time, more lo-fi". You get 3 variations, can accept one, and can roll back.
5. **"Your Universe"**: Import 500 songs. They form named clusters. Search "sad piano intros" and the right *sections* light up.
6. **"Generate into the gap"**: Click empty space between two clusters, and Bragi generates a song that plausibly belongs there.
7. **"Fuse"**: Drop two of your songs. Bragi proposes a key/tempo-aligned mashup you can then edit like any song.

## 10. Ambition and risk register

Bragi is deliberately ambitious. These are the hardest problems, so each gets explicit attention in the specs:

| # | Hard problem | Where addressed |
|---|---|---|
| R1 | Seamless AI edits (no audible seams in timbre, loudness or timing) | [09-generation.md §6](09-generation.md) |
| R2 | Stem separation artifacts become audible once stems are edited | [04-analysis-pipeline.md §4](04-analysis-pipeline.md), [03-audio-engine.md §8](03-audio-engine.md) |
| R3 | Generation latency (seconds to minutes) vs. interactive feel | [09-generation.md §5](09-generation.md) (preview tiers) |
| R4 | Mapping vague intent to concrete edits | [06-ai-planner.md](06-ai-planner.md) |
| R5 | 60 fps zoom from galaxy to waveform in a browser and three different webviews | [07-song-canvas.md §9](07-song-canvas.md), [08-universe.md §8](08-universe.md) |
| R6 | GPU inference cost | [05-backend-and-jobs.md §9](05-backend-and-jobs.md) |
| R7 | Model licensing and copyright | [10-fusion.md §7](10-fusion.md), [04-analysis-pipeline.md §9](04-analysis-pipeline.md) |
| R8 | Cross-platform audio parity (WASM in browser vs native on desktop) | [03-audio-engine.md §3](03-audio-engine.md) |
