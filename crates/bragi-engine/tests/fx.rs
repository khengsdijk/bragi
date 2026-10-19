//! FX catalogue integration with the render plan and mixer (WP-2.3).
//!
//! Every test uses `gain`, the reference effect that always exists; the
//! unimplemented-kind test discovers whatever `create` cannot build yet, so it
//! keeps covering the bypass path as the parallel effect batches land.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

mod common;

use std::sync::Arc;

use bragi_dsp::fx::{FxKind, create};
use bragi_engine::offline::{OfflineOptions, render};
use bragi_engine::pcm::PcmSource;
use bragi_engine::plan::{compile, compile_delta, quality_for};
use bragi_engine::render::{PreparedPlan, Renderer};
use bragi_model::generated::Project;
use bragi_model::{AssetIndex, diff};
use common::*;
use serde_json::json;

const BLOCK: usize = 128;

fn document_with_track_fx(fx: Vec<bragi_model::generated::FxInstance>) -> Project {
    let h = hash('a');
    let mut doc = project(
        vec![track("trk_01")],
        vec![section(
            "sec_a",
            BAR_TICKS * 5,
            json!({ "trk_01": lane(vec![clip_none("clp_01", &h, 0, 480_000, 0)]) }),
        )],
    );
    doc.tracks[0].fx.0.extend(fx);
    doc
}

fn assets_for() -> AssetIndex {
    assets(&hash('a'), 480_000)
}

fn rms(samples: &[f32]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples
        .iter()
        .map(|sample| f64::from(*sample) * f64::from(*sample))
        .sum();
    (sum / samples.len() as f64).sqrt()
}

#[test]
fn a_track_gain_effect_is_six_db_quieter_after_settling() {
    let h = hash('a');
    let source = pcm(&h, dc(480_000, 0.5));
    let dry = compile(
        &document_with_track_fx(Vec::new()),
        &assets_for(),
        48_000,
        1,
    )
    .unwrap();
    let wet = compile(
        &document_with_track_fx(vec![fx_instance("fx_gain", "gain", &[("db", -6.0)], false)]),
        &assets_for(),
        48_000,
        1,
    )
    .unwrap();

    let dry_out = render(&dry, &source, &OfflineOptions::default()).samples;
    let wet_out = render(&wet, &source, &OfflineOptions::default()).samples;
    // Skip the first 0.1 s so the effect and fader are fully settled.
    let settled = 4_800 * 2;
    let level = 20.0 * (rms(&wet_out[settled..]) / rms(&dry_out[settled..])).log10();
    println!("gain -6 dB effect: {level:.4} dB relative");
    assert!(
        (level + 6.0).abs() <= 0.05,
        "expected -6.00 dB, measured {level:.4} dB"
    );
}

#[test]
fn a_bypassed_effect_is_bit_exact_identity() {
    let h = hash('a');
    let source = pcm(&h, tone(480_000, 220.0, 0.4));
    let dry = compile(
        &document_with_track_fx(Vec::new()),
        &assets_for(),
        48_000,
        1,
    )
    .unwrap();
    let bypassed = compile(
        &document_with_track_fx(vec![fx_instance("fx_gain", "gain", &[("db", -24.0)], true)]),
        &assets_for(),
        48_000,
        1,
    )
    .unwrap();
    let dry_out = render(&dry, &source, &OfflineOptions::default()).samples;
    let bypassed_out = render(&bypassed, &source, &OfflineOptions::default()).samples;
    assert_eq!(dry_out, bypassed_out);
}

