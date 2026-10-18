//! Writes the listening renders for the owner's ±12 % check into a **gitignored** directory.
//! Run from the repository root:
//!
//! ```text
//! cargo run --release --manifest-path crates/bragi-dsp/stretch-lab/Cargo.toml -p stretch-lab --bin render-listen
//! ```
//!
//! Output goes to `crates/bragi-dsp/stretch-lab/renders/` (see `docs/wp/0.4-MANUAL_CHECKS.md`).
//! The rendered audio is never committed.

use std::fs;
use std::path::PathBuf;

use bragi_dsp::stretch::{PhaseVocoder, Quality, Stretcher};
use stretch_lab::wav::{self, Audio};
use stretch_lab::{fixture, repo_root};

fn render(st: &mut PhaseVocoder, input: &[Vec<f32>], ratio: f64, sr: u32) -> Audio {
    let frames = st.latency() + (input[0].len() as f64 * ratio) as usize;
    let mut out = vec![vec![0.0f32; frames]; input.len()];
    let mut in_pos = 0usize;
    let mut out_pos = 0usize;
    let mut scratch: Vec<Vec<f32>> = vec![Vec::new(); input.len()];
    while out_pos < frames {
        let n = 128.min(frames - out_pos);
        let need = st.input_required(n);
        for (c, s) in scratch.iter_mut().enumerate() {
            s.clear();
            for k in 0..need {
                s.push(input[c].get(in_pos + k).copied().unwrap_or(0.0));
            }
        }
        in_pos += need;
        let ins: Vec<&[f32]> = scratch.iter().map(Vec::as_slice).collect();
        let mut outs: Vec<&mut [f32]> = out
            .iter_mut()
            .map(|o| &mut o[out_pos..out_pos + n])
            .collect();
        st.process(&ins, &mut outs);
        out_pos += n;
    }
    Audio {
        sample_rate: sr,
        channels: out,
    }
}

fn main() {
    let dir = repo_root().join("crates/bragi-dsp/stretch-lab/renders");
    fs::create_dir_all(&dir).unwrap();

    for name in ["drums_120", "tone_440"] {
        let audio = wav::read(&fixture(&format!("{name}.wav")));
        let sr = audio.sample_rate;
        wav::write_f32(&dir.join(format!("{name}_original.wav")), &audio);
        for ratio in [0.88, 1.12] {
            for quality in [Quality::Preview, Quality::Render] {
                let mut st = PhaseVocoder::new(audio.channels.len(), sr).unwrap();
                st.configure(ratio, 0.0, quality).unwrap();
                let out = render(&mut st, &audio.channels, ratio, sr);
                let q = if matches!(quality, Quality::Preview) {
                    "preview"
                } else {
                    "render"
                };
                let pct = (ratio * 100.0).round() as i32;
                let path = dir.join(format!("{name}_{pct}_{q}.wav"));
                wav::write_f32(&path, &out);
                println!("wrote {}", path.display());
            }
        }
        // Pitch listening: +7 and -5 semitones at ratio 1.0.
        for semis in [7.0f32, -5.0] {
            let mut st = PhaseVocoder::new(audio.channels.len(), sr).unwrap();
            st.configure(1.0, semis, Quality::Render).unwrap();
            let out = render(&mut st, &audio.channels, 1.0, sr);
            let path = dir.join(format!("{name}_pitch{semis:+.0}.wav"));
            wav::write_f32(&path, &out);
            println!("wrote {}", path.display());
        }
    }
    let _ = PathBuf::new();
    println!(
        "\nRenders are in {} (gitignored). See docs/wp/0.4-MANUAL_CHECKS.md.",
        dir.display()
    );
}
