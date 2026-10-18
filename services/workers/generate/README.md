# bragi-generate

Generation and transformation ([09-generation.md](../../../specs/09-generation.md),
[10-fusion.md](../../../specs/10-fusion.md)): `generate.extend`, `generate.inpaint`,
`generate.stem`, `generate.fx`, `text2music`, `stem_resynth`, timbre swap and style transfer,
behind the `GenerationBackend` adapter and its routing table.

Two rules carry over into every capability here:

- **Quality gates first.** Nothing is offered to the user before `postprocess.py` passes it
  ([09 §5](../../../specs/09-generation.md)).
- **The content policy is binding** ([10 §7](../../../specs/10-fusion.md)): no voice cloning of
  real people, artist names become descriptors, and generated audio is watermarked where the
  backend supports it.

**Status:** scaffold. Built from **WP-2.7** onwards (model bake-off → ADR-0004).
