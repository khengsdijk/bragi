# 11 — UX, Design System & Accessibility

Status: Draft v0.2 · Code: `packages/design/`, `packages/app/src/features/onboarding/`

## 1. Experience pillars

1. **Curiosity over competence.** The first minute should feel like discovering something, not like learning a tool.
2. **Safe to play.** Nothing breaks, everything is undoable, and the original is always there.
3. **Talk like a musician friend, not an engineer.** Plain language everywhere, with expert detail one click away.
4. **The music is the interface.** Visuals react to sound (glow, pulse, motion), so seeing and hearing reinforce each other.

## 2. Language guide

The UI uses Bragi words by default. Expert mode (§5) shows technical terms in parentheses or replaces them.

| Technical term | Bragi word (Simple mode) |
|---|---|
| Stem / track | **Instrument** (e.g. "Drums", "Vocals") |
| Arrangement | **Song layout** |
| Section | **Part** (Intro, Verse, Chorus…) |
| Reverb / width | **Space** |
| EQ (high/low) | **Brighter / Darker**, **Warmth** |
| Compression / transient shaping | **Punch** |
| Saturation | **Warmth / Grit** |
| Automation | **Changes over time** |
| Mixdown / bounce | **Export song** |
| Time-stretch | **Change speed** |
| Transpose | **Change key / Higher / Lower** |
| Inpainting | **Fill the gap** |
| Separation artifacts | **Rough edges** ("✨ Clean up rough edges") |
| Candidate / variation | **Version idea** |
| Commit / version | **Version** |

Copy rules: second person, present tense, ≤ 12 words for labels and tooltips, no exclamation marks except celebratory moments, and never blame the user ("We couldn't find chords in this song", not "Invalid input").

## 3. Visual language (design tokens)

Tokens in `packages/design/tokens.json` are the single hand-edited source; `packages/design/tokens.css`
is generated from it for the DOM UI (CSS variables) and the file itself is what the PixiJS/Three.js
renderers read. Regenerate with `pnpm --filter @bragi/design tokens:gen`; `tokens:report` prints every
contrast pairing, every ΔE00 minimum and the palette as OKLCH. Colours are designed in OKLCH and
committed as hex.

- **Dark-first** theme (the canvas glows best on dark), with a full light theme. Both themes are
  complete: `:root` carries the dark values, `[data-theme="light"]` the light ones.
- **Typography:** **Geist** (UI, variable `wght` 100–900) plus **Geist Mono** (times, BPM and values,
  tabular figures), both SIL OFL 1.1, self-hosted as `woff2` (latin + latin-ext) in
  `packages/design/fonts/` with the licence file next to them — no remote font loading (strict CSP,
  [01 §10](01-architecture.md)). Pending the owner's sign-off (Q8 in [15](15-open-questions.md));
  swapping a family is a token change plus a file swap. Base size 14 px (`0.875rem`), scale 1.2, five
  steps (`xs`, `base`, `lg`, `xl`, `2xl`), all in `rem` so text follows the user's font size (200 %).
- **Instrument role colours** (final, both themes). Colour is never the only carrier: every role also
  has a paper pattern for the ribbon texture ([07 §2](07-song-canvas.md)) and a name in the lane header.

| Role | Dark | Light | Pattern |
|---|---|---|---|
| Vocals | Coral `#FB766A` | `#822A35` | Smooth |
| Drums | Amber `#FFAB46` | `#A44B20` | Dotted grain |
| Bass | Violet `#9778F5` | `#5D3DDB` | Thick solid |
| Guitar | Green `#6AD987` | `#327122` | Fine hatching |
| Piano | Ice `#8FE1FF` | `#005D95` | Light dots |
| Synth / Other | Magenta `#DB5FD3` | `#6A3373` | Wave texture |
| Strings | Teal `#29B5A8` | `#007E6B` | Long strokes |
| Generated | Gold `#F3DF83` + sparkle edge | `#674700` | Sparkle |
| Residual / FX | Slate `#808693` | `#676D79` | Faint |

  `StemRole` has more members than the table: `other` uses the Synth colour, `fx`, `full_mix` and
  `recorded` use the residual slate until they need a hue of their own ([02 §3.4](02-song-model.md)).

