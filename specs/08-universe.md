# 08 — The Universe (library map)

Status: Draft v0.2 · Code: `packages/app/src/features/universe/`, `packages/render-universe/`, `services/workers/embed/`

The Universe is zoom level **L1**: the user's whole library as a navigable space where position means sound, and lines mean relationships.

## 1. What's in the Universe

| Item | Source | Shown |
|---|---|---|
| **Songs** (library items) | Imports, `quick` analysis | Always, as stars |
| **Creations** (projects: edits, generations, fusions) | Projects with a render | Always, as distinct star shapes (✦), with lineage lines to their sources |
| **Sections** | `section_embed` (standard profile) | When zoomed into a cluster or when a song is selected: the song's sections orbit it, and section points show in search results |
| **Stems** | `stem_embed` | Only in search results and the "Stems" lens filter (e.g. "show me all basslines") |

Scale target for v1: **50 000 songs** per user at 60 fps, with sections and stems loaded lazily per viewport.

## 2. Layout computation (`embed.project` job)

- **Default "Sound" layout:** UMAP (`n_neighbors=15`, `min_dist=0.1`, cosine metric, fixed seed) on the 512-d song embeddings. 2D by default, with a 3D variant computed alongside.
- **Incremental placement:** newly imported songs are placed with the fitted UMAP model's `transform`, so existing points don't move. A full **re-fit** happens when the library has grown more than 20% since the last fit, or nightly if changed. After a re-fit, the new layout is **Procrustes-aligned** to the previous one so the map doesn't flip or rotate, and the client animates points to their new positions.
- **Sections and stems** are placed with the same fitted model's `transform`, so a song's chorus sits in the same sound space as other choruses.
- **Output blob:** `LayoutBlob { lens, version, dims: 2|3, items: [{ id, kind, x, y, z? }], clusters: [...] }`, cached locally (SQLite + Float32Array buffers).
- Small libraries (< 30 songs) skip UMAP and use a PCA layout plus force-directed spacing, because UMAP is unstable on tiny sets. The UI shows a friendly "Your universe grows as you add music" state.

## 3. Lenses

Switching lenses **morphs** points from one layout to another (600 ms eased animation). A lens defines position, colour and grouping.

| Lens | Position | Colour | Notes |
|---|---|---|---|
| **Sound** (default) | UMAP of embeddings | Top genre hue | "What sounds like what" |
| **Genre** | Genre taxonomy as a galaxy: top-level genres as force-laid-out regions, subgenres as sub-clusters, songs placed inside by local sound similarity | Genre hue | Uses `tag` hierarchy ([04 §6.2](04-analysis-pipeline.md)) |
| **Mood** | Valence (x) × arousal (y) plane. Each mood label in the taxonomy has fixed circumplex coordinates. A song's position is the score-weighted average, nudged by mode (major → +valence) and energy (→ arousal). | Energy | Labelled quadrants: "Happy & energetic", "Calm & content", "Sad & quiet", "Tense & intense" |
| **Energy × Tempo** | x = BPM (log), y = absolute energy | Key | For DJs and workout playlists |
| **Harmonic wheel** | Polar Camelot wheel: angle = Camelot number, ring = minor (inner) / major (outer), radial jitter by BPM | Camelot colour | Harmonic-mixing neighbours are adjacent |
| **Timeline** | x = date (added, release year from metadata, or project creation), y = 1D sound projection | Genre hue | "How my taste and creations evolved" |
| **Creations** | Sound layout, but only creations + their sources, with lineage edges emphasised | Creation type | Your work as a family tree in sound space |

Filters apply to every lens: BPM range, key, energy, genre/mood tags, item kind, date range, and "has stems".

## 4. Clusters and naming

