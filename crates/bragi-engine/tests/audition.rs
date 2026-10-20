//! Warm plans and gapless audition switching
//! (`specs/03-audio-engine.md` §5.4, `specs/07-song-canvas.md` §10 check 4).
//!
//! Four plans of the same generated fixture differ in track gain, an fx and a
//! muted track. The fixtures are generated here (13 §6); no audio is committed.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

mod common;

use bragi_engine::SAMPLE_RATE;
use bragi_engine::engine::Engine;
use bragi_engine::plan::{RenderPlan, compile};
use bragi_engine::render::Renderer;
use bragi_engine::{AUDITION_FADE_MS, MAX_WARM_PLANS};
use bragi_model::AssetIndex;
use bragi_model::generated::Project;
use common::*;
use serde_json::json;

/// The AudioWorklet render quantum, so switches land on block boundaries.
const BLOCK: usize = 128;
/// The 30 ms crossfade in frames at 48 kHz.
const FADE_FRAMES: usize = (AUDITION_FADE_MS as usize) * 48_000 / 1000;
/// The generated fixture: one 10 s asset, five bars of 120 bpm.
const FRAMES: usize = 480_000;
const SECTION_TICKS: u64 = 5 * BAR_TICKS;

fn assets_with(hash: &bragi_model::generated::AssetHash, frames: u64) -> AssetIndex {
    AssetIndex::from_metas([meta(hash, frames)])
}

/// One plan of the audition fixture. Track 1 carries the candidate's gain, fx
/// or mute; track 2 stays at −6 dB so the plans differ audibly.
fn document(gain_db: f64, with_fx: bool, mute_first: bool) -> Project {
    let h = hash('a');
    let mut first = track_with("trk_01", gain_db, 0.0, mute_first, false);
    if with_fx {
        first["fx"] = json!([{
            "id": "fx_candidate", "type": "gain", "params": { "db": -6.0 }, "bypass": false
        }]);
    }
    let second = track_with("trk_02", -6.0, 0.0, false, false);
    project(
        vec![first, second],
        vec![section(
            "sec_a",
            SECTION_TICKS,
            json!({
                "trk_01": lane(vec![clip_none("clp_01", &h, 0, FRAMES as u64, 0)]),
                "trk_02": lane(vec![clip_none("clp_02", &h, 0, FRAMES as u64, 0)]),
            }),
        )],
    )
}

/// The four candidate plans, each audibly different from the others.
fn documents() -> Vec<Project> {
    vec![
        document(0.0, false, false),
        document(-6.0, false, false),
        document(0.0, true, false),
        document(0.0, false, true),
    ]
}

fn plans() -> Vec<RenderPlan> {
    let index = assets_with(&hash('a'), FRAMES as u64);
    documents()
        .iter()
        .enumerate()
        .map(|(version, doc)| compile(doc, &index, 48_000, version as u64 + 1).unwrap())
        .collect()
}

fn dbfs(value: f32) -> f32 {
    if value <= 0.0 {
        f32::NEG_INFINITY
    } else {
        20.0 * value.log10()
    }
}

fn left_step(samples: &[f32], frame: usize) -> f32 {
    if frame == 0 {
        return 0.0;
    }
    (samples[frame * 2] - samples[(frame - 1) * 2]).abs()
}

fn max_step(samples: &[f32], frames: impl Iterator<Item = usize>) -> f32 {
    frames.fold(0.0, |max, frame| max.max(left_step(samples, frame)))
}

/// The WP-2.2 / 07 §10 check 4 metric: no step inside a switch window may
/// exceed the signal's own maximum step elsewhere by more than -40 dBFS.
fn assert_no_switch_step(samples: &[f32], switches: &[usize]) {
    let frames = samples.len() / 2;
    let inside = |frame: usize| {
        switches.iter().any(|switch| {
            frame >= switch.saturating_sub(FADE_FRAMES) && frame <= switch + FADE_FRAMES
        })
    };
    let at_switches = max_step(
        samples,
        switches
            .iter()
            .flat_map(|switch| {
                switch.saturating_sub(FADE_FRAMES)..=(*switch + FADE_FRAMES).min(frames - 1)
            })
            .collect::<Vec<_>>()
            .into_iter(),
    );
    let elsewhere = max_step(samples, (1..frames).filter(|frame| !inside(*frame)));
    println!(
        "audition step: at switches {:.2} dBFS, elsewhere {:.2} dBFS",
        dbfs(at_switches),
        dbfs(elsewhere)
    );
    assert!(
        at_switches <= elsewhere + 0.01,
        "switch step {} > {} + 0.01",
        dbfs(at_switches),
        dbfs(elsewhere)
    );
}

