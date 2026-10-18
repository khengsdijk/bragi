//! The objective "no flamming" proxies for the ±12 % drum-fixture listening check (WP-0.4,
//! [ADR-0002]). They supplement the owner's ear, they do not replace it: the acceptance is the
//! listening check in [`docs/wp/0.4-MANUAL_CHECKS.md`].
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use bragi_dsp::stretch::{PhaseVocoder, Quality, Stretcher};
use common::metrics::hit_report;
use common::signals::{DRUM_HIT_TIMES_MS, render};
use common::wav;

const SR: u32 = 48_000;

fn drums() -> Vec<Vec<f32>> {
    let audio = wav::read(&common::fixture("drums_120.wav"));
    assert_eq!(audio.sample_rate, SR);
    audio.channels
}

#[test]
fn twelve_percent_stretch_keeps_every_hit_single_and_in_place() {
    let input = drums();
    let frames = input[0].len();
    for ratio in [0.88, 0.94, 1.06, 1.12] {
        for quality in [Quality::Preview, Quality::Render] {
            let mut st = PhaseVocoder::new(input.len(), SR).unwrap();
            st.configure(ratio, 0.0, quality).unwrap();
            let lat = st.latency();
            let out_frames = lat + (frames as f64 * ratio) as usize;
            let (out, _) = render(&mut st, &input, out_frames, || 128);
            let rep = hit_report(&input, &out, SR, ratio, lat, &DRUM_HIT_TIMES_MS);
            assert!(rep.hits >= 7, "ratio {ratio} {quality:?}: {rep:?}");
            assert_eq!(rep.matched, rep.hits, "a hit drifted out of place: {rep:?}");
            assert_eq!(
                rep.flams, 0,
                "a hit was reproduced twice (flamming): {rep:?}"
            );
            assert!(
                rep.worst_secondary_increase_db < 6.0,
                "secondary attack grew by {} dB: {rep:?}",
                rep.worst_secondary_increase_db
            );
            assert!(
                rep.worst_image_shift_db < 1.0,
                "stereo image moved: {rep:?}"
            );
            // The envelope peak of a smeared attack moves by up to one window times |ratio − 1|;
            // that is far below the ~10 ms at which two hits read as a flam. The audible flam
            // test is `flams == 0` and the secondary-attack bound above.
            let smear_ms = 1000.0 * quality.fft_size() as f64 * (ratio - 1.0).abs() / f64::from(SR);
            assert!(
                rep.worst_timing_ms <= 2.0 + smear_ms,
                "hit timing drifted: {rep:?}"
            );
        }
    }
}

#[test]
fn every_hit_survives_a_round_trip_of_block_partitions() {
    // The worklet feeds 128-frame quanta, cpal 256, the renderer large blocks. Whichever the
    // host uses, every hit must still be a single hit.
    let input = drums();
    let frames = input[0].len();
    let ratio = 1.12;
    let mut st = PhaseVocoder::new(input.len(), SR).unwrap();
    st.configure(ratio, 0.0, Quality::Preview).unwrap();
    let lat = st.latency();
    let out_frames = lat + (frames as f64 * ratio) as usize;
    let (out, _) = render(&mut st, &input, out_frames, || 4096);
    let rep = hit_report(&input, &out, SR, ratio, lat, &DRUM_HIT_TIMES_MS);
    assert_eq!(rep.flams, 0, "{rep:?}");
    assert_eq!(rep.matched, rep.hits, "{rep:?}");
}
