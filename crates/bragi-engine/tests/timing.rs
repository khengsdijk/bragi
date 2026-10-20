//! Acceptance criterion 1: the timing targets of `specs/03-audio-engine.md` §5.2.
//!
//! Every measurement is in samples and converted to milliseconds at 48 kHz, so
//! the numbers are exact rather than wall-clock.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

mod common;

use std::sync::Arc;
use std::time::Instant;

use bragi_engine::engine::Engine;
use bragi_engine::pcm::PcmSource;
use bragi_engine::plan::compile;
use bragi_engine::preview::PreviewPatch;
use bragi_engine::render::Renderer;
use bragi_engine::transport::{Transport, TransportState};
use bragi_engine::{QUANTUM_FRAMES, SAMPLE_RATE};
use common::*;
use serde_json::json;

fn ms(samples: u64) -> f64 {
    samples as f64 * 1000.0 / SAMPLE_RATE as f64
}

/// A ramp whose value identifies its source position: `i / 48000`.
fn ramp(frames: usize) -> Vec<f32> {
    (0..frames)
        .flat_map(|frame| {
            let value = frame as f32 / 48_000.0;
            [value, value]
        })
        .collect()
}

fn ramp_pcm(hash: &bragi_model::generated::AssetHash, frames: usize) -> impl PcmSource {
    pcm(
        hash,
        bragi_engine::pcm::PcmBuffer::new(ramp(frames), 2, 48_000),
    )
}

/// Play start latency: with PCM cached, the very first rendered sample is the
/// playhead's sample — zero frames of latency (target < 100 ms).
#[test]
fn play_start_latency_is_zero_samples() {
    let hash = hash('0');
    let clip = clip_none("clp_01", &hash, 0, 480_000, 0);
    let doc = project(
        vec![track("trk_01")],
        vec![section(
            "sec_a",
            BAR_TICKS * 5,
            json!({ "trk_01": lane(vec![clip]) }),
        )],
    );
    let plan = compile(&doc, &assets(&hash, 480_000), 48_000, 1).unwrap();
    let source = ramp_pcm(&hash, 480_000);
    let mut renderer = Renderer::new(Arc::new(plan), QUANTUM_FRAMES);
    renderer.transport_mut().play();
    let mut left = [0.0f32; QUANTUM_FRAMES];
    let mut right = [0.0f32; QUANTUM_FRAMES];
    renderer.process(&source, &mut [&mut left, &mut right]);
    assert_eq!(left[0], 0.0, "frame 0 is the playhead sample");
    // Frame 0 is also the first sample of a silent block, so pin the ramp at a
    // non-zero sample too: with zero latency the ramp's sample 1 lands at frame 1.
    assert_eq!(
        left[1],
        1.0 / 48_000.0,
        "frame 1 is one sample later — zero latency"
    );
    assert!(ms(0) < 100.0);
}

/// Seek: the new position is audible in the next block — at most 128 samples
/// (2.67 ms) later (target < 50 ms).
#[test]
fn seek_is_audible_in_the_next_block() {
    const TARGET: u64 = 24_000; // beat 1
    let hash = hash('1');
    let clip = clip_none("clp_01", &hash, 0, 480_000, 0);
    let doc = project(
        vec![track("trk_01")],
        vec![section(
            "sec_a",
            BAR_TICKS * 5,
            json!({ "trk_01": lane(vec![clip]) }),
        )],
    );
    let plan = compile(&doc, &assets(&hash, 480_000), 48_000, 1).unwrap();
    let source = ramp_pcm(&hash, 480_000);
    let mut renderer = Renderer::new(Arc::new(plan), QUANTUM_FRAMES);
    renderer.transport_mut().play();
    let mut left = [0.0f32; QUANTUM_FRAMES];
    let mut right = [0.0f32; QUANTUM_FRAMES];
    renderer.process(&source, &mut [&mut left, &mut right]);
    renderer.transport_mut().seek(TARGET);
    renderer.process(&source, &mut [&mut left, &mut right]);
    assert_eq!(left[0], TARGET as f32 / 48_000.0);
    assert!(ms(QUANTUM_FRAMES as u64) < 50.0);
}

