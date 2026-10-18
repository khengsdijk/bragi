# Fonts

**Geist** (UI) and **Geist Mono** (times, BPM and values), self-hosted. Chosen in WP-0.6 and
recorded as a proposal in [`specs/15-open-questions.md` Q8](../../../specs/15-open-questions.md)
— pending the owner's sign-off. Swapping either family is a token change (`font.sans` /
`font.mono` in `../tokens.json`) plus a file swap here.

## Why self-hosted

No remote font loading: a strict CSP ([01 §10](../../../specs/01-architecture.md)) and the
desktop build must render identically offline. The files are part of the repository, so the
first paint never waits on a third-party host.

## Files

| File | Family | Weight | Subset |
|---|---|---|---|
| `geist-latin.woff2` | Geist | 100–900 (variable) | Latin |
| `geist-latin-ext.woff2` | Geist | 100–900 (variable) | Latin Extended |
| `geist-mono-latin.woff2` | Geist Mono | 100–900 (variable) | Latin |
| `geist-mono-latin-ext.woff2` | Geist Mono | 100–900 (variable) | Latin Extended |

96 KB in total. `../fonts.css` declares the four `@font-face` rules with the matching
`unicode-range`, so a browser only fetches the subset it needs.

- Version: Geist v5 / Geist Mono v6, as served by Google Fonts (`fonts.gstatic.com`), fetched
  2026-10-18.
- SHA-256 of the committed files:

```
9b6f5ff45b278c744b5f379a2c4ecbaf858a842b8eaf82ac8d21b699ca16c608  geist-latin.woff2
58a6b173d5ca1dec92166ea3c6cb1a84a4144556d10928ac14e8e6b40e4787bd  geist-latin-ext.woff2
5f3d6ad60f29d6cb708414ec6887163d63bf197377ef5417d2483ff31ace6c3b  geist-mono-latin.woff2
745994b5cd950ec201b66526375f057d540847cccfc70f4f24f5f571d26d3923  geist-mono-latin-ext.woff2
```

## Licence

SIL Open Font License 1.1 — full text in [`OFL.txt`](./OFL.txt), next to the fonts as the
licence requires. Copyright 2024 The Geist Project Authors
(<https://github.com/vercel/geist-font>). Both families ship under the same licence text
(`ofl/geist` and `ofl/geistmono` in the Google Fonts repository are identical).

OFL permits bundling and self-hosting, including in a commercial product. The reserved font
name must not be reused for a modified version, so if the files are ever subset further, the
result keeps the `Geist` name only if the outlines are unchanged (subsetting with the original
`unicode-range` values, as here, does not modify the outlines).