- **Section kind hues** are a separate, calmer palette, always shown with text labels. Six families
  cover the thirteen `SectionKind` values ([02 §3.5](02-song-model.md)): **neutral** (intro, outro,
  solo, interlude, custom), **blue** (verse), **warm** (chorus, pre-chorus, post-chorus), **purple**
  (bridge), **red-orange** (drop, build) and **teal** (breakdown). The label sits on the fill: the dark
  theme uses light fills with a dark label, the light theme dark fills with a light label, and the
  label's contrast is checked against every fill.

| Family | Dark fill | Light fill |
|---|---|---|
| Neutral | `#D4D7DE` | `#3A3D44` |
| Blue | `#A5CCF4` | `#085491` |
| Warm | `#FAC597` | `#8C4500` |
| Purple | `#AC9BE0` | `#482584` |
| Red-orange | `#F09080` | `#8D0E04` |
| Teal | `#81C6C1` | `#00726D` |

- **Energy gradient** (skyline): deep blue → cyan → yellow → orange → hot pink. The skyline is an
  essential graphic, so every stop is checked at 3:1 against the canvas; the light theme's stops are
  therefore deep (`#3054AE` → `#B51C79`) rather than bright, and its low stop stays brighter than a
  naive "deep blue" so the line stays perceivable in both themes.

| Stop | Dark | Light |
|---|---|---|
| 1 (low) | `#5680E6` | `#3054AE` |
| 2 | `#17D0D8` | `#00848B` |
| 3 | `#FCD948` | `#9E840A` |
| 4 | `#FF8F31` | `#9F3E00` |
| 5 (high) | `#FB40AD` | `#B51C79` |

- **Colour is never the only carrier of meaning.** Every colour-coded element also has a label, glyph
  or pattern. The palettes are checked under deuteranopia, protanopia and tritanopia (Machado et al.
  2009, severity 1.0): a CIEDE2000 minimum per group and vision is declared in `tokens.json` and
  asserted by `pnpm --filter @bragi/design test`, which also writes the simulation snapshots in
  `packages/design/snapshots/cvd/`.
- **Contrast** is declared, not assumed: `tokens.json` lists which token pairs must meet which ratio
  (text 4.5:1, essential graphics 3:1), the check iterates that list in both themes, and a second test
  fails if a colour token has no pairing. The focus ring is drawn with an offset, so it is checked
  against the surfaces behind a control rather than against the control's own fill.
