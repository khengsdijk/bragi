//! The `Stretcher` contract (03 §7): bit-exact pass-through at ratio 1.0, block-partition
//! independence, time mapping, pitch, configuration errors, reset, and robustness.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use bragi_dsp::stretch::{PhaseVocoder, Quality, StretchError, Stretcher};
use common::metrics::{hit_report, zero_crossing_hz};
use common::signals::{Rng, click_train, noise, render, sine};

const SR: u32 = 48_000;

fn stereo_noise(frames: usize) -> Vec<Vec<f32>> {
    vec![noise(1, frames, 0.5), noise(2, frames, 0.5)]
}

fn bits(x: &[Vec<f32>]) -> Vec<Vec<u32>> {
    x.iter()
        .map(|c| c.iter().map(|s| s.to_bits()).collect())
        .collect()
}

#[test]
fn ratio_one_is_a_bit_exact_pass_through_for_any_block_partition() {
    let input = stereo_noise(SR as usize * 3);
    let frames = input[0].len();
    for quality in [Quality::Preview, Quality::Render] {
        for seed in 1..=20u64 {
            let mut st = PhaseVocoder::new(2, SR).unwrap();
            st.configure(1.0, 0.0, quality).unwrap();
            assert_eq!(st.latency(), 0, "pass-through has no latency");
            let mut rng = Rng::new(seed);
            let max = [1, 7, 128, 256, 4096][(seed % 5) as usize];
            let (out, consumed) = render(&mut st, &input, frames, || rng.range(1, max));
            assert_eq!(
                consumed, frames,
                "pass-through consumes exactly one input frame per output frame"
            );
            assert_eq!(bits(&out), bits(&input), "seed {seed}, {quality:?}");
        }
    }
}

#[test]
fn pass_through_survives_a_round_trip_through_another_ratio() {
    // Leaving and re-entering ratio 1.0 restarts the stream, and is exact again afterwards.
    let input = stereo_noise(SR as usize);
    let mut st = PhaseVocoder::new(2, SR).unwrap();
    st.configure(1.12, 0.0, Quality::Render).unwrap();
    let _ = render(&mut st, &input, 10_000, || 256);
    st.configure(1.0, 0.0, Quality::Render).unwrap();
    st.reset();
    let (out, _) = render(&mut st, &input, input[0].len(), || 333);
    assert_eq!(bits(&out), bits(&input));
}

#[test]
fn output_does_not_depend_on_how_the_caller_slices_blocks() {
    let input = stereo_noise(SR as usize * 2);
    for (ratio, semis) in [
        (0.88, 0.0),
        (1.12, 0.0),
        (1.5, 0.0),
        (1.0, 3.0),
        (0.94, -5.0),
    ] {
        for quality in [Quality::Preview, Quality::Render] {
            let frames = (input[0].len() as f64 * ratio) as usize;
            let mut a = PhaseVocoder::new(2, SR).unwrap();
            a.configure(ratio, semis, quality).unwrap();
            let (ref_out, ref_in) = render(&mut a, &input, frames, || 128);
            for seed in 1..=4u64 {
                let mut b = PhaseVocoder::new(2, SR).unwrap();
                b.configure(ratio, semis, quality).unwrap();
                let mut rng = Rng::new(seed * 31);
                let (out, consumed) = render(&mut b, &input, frames, || rng.range(1, 3000));
                assert_eq!(
                    consumed, ref_in,
                    "input consumption differs ({ratio}, {semis}, {quality:?})"
                );
                assert_eq!(
                    bits(&out),
                    bits(&ref_out),
                    "output differs ({ratio}, {semis}, {quality:?}, seed {seed})"
                );
            }
        }
    }
}

#[test]
fn input_consumption_follows_the_ratio() {
    let input = stereo_noise(SR as usize * 4);
    for ratio in [0.5, 0.75, 0.88, 0.94, 1.06, 1.12, 1.25, 1.5, 2.0] {
        for quality in [Quality::Preview, Quality::Render] {
            let mut st = PhaseVocoder::new(2, SR).unwrap();
            st.configure(ratio, 0.0, quality).unwrap();
            let lat = st.latency();
            // Output frames covering exactly the 4 s of input, plus the latency.
            let out_frames = lat + (input[0].len() as f64 * ratio).round() as usize;
            let (out, consumed) = render(&mut st, &input, out_frames, || 512);
            assert_eq!(out[0].len(), out_frames);
            // The stretcher may read ahead by at most one analysis window (its look-ahead).
            let expected = input[0].len();
            let slack = st.look_ahead();
            assert!(
                consumed >= expected && consumed <= expected + slack,
                "ratio {ratio} {quality:?}: consumed {consumed}, expected {expected}..={}",
                expected + slack
            );
        }
    }
}

