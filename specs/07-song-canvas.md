# 07 — Song Canvas (single-song editor)

Status: Draft v0.2 · Code: `packages/app/src/features/song/`, `packages/render-canvas/`

The Song Canvas is where a song becomes visible and editable. It covers zoom levels **L2 (Song)** and **L3 (Moment)** from [00 §4](00-vision.md).

## 1. Layout

```
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│ ◀ Universe   Midnight Drive ✎     [118 BPM] [F# minor] [4:00]   synthwave · nostalgic · driving │  Top bar
├───────────────────────────────────────────────────────────────────────────────┬───────────────┤
│  ▁▂▃▅▇██▇▅▃▂▁▂▃▅▇███▇▆▅▄▃▄▅▇██████▇▅▃▁                                         │  INSPECTOR    │  Energy skyline
│ ┌──────┬────────────┬──────┬────────────┬──────┬────────┬──────────────┬─────┐│  CHAT         │
│ │Intro │  Verse 1   │Chorus│  Verse 2   │Chorus│ Bridge │  Chorus  ×2  │Outro││  HISTORY      │  Section blocks
│ └──────┴────────────┴──────┴────────────┴──────┴────────┴──────────────┴─────┘│               │
│  i   VI │ i  VI  III VII │VI VII i│ ...                                        │  (tabbed      │  Harmony strip
│ ═══════════════════════════ Vocals ═══════════~~~~~~══════════════            │   right       │  Instrument ribbons
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ Drums ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓            │   panel,      │
│ ████████████████████████ Bass ██████████████████████████████████            │   collapsible)│
│ ░░░░░░░░░░░░░░░░░░░ Synths ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░           │               │
│ ∙∙∙∙∙∙∙∙∙ Piano ∙∙∙∙∙∙∙                                   ∙∙∙∙∙∙∙∙∙∙∙∙∙∙∙∙   │               │
│  ♪ lyrics line (deep profile only) ♪                                          │               │  Lyrics lane
│  ┊minimap ▕████▏                                                    ⟶ extend  │               │  Minimap + extend handle
├───────────────────────────────────────────────────────────────────────────────┴───────────────┤
│ ⏮ ▶ ⏭  01:12.4 / 04:00   🔁 loop   ── zoom ──   Tools: ⬚ Select ◌ Lasso 🖌 Paint ✂ Split   ⚙   │  Transport + tools
└───────────────────────────────────────────────────────────────────────────────────────────────┘
          (when AI candidates exist, the Audition bar slides up above the transport, §6)
```

The canvas area (skyline → minimap) is **one PixiJS stage**. Everything else is React. All lanes share one horizontal time axis.

## 2. Visual encoding

| Element | Encodes | Spec |
|---|---|---|
| **Energy skyline** | Energy curve (0..1) | Filled area, 48 px tall, smoothed (Catmull-Rom). Gradient from cool (low) to warm (high) colours. Shows the drawn `energyTarget` as a dashed line when it differs from the current energy. |
| **Section blocks** | Sections | Width = duration. Fill hue by `SectionKind` (design tokens, [11 §3](11-ux-and-accessibility.md)). Fill brightness by mean energy. Sections in the same `repeatGroup` share a small glyph (◆, ●, ▲) so repeats are recognisable. Locked sections show a padlock. |
| **Harmony strip** | Chords | 20 px band. Each chord is a segment: hue = root on the circle of fifths (so related keys look related), lightness = major (light) or minor (dark), saturation drop = diminished/suspended. A thin outline glow marks tension (chords far from the tonic). Labels (`F#m`, or roman numerals in Learn mode) are shown when they fit. |
| **Instrument ribbons** | Stems | One per visible track. **Thickness** = short-term RMS envelope (from peaks). **Colour** = role colour. **Texture** = timbre: brightness (spectral centroid) modulates ribbon lightness, and noisiness (spectral flatness) adds grain. Ribbons fade to a thin line where the stem is inactive. Generated clips show a subtle sparkle edge, and AI-modified regions show a dotted underline. |
| **Beat grid** | Bars/beats | Faint vertical lines. Bar numbers appear on hover in the top ruler. Hidden in free-time mode ([04 §10](04-analysis-pipeline.md)). |
| **Playhead** | Position | Bright vertical line. Ribbons "glow" at the playhead, with intensity driven by live meters. |
| **Lyrics lane** | Words | Shown only if lyrics exist. Words highlight karaoke-style while playing. |