/// Renders an engine for `frames`, calling `audition` at the block whose first
/// sample is the key of `switches`. Returns the output and the playhead after
/// every block.
fn render_switches(
    engine: &mut Engine,
    pcm: &dyn bragi_engine::pcm::PcmSource,
    frames: usize,
    switches: &[(usize, usize)],
) -> (Vec<f32>, Vec<u64>) {
    let mut left = vec![0.0f32; BLOCK];
    let mut right = vec![0.0f32; BLOCK];
    let mut out = Vec::with_capacity(frames * 2);
    let mut playheads = Vec::with_capacity(frames / BLOCK);
    let mut rendered = 0usize;
    while rendered < frames {
        if let Some((_, slot)) = switches.iter().find(|(at, _)| *at == rendered) {
            assert!(engine.audition(Some(*slot)));
        }
        let count = (frames - rendered).min(BLOCK);
        engine.process(pcm, &mut [&mut left[..count], &mut right[..count]]);
        for index in 0..count {
            out.push(left[index]);
            out.push(right[index]);
        }
        rendered += count;
        playheads.push(engine.transport().playhead());
    }
    (out, playheads)
}

#[test]
fn four_warm_plans_switch_without_a_step_at_any_random_playhead() {
    let plans = plans();
    let source = pcm(&hash('a'), tone(FRAMES, 220.0, 0.5));
    let mut engine = Engine::new(plans[0].clone(), BLOCK);
    for (slot, plan) in plans.iter().enumerate().take(MAX_WARM_PLANS).skip(1) {
        assert!(engine.warm(slot, plan.clone()));
    }
    engine.transport_mut().play();

    // Deterministic "random" playheads: an LCG picks block-aligned switch
    // points across the fixture, cycling through every candidate slot.
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    let mut switches = Vec::new();
    let mut at = 24 * BLOCK;
    for slot in [1usize, 2, 3, 0, 2, 1, 3, 0] {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let blocks = 8 + (state >> 33) as usize % 24;
        at += blocks * BLOCK;
        if at + FADE_FRAMES >= FRAMES {
            break;
        }
        switches.push((at, slot));
    }
    assert!(switches.len() >= 6, "enough switch points");

    let (out, playheads) = render_switches(&mut engine, &source, FRAMES, &switches);

    // The playhead advances by exactly one block per call, across every switch.
    for (index, playhead) in playheads.iter().enumerate() {
        assert_eq!(*playhead, ((index + 1) * BLOCK) as u64);
    }
    assert_eq!(
        engine.transport().playhead(),
        (FRAMES / BLOCK * BLOCK) as u64
    );

    assert_no_switch_step(
        &out,
        &switches.iter().map(|(at, _)| *at).collect::<Vec<_>>(),
    );
}

#[test]
fn a_hard_cut_fails_the_same_step_metric() {
    // The check has teeth: concatenating two plans at a sample without a fade
    // leaves the gain jump between them.
    let plans = plans();
    let source = pcm(&hash('a'), tone(FRAMES, 220.0, 0.5));
    // A quarter period past a peak of the 220 Hz tone, where the two levels
    // differ most.
    let switch = 24_164usize;

    let mut before = Renderer::new(std::sync::Arc::new(plans[0].clone()), BLOCK);
    before.transport_mut().play();
    let mut left = vec![0.0f32; BLOCK];
    let mut right = vec![0.0f32; BLOCK];
    let mut out = Vec::with_capacity(FRAMES * 2);
    let mut rendered = 0usize;
    while rendered < switch {
        let count = (switch - rendered).min(BLOCK);
        before.process(&source, &mut [&mut left[..count], &mut right[..count]]);
        for index in 0..count {
            out.push(left[index]);
            out.push(right[index]);
        }
        rendered += count;
    }
    let mut after = Renderer::new(std::sync::Arc::new(plans[1].clone()), BLOCK);
    after.transport_mut().seek(switch as u64);
    after.transport_mut().play();
    let mut rendered = switch;
    while rendered < FRAMES {
        let count = (FRAMES - rendered).min(BLOCK);
        after.process(&source, &mut [&mut left[..count], &mut right[..count]]);
        for index in 0..count {
            out.push(left[index]);
            out.push(right[index]);
        }
        rendered += count;
    }

    let frames = out.len() / 2;
    let inside =
        |frame: usize| frame >= switch.saturating_sub(FADE_FRAMES) && frame <= switch + FADE_FRAMES;
    let at = max_step(
        &out,
        switch - FADE_FRAMES..=(switch + FADE_FRAMES).min(frames - 1),
    );
    let elsewhere = max_step(&out, (1..frames).filter(|frame| !inside(*frame)));
    println!(
        "hard-cut step: at switch {:.2} dBFS, elsewhere {:.2} dBFS",
        dbfs(at),
        dbfs(elsewhere)
    );
    assert!(
        at > elsewhere + 0.01,
        "a hard cut should fail the metric: {} vs {}",
        dbfs(at),
        dbfs(elsewhere)
    );
}