- **Motion:** 150–250 ms UI transitions, 600 ms for lens morphs and zoom transitions, spring easing
  for drag. Music-reactive motion (ribbon glow, star twinkle) is subtle. With
  `prefers-reduced-motion` **or** the reduced-motion setting ([§9](#9-settings-v1), which sets
  `data-motion="reduced"` on `<html>`), reactive motion is off, transforms are dropped and what
  remains reads as a cross-fade.

## 4. Onboarding (first run)

1. **Welcome:** one screen with "Drop a song to see inside it" and a big drop zone. A secondary button says "Try with a demo song". Demo songs are licence-clean: made for Bragi or CC0, and stored in `fixtures/demo/` with licence notes.
2. **Song comes alive:** progressive analysis ([07 §8](07-song-canvas.md)) with a one-line coach mark per stage ("These are the parts of your song", "Each ribbon is an instrument. Click one to hear it alone").
3. **Three quests** (dismissible checklist, bottom-left):
   - "Hear just the vocals" (solo a ribbon)
   - "Make it longer" (drag the extend handle, accept a version idea)
   - "Make the bridge calmer" (drag the skyline, or lasso + "calmer")
4. **Unlock the Universe:** after the first song, a prompt says "Add more music to see how your songs connect". From 5 songs on, the Universe shows clusters.
5. Onboarding state is stored per account. It can be replayed from Help.

## 5. Modes

| | Simple (default) | Expert (toggle in the top bar) |
|---|---|---|
| Labels | Bragi words | Technical terms |
| Values | Sliders without numbers | dB, Hz, ms, %, bar:beat:tick |
| Inspector | Vibe sliders, swap, regenerate | + full fx chain, raw params, clip properties, warp anchors |
| Lanes | Ribbons | Ribbons or waveforms (setting) |
| History | Simplified (analysis collapsed) | Full commit tree with op details |
| Export | Song / instruments | + format options, normalisation, DAW bundle details |

## 6. Accessibility (target: WCAG 2.2 AA for all DOM UI, with equivalent access for canvas content)

### 6.1 Canvas accessibility model
PixiJS and Three.js canvases are invisible to assistive tech, so each canvas has a **parallel accessible DOM structure** (visually hidden, kept in sync from the same store):
- **Song Canvas:** an ARIA `grid`. Rows are "Song layout" (sections) and one row per instrument. Columns are sections. Each cell exposes the section name, bars, energy ("high energy"), and whether the instrument is playing there. Chords are exposed per section as text.
- **Universe:** an ARIA `tree` of clusters → songs, plus a "Nearby songs" list for the focused song (its constellation neighbours with relationship labels).
- Focus in the accessible DOM drives a **visible focus ring** drawn on the canvas, and vice versa.

### 6.2 Keyboard
- Every action has a keyboard path: arrow keys move between sections/lanes, `Enter` selects, `Shift+Arrows` extends the selection to a region, `Cmd/Ctrl+K` opens the command palette (all commands, searchable), `/` focuses the prompt bar, and `Esc` cancels.
- **Drag alternatives:** moving sections (`Alt+←/→`), resizing (`Alt+Shift+←/→` by bar), setting energy targets (`Alt+↑/↓` on a focused section), and painting (select a region, then "Apply brush…" from the menu).

### 6.3 Screen readers
- Live region announcements for state changes: "Chorus 2 moved after Verse 3", "3 version ideas ready, playing idea 1", "Analysis complete: 9 parts, 6 instruments found".
- "Describe this song" reads the generated description. "Explain" output is plain text.
- Transport state and playhead position are announced on request (`T`), not continuously.

### 6.4 Other needs
- Text scales to 200% without loss of function. The canvas lanes grow in height accordingly.
- Hit targets ≥ 24×24 px (WCAG 2.5.8). Section edges have enlarged invisible handles (12 px).
- Contrast: text ≥ 4.5:1, essential graphics ≥ 3:1, verified by automated checks on tokens.
- For hearing-impaired users: meters and ribbon glow show sound visually, and lyrics act as captions where available.
- No time limits on interactions. Flashing content is limited to fewer than 3 flashes per second (the star twinkle respects this).

### 6.5 Testing
- `axe-core` in Playwright for every route (0 serious or critical violations).
- Keyboard-only e2e scripts for the three onboarding quests.
- Manual VoiceOver (macOS) and NVDA (Windows) passes before each phase release.

## 7. Input devices and screen sizes

- **Minimum supported viewport:** 1024 × 700. Below that, the app shows a "Best on a larger screen" notice but remains usable in read-only mode.
- **Tablet (landscape) with touch:** pinch to zoom, two-finger pan, long-press for the context menu, and **Apple Pencil / stylus pressure** for brush strength.
- **Trackpad:** pinch zoom, two-finger horizontal pan through time.
- **MIDI controllers:** out of scope for v1.

## 8. Feedback, errors and waiting

- Long operations show **what is happening in words** ("Separating instruments… about 20 seconds") with a progress ring on the affected element, not a global spinner.
- Errors are inline at the place of action, with a retry option and a plain explanation. Technical details are behind "Details".
- Credits: every AI action shows its cost on hover ("Uses 2 credits"). When credits are low, a calm banner offers the free daily refill time.
- Offline: a small indicator. AI buttons are disabled with the tooltip "Needs internet". Editing and playback continue.

## 9. Settings (v1)

Audio output device and buffer size (desktop), theme, mode (Simple/Expert), smart transitions on/off, auto-run AI plans on/off, number of version ideas (1–3), Learn mode, reduced motion override, library folders (desktop), compute server URL (desktop, [05 §10](05-backend-and-jobs.md)), privacy (analytics opt-in), account and export-all-data.

## 10. Product analytics (opt-in only)

Events: onboarding quest completion, time-to-first-play, AI candidate accept/discard rates per capability, undo frequency after AI edits (a signal of bad edits), and feature discovery. No audio, lyrics, prompts or titles are collected unless the user opts into "Help improve AI edits", which is separate and explicit.
