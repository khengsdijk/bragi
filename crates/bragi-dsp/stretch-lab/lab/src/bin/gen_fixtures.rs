//! Writes the committed fixtures under `fixtures/audio/`. Run from the repository root:
//!
//! ```text
//! cargo run --manifest-path crates/bragi-dsp/stretch-lab/lab/Cargo.toml --bin gen-fixtures
//! ```
//!
//! Everything here is generated, so the fixtures are licence-clean; add an entry to
//! `fixtures/audio/LICENSE.txt` when a new file is added.

use stretch_lab::{drum_loop, fixture, signals};

fn main() {
    let sr = 48_000u32;
    let drums = drum_loop(sr);
    let path = fixture("drums_120.wav");
    stretch_lab::wav::write_pcm16(&path, &drums);
    println!(
        "wrote {} ({} frames, {} ch)",
        path.display(),
        drums.frames(),
        drums.channels.len()
    );

    // A steady tone, for pitch listening checks.
    let tone = signals::sine(440.0, sr, sr as usize * 2, 0.4);
    let audio = stretch_lab::wav::Audio {
        sample_rate: sr,
        channels: vec![tone.clone(), tone],
    };
    let path = fixture("tone_440.wav");
    stretch_lab::wav::write_pcm16(&path, &audio);
    println!("wrote {}", path.display());
}