### 2.1 Semantic zoom (L2 → L3)
| Zoom (px per beat) | Level | What changes |
|---|---|---|
| < 4 | L2-far | Ribbons simplified to bands, section labels only |
| 4–24 | L2 | Full encoding as above |
| 24–64 | L2-near | Chord labels always visible, clip boundaries shown, drum hits visible as ticks on the drum ribbon |
| ≥ 64 | **L3 Moment** | Ribbons expand to waveform lanes (min/max peaks). Toggle for spectrogram view per lane. Note lanes appear if transcription exists. Onset markers. |

Zooming is continuous (pinch, ctrl/cmd + scroll, or zoom slider), and the transition between levels is animated (ribbons morph into waveforms). Zoom is anchored at the cursor.

## 3. Tools

| Tool | Key | Default gesture |
|---|---|---|
| **Select / Move** (default) | `V` | Click selects section/ribbon/clip. Drag moves sections. |
| **Lasso** | `L` | Draw a free shape over time × ribbons → bounding `Region` → prompt bar |
| **Paint** | `B` | Choose a brush, paint over ribbons |
| **Split** | `S` | Click a section block to split at the nearest bar, or click a clip at the nearest beat |
| **Erase** | `E` | Drag over a region → clears it, with an option to "fill with AI" |
| **Explain** | `?` | Click anything → explanation popover |

Global shortcuts: `Space` play/pause, `Enter` play from selection, `Cmd/Ctrl+Z` / `Shift+Cmd/Ctrl+Z` undo/redo (moves HEAD), `Cmd/Ctrl+K` command palette, `1–4` audition candidates, `0` original, `A` accept candidate, `M`/`O` mute/solo the hovered ribbon, `+`/`−` zoom, `F` fit song.

## 4. Interactions (normative)

Each interaction lists **gesture → live preview → committed result**. The preview never mutates the document ([01 §5](01-architecture.md)).

### 4.1 Rearranging sections
- **Drag a section block** horizontally. Preview: the block lifts (shadow), other blocks part to show the drop slot, and audio follows the new order if playing (`setPreview.moveSection`). Commit: `section.move`. If the user's "smart transitions" setting is on (default), the affected boundaries become 1-beat crossfades. A "✨ Smooth with AI" chip appears on each new boundary and offers a `generate.transition` job ([09 §4.4](09-generation.md)).
- **Alt/Option-drag** duplicates (`section.duplicate`).
- **Delete/Backspace** on a selected section removes it (`section.remove`) with the same transition smoothing.
- **Right-click a section** opens a menu: Duplicate, Remove, Rename, Change type, Lock from AI, Loop this, Make longer…, Make shorter…, Regenerate…, Explain.

### 4.2 Resizing and extending
- **Drag a section's right edge.** The popover on release asks "How should it get longer?": **Loop** (repeat bars), **Stretch** (slower), or **✨ Continue with AI** (generate new bars in style). Shortening offers **Trim** or **✨ Condense** (AI re-composes a shorter version). The ghost preview shows the bar count ("+8 bars").
- **Extend handle at song end (⟶):** drag right to reveal a "future" zone with a bar counter. On release: `generate.extend` with 3 candidates for the requested length. Max per drag is 3 minutes. For longer lengths, Bragi suggests long-form mode ([09 §4.5](09-generation.md)).
- **Extend handle at song start:** same, for generating an intro.
- **"+" between sections** (appears on hover in gaps): "Insert…" → Bridge, Breakdown, Build-up, Drop, Instrumental break, or a custom prompt. Each is a generation job conditioned on both neighbours.

### 4.3 Lasso + prompt
1. Draw the lasso over any combination of time and ribbons. It snaps to beats (to bars if the lasso spans more than 2 bars). Hold `Alt` to disable snapping.
2. The **prompt bar** appears anchored to the selection: a text field plus **suggestion chips** generated locally from the region context, e.g. for drums: "Half-time", "More lo-fi", "Add fill", "Quieter", "Replace with live drums", "Remove". For vocals: "Add harmony", "More reverb", "Remove", "Double it".
3. Submitting calls the planner ([06](06-ai-planner.md)). While waiting, the region pulses. The `interpretation` text appears in the prompt bar ("I'll…").
4. Candidates arrive in the Audition bar (§6).

### 4.4 Paint brushes
Brushes are painted directly onto ribbons. The stroke defines a region (time × the tracks touched). **Strength** is set by pen pressure, by the scroll wheel while painting, or by the brush size slider, and shown as stroke opacity.