#[test]
fn the_crossfade_lasts_thirty_milliseconds_and_the_playhead_is_continuous() {
    // DC makes the equal-power envelope directly observable.
    let h = hash('b');
    let document = |gain_db: f64| {
        project(
            vec![track_with("trk_01", gain_db, 0.0, false, false)],
            vec![section(
                "sec_a",
                SECTION_TICKS,
                json!({ "trk_01": lane(vec![clip_none("clp_01", &h, 0, FRAMES as u64, 0)]) }),
            )],
        )
    };
    let index = assets_with(&h, FRAMES as u64);
    let first = compile(&document(0.0), &index, 48_000, 1).unwrap();
    let second = compile(&document(-6.0), &index, 48_000, 2).unwrap();
    let source = pcm(&h, dc(FRAMES, 0.5));

    let mut engine = Engine::new(first, BLOCK);
    assert!(engine.warm(1, second));
    engine.transport_mut().play();
    let switch = 40 * BLOCK;
    let (out, playheads) = render_switches(&mut engine, &source, FRAMES, &[(switch, 1)]);

    let level = |frame: usize| out[frame * 2];
    let target = 0.5 * 10f32.powf(-6.0 / 20.0);
    assert!((level(switch - 1) - 0.5).abs() < 1e-5);
    // Equal-power midpoint and the end of the fade. The crossfade's first frame
    // is 1/1440 through the curve, so frame `switch + k` uses `x = (k + 1) / n`.
    let midpoint_at = |offset: usize| {
        let x = (offset + 1) as f32 / FADE_FRAMES as f32;
        let fade_in = (x * std::f32::consts::FRAC_PI_2).sin();
        let fade_out = (x * std::f32::consts::FRAC_PI_2).cos();
        0.5 * fade_out + target * fade_in
    };
    let midpoint = midpoint_at(FADE_FRAMES / 2);
    assert!(
        (level(switch + FADE_FRAMES / 2) - midpoint).abs() < 1e-4,
        "midpoint {} vs {midpoint}",
        level(switch + FADE_FRAMES / 2)
    );
    assert!(
        level(switch + FADE_FRAMES - 2) > target + 1e-4,
        "the crossfade is still running one frame before its end: {}",
        level(switch + FADE_FRAMES - 2)
    );
    assert!(
        (level(switch + FADE_FRAMES) - target).abs() < 1e-5,
        "the target is reached after exactly 30 ms: {}",
        level(switch + FADE_FRAMES)
    );
    // 30 ms ± one block: nothing longer than that is mixed.
    assert!(
        (level(switch + FADE_FRAMES + BLOCK) - target).abs() < 1e-5,
        "the fade never outlasts one extra block"
    );

    for (index, playhead) in playheads.iter().enumerate() {
        assert_eq!(*playhead, ((index + 1) * BLOCK) as u64);
    }
}

#[test]
fn a_switch_during_a_running_crossfade_is_click_free() {
    let plans = plans();
    let source = pcm(&hash('a'), tone(FRAMES, 220.0, 0.5));
    let mut engine = Engine::new(plans[0].clone(), BLOCK);
    for (slot, plan) in plans.iter().enumerate().take(MAX_WARM_PLANS).skip(1) {
        assert!(engine.warm(slot, plan.clone()));
    }
    engine.transport_mut().play();

    let first = 40 * BLOCK;
    let second = first + 5 * BLOCK; // 640 frames into the 1440-frame fade
    assert!(second - first < FADE_FRAMES);
    let (out, playheads) = render_switches(
        &mut engine,
        &source,
        FRAMES,
        &[(first, 1), (second, 2), (second + 20 * BLOCK, 3)],
    );
    assert_no_switch_step(&out, &[first, second, second + 20 * BLOCK]);
    for (index, playhead) in playheads.iter().enumerate() {
        assert_eq!(*playhead, ((index + 1) * BLOCK) as u64);
    }
}

