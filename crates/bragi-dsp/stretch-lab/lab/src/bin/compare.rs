//! ADR-0002 comparison bench: Signalsmith Stretch (native) vs the pure-Rust vocoder, on the drum
//! fixture. Run from the repository root:
//!
//! ```text
//! LIBCLANG_PATH=/Library/Developer/CommandLineTools/usr/lib \
//!   cargo run --release --manifest-path crates/bragi-dsp/stretch-lab/Cargo.toml \
//!   -p stretch-lab --features signalsmith --bin compare
//! ```

use std::time::Instant;

use bragi_dsp::stretch::{PhaseVocoder, Quality, Stretcher};
use signalsmith_stretch::Stretch;
use stretch_lab::metrics::hit_report;
use stretch_lab::signals::DRUM_HIT_TIMES_MS;
use stretch_lab::{fixture, wav};

fn interleave(input: &[Vec<f32>]) -> Vec<f32> {
    let frames = input[0].len();
    let ch = input.len();
    let mut out = Vec::with_capacity(frames * ch);
    for f in 0..frames {
        for c in input.iter() {
            out.push(c[f]);
        }
    }
    out
}

fn main() {
    let audio = wav::read(&fixture("drums_120.wav"));
    let sr = audio.sample_rate;
    let ch = audio.channels.len();
    let frames = audio.channels[0].len();
    let interleaved = interleave(&audio.channels);

    println!("{:<34} {:>6} {:>8} {:>8}", "engine", "ratio", "rms", "rtf");
    for ratio in [0.88, 1.12] {
        // Signalsmith Stretch, default (highest quality) preset.
        let out_frames = (frames as f64 * ratio) as usize;
        let mut st = Stretch::preset_default(ch as u32, sr);
        let lat = st.input_latency() + st.output_latency();
        let mut out = vec![0.0f32; (out_frames + lat + 1024) * ch];
        let start = Instant::now();
        let ok = st.exact(&interleaved, &mut out);
        let elapsed = start.elapsed().as_secs_f64();
        let used = if ok { out_frames } else { out.len() / ch };
        let rms = (out[..used * ch].iter().map(|s| s * s).sum::<f32>() / (used * ch) as f32).sqrt();
        println!(
            "{:<34} {ratio:>6} {rms:>8.3} {:>8.1}",
            "Signalsmith (preset_default)",
            (used as f64 / f64::from(sr)) / elapsed
        );

        // The pure-Rust vocoder, both tiers, for a like-for-like realtime factor.
        for quality in [Quality::Preview, Quality::Render] {
            let mut pv = PhaseVocoder::new(ch, sr).unwrap();
            pv.configure(ratio, 0.0, quality).unwrap();
            let nframes = pv.latency() + out_frames;
            let mut pout = vec![vec![0.0f32; nframes]; ch];
            let start = Instant::now();
            render(&mut pv, &audio.channels, &mut pout);
            let elapsed = start.elapsed().as_secs_f64();
            let rep = hit_report(
                &audio.channels,
                &pout,
                sr,
                ratio,
                pv.latency(),
                &DRUM_HIT_TIMES_MS,
            );
            let rms = (pout[0].iter().map(|s| s * s).sum::<f32>() / pout[0].len() as f32).sqrt();
            println!(
                "{:<34} {ratio:>6} {rms:>8.3} {:>8.1}   hits {}/{}, flams {}",
                format!("PhaseVocoder {quality:?}"),
                (nframes as f64 / f64::from(sr)) / elapsed,
                rep.matched,
                rep.hits,
                rep.flams
            );
        }
    }
}

fn render(st: &mut PhaseVocoder, input: &[Vec<f32>], out: &mut [Vec<f32>]) {
    let frames = out[0].len();
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
}