/// Loop: the wrap is sample-accurate (the incoming material starts exactly one
/// frame after the loop end) and the crossfade is 5 ms.
#[test]
fn loop_boundary_is_sample_accurate_with_a_five_millisecond_crossfade() {
    const LOOP_START: u64 = 48_000;
    const LOOP_END: u64 = 72_000;

    let mut transport = Transport::new(480_000);
    transport.set_loop(Some((LOOP_START, LOOP_END)));
    transport.seek(LOOP_END - 10);
    transport.play();
    assert_eq!(transport.state(), TransportState::Looping);
    let schedule = transport.schedule(512, 240);
    assert_eq!(schedule.first_frames, 10);
    let wrap = schedule.wrap.unwrap();
    assert_eq!(wrap.frames, 240, "the crossfade is 5 ms = 240 frames");
    assert_eq!(wrap.incoming_start, LOOP_START);
    assert_eq!(wrap.outgoing_start, LOOP_END);
    assert_eq!(schedule.resume_start, LOOP_START + 240);
    assert_eq!(schedule.resume_frames, 512 - 10 - 240);

    // Render the same situation and check the impulse positions.
    let hash = hash('2');
    let clip = clip_none("clp_01", &hash, 0, 480_000, 0);
    let doc = project(
        vec![track("trk_01")],
        vec![section(
            "sec_a",
            BAR_TICKS * 5,
            json!({ "trk_01": lane(vec![clip]) }),
        )],
    );
    let plan = compile(&doc, &assets(&hash, 480_000), 48_000, 1).unwrap();
    let source = pcm(
        &hash,
        impulses(
            480_000,
            &[(LOOP_START as usize, 0.4), (LOOP_END as usize, 0.5)],
        ),
    );
    let mut renderer = Renderer::new(Arc::new(plan), 512);
    renderer
        .transport_mut()
        .set_loop(Some((LOOP_START, LOOP_END)));
    renderer.transport_mut().seek(LOOP_END - 10);
    renderer.transport_mut().play();
    let mut left = [0.0f32; 512];
    let mut right = [0.0f32; 512];
    renderer.process(&source, &mut [&mut left, &mut right]);

    // Frames 0..10 are the outgoing tail before the boundary: silence here.
    assert!(left[..10].iter().all(|sample| *sample == 0.0));
    // Frame 10 is the wrap: almost all outgoing (source 72000, 0.5) plus the
    // first incoming frame (source 48000, 0.4) at the crossfade's first step.
    let x = 0.5 / 240.0;
    let fade_in = (x * std::f32::consts::FRAC_PI_2).sin();
    let fade_out = (x * std::f32::consts::FRAC_PI_2).cos();
    let expected = 0.5 * fade_out + 0.4 * fade_in;
    assert!(
        (left[10] - expected).abs() < 1e-4,
        "wrap frame: got {}, expected {expected}",
        left[10]
    );
}

/// Mute and solo apply within one buffer with a 5 ms linear ramp.
#[test]
fn mute_and_solo_ramp_over_five_milliseconds_in_one_buffer() {
    let hash = hash('3');
    let clip = clip_none("clp_01", &hash, 0, 480_000, 0);
    let doc = project(
        vec![track("trk_01")],
        vec![section(
            "sec_a",
            BAR_TICKS * 5,
            json!({ "trk_01": lane(vec![clip]) }),
        )],
    );
    let mut engine = Engine::new(
        compile(&doc, &assets(&hash, 480_000), 48_000, 1).unwrap(),
        512,
    );
    engine.transport_mut().play();
    let source = pcm(&hash, dc(480_000, 0.5));
    let mut left = [0.0f32; 512];
    let mut right = [0.0f32; 512];
    engine.process(&source, &mut [&mut left, &mut right]);
    assert!((left[0] - 0.5).abs() < 1e-6);

    let track_id: bragi_model::generated::TrackId = "trk_01".parse().unwrap();
    engine.set_preview(Some(PreviewPatch::TrackMute {
        track_id,
        mute: true,
    }));
    engine.process(&source, &mut [&mut left, &mut right]);
    assert!(left[0] < 0.5, "the ramp starts in the first sample");
    assert!(left[100] < 0.5);
    assert!(left[240] < 1e-6, "after 5 ms (240 frames) it is silent");
    assert!(left[511] < 1e-6);
}