#[test]
fn clicks_land_at_latency_plus_ratio_times_source_time() {
    let sr = SR;
    let src = click_train(sr, sr as usize * 4, 4_800, 12_000); // every 250 ms from 100 ms
    let input = vec![src.clone(), src];
    // The generator's schedule: 100 ms, then a click every 250 ms.
    let hits: Vec<f64> = (0..16).map(|k| 100.0 + 250.0 * k as f64).collect();
    for ratio in [0.75, 0.88, 1.12, 1.25, 1.5] {
        for quality in [Quality::Preview, Quality::Render] {
            let mut st = PhaseVocoder::new(2, sr).unwrap();
            st.configure(ratio, 0.0, quality).unwrap();
            let out_frames = st.latency() + (input[0].len() as f64 * ratio) as usize;
            let (out, _) = render(&mut st, &input, out_frames, || 256);
            let rep = hit_report(&input, &out, sr, ratio, st.latency(), &hits);
            assert!(rep.hits >= 12, "{rep:?}");
            // Every click is reproduced exactly once: none appears twice (flamming), none drifts
            // so far that it counts as missed.
            assert_eq!(rep.matched, rep.hits, "ratio {ratio} {quality:?}: {rep:?}");
            assert_eq!(rep.flams, 0, "ratio {ratio} {quality:?}: {rep:?}");
            // A phase vocoder smears an attack across the frames that overlap it, so the hit's
            // measured time drifts by up to one window times |ratio − 1|. That is a property of
            // the algorithm, not a bug; it is recorded in ADR-0002 and is under 1 ms at ±12 %.
            let smear_ms = 1000.0 * quality.fft_size() as f64 * (ratio - 1.0).abs() / f64::from(sr);
            assert!(
                rep.worst_timing_ms <= 3.0 + smear_ms,
                "ratio {ratio} {quality:?}: {rep:?}"
            );
        }
    }
}

#[test]
fn latency_is_constant_across_ratios_within_a_quality_tier() {
    for quality in [Quality::Preview, Quality::Render] {
        let mut st = PhaseVocoder::new(1, SR).unwrap();
        st.configure(0.5, 0.0, quality).unwrap();
        let l = st.latency();
        assert!(l > 0);
        for ratio in [0.75, 0.88, 1.12, 2.0, 4.0, 0.25] {
            st.configure(ratio, 0.0, quality).unwrap();
            assert_eq!(st.latency(), l);
        }
        st.configure(1.0, 2.0, quality).unwrap();
        assert_eq!(
            st.latency(),
            l,
            "pitch-only shifting uses the vocoder and its latency"
        );
    }
}

#[test]
fn pitch_shift_moves_a_sine_by_the_expected_ratio() {
    let frames = SR as usize * 2;
    let input = vec![sine(440.0, SR, frames, 0.5)];
    for (ratio, semis) in [
        (1.0, 12.0),
        (1.0, 7.0),
        (1.0, -5.0),
        (1.0, -12.0),
        (1.12, 4.0),
        (0.88, -3.0),
    ] {
        for quality in [Quality::Preview, Quality::Render] {
            let mut st = PhaseVocoder::new(1, SR).unwrap();
            st.configure(ratio, semis, quality).unwrap();
            let lat = st.latency();
            let out_frames = lat + (frames as f64 * ratio) as usize;
            let (out, _) = render(&mut st, &input, out_frames, || 480);
            let steady = &out[0][lat + SR as usize / 4..out_frames - SR as usize / 4];
            let got = zero_crossing_hz(steady, SR);
            let want = 440.0 * 2f64.powf(f64::from(semis) / 12.0);
            assert!(
                (got / want - 1.0).abs() < 0.005,
                "ratio {ratio}, {semis} st, {quality:?}: {got:.2} Hz, want {want:.2}"
            );
        }
    }
}

#[test]
fn time_stretch_alone_keeps_the_pitch() {
    let frames = SR as usize * 2;
    let input = vec![sine(440.0, SR, frames, 0.5)];
    for ratio in [0.75, 0.88, 1.12, 1.5] {
        let mut st = PhaseVocoder::new(1, SR).unwrap();
        st.configure(ratio, 0.0, Quality::Render).unwrap();
        let lat = st.latency();
        let out_frames = lat + (frames as f64 * ratio) as usize;
        let (out, _) = render(&mut st, &input, out_frames, || 480);
        let got = zero_crossing_hz(
            &out[0][lat + SR as usize / 4..out_frames - SR as usize / 4],
            SR,
        );
        assert!(
            (got / 440.0 - 1.0).abs() < 0.002,
            "ratio {ratio}: {got:.2} Hz"
        );
    }
}

