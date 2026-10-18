//! Prints the objective "no flamming" proxies and a realtime factor for every ratio on the drum
//! fixture, for ADR-0002. Run from the repository root:
//!
//! ```text
//! cargo run --release --manifest-path crates/bragi-dsp/stretch-lab/Cargo.toml -p stretch-lab --bin measure
//! ```

use std::time::Instant;

use bragi_dsp::stretch::{PhaseVocoder, Quality, Stretcher};
use stretch_lab::metrics::{HOP_MS, hit_report};
use stretch_lab::signals::DRUM_HIT_TIMES_MS;
use stretch_lab::{fixture, wav};

fn main() {
    let audio = wav::read(&fixture("drums_120.wav"));
    let sr = audio.sample_rate;
    let input = audio.channels;
    let frames = input[0].len();

    println!(
        "fixture: drums_120.wav, {sr} Hz, {} ch, {:.2} s",
        input.len(),
        frames as f64 / f64::from(sr)
    );
    println!(
        "{:<8} {:<8} {:>7} {:>6} {:>6} {:>8} {:>8} {:>7} {:>8} {:>8} {:>8}",
        "quality",
        "ratio",
        "rms",
        "match",
        "flam",
        "2nd+dB",
        "pre+dB",
        "med+dB",
        "img+dB",
        "timems",
        "rtf"
    );
    for quality in [Quality::Preview, Quality::Render] {
        for ratio in [0.88, 0.94, 1.0, 1.06, 1.12, 1.25, 1.5] {
            let mut st = PhaseVocoder::new(input.len(), sr).unwrap();
            st.configure(ratio, 0.0, quality).unwrap();
            let lat = st.latency();
            let out_frames = lat + (frames as f64 * ratio) as usize;
            let mut out = vec![vec![0.0f32; out_frames]; input.len()];
            let start = Instant::now();
            render(&mut st, &input, &mut out);
            let elapsed = start.elapsed().as_secs_f64();
            if (ratio - 1.0).abs() < f64::EPSILON && matches!(quality, Quality::Preview) {
                // pass-through, no report
                println!("{quality:8?} {ratio:<8} passthrough");
                continue;
            }
            let rep = hit_report(&input, &out, sr, ratio, lat, &DRUM_HIT_TIMES_MS);
            let rms = (out[0].iter().map(|s| s * s).sum::<f32>() / out[0].len() as f32).sqrt();
            let rtf = (out_frames as f64 / f64::from(sr)) / elapsed;
            println!(
                "{quality:8?} {ratio:<8} {rms:>7.3} {:>6} {:>6} {:>8.1} {:>8.1} {:>7.1} {:>8.2} {:>8.2} {:>8.1}",
                format!("{}/{}", rep.matched, rep.hits),
                rep.flams,
                rep.worst_secondary_increase_db,
                rep.worst_pre_echo_increase_db,
                rep.median_pre_echo_increase_db,
                rep.worst_image_shift_db,
                rep.worst_timing_ms,
                rtf
            );
            let _ = HOP_MS;
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
        let (a, b) = out.split_at_mut(1);
        let mut outs: Vec<&mut [f32]> = vec![
            &mut a[0][out_pos..out_pos + n],
            &mut b[0][out_pos..out_pos + n],
        ];
        st.process(&ins, &mut outs);
        out_pos += n;
    }
}