- **Clustering:** HDBSCAN on the 2D sound layout (`min_cluster_size` scaled to library size), using the condensed tree for **hierarchical clusters**. Coarse clusters show when zoomed out and finer ones when zoomed in.
- **Naming:** for each cluster, aggregate the top tags, mean BPM range and mode distribution, then ask the configured LLM (OpenRouter, ADR-0012) for a 2–4 word evocative but descriptive name ("Late-night synthwave", "Sunny acoustic folk", "Heavy 140 bpm dubstep"). Names are cached per cluster and recomputed only when a cluster's membership changes by more than 30%. The user can rename a cluster, and the rename persists by matching the cluster's centroid.
- Cluster labels float at the centroid and fade with zoom level (LOD).

## 5. Constellations (relationships)

Computed by the `embed.constellations` job per user. Edges are stored as a blob and toggled per type in the UI.

| Type | Rule | Edge label (on hover/click) |
|---|---|---|
| **Sound neighbours** | kNN (k=5) in embedding space, cosine sim ≥ 0.75 | "Very similar sound" |
| **Shared progression** | Equal `progressionFingerprint` (key-normalised roman n-gram of length ≥ 4) in any section | "Both use i–VI–III–VII" |
| **Mix-compatible** | Camelot-adjacent keys and BPM within ±6% (or 2× / ½×) | "Mixes harmonically: 8A → 9A, 124 → 126 BPM" |
| **Similar groove** | Drum-stem embeddings cosine ≥ 0.8 | "Similar drum groove" |
| **Similar section** | A section of A is a kNN of a section of B (sim ≥ 0.85) | "A's intro sounds like B's breakdown" |
| **Lineage** | Project derived from song(s) | "Extended mix of …", "Fusion of A + B" |
| **Same artist** | Metadata | Artist name |

Edges are drawn as faint curved lines, brightened on hover. At most 2 000 visible edges are drawn, prioritised by strength and proximity to the cursor. Clicking an edge opens a **comparison card** with an A/B audition of the related sections.

## 6. Search

| Query type | Pipeline | Result scope |
|---|---|---|
| **Text** ("sad piano intros") | CLAP text embedding → pgvector kNN over song/section/stem embeddings, re-ranked by tag matches and filters | Points light up on the map + a results list. Section results jump to the section on click. |
| **Reference clip** (drag in audio or pick a region of any song) | CLAP audio embedding → kNN | Same |
| **"More like this"** (on any point) | Embedding of that item → kNN | Same |
| **Hum / sing** (Phase 3b) | Mic recording → melody transcription → interval contour → DTW against section melody contours from `transcribe` (deep profile) | Sections only. Accuracy is honest: works for songs with deep analysis. Otherwise it falls back to a CLAP audio embedding of the recording, which is weak. |

Search runs on the server (pgvector HNSW). The client also holds the cached song vectors, so **offline search** over songs works via brute-force cosine in a Web Worker. 50k × 512 floats is about 100 MB, so this is enabled only on desktop by default.

## 7. Interacting with the map