| Brush | Effect | Implementation |
|---|---|---|
| Space | More reverb/width | Automation on `space` macro fx (instant) |
| Warmth | Saturation + low-mid lift | Macro automation (instant) |
| Brighter / Darker | Tone | `brightness` macro automation (instant) |
| Lo-fi | Tape/vinyl colour | Clip-level `lofi` fx in the region (instant) |
| Louder / Quieter | Level | Gain automation (instant) |
| Filter sweep | Rising/falling filter across the stroke direction | Filter cutoff automation following the stroke (instant) |
| Remove | Silence this part of the stem | `region.clear` with fades (instant) |
| ✨ Shimmer | Airy octave-up reverb tail | `generate.fx` layer (job) |
| ✨ More drums | Extra percussion layer | `generate.stem` drums, layered (job) |
| ✨ Riser / Impact | Transition FX at stroke end | `generate.fx` placed on a new FX track (job) |

Instant brushes commit on stroke end as one op batch. ✨ brushes go through candidates. Automation from brushes uses 50 ms ramps at the stroke edges.

### 4.5 Ribbon (track) actions
Clicking a ribbon selects it and opens the **Inspector**:
- Solo, mute, volume, pan.
- **Vibe sliders** for that track: Darker↔Brighter, Dry↔Spacious, Soft↔Punchy, Clean↔Warm, Modern↔Vintage, Close↔Distant ([03 §6.1](03-audio-engine.md)).
- **Swap instrument…**: grid of target timbres (Rhodes, grand piano, nylon guitar, strings, choir, synth pad, 8-bit, music box, brass…, plus free text) → `transform.timbre` job → candidates.
- **✨ Regenerate this part**: new performance of the same role, conditioned on the other stems.
- **✨ Clean up**: stem resynthesis to remove separation artifacts ([09 §4.6](09-generation.md)).
- Expert drawer: the full fx chain with raw parameters.

### 4.6 Energy skyline editing
- Hover the skyline to reveal one draggable handle per section (at its mean energy) and a freehand draw mode (hold `D`).
- Drag handles up or down to set `energyTarget`. The dashed target line shows the result. On release, the skyline compiler runs ([06 §6](06-ai-planner.md)) and produces up to 2 candidates ("Mix only", "Re-arranged").

### 4.7 Global musical controls
- **BPM chip:** drag or type → `tempo.set` (time-stretches everything, preview tier first). Options are "Change speed" and "Keep speed, just re-grid", the latter for fixing a wrong detection.
- **Key chip:** "Transpose ±n semitones" → `key.transpose`, or "Fix detected key".
- **Title/tags:** editable inline (`project.set_meta`).

### 4.8 Erase & fill
Erase a region (any tracks). A floating chip offers **✨ Fill gap**: `generate.inpaint` with context before and after → candidates. Without fill, the gap stays silent (with fades).

### 4.9 Explain mode
In explain mode, clicking a point or section requests an Explanation ([06 §8](06-ai-planner.md)). The popover shows text, and the canvas highlights the referenced regions. **Learn mode** (a toggle in settings) shows roman numerals, section function hints, and an occasional "Did you notice…?" tip during playback, with at most one tip per minute.

## 5. Selection model

- Selection is one of `{ sections: SectionId[] } | { tracks: TrackId[] } | { clips: ClipId[] } | { region: Region }`.
- It is serialised in the URL search params (`?sel=`) so links and history preserve it.
- The command palette and prompt bar always act on the current selection, or on the whole song if nothing is selected (with a clear "Whole song" label).