#[test]
fn a_switch_into_a_stretched_plan_reprimes_without_a_dip() {
    // A ratio-0.75 candidate exercises the phase vocoder's re-prime path: the
    // first audible frame after activation must already carry the source, not
    // `latency()` frames of silence.
    let h = hash('c');
    let document = |stretch: bool| {
        let clip = if stretch {
            clip(
                "clp_01",
                &h,
                0,
                FRAMES as u64,
                0,
                json!({ "mode": "stretch", "ratio": 0.75 }),
                0,
                0,
                0.0,
            )
        } else {
            clip_none("clp_01", &h, 0, FRAMES as u64, 0)
        };
        project(
            vec![track("trk_01")],
            vec![section(
                "sec_a",
                SECTION_TICKS,
                json!({ "trk_01": lane(vec![clip]) }),
            )],
        )
    };
    let index = assets_with(&h, FRAMES as u64);
    let main = compile(&document(false), &index, 48_000, 1).unwrap();
    let candidate = compile(&document(true), &index, 48_000, 2).unwrap();
    let source = pcm(&h, dc(FRAMES, 0.5));
    let mut engine = Engine::new(main, 128);
    assert!(engine.warm(1, candidate));
    engine.transport_mut().play();
    let switch = 40 * BLOCK;
    let (out, _) = render_switches(&mut engine, &source, switch + 6_000, &[(switch, 1)]);
    // A DC source through the vocoder is not sample-exact, but the plan is
    // audible from the first crossfade block on: no block of silence.
    for frame in switch..switch + BLOCK {
        assert!(
            out[frame * 2].abs() > 1e-4,
            "frame {frame} is silent after the switch"
        );
    }
}

#[test]
fn auditioning_the_main_plan_clears_the_overlay_flag() {
    let plans = plans();
    let mut engine = Engine::new(plans[0].clone(), BLOCK);
    assert!(engine.warm(1, plans[1].clone()));
    assert!(!engine.transport().is_auditioning());
    assert!(engine.audition(Some(1)));
    assert!(engine.transport().is_auditioning());
    assert!(engine.audition(None));
    let source = pcm(&hash('a'), tone(FRAMES, 220.0, 0.5));
    let mut left = vec![0.0f32; BLOCK];
    let mut right = vec![0.0f32; BLOCK];
    for _ in 0..((FADE_FRAMES / BLOCK) + 2) {
        engine.process(&source, &mut [&mut left, &mut right]);
    }
    assert!(!engine.transport().is_auditioning(), "the fade is over");
    assert!(!engine.audition(Some(2)), "slot 2 was never warmed");
}

#[test]
fn an_idle_slot_can_be_warmed_again_but_not_while_it_fades_out() {
    let plans = plans();
    let mut engine = Engine::new(plans[0].clone(), BLOCK);
    assert!(engine.warm(1, plans[1].clone()));
    // Replacing an idle warm plan succeeds (a new candidate group reuses the slots).
    assert!(engine.warm(1, plans[2].clone()));
    engine.transport_mut().play();
    assert!(engine.audition(Some(1)));
    let source = pcm(&hash('a'), tone(FRAMES, 220.0, 0.5));
    let mut left = vec![0.0f32; BLOCK];
    let mut right = vec![0.0f32; BLOCK];
    for _ in 0..((FADE_FRAMES / BLOCK) + 2) {
        engine.process(&source, &mut [&mut left, &mut right]);
    }
    assert!(!engine.warm(1, plans[3].clone()), "slot 1 is audible");
    assert!(engine.audition(None));
    engine.process(&source, &mut [&mut left, &mut right]);
    assert!(
        !engine.warm(1, plans[3].clone()),
        "slot 1 is still fading out"
    );
    for _ in 0..((FADE_FRAMES / BLOCK) + 2) {
        engine.process(&source, &mut [&mut left, &mut right]);
    }
    assert!(engine.warm(1, plans[3].clone()), "the fade is over");
}

/// `SAMPLE_RATE` is the rate the crossfade length above assumes.
#[test]
fn the_crossfade_constant_matches_the_sample_rate() {
    assert_eq!(FADE_FRAMES, 1_440);
    assert_eq!(SAMPLE_RATE, 48_000);
}
