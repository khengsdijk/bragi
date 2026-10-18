# WP-0.4 stretch lab

The spike's scratch space. **Nothing in here ships**, and none of it is a member of the root
Cargo workspace: it pulls in a C++ build (Signalsmith Stretch needs a C++ compiler and libclang)
and comparison crates that must never become requirements of `pnpm verify`.

```
lab/       fixture generator, listening renders, CPU + quality measurement
worklet/   wasm32 cdylib wrapping bragi-dsp for the AudioWorklet page
web/       the AudioWorklet test page and a headless runner (see web/README.md)
```

It is its own Cargo workspace (`Cargo.toml` here), with every comparison candidate behind a
feature so a plain build needs only `bragi-dsp`:

```sh
# fixtures (committed, licence-clean, generated) — needs only bragi-dsp
cargo run --manifest-path crates/bragi-dsp/stretch-lab/Cargo.toml -p stretch-lab --bin gen_fixtures

# CPU + no-flam numbers for ADR-0002
cargo run --release --manifest-path crates/bragi-dsp/stretch-lab/Cargo.toml -p stretch-lab --bin measure

# listening renders (gitignored) for the owner's ±12 % check
cargo run --release --manifest-path crates/bragi-dsp/stretch-lab/Cargo.toml -p stretch-lab --bin render_listen

# Signalsmith Stretch comparison (native; needs a C++ compiler + libclang)
LIBCLANG_PATH=/Library/Developer/CommandLineTools/usr/lib \
  cargo run --release --manifest-path crates/bragi-dsp/stretch-lab/Cargo.toml \
  -p stretch-lab --features signalsmith --bin compare

# AudioWorklet page
node crates/bragi-dsp/stretch-lab/web/run.mjs
```

The `lab` crate includes the integration tests' `tests/common/{signals,metrics,wav}.rs` **by
path**, so a number printed here and a number asserted in `cargo test` come from one
implementation.