## 6. Audition bar (AI candidates)

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│ "Half-time drums in Verse 2"     [0 Original] [1 Lo-fi only ●HQ] [2 Half-time feel ◐preview] │
│                                   [3 Stripped ●HQ]     ⟳ More like 2   ✕ Discard   ✓ Accept │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```
- Opening the bar auto-loops the affected region plus 2 bars of context on both sides and starts playback.
- Pressing `0–3` switches instantly via the engine's warm plans ([03 §5.4](03-audio-engine.md)). The canvas shows the selected candidate's ribbons, with changed areas outlined.
- Each candidate shows a status: `queued`, `generating n%`, `preview`, or `HQ`. Accepting a preview candidate commits immediately and swaps in the HQ asset when ready, which is a background re-apply with the same clip IDs.
- **More like this** creates a new candidate group seeded from the chosen candidate's params.
- **Discard** marks all candidates discarded and returns to HEAD.
- Only one candidate group is active at a time. Starting a new AI action while one is open asks the user to accept or discard first.

## 7. History panel (version tree)

- A vertical tree of commits: nodes are labelled with the batch label and an author icon (👤 user, ✨ AI, ⚙ system). Discarded candidates appear faded.
- Clicking a node checks it out (moves HEAD). Editing from a non-tip node creates a branch, and the user can name branches.
- **Compare:** select two nodes and then **A/B** them in the audition bar, which reuses the audition machinery.
- **Take this part from…**: with a region selected, choose a node → `region.adopt`.
- Star a version (pins it and protects it from GC).
- Analysis commits are collapsed into one "Analysis" node by default.

## 8. Progressive states (song comes alive)

| Available | What the canvas shows |
|---|---|
| ingest | Single "Full song" block, waveform ribbon of the full mix, playable |
| + rhythm | Beat grid, BPM chip, bar ruler |
| + loudness_energy | Energy skyline fades in |
| + structure | Block splits into labelled sections with an animated "crack" |
| + separation | Full-mix ribbon splits into stem ribbons (animated "unweave") |
| + harmony | Harmony strip and key chip fill in |
| + tags/describe | Tag chips, plus a description card in the Inspector ("About this song") |

Each pending item shows a subtle shimmer placeholder, not a spinner. Editing is allowed from the first state. The model handles late-arriving analysis ([02 §6](02-song-model.md)).

## 9. Rendering architecture and performance

- **PixiJS v8** application with `preference: "webgpu"`, falling back to WebGL2. Layers (z-order): grid → skyline → section blocks → harmony → ribbons → overlays (selection, lasso, brush strokes, highlights) → playhead.
- Ribbons are built as **triangle-strip meshes** from envelope arrays (one vertex pair per envelope bin at the current LOD). Timbre texture is a shader uniform per segment, not per-pixel analysis at runtime.
- **LOD:** envelope and peak data are chosen from the pyramid ([03 §10](03-audio-engine.md)) so that there are about 1–2 bins per pixel. Offscreen geometry is culled and only meshes in the viewport ± 1 screen width are kept.
- **No React in the render loop.** The renderer subscribes to store slices and the engine state. React renders panels, popovers and the prompt bar as DOM overlays positioned from the renderer's coordinate system.
- **Budgets:** 60 fps while playing and zooming on a 2020-era integrated GPU, a 10-minute song with 12 ribbons, and a frame time ≤ 8 ms for rendering. Opening a cached project shows a first canvas in < 500 ms.
- Text uses MSDF bitmap fonts for crisp labels at any zoom. *(WP-1.9 uses pooled Pixi `Text` at the device pixel ratio instead; see Q50.)*

**As built in WP-1.9** (clarifications, not contract changes):
- Ribbons and the skyline are meshes/polygons built **in world space** at a level of detail and moved/scaled by their container, so pan and zoom cost a transform; they are rebuilt when the zoom leaves a factor-of-two band or the viewport leaves the built window, at most three ribbons per frame. Timbre is a 3-row texture per ribbon (Q51).
- The renderer is `render-canvas`'s `SongCanvas`: data in (`CanvasDocument`, `AnalysisView`), events out (`selectionChange`, `seek`, `trackToggle`, `viewportChange`, `hoverTrack`, `contentHeight`, `sectionContextMenu`, and the `sectionDrag*` / `sectionResize*` gestures). Solo/mute leave as `trackToggle` and become one `track.update` batch in the Song Store.
- Bar numbers on the ruler are always drawn where they fit (not only on hover). Dragging on the time area pans. Section drags (§4.1-4.2) start after a 4 px threshold; the body moves (Alt duplicates), the 12 px right-edge handle resizes with a bar-count ghost, and the app renders `preview ?? doc` in both the canvas and the accessible grid while a gesture runs (WP-2.2).
- The `sel` URL parameter is `s:<ids>`, `t:<ids>`, `c:<ids>` or `r:<startTick>-<endTick>:<ids|*>` (`render-canvas/src/selection.ts`).

## 10. Acceptance checks (for work packages)

1. Reordering Chorus 2 before Verse 2 updates audio while dragging (if playing) and commits a single `section.move` batch. Undo restores the exact previous document (deep-equal).
2. Lasso across 2 ribbons × 4 bars produces a region snapped to bar boundaries containing exactly those 2 track IDs.
3. An instant paint brush stroke produces one commit with automation points whose ramps are ≥ 50 ms at the edges.
4. Audition switching between 4 warm plans has no gap or click (verified by render capture: no sample discontinuity > −40 dBFS step at the switch).
5. With WebGPU disabled, all lanes render identically (visual regression snapshots within tolerance).
6. All tool actions are reachable via keyboard and the command palette ([11 §6](11-ux-and-accessibility.md)).