#[test]
fn configure_rejects_out_of_range_values_and_keeps_the_previous_setting() {
    let mut st = PhaseVocoder::new(2, SR).unwrap();
    st.configure(1.12, 0.0, Quality::Render).unwrap();
    for bad in [0.0, -1.0, f64::NAN, f64::INFINITY, 0.1, 10.0] {
        assert!(
            matches!(
                st.configure(bad, 0.0, Quality::Render),
                Err(StretchError::RatioOutOfRange(_))
            ),
            "{bad}"
        );
    }
    for bad in [f32::NAN, 25.0, -25.0, f32::INFINITY] {
        assert!(
            matches!(
                st.configure(1.0, bad, Quality::Render),
                Err(StretchError::SemitonesOutOfRange(_))
            ),
            "{bad}"
        );
    }
    assert_eq!(st.ratio(), 1.12);
    assert!(matches!(
        PhaseVocoder::new(0, SR),
        Err(StretchError::ChannelCount(0))
    ));
    assert!(matches!(
        PhaseVocoder::new(9, SR),
        Err(StretchError::ChannelCount(9))
    ));
    assert!(matches!(
        PhaseVocoder::new(2, 1000),
        Err(StretchError::SampleRate(1000))
    ));
}

#[test]
fn reset_returns_to_the_state_of_a_fresh_instance() {
    let input = stereo_noise(SR as usize);
    let mut fresh = PhaseVocoder::new(2, SR).unwrap();
    fresh.configure(1.12, 2.0, Quality::Preview).unwrap();
    let (want, _) = render(&mut fresh, &input, 30_000, || 256);

    let mut used = PhaseVocoder::new(2, SR).unwrap();
    used.configure(0.8, -3.0, Quality::Render).unwrap();
    let _ = render(&mut used, &stereo_noise(20_000), 20_000, || 100);
    used.configure(1.12, 2.0, Quality::Preview).unwrap();
    used.reset();
    let (got, _) = render(&mut used, &input, 30_000, || 256);
    assert_eq!(bits(&got), bits(&want));
}

#[test]
fn output_stays_finite_and_bounded_on_hostile_input() {
    let mut rng = Rng::new(99);
    for case in 0..40u64 {
        let ch = rng.range(1, 2);
        let frames = rng.range(1, 30_000);
        let kind = case % 4;
        let input: Vec<Vec<f32>> = (0..ch)
            .map(|c| match kind {
                0 => vec![0.0; frames],
                1 => noise(case * 10 + c as u64, frames, 1.0),
                2 => (0..frames)
                    .map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
                    .collect(),
                _ => vec![1.0; frames],
            })
            .collect();
        let ratio = 0.25 + (rng.next_u64() % 3750) as f64 / 1000.0;
        let semis = (rng.next_u64() % 48) as f32 - 24.0;
        let quality = if case % 2 == 0 {
            Quality::Preview
        } else {
            Quality::Render
        };
        let mut st = PhaseVocoder::new(ch, SR).unwrap();
        st.configure(ratio, semis, quality).unwrap();
        let (out, _) = render(&mut st, &input, rng.range(1, 40_000), || rng.range(1, 5000));
        for c in &out {
            assert!(
                c.iter().all(|s| s.is_finite() && s.abs() < 8.0),
                "case {case}: ratio {ratio}, {semis} st"
            );
        }
    }
}

#[test]
fn mismatched_buffers_do_not_panic() {
    let mut st = PhaseVocoder::new(2, SR).unwrap();
    st.configure(1.12, 0.0, Quality::Preview).unwrap();
    let a = vec![0.1f32; 100];
    let mut o1 = vec![0.0f32; 64];
    let mut o2 = vec![0.0f32; 32];
    // Fewer input channels than configured, ragged output, too little input.
    st.process(&[&a], &mut [&mut o1, &mut o2]);
    st.process(&[], &mut []);
    st.process(&[&a, &a, &a], &mut [&mut o1]);
    st.configure(1.0, 0.0, Quality::Preview).unwrap();
    st.process(&[&a[..10]], &mut [&mut o1, &mut o2]);
    assert!(o1.iter().chain(&o2).all(|s| s.is_finite()));
}
