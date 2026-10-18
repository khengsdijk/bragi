# @bragi/design

Bragi's design tokens and the accessible component layer: Radix UI primitives wrapped in Bragi's
own tokens (CSS variables + CSS Modules), plus a Storybook to look at them.

Spec: [11 §3](../../specs/11-ux-and-accessibility.md). Owner of this package: **WP-0.6**.

## Tokens

`tokens.json` is the **only** hand-edited token file. `tokens.css` is generated from it and
checked in (with a "do not edit" header); a test regenerates it in memory and fails if the two
differ, so they cannot drift.

```
tokens.json ──tokens:gen──► tokens.css      (DOM UI: CSS variables)
            └──────────────► snapshots/cvd/ (colour-blind proof)
            └──────────────► read directly by the PixiJS/Three.js renderers
```

| Path | What |
|---|---|
| `tokens.json` | fonts, type scale, spacing, radii, sizes, motion, both themes, and the contrast / ΔE00 budgets |
| `tokens.css` | generated; `:root` carries the base plus the dark theme, `[data-theme="light"]` the light theme |
| `fonts.css` | `@font-face` for the self-hosted Geist / Geist Mono subsets |
| `fonts/` | the `woff2` files and their OFL licence |
| `base.css` | tokens + fonts + a minimal reset + focus defaults + the motion policy |
| `snapshots/cvd/` | colour-blind simulation snapshots (JSON + SVG swatch sheet) |

```sh
pnpm --filter @bragi/design tokens:gen      # write tokens.css from tokens.json
pnpm --filter @bragi/design tokens:report   # print every pairing, every ΔE00 minimum, the palette as OKLCH
```

Colours are designed in OKLCH and committed as hex. Tokens are read in the browser as
`var(--token)`; renderers import `@bragi/design/tokens.json`.

## Components

Radix primitives, styled with CSS Modules over the tokens. Every user-facing string is a prop —
the app supplies the copy from `packages/app/src/i18n/en.json` (11 §2). Only stories contain
English text.

| Component | Built on | Notes |
|---|---|---|
| `Button` | `<button>` + Radix `Slot` (`asChild`) | primary / secondary / ghost / danger, 24–40 px, loading spinner |
| `IconButton` | `Button` | `label` is required and becomes `aria-label`; optional tooltip |
| `Slider` | Radix Slider | unipolar; `formatValue` feeds both the readout and `aria-valuetext` |
| `VibeSlider` | Radix Slider | bipolar −1…1, fill from the centre, pointer detent, `0`/`Delete`/`Backspace` reset, required `getValueText` |
| `Popover`, `Menu`, `Dialog`, `Tabs`, `Tooltip`, `Toast` | Radix | thin styled wrappers; Radix keeps the keyboard and focus behaviour |
| `CommandPalette` | Radix Dialog + our ARIA combobox/listbox | no `cmdk` dependency |
| `Chip` | `<span>` / `<button>` | optional role swatch or section fill; the text always carries the meaning |
| `Icon` | inline `<svg>` | a 1em glyph that scales with the font; decorative, the label lives on the control |

Every control is at least a 24 × 24 px target (11 §6.4, WCAG 2.5.8), sizes are in `rem` so they
grow with the user's text size, and the focus ring is one shared token checked against every
surface it can land on.

## Checks

`pnpm --filter @bragi/design test` runs both halves of the verification:

1. **Vitest** — the colour maths (WCAG contrast, Machado simulation, CIEDE2000 against Sharma's
   reference pairs), every declared contrast pairing in both themes, coverage (no colour token
   without a pairing), the CVD snapshots, `tokens.css` freshness, and behaviour/ARIA tests for
   every component.
2. **axe over every story** (`scripts/axe-stories.mjs`) — builds Storybook, serves it, opens each
   story in both themes and fails on any serious or critical violation. The report also lists
   what axe could not decide.

`pnpm --filter @bragi/design storybook` opens the workshop; the theme toolbar switches dark/light.
