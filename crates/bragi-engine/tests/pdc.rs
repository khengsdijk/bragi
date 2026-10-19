//! Plugin delay compensation (03 §6, §9).
//!
//! Saturation reports 30 frames of oversampling latency and the limiter 240
//! frames of look-ahead. Without compensation a saturated track would play
//! late relative to the dry tracks; the renderer delays the faster tracks to the
//! slowest one, and offline renders trim the total latency so the file stays
//! aligned with the timeline.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

mod common;

use std::sync::Arc;

use bragi_engine::offline::{OfflineOptions, render};
use bragi_engine::plan::compile;
use bragi_engine::render::Renderer;
use bragi_model::generated::{AssetHash, FxInstance, Project};
use bragi_model::{AssetIndex, diff};
use common::*;
use serde_json::json;

const IMPULSE: usize = 1_000;
const AMPLITUDE: f32 = 0.2;
const RANGE: u64 = 4_000;

fn saturation(bypass: bool) -> FxInstance {
    fx_instance("fx_sat", "saturation", &[], bypass)
}

fn limiter() -> FxInstance {
    fx_instance("fx_lim", "limiter", &[], false)
}

fn two_track_document(hash: &AssetHash) -> Project {
    project(
        vec![
            track_with("trk_dry", 0.0, 1.0, false, false),
            track_with("trk_sat", 0.0, -1.0, false, false),
        ],
        vec![section(
            "sec_a",
            BAR_TICKS * 5,
            json!({
                "trk_dry": lane(vec![clip_none("clp_dry", hash, 0, 48_000, 0)]),
                "trk_sat": lane(vec![clip_none("clp_sat", hash, 0, 48_000, 0)]),
            }),
        )],
    )
}

fn one_track_document(hash: &AssetHash) -> Project {
    project(
        vec![track("trk_01")],
        vec![section(
            "sec_a",
            BAR_TICKS * 5,
            json!({ "trk_01": lane(vec![clip_none("clp_01", hash, 0, 48_000, 0)]) }),
        )],
    )
}

fn source(hash: &AssetHash) -> bragi_engine::pcm::MemoryPcm {
    pcm(hash, impulses(48_000, &[(IMPULSE, AMPLITUDE)]))
}

fn assets_for(hash: &AssetHash) -> AssetIndex {
    assets(hash, 48_000)
}

/// The frame of the largest absolute sample in one channel.
fn peak_frame(samples: &[f32], channel: usize) -> usize {
    let mut best = 0usize;
    let mut best_value = 0.0f32;
    for (frame, pair) in samples.as_chunks::<2>().0.iter().enumerate() {
        let value = pair[channel].abs();
        if value > best_value {
            best_value = value;
            best = frame;
        }
    }
    best
}

#[test]
fn a_saturated_track_and_a_dry_track_impulse_peak_at_the_same_frame() {
    let hash = hash('a');
    let mut doc = two_track_document(&hash);
    doc.tracks[1].fx.0.push(saturation(false));
    let plan = compile(&doc, &assets_for(&hash), 48_000, 1).unwrap();
    assert!(
        plan.warnings.is_empty(),
        "saturation should not warn: {:?}",
        plan.warnings
    );

    // Panning puts the saturated track in the left channel and the dry one in
    // the right, so each peak can be measured on its own.
    let out = render(&plan, &source(&hash), &OfflineOptions::range(0, RANGE));
    let saturated = peak_frame(&out.samples, 0);
    let dry = peak_frame(&out.samples, 1);
    println!("peaks: saturated {saturated}, dry {dry}");
    assert_eq!(
        saturated, dry,
        "PDC must align the saturated track with the dry one"
    );
    assert_eq!(
        saturated, IMPULSE,
        "the offline render is sample-aligned with the timeline"
    );
}

#[test]
fn the_saturation_latency_is_thirty_frames() {
    let hash = hash('a');
    let mut doc = two_track_document(&hash);
    doc.tracks[1].fx.0.push(saturation(false));
    let plan = compile(&doc, &assets_for(&hash), 48_000, 1).unwrap();
    let latency = Renderer::new(Arc::new(plan), 128).output_latency_frames();
    println!("saturation output latency: {latency} frames");
    assert_eq!(latency, 30);
}

#[test]
fn a_master_limiter_keeps_the_impulse_on_the_timeline() {
    let hash = hash('a');
    let mut doc = one_track_document(&hash);
    doc.arrangement.master.fx.0.push(limiter());
    let plan = compile(&doc, &assets_for(&hash), 48_000, 1).unwrap();
    assert_eq!(
        Renderer::new(Arc::new(plan.clone()), 128).output_latency_frames(),
        240,
        "the master limiter's look-ahead is the whole output latency"
    );

    let out = render(&plan, &source(&hash), &OfflineOptions::range(0, RANGE));
    let peak = peak_frame(&out.samples, 0);
    println!("limiter impulse: {peak} (timeline {IMPULSE})");
    assert!(
        peak.abs_diff(IMPULSE) <= 1,
        "the limiter must not shift the impulse: {peak} vs {IMPULSE}"
    );
}

#[test]
fn bypassing_saturation_removes_its_latency() {
    let hash = hash('a');
    let mut doc = two_track_document(&hash);
    doc.tracks[1].fx.0.push(saturation(true));
    let plan = compile(&doc, &assets_for(&hash), 48_000, 1).unwrap();
    let latency = Renderer::new(Arc::new(plan.clone()), 128).output_latency_frames();
    println!("bypassed saturation output latency: {latency} frames");
    assert_eq!(latency, 0);

    // A plan with no fx and the bypassed one produce the same buffered output.
    let dry_doc = two_track_document(&hash);
    let dry = compile(&dry_doc, &assets_for(&hash), 48_000, 1).unwrap();
    let bypassed = render(&plan, &source(&hash), &OfflineOptions::range(0, RANGE));
    let reference = render(&dry, &source(&hash), &OfflineOptions::range(0, RANGE));
    assert_eq!(bypassed.samples, reference.samples);
}

#[test]
fn a_latency_change_across_a_plan_swap_keeps_rendering() {
    let hash = hash('a');
    let mut before_doc = two_track_document(&hash);
    before_doc.tracks[1].fx.0.push(saturation(false));
    let after_doc = two_track_document(&hash);
    let index = assets_for(&hash);
    let before = compile(&before_doc, &index, 48_000, 1).unwrap();
    let delta = diff(&before_doc, &after_doc);
    let after = compile_delta_for(&before, &after_doc, &index, &delta);

    let mut renderer = Renderer::new(Arc::new(before), 128);
    renderer.transport_mut().play();
    let source = source(&hash);
    let mut left = [0.0f32; 128];
    let mut right = [0.0f32; 128];
    for _ in 0..20 {
        renderer.process(&source, &mut [&mut left, &mut right]);
    }
    assert_eq!(renderer.output_latency_frames(), 30);

    let prepared = bragi_engine::render::PreparedPlan::new(
        Arc::new(after),
        bragi_engine::plan::quality_for(false),
        128,
    );
    renderer.set_prepared(prepared);
    assert_eq!(renderer.output_latency_frames(), 0);
    renderer.process(&source, &mut [&mut left, &mut right]);
    assert!(
        left.iter()
            .chain(right.iter())
            .all(|sample| sample.is_finite())
    );
}

fn compile_delta_for(
    before: &bragi_engine::plan::RenderPlan,
    doc: &Project,
    index: &AssetIndex,
    delta: &bragi_model::EngineDelta,
) -> bragi_engine::plan::RenderPlan {
    bragi_engine::plan::compile_delta(before, doc, index, delta).unwrap()
}
