# 14 — Glossary

| Term | Meaning |
|---|---|
| **Analysis blob** | Content-addressed JSON result of one analysis stage for one asset ([04](04-analysis-pipeline.md)) |
| **Analysis profile** | `quick`, `standard` or `deep`: which stages run ([04 §3](04-analysis-pipeline.md)) |
| **Asset** | An immutable binary file (audio, snapshot, blob) identified by `sha256:<hex>` |
| **Audition** | Listening to and switching between candidate versions at the same playhead position ([03 §5.4](03-audio-engine.md)) |
| **Blueprint** | User-editable plan of blocks for long-form generation ([09 §4.5](09-generation.md)) |
| **Candidate** | A commit produced by an AI request, not yet accepted. UI word: "version idea" ([02 §7](02-song-model.md)) |
| **Candidate group** | The set of candidates produced by one AI request |
| **Capability** | A named job type workers can perform, e.g. `generate.extend` ([05 §4](05-backend-and-jobs.md)) |
| **Clip** | A reference to a range of an asset placed on a lane within a section ([02 §3.6](02-song-model.md)) |
| **Commit** | An immutable version of a project: op batch + snapshot + parents ([02 §7](02-song-model.md)) |
| **Constellation** | A relationship edge between items in the Universe ([08 §5](08-universe.md)) |
| **Context audio** | Rendered audio around a target region, used to condition generation |
| **Creation** | A project made in Bragi (edit, generation, fusion), shown as ✦ in the Universe |
| **EditPlan** | The planner's output: variants made of ops and generation steps ([06 §3](06-ai-planner.md)) |
| **Energy skyline** | The editable energy curve above the section blocks ([07 §4.6](07-song-canvas.md)) |
| **EngineDelta** | Minimal change description from `bragi-model::diff`, consumed by the engine |
| **EngineHost** | TS interface abstracting the audio engine on web (WASM) and desktop (native) |
| **Harmony strip** | The chord lane, coloured by root and quality ([07 §2](07-song-canvas.md)) |
| **HQ / preview tier** | High-quality vs fast generation output ([09 §5](09-generation.md)) |
| **Lane** | The content (clips + automation) of one track within one section |
| **Lens** | A Universe layout/colouring mode (Sound, Genre, Mood…) ([08 §3](08-universe.md)) |
| **Macro / vibe control** | A plain-language control driving several fx params ([03 §6.1](03-audio-engine.md)) |
| **Mix project** | A project with multiple sources (paths, mashups, collages) |
| **Op / op batch** | A typed edit operation. A batch is an atomic group of ops with author and label ([02 §4](02-song-model.md)) |
| **PPQ / tick** | Pulses per quarter note (960). The tick is the musical time unit. |
| **Region** | Universal selection: absolute tick range × tracks (× optional frequency range) ([02 §3.8](02-song-model.md)) |
| **Render plan** | The engine's flattened, sample-domain compilation of a document ([03 §4](03-audio-engine.md)) |
| **Repeat group** | Label shared by sections that repeat the same material, e.g. all choruses |
| **Residual** | `mix − Σ stems`, kept so unedited playback reconstructs the original ([02 §3.4](02-song-model.md)) |
| **Ribbon** | The visual representation of a track (instrument) in the Song Canvas |
| **Seam score** | Objective measure of how audible a splice is (lower is better) ([03 §8.2](03-audio-engine.md)) |
| **Section (instance)** | An ordered arrangement element (Intro, Verse…) holding per-track lanes |
| **Snapshot** | Full canonical JSON of a document at a commit, stored as an asset |
| **Source** | An original input (upload, generation, recording) with original + working assets |
| **Stem** | One separated instrument signal (vocals, drums, bass, …) |
| **Universe** | The library map, zoom level L1 ([08](08-universe.md)) |
| **Working asset** | The 48 kHz 24-bit FLAC normalised copy of a source used for everything downstream |
| **WP** | Work package ([12](12-roadmap.md)) |