#[test]
fn master_fx_runs_before_the_safety_limiter() {
    let h = hash('a');
    let source = pcm(&h, dc(48_000, 0.5));
    let mut doc = document_with_track_fx(Vec::new());
    doc.arrangement
        .master
        .fx
        .0
        .push(fx_instance("fx_master", "gain", &[("db", 12.0)], false));
    let plan = compile(&doc, &assets_for(), 48_000, 1).unwrap();

    let out = render(&plan, &source, &OfflineOptions::default());
    let ceiling = 10.0_f32.powf(-0.3 / 20.0);
    assert!(
        out.peak <= ceiling + 1e-6,
        "master fx must be limited: peak {} > ceiling {ceiling}",
        out.peak
    );
    assert!(
        out.peak > 0.9,
        "the +12 dB gain should drive the limiter, peak {}",
        out.peak
    );

    // Without the master fx the same source stays far below the ceiling, so
    // the assertion above really is about the fx-before-limiter order.
    let dry = compile(
        &document_with_track_fx(Vec::new()),
        &assets_for(),
        48_000,
        1,
    )
    .unwrap();
    let dry_out = render(&dry, &source, &OfflineOptions::default());
    assert!((dry_out.peak - 0.5).abs() < 1e-6);
}

#[test]
fn an_fx_update_glides_instead_of_resetting_the_effect() {
    let h = hash('a');
    let source = pcm(&h, dc(480_000, 0.5));
    let before_doc =
        document_with_track_fx(vec![fx_instance("fx_gain", "gain", &[("db", 0.0)], false)]);
    let after_doc = document_with_track_fx(vec![fx_instance(
        "fx_gain",
        "gain",
        &[("db", -12.0)],
        false,
    )]);
    let asset_index = assets_for();
    let before = compile(&before_doc, &asset_index, 48_000, 1).unwrap();
    let delta = diff(&before_doc, &after_doc);
    assert_eq!(delta.tracks_updated.len(), 1);
    let after = compile_delta(&before, &after_doc, &asset_index, &delta).unwrap();

    let mut renderer = Renderer::new(Arc::new(before), BLOCK);
    renderer.transport_mut().play();
    let mut left = vec![0.0f32; BLOCK];
    let mut right = vec![0.0f32; BLOCK];
    // Settle at 0 dB.
    for _ in 0..20 {
        renderer.process(&source, &mut [&mut left, &mut right]);
    }
    assert!((left[BLOCK - 1] - 0.5).abs() < 1e-6);

    let prepared = PreparedPlan::new(Arc::new(after), quality_for(false), BLOCK);
    renderer.set_prepared(prepared);

    // The same effect instance glides: the first block after the update is
    // still near the old level, not snapped to the new one. A rebuilt effect
    // would start at -12 dB (0.1255).
    renderer.process(&source, &mut [&mut left, &mut right]);
    let first = left[0];
    println!("first sample after fx.update: {first}");
    assert!(
        first > 0.45,
        "the update jumped to the new gain instead of gliding: {first}"
    );
    assert!(first < 0.5);

    // 30 ms later the glide has reached the new target.
    for _ in 0..12 {
        renderer.process(&source, &mut [&mut left, &mut right]);
    }
    let expected = 0.5 * 10.0_f32.powf(-12.0 / 20.0);
    assert!(
        (left[BLOCK - 1] - expected).abs() < 0.01,
        "expected {expected}, got {}",
        left[BLOCK - 1]
    );
}

