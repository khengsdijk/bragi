# ADR-0002 — Time-stretch / pitch-shift implementation

- **Status:** Proposed (awaiting the owner's listening check, [`docs/wp/0.4-MANUAL_CHECKS.md`](../../docs/wp/0.4-MANUAL_CHECKS.md))
- **Date:** 2026-10-18
- **Decider:** Koen
- **Work package:** WP-0.4 · **Open question:** [Q1](../15-open-questions.md)

## Context

[03 §7](../03-audio-engine.md) needs a `Stretcher` behind a trait, used during playback
(preview, real-time) and in offline renders (high quality). It must compile to `wasm32-unknown-unknown`
and run in an AudioWorklet, must not allocate on the audio thread, and must be an exact
pass-through at ratio 1.0 so un-warped clips are bit-identical ([03 §7](../03-audio-engine.md),
[03 §11](../03-audio-engine.md)).

WP-0.4 evaluates the three candidates named in the spec — Signalsmith Stretch, a pure-Rust phase
vocoder, and Rubber Band — and lands the trait with at least one real implementation.

## Options considered

| # | Candidate | Verdict |
|---|---|---|
| 1 | **Pure-Rust phase vocoder** (`bragi-dsp::stretch::PhaseVocoder`) | **Chosen as the always-present implementation.** Zero build risk, compiles to every target including `wasm32-unknown-unknown` with no toolchain beyond `rustc`, allocation moved to the constructor. |
| 2 | **Signalsmith Stretch** (C++, via the `signalsmith-stretch` crate) | **Built and benchmarked natively; held for offline `Render` pending the listening check.** Native build works (needs a C++ compiler + libclang). Quality and CPU are on par with the vocoder on the drum fixture. The wasm build is possible but costly — see below — so it is kept in the lab, not shipped. |
| 3 | **Rubber Band** | **Not built yet; a candidate for the quality bake-off.** |
| 4 | `timestretch` (crates.io, pure-Rust SOLA keylock) | Considered as the "existing crate" baseline. It is a SOLA engine (no pitch shift), fixates window sizes and its own latency, and does not accept the pull model; a 0.15.x single-maintainer crate is more surface than the ~400 lines of vocoder we control. Not adopted. |
| 5 | `cute-dsp` (0.0.x pure-Rust port of the Signalsmith DSP library) | Considered. It is an unreleased 0.0.x port with no stability promise; adopting it trades the C++ toolchain for an unfinished dependency. Not adopted. |

### Signalsmith on `wasm32-unknown-unknown`

Recorded while writing the plan and re-confirmed by building it natively in this WP: the
`signalsmith-stretch` 0.1.3 crate **does** build and run for `wasm32-unknown-unknown`, but only
with a real C++ wasm toolchain (Apple's clang has no wasm32 backend, so wasi-sdk is required),
`-D__wasi__` to get past libc++'s platform gate, `-fvisibility=default` for bindgen (otherwise it
silently emits no functions), no `-lstdc++`, and seven hand-written Rust shims for libc++ runtime
symbols (`operator new`/`delete`, `std::random_device`, `__libcpp_verbose_abort`,
`typeinfo for void`). That is a lot of build machinery to carry in `pnpm verify` on every machine
for a fallback we can write ourselves, which is why it stays in the lab.

## Decision

**Ship the pure-Rust phase vocoder as `bragi-dsp`'s `Stretcher` implementation.** It is the
portable baseline that compiles everywhere with no extra toolchain, is allocation-free after
construction, and passes the contract and no-flam tests.

Design, as landed in `crates/bragi-dsp/src/stretch/`:

- **Time-stretch only.** Pitch shift is a **resample of the source by `2^(semitones/12)`** feeding
  a vocoder that stretches by `ratio · pitch` (so duration stays `ratio` and pitch is `pitch`).
  Keeping the two stages separate is what makes pitch exact: a phase vocoder cannot move a partial
  to a different bin without either aliasing the phase advance or cancelling the partial.
- **Phase vocoder** with instantaneous-frequency tracking (predicting each frame's phase advance
  from the previous frame's frequency, so time *compression* unwraps correctly), **identity phase
  locking** around spectral peaks, **transient phase reset** driven by a frame-energy gate (not
  raw spectral flux — flux false-fires on steady tones), and **window-centred** analysis/synthesis
  (so a transient's timing error is one analysis hop, not one window).
- **Pull model:** `input_required(out_frames)` depends only on the ratio history, so 128-frame
  worklet quanta, 256-frame cpal buffers and the offline renderer produce identical output.
- **Constructor-only allocation:** both quality tiers' buffers and FFT plans are built in `new`.
- **Tiers:** `Preview` = 1024-point FFT / 256 hop (≈21 ms latency), `Render` = 2048 / 512 (≈43 ms).

## Measured numbers

Apple Silicon (arm64), release build, single core, 4 s stereo drum fixture
(`crates/bragi-dsp/stretch-lab`, `--bin measure` / `--bin compare`). RTF = seconds of audio per
second of CPU.

| Engine | ratio | RTF | hits | flams | 2nd attack +dB | pre-echo +dB | image ±dB | timing ms |
|---|---|---|---|---|---|---|---|---|
| PhaseVocoder Preview | 0.88 | ~100 | 7/7 | 0 | 0.0 | 41.3 | 0.04 | 0.7 |
| PhaseVocoder Render | 0.88 | ~110 | 7/7 | 0 | 0.1 | 42.3 | 0.08 | 4.3 |
| PhaseVocoder Preview | 1.12 | ~111 | 7/7 | 0 | 0.0 | 41.4 | 0.05 | 0.7 |
| PhaseVocoder Render | 1.12 | ~111 | 7/7 | 0 | 0.0 | 41.3 | 0.02 | 1.3 |
| Signalsmith Stretch (`preset_default`) | 0.88 | ~81 | — | — | — | — | — | — |
| Signalsmith Stretch (`preset_default`) | 1.12 | ~120 | — | — | — | — | — | — |

RTF is approximate and noisy on this machine (±30 % run-to-run: CPU frequency scaling dominates a
4 s fixture, and a cold first iteration runs slow). The flam/timing/image/pre-echo figures are
stable across runs.

- **Pitch accuracy** (`--bin measure` is stretch-only; the contract test
  `pitch_shift_moves_a_sine_by_the_expected_ratio`): 880.00 Hz / 220.00 Hz for +12 / −12 semitones
  on a 440 Hz sine — **0.0 % error**, well inside the 0.5 % test tolerance.
- **Pass-through** at ratio 1.0 / 0 semitones is bit-exact (`f32::to_bits`) for random block
  partitions, and zero-latency.
- **No allocation** after `new`: proved by a counting `#[global_allocator]` test
  (`tests/no_alloc.rs`), across configure/process/input_required/latency/reset.
- **WASM:** `cargo build --target wasm32-unknown-unknown -p bragi-dsp` succeeds; the worklet shim
  is 299 KB and runs in an AudioWorklet (`stretch-lab/web`, headless-Chrome runner passes).

The objective proxies **supplement** the listening check; they do not replace it. They show no
flamming — the secondary-attack increase over the source is ~0 dB and every hit stays single —
and a preserved stereo image (≤ 0.08 dB shift). Pre-echo is the real finding: the vocoder lifts
energy 5–35 ms before each transient by ~41 dB over the source. That transient smearing is what
the ear must judge (see *Consequences → Transient smearing* and Q12), not an automated pass.

## Listening notes

**Pending** — to be filled in by the owner after `render_listen` and
[`docs/wp/0.4-MANUAL_CHECKS.md`](../../docs/wp/0.4-MANUAL_CHECKS.md). The decision above is the
portable-baseline call; the `Render`-tier recommendation for release quality is **provisional**
until this section exists.

## Consequences

**Positive**
- One implementation, no C++ toolchain, compiles for every target with plain `rustc`; `pnpm
  verify` gains no new build requirements.
- Allocation-free and panic-free off the constructor; exact pass-through keeps un-warped clips
  untouched.
- Quality/CPU are within ~30 % of Signalsmith on the acoustic fixture, so the portable baseline is
  not obviously worse for the common ±12 % warp.

**Negative / mitigations**
- **Transient smearing.** A phase vocoder spreads an attack across the frames that overlap it,
  moving the envelope peak by up to `fft_size · |ratio − 1|` (under 1 ms at ±12 %, growing at
  larger ratios and hidden by window-centring + transient reset). Mitigation: keep `fft_size`
  small, and if the ear rejects the `Render` tier, drop `Quality::Render::fft_size` to 1024 or
  adopt Signalsmith for offline renders.
- **Phasiness** on long tonal material (a known vocoder artefact); phase locking reduces it but
  does not remove it.
- **New dependency** `realfft` (with `rustfft` transitively) for the FFT — pure Rust, builds
  for `wasm32-unknown-unknown`. No other dependency is added.
- **Pitch shift resamples** the source, so transposing up can alias content above
  `0.5 · sample_rate / pitch`; acceptable for the ±24 semitone range, and documented here.

## Related

- [03 §7](../03-audio-engine.md) (trait, ratio direction, channels, latency — clarified in this WP)
- [Q1](../15-open-questions.md) (resolved: this ADR)
- [WP-0.4 plan](../../docs/wp/0.4.md) · [manual checks](../../docs/wp/0.4-MANUAL_CHECKS.md)
