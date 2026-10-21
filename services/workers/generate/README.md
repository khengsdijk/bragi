# bragi-generate

Generation and transformation ([09-generation.md](../../../specs/09-generation.md),
[10-fusion.md](../../../specs/10-fusion.md)): `generate.extend`, `generate.inpaint`,
`generate.stem`, `generate.fx`, `text2music`, `stem_resynth`, timbre swap and style transfer,
behind the `GenerationBackend` adapter and its routing table.

Two rules carry over into every capability here:

- **Quality gates first.** Nothing is offered to the user before it passes the `postprocess/`
  package ([09 §6](../../../specs/09-generation.md)): sanity, tempo conform, key check, beat align,
  splice search, loudness/spectral match and the final seam score, all on CPU without the `models`
  group. Thresholds are in `config/generation_gates.toml`.
- **The content policy is binding** ([10 §7](../../../specs/10-fusion.md)): no voice cloning of
  real people, artist names become descriptors, and generated audio is watermarked where the
  backend supports it.

**Status:** scaffold plus the quality gates (WP-2.7 B). Backends and `generate.extend` land with
WP-2.7 A.