/// Ten minutes of playback: the playhead is an integer sample counter, so the
/// drift against the rendered frame count is exactly zero (target < 1 ms).
#[test]
fn playhead_drift_is_zero_over_ten_minutes() {
    let hash = hash('4');
    // One 310-bar section (2.5 hours at 120 bpm) so ten minutes never reaches
    // the end; the clip only covers the first 10 s, the rest is silence.
    let clip = clip_none("clp_01", &hash, 0, 480_000, 0);
    let doc = project(
        vec![track("trk_01")],
        vec![section(
            "sec_a",
            BAR_TICKS * 310,
            json!({ "trk_01": lane(vec![clip]) }),
        )],
    );
    let plan = compile(&doc, &assets(&hash, 480_000), 48_000, 1).unwrap();
    let source = pcm(&hash, dc(480_000, 0.25));
    let mut renderer = Renderer::new(Arc::new(plan), QUANTUM_FRAMES);
    renderer.transport_mut().play();
    let mut left = [0.0f32; QUANTUM_FRAMES];
    let mut right = [0.0f32; QUANTUM_FRAMES];

    let ten_minutes = 10 * 60 * SAMPLE_RATE as u64;
    let mut rendered = 0u64;
    while rendered < ten_minutes {
        renderer.process(&source, &mut [&mut left, &mut right]);
        rendered += QUANTUM_FRAMES as u64;
    }
    let drift_samples = renderer.transport().playhead().abs_diff(rendered);
    assert_eq!(drift_samples, 0);
    assert!(ms(drift_samples) < 1.0);
    assert_eq!(renderer.underruns_for_test(), 0);
}

/// 12 tracks × 3 `gain` effects plus a 3-effect master chain: the CPU budget
/// from `specs/03-audio-engine.md` §11 (WP-2.3 §6). Prints the real-time ratio
/// (rendered audio seconds / wall-clock seconds); it must stay well under 100 %.
#[test]
fn twelve_tracks_with_three_fx_each_stay_far_below_real_time() {
    let h = hash('7');
    let mut tracks = Vec::new();
    let mut lanes = serde_json::Map::new();
    for index in 0..12 {
        let id = format!("trk_{index:02}");
        tracks.push(track(&id));
        lanes.insert(id, lane(vec![clip_none("clp_01", &h, 0, 480_000, 0)]));
    }
    let mut doc = project(tracks, vec![section("sec_a", BAR_TICKS * 5, json!(lanes))]);
    for (index, track) in doc.tracks.iter_mut().enumerate() {
        for effect in 0..3 {
            let id = format!("fx_t{index}{effect}");
            track.fx.0.push(fx_instance(
                &id,
                "gain",
                &[("db", -0.5 - effect as f64)],
                false,
            ));
        }
    }
    for effect in 0..3 {
        let id = format!("fx_m{effect}");
        doc.arrangement
            .master
            .fx
            .0
            .push(fx_instance(&id, "gain", &[("db", -0.5)], false));
    }
    let plan = compile(&doc, &assets(&h, 480_000), 48_000, 1).unwrap();
    let source = pcm(&h, tone(480_000, 220.0, 0.4));

    let frames = 10 * SAMPLE_RATE as usize;
    let mut renderer = Renderer::new(Arc::new(plan), QUANTUM_FRAMES);
    renderer.transport_mut().set_length(480_000);
    renderer.transport_mut().play();
    let mut left = [0.0f32; QUANTUM_FRAMES];
    let mut right = [0.0f32; QUANTUM_FRAMES];

    let start = Instant::now();
    let mut rendered = 0usize;
    while rendered < frames {
        renderer.process(&source, &mut [&mut left, &mut right]);
        rendered += QUANTUM_FRAMES;
    }
    let elapsed = start.elapsed().as_secs_f64();
    let audio_seconds = frames as f64 / SAMPLE_RATE as f64;
    let ratio = elapsed / audio_seconds * 100.0;
    println!(
        "12 tracks × 3 gain fx + 3 master fx: {frames} frames in {elapsed:.3} s \
         ({ratio:.2} % of real time)"
    );
    assert!(ratio < 100.0, "fx mix took {ratio:.1} % of real time");
    assert!(renderer.underruns_for_test() == 0);
}