#[test]
fn fx_automation_moves_a_gain_parameter_over_time() {
    let h = hash('a');
    let lane = json!({
        "clips": [clip_none("clp_01", &h, 0, 480_000, 0)],
        "automation": [{
            "target": "fx:fx_gain/db",
            "points": [
                { "tick": 0, "value": 0.0, "curve": "linear" },
                { "tick": BAR_TICKS * 4, "value": -60.0, "curve": "linear" }
            ]
        }]
    });
    let mut doc = project(
        vec![track("trk_01")],
        vec![section("sec_a", BAR_TICKS * 5, json!({ "trk_01": lane }))],
    );
    doc.tracks[0]
        .fx
        .0
        .push(fx_instance("fx_gain", "gain", &[("db", 0.0)], false));
    let plan = compile(&doc, &assets_for(), 48_000, 1).unwrap();
    assert!(plan.tracks[0].automation.iter().any(|lane| matches!(
        lane.target,
        bragi_engine::plan::AutomationTarget::FxParam { .. }
    )));

    let source = pcm(&h, dc(480_000, 0.5));
    let out = render(&plan, &source, &OfflineOptions::default()).samples;
    // 120 bpm / 48 kHz: one tick is exactly 25 samples, one bar 96 000.
    let samples_per_tick = 25usize;
    let start = out[0];
    let end = out[(4 * BAR_TICKS as usize * samples_per_tick) * 2];
    println!("fx automation: start {start}, four bars later {end}");
    assert!((start - 0.5).abs() < 0.01, "start {start}");
    assert!(end < 0.01, "the lane should reach -60 dB, got {end}");
    // Midway the parameter is between the endpoints (not a step).
    let middle = out[(2 * BAR_TICKS as usize * samples_per_tick) * 2];
    assert!(middle > end && middle < start, "middle {middle}");
}

#[test]
fn an_unimplemented_kind_bypasses_with_a_plan_warning() {
    let Some(kind) = FxKind::ALL
        .into_iter()
        .find(|kind| create(*kind, 48_000, BLOCK).is_err())
    else {
        // Every catalogue kind is implemented; nothing to bypass.
        return;
    };
    let h = hash('a');
    let source = pcm(&h, tone(48_000, 220.0, 0.4));
    let mut doc = document_with_track_fx(Vec::new());
    doc.tracks[0]
        .fx
        .0
        .push(fx_instance("fx_todo", kind.name(), &[], false));
    let plan = compile(&doc, &assets_for(), 48_000, 1).unwrap();
    assert!(
        plan.warnings
            .iter()
            .any(|warning| warning.contains("not implemented")),
        "missing warning: {:?}",
        plan.warnings
    );

    let dry = compile(
        &document_with_track_fx(Vec::new()),
        &assets_for(),
        48_000,
        1,
    )
    .unwrap();
    let with_todo = render(&plan, &source, &OfflineOptions::default()).samples;
    let dry_out = render(&dry, &source, &OfflineOptions::default()).samples;
    assert_eq!(with_todo, dry_out, "unimplemented fx must be bypassed");
}

/// A renderer over a plan, returning interleaved stereo.
fn renderer_output(renderer: &mut Renderer, source: &dyn PcmSource, frames: usize) -> Vec<f32> {
    let mut left = vec![0.0f32; BLOCK];
    let mut right = vec![0.0f32; BLOCK];
    let mut out = Vec::with_capacity(frames * 2);
    let mut done = 0;
    while done < frames {
        let count = (frames - done).min(BLOCK);
        renderer.process(source, &mut [&mut left[..count], &mut right[..count]]);
        for index in 0..count {
            out.push(left[index]);
            out.push(right[index]);
        }
        done += count;
    }
    out
}

#[test]
fn a_master_chain_with_two_gains_composes() {
    let h = hash('a');
    let source = pcm(&h, dc(48_000, 0.5));
    let mut doc = document_with_track_fx(Vec::new());
    doc.arrangement
        .master
        .fx
        .0
        .push(fx_instance("fx_m1", "gain", &[("db", -6.0)], false));
    doc.arrangement
        .master
        .fx
        .0
        .push(fx_instance("fx_m2", "gain", &[("db", -6.0)], false));
    let plan = compile(&doc, &assets_for(), 48_000, 1).unwrap();
    let mut renderer = Renderer::new(Arc::new(plan), BLOCK);
    renderer.transport_mut().play();
    let out = renderer_output(&mut renderer, &source, 12_000);
    let expected = 0.5 * 10.0_f32.powf(-12.0 / 20.0);
    let last = out[out.len() - 2];
    assert!((last - expected).abs() < 1e-4, "last {last}");
}
