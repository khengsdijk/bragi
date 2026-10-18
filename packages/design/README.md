# @bragi/design

Design tokens and the accessible component layer: Radix UI primitives wrapped with Bragi's own
tokens (CSS variables + CSS Modules), plus icons.

Planned contents ([11 §3](../../specs/11-ux-and-accessibility.md)):

- `tokens.css` + `tokens.json` — colour, type, spacing, radii, motion; the role and section
  colours and the energy gradient.
- Components: Button, IconButton, Slider (including the bipolar vibe slider), Popover, Menu,
  Dialog, Tabs, Tooltip, Toast, CommandPalette, Chip.
- A component workshop (Storybook or Ladle) with a story per component.

Every token pairing must pass contrast checks by script, and colour-blind simulation snapshots
exist for the role and section palettes. axe passes on all stories.

**Status:** scaffold only. Filled by **WP-0.6**.