- **Navigation:** pan (drag), zoom (scroll/pinch), and fit-all (`F`). A 3D toggle switches to an orbit camera.
- **Hover-to-hear:** hovering a star for 300 ms plays its **preview snippet** (a 12 s clip from the song's most energetic stretch, produced by the `preview` analysis stage ([04 §5.7](04-analysis-pipeline.md)), stored as 96 kbps Opus, about 150 KB). Moving between stars crossfades. Previews are prefetched for stars near the cursor.
- **Select:** clicking a star opens a side card with the title, tags, description, BPM/key and actions: Open in canvas, Find similar, Use in Fusion, Start path from here.
- **Lasso multiple stars** → "Make a playlist", "Fuse these", "Tag these", "Generate something like these".
- **Zoom into a song:** double-click → the camera flies to the star, the star blooms into a ring of its sections, and the view crossfades into the Song Canvas route (`/song/:projectId`). The back button reverses the animation.

### 7.1 Paths
1. Pick start A and end B (or draw a freehand curve across the map).
2. Server `POST /universe/path` builds a kNN graph (k=10). The edge cost is cosine distance plus compatibility penalties (BPM jump > 8%: +0.1, non-adjacent Camelot: +0.05). Dijkstra runs with a waypoint count constraint (default: 8 songs). For a freehand curve, the path picks the nearest songs to N evenly spaced points on the curve.
3. **Mode "Playlist":** an ordered list, exportable as M3U and playable in Bragi with automatic crossfades.
4. **Mode "Mix":** creates a **Mix project** (a project with multiple sources). Each song contributes its sections and the transitions are beat-matched (tempo ramps, key-compatible crossfades at outro→intro). The result is editable in the Song Canvas like any song.
5. **Mode "Generate the gaps":** wherever consecutive waypoints are far apart (distance > a threshold), Bragi generates bridging songs (§7.2) at the midpoint.

### 7.2 Generate into empty space
1. The user clicks an empty spot *p* (cursor shows ✨) or uses "Generate something like these" on a lasso selection.
2. Find the k=8 nearest songs to *p* in layout space. Weights = inverse layout distance. Compute the target embedding `e* = normalise(Σ wᵢ·eᵢ)`.
3. **Descriptor extraction:** zero-shot score `e*` against the taxonomy's text embeddings → top genres/moods/descriptors. BPM = weighted median of the neighbours, key/mode = weighted mode.
4. Build a generation request ([09 §4.1](09-generation.md)): text prompt from descriptors, BPM, key and target duration, plus **optional audio style references** (preview snippets of the 1–2 nearest songs) **only if** they are the user's own uploads and the generation model supports audio conditioning (see the policy in [10 §7](10-fusion.md)).
5. Generate 2 candidates → ingest → quick analysis → embed → place via `transform`.
6. The UI animates a **new star being born** at its *actual* position. If the result landed far from *p*, the animation shows it drifting there, with the note "Landed a bit closer to *Late-night synthwave*". **Embedding inversion is approximate**, and the UI is honest about it.

## 8. Rendering (`packages/render-universe`)

- Three.js `WebGPURenderer` with WebGL2 fallback. Points are a single **instanced mesh** (a camera-facing quad per item) with a custom shader: soft glow, size by duration (log), colour from the lens, and twinkle when playing.
- Per-lens positions are uploaded as GPU buffers. The lens morph interpolates on the GPU (a `mix(posA, posB, t)` uniform).
- **Picking:** a spatial index (kdbush in a worker) on 2D positions. In 3D mode, the GPU ID buffer is used.
- **Labels:** MSDF text for cluster names and hovered/selected titles only (never 50k labels).
- **Edges:** line segments in one buffer geometry, rebuilt on filter changes.
- **Budgets:** 50k points + 2k edges at 60 fps on an integrated GPU. Lens morph without frame drops. First paint of a cached library < 300 ms.

## 9. Library import

- Drag a folder or files (or, on desktop, add a **watched folder**). The client reads metadata (ID3/Vorbis/MP4 tags via a JS metadata parser), hashes the files, and uploads in parallel (4 concurrent). Duplicates are detected by hash, and near-duplicates by Chromaprint ([04 §3.1](04-analysis-pipeline.md)), shown as "Possible duplicate" and never auto-deleted.
- Import UX: stars appear one by one as `quick` analysis completes, so the constellation visibly *forms*. A progress pill shows "312 / 500 analysed".
- Background priority. Opening a song bumps it to interactive priority.

## 10. Acceptance checks

1. Importing a 500-song fixture library produces ≥ 5 named clusters, and names contain no artist names.
2. Adding 10 songs to an existing map does not move pre-existing points (incremental `transform`).
3. After a re-fit, the mean point displacement is ≤ 15% of the map diameter (Procrustes alignment works).
4. The text query "piano" returns ≥ 80% results whose `instruments` tags include piano (fixture library).
5. Lens morph runs at ≥ 55 fps average with 50k synthetic points on the CI GPU runner (or in a headless benchmark).
6. "Generate into empty space" produces a song whose embedding is closer to `e*` than the median song in the library (sanity metric, logged).