/// Four warm plans (six tracks and three gain fx each): only the audible one or
/// the two sides of a crossfade render per block. Prints the real-time ratio as
/// a sanity check that warming does not multiply playback cost.
#[test]
fn four_warm_plans_stay_below_real_time() {
    let h = hash('8');
    let document = |gain_db: f64| {
        let mut tracks = Vec::new();
        let mut lanes = serde_json::Map::new();
        for index in 0..6 {
            let id = format!("trk_{index:02}");
            let mut track = track(&id);
            let fx: Vec<_> = (0..3)
                .map(|effect| {
                    fx_instance(
                        &format!("fx_{index}{effect}"),
                        "gain",
                        &[("db", gain_db - effect as f64 * 0.5)],
                        false,
                    )
                })
                .collect();
            track["fx"] = json!(fx);
            tracks.push(track);
            lanes.insert(id, lane(vec![clip_none("clp_01", &h, 0, 480_000, 0)]));
        }
        project(tracks, vec![section("sec_a", BAR_TICKS * 5, json!(lanes))])
    };
    let index = assets(&h, 480_000);
    let plans: Vec<_> = [0.0, -3.0, -6.0, -9.0]
        .into_iter()
        .enumerate()
        .map(|(version, db)| compile(&document(db), &index, 48_000, version as u64 + 1).unwrap())
        .collect();
    let source = pcm(&h, tone(480_000, 220.0, 0.4));

    let frames = 10 * SAMPLE_RATE as usize;
    let mut engine = Engine::new(plans[0].clone(), QUANTUM_FRAMES);
    for (slot, plan) in plans
        .iter()
        .enumerate()
        .take(bragi_engine::MAX_WARM_PLANS)
        .skip(1)
    {
        assert!(engine.warm(slot, plan.clone()));
    }
    engine.transport_mut().set_length(480_000);
    engine.transport_mut().play();
    let mut left = [0.0f32; QUANTUM_FRAMES];
    let mut right = [0.0f32; QUANTUM_FRAMES];

    let start = Instant::now();
    let mut rendered = 0usize;
    let mut blocks = 0usize;
    while rendered < frames {
        if blocks.is_multiple_of(750) {
            let slot = (blocks / 750) % bragi_engine::MAX_WARM_PLANS;
            engine.audition(if slot == 0 { None } else { Some(slot) });
        }
        engine.process(&source, &mut [&mut left, &mut right]);
        rendered += QUANTUM_FRAMES;
        blocks += 1;
    }
    let elapsed = start.elapsed().as_secs_f64();
    let audio_seconds = frames as f64 / SAMPLE_RATE as f64;
    let ratio = elapsed / audio_seconds * 100.0;
    println!(
        "four warm plans × 6 tracks × 3 gain fx: {frames} frames in {elapsed:.3} s \
         ({ratio:.2} % of real time, one or two plans rendering)"
    );
    assert!(
        ratio < 100.0,
        "four warm plans took {ratio:.1} % of real time"
    );
    assert_eq!(engine.underruns(), 0);
}

/// A small helper so the drift test can see the renderer's read failures.
trait UnderrunsForTest {
    fn underruns_for_test(&self) -> u64;
}

impl UnderrunsForTest for Renderer {
    fn underruns_for_test(&self) -> u64 {
        self.stats().underruns
    }
}
