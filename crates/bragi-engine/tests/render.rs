//! Render-plan and mixer behaviour: warp modes, fades, gains, pan, mute/solo,
//! reverse, automation, sections and delta recompilation.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::sync::Arc;

use bragi_engine::plan::{compile, compile_delta, db_to_gain};
use bragi_engine::render::{PreparedPlan, Renderer};
use bragi_model::EngineDelta;
use bragi_model::generated::AssetHash;
use common::*;
use serde_json::json;

fn plan_for(
    tracks: Vec<serde_json::Value>,
    sections: Vec<serde_json::Value>,
    hash: &AssetHash,
    frames: u64,
) -> bragi_engine::plan::RenderPlan {
    let doc = project(tracks, sections);
    compile(&doc, &assets(hash, frames), 48_000, 1).unwrap()
}

#[test]
fn none_warp_is_a_bit_exact_copy() {
    let hash = hash('0');
    let clip = clip_none("clp_01", &hash, 0, 48_000, 0);
    let plan = plan_for(
        vec![track("trk_01")],
        vec![section(
            "sec_a",
            BAR_TICKS,
            json!({ "trk_01": lane(vec![clip]) }),
        )],
        &hash,
        48_000,
    );
    let source = tone(48_000, 220.0, 0.5);
    let out = render_plan(&plan, &pcm(&hash, source.clone()), 48_000, 128);
    for frame in 0..48_000 {
        let (left, right) = source.frame(frame);
        assert_eq!(out[frame * 2], left, "left frame {frame}");
        assert_eq!(out[frame * 2 + 1], right, "right frame {frame}");
    }
}

#[test]
fn fade_in_starts_at_zero_and_reaches_unity() {
    let hash = hash('1');
    let clip = clip(
        "clp_01",
        &hash,
        0,
        48_000,
        0,
        json!({ "mode": "none" }),
        BEAT_TICKS,
        0,
        0.0,
    );
    let plan = plan_for(
        vec![track("trk_01")],
        vec![section(
            "sec_a",
            BAR_TICKS,
            json!({ "trk_01": lane(vec![clip]) }),
        )],
        &hash,
        48_000,
    );
    let out = render_plan(&plan, &pcm(&hash, dc(96_000, 0.5)), 48_000, 128);
    // One beat at 120 bpm is exactly 24 000 samples.
    assert_eq!(out[0], 0.0);
    assert!((out[12_000 * 2] - 0.5 * std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-5);
    assert_eq!(out[24_000 * 2], 0.5);
}

#[test]
fn fade_out_mirrors_the_fade_in() {
    let hash = hash('2');
    // Half a bar of audio, with a one-beat fade-out.
    let clip = clip(
        "clp_01",
        &hash,
        0,
        48_000,
        0,
        json!({ "mode": "none" }),
        0,
        BEAT_TICKS,
        0.0,
    );
    let plan = plan_for(
        vec![track("trk_01")],
        vec![section(
            "sec_a",
            BAR_TICKS,
            json!({ "trk_01": lane(vec![clip]) }),
        )],
        &hash,
        48_000,
    );
    let out = render_plan(&plan, &pcm(&hash, dc(48_000, 0.5)), 48_000, 128);
    assert_eq!(out[24_000 * 2], 0.5);
    assert!((out[36_000 * 2] - 0.5 * std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-5);
    assert!(out[47_999 * 2] < 0.01);
    assert!(out[40_000 * 2] < 0.5);
}

#[test]
fn clip_and_track_gains_multiply() {
    let hash = hash('3');
    let clip = clip(
        "clp_01",
        &hash,
        0,
        48_000,
        0,
        json!({ "mode": "none" }),
        0,
        0,
        -6.0,
    );
    let plan = plan_for(
        vec![track_with("trk_01", -6.0, 0.0, false, false)],
        vec![section(
            "sec_a",
            BAR_TICKS,
            json!({ "trk_01": lane(vec![clip]) }),
        )],
        &hash,
        48_000,
    );
    let out = render_plan(&plan, &pcm(&hash, dc(48_000, 0.5)), 1_024, 128);
    let expected = 0.5 * db_to_gain(-6.0) * db_to_gain(-6.0);
    assert!((out[0] - expected).abs() < 1e-6, "got {}", out[0]);
}

#[test]
fn pan_is_a_balance_law() {
    let hash = hash('4');
    let clip = clip_none("clp_01", &hash, 0, 48_000, 0);
    let plan = plan_for(
        vec![track_with("trk_01", 0.0, -1.0, false, false)],
        vec![section(
            "sec_a",
            BAR_TICKS,
            json!({ "trk_01": lane(vec![clip]) }),
        )],
        &hash,
        48_000,
    );
    let out = render_plan(&plan, &pcm(&hash, dc(48_000, 0.5)), 256, 128);
    assert!((out[0] - 0.5).abs() < 1e-6);
    assert_eq!(out[1], 0.0);
}

#[test]
fn mute_and_solo_are_resolved_at_plan_compile() {
    let hash = hash('5');
    let clip_a = clip_none("clp_a", &hash, 0, 48_000, 0);
    let clip_b = clip_none("clp_b", &hash, 0, 48_000, 0);
    let plan = plan_for(
        vec![
            track_with("trk_01", 0.0, 0.0, true, false),
            track_with("trk_02", 0.0, 0.0, false, false),
        ],
        vec![section(
            "sec_a",
            BAR_TICKS,
            json!({ "trk_01": lane(vec![clip_a.clone()]), "trk_02": lane(vec![clip_b.clone()]) }),
        )],
        &hash,
        48_000,
    );
    let out = render_plan(&plan, &pcm(&hash, dc(48_000, 0.25)), 256, 128);
    assert!((out[0] - 0.25).abs() < 1e-6, "only track 2 should sound");

    let plan = plan_for(
        vec![
            track_with("trk_01", 0.0, 0.0, false, true),
            track_with("trk_02", 0.0, 0.0, false, false),
        ],
        vec![section(
            "sec_a",
            BAR_TICKS,
            json!({ "trk_01": lane(vec![clip_a]), "trk_02": lane(vec![clip_b]) }),
        )],
        &hash,
        48_000,
    );
    let out = render_plan(&plan, &pcm(&hash, dc(48_000, 0.25)), 256, 128);
    assert!(
        (out[0] - 0.25).abs() < 1e-6,
        "only the soloed track should sound, got {}",
        out[0]
    );
}

#[test]
fn beatgrid_with_matching_tempo_is_the_direct_path() {
    let hash = hash('6');
    let clip = clip(
        "clp_01",
        &hash,
        0,
        48_000,
        0,
        beatgrid(&[(0, 0), (48_000, 1920)]),
        0,
        0,
        0.0,
    );
    let plan = plan_for(
        vec![track("trk_01")],
        vec![section(
            "sec_a",
            BAR_TICKS,
            json!({ "trk_01": lane(vec![clip]) }),
        )],
        &hash,
        48_000,
    );
    let segment = &plan.tracks[0].segments[0];
    assert_eq!(segment.dst_start, 0);
    assert_eq!(segment.dst_end, 48_000);
    assert!(!segment.needs_stretcher());
    let source = tone(48_000, 220.0, 0.5);
    let out = render_plan(&plan, &pcm(&hash, source.clone()), 48_000, 128);
    for frame in 0..48_000 {
        assert_eq!(out[frame * 2], source.frame(frame).0, "frame {frame}");
    }
}

#[test]
fn beatgrid_at_half_tempo_uses_the_stretcher_and_doubles_the_length() {
    let hash = hash('7');
    let clip = clip(
        "clp_01",
        &hash,
        0,
        48_000,
        0,
        beatgrid(&[(0, 0), (48_000, 3840)]),
        0,
        0,
        0.0,
    );
    let plan = plan_for(
        vec![track("trk_01")],
        vec![section(
            "sec_a",
            BAR_TICKS * 2,
            json!({ "trk_01": lane(vec![clip]) }),
        )],
        &hash,
        48_000,
    );
    let segment = &plan.tracks[0].segments[0];
    assert_eq!(segment.dst_end, 96_000);
    assert!((segment.ratio - 2.0).abs() < 1e-9);
    let prepared = PreparedPlan::new(
        Arc::new(plan.clone()),
        bragi_engine::plan::quality_for(true),
        256,
    );
    assert!(prepared.runtimes()[0].stretcher.is_some());

    let out = render_plan(&plan, &pcm(&hash, tone(48_000, 220.0, 0.5)), 96_000, 256);
    assert!(out.iter().all(|sample| sample.is_finite()));
    assert!(out.iter().any(|sample| sample.abs() > 0.1));
    // The vocoder has latency but the segment is written for its full length.
    assert_eq!(out.len(), 96_000 * 2);
}

#[test]
fn stretch_warp_overrides_the_clip_length() {
    let hash = hash('8');
    let clip = clip(
        "clp_01",
        &hash,
        0,
        48_000,
        0,
        json!({ "mode": "stretch", "ratio": 2.0 }),
        0,
        0,
        0.0,
    );
    let plan = plan_for(
        vec![track("trk_01")],
        vec![section(
            "sec_a",
            BAR_TICKS,
            json!({ "trk_01": lane(vec![clip]) }),
        )],
        &hash,
        48_000,
    );
    assert_eq!(plan.tracks[0].segments[0].dst_end, 24_000);
}

#[test]
fn sections_offset_clips_in_absolute_samples() {
    let hash = hash('9');
    let clip_a = clip_none("clp_a", &hash, 0, 48_000, 0);
    let clip_b = clip_none("clp_b", &hash, 0, 48_000, 0);
    let plan = plan_for(
        vec![track("trk_01")],
        vec![
            section("sec_a", BAR_TICKS, json!({ "trk_01": lane(vec![clip_a]) })),
            section("sec_b", BAR_TICKS, json!({ "trk_01": lane(vec![clip_b]) })),
        ],
        &hash,
        48_000,
    );
    assert_eq!(plan.length_samples, 192_000);
    assert_eq!(plan.tracks[0].segments[1].dst_start, 96_000);
    assert_eq!(plan.sections[1].start, 96_000);
}

#[test]
fn reverse_reads_the_source_backwards() {
    let hash = hash('a');
    let mut clip = clip_none("clp_01", &hash, 0, 100, 0);
    clip["reverse"] = json!(true);
    let plan = plan_for(
        vec![track("trk_01")],
        vec![section("sec_a", 4, json!({ "trk_01": lane(vec![clip]) }))],
        &hash,
        100,
    );
    // 100 samples at 48 kHz is 2 ticks at 120 bpm; keep the section long enough.
    let source = impulses(100, &[(0, 0.5), (99, 0.25)]);
    let out = render_plan(&plan, &pcm(&hash, source), 2, 2);
    assert!(
        (out[0] - 0.25).abs() < 1e-6,
        "reversed first frame is source 99"
    );
}

#[test]
fn beatgrid_splits_where_the_rate_changes_and_coalesces_equal_pieces() {
    let hash = hash('b');
    let clip = clip(
        "clp_01",
        &hash,
        0,
        96_000,
        0,
        beatgrid(&[(0, 0), (48_000, 1920), (96_000, 3840)]),
        0,
        0,
        0.0,
    );
    let plan = plan_for(
        vec![track("trk_01")],
        vec![section(
            "sec_a",
            BAR_TICKS * 2,
            json!({ "trk_01": lane(vec![clip]) }),
        )],
        &hash,
        96_000,
    );
    // The two anchors have the same rate, so the pieces coalesce into one.
    assert_eq!(plan.tracks[0].segments.len(), 1);
    assert_eq!(plan.tracks[0].segments[0].dst_end, 96_000);
}

#[test]
fn track_automation_ramps_the_gain() {
    let hash = hash('c');
    let clip = clip_none("clp_01", &hash, 0, 480_000, 0);
    let lane = lane_with_gain(vec![clip], &[(0, 0.0), ((BAR_TICKS * 4) as i64, -60.0)]);
    let plan = plan_for(
        vec![track("trk_01")],
        vec![section("sec_a", BAR_TICKS * 5, json!({ "trk_01": lane }))],
        &hash,
        480_000,
    );
    let out = render_plan(&plan, &pcm(&hash, dc(480_000, 0.5)), 480_000, 512);
    assert!((out[0] - 0.5).abs() < 0.01, "start: {}", out[0]);
    let end = out[(479_000) * 2];
    assert!(end < 0.01, "after the ramp: {end}");
}

#[test]
fn delta_recompilation_bumps_the_version_and_keeps_other_tracks() {
    let hash = hash('d');
    let clip_a = clip_none("clp_a", &hash, 0, 48_000, 0);
    let clip_b = clip_none("clp_b", &hash, 0, 48_000, 0);
    let before_doc = project(
        vec![track("trk_01"), track("trk_02")],
        vec![section(
            "sec_a",
            BAR_TICKS,
            json!({ "trk_01": lane(vec![clip_a]), "trk_02": lane(vec![clip_b]) }),
        )],
    );
    let assets = assets(&hash, 48_000);
    let before = compile(&before_doc, &assets, 48_000, 1).unwrap();
    let after_doc = project(
        vec![
            track_with("trk_01", -6.0, 0.0, false, false),
            track("trk_02"),
        ],
        vec![section(
            "sec_a",
            BEAT_TICKS,
            json!({
                "trk_01": lane(vec![clip_none("clp_a", &hash, 0, 48_000, 0)]),
                "trk_02": lane(vec![clip_none("clp_b", &hash, 0, 48_000, 0)])
            }),
        )],
    );
    let delta = EngineDelta {
        project_id: after_doc.id.clone(),
        timebase_changed: false,
        meta_changed: false,
        sources_added: vec![],
        sources_removed: vec![],
        tracks_added: vec![],
        tracks_removed: vec![],
        tracks_updated: vec![after_doc.tracks[0].clone()],
        sections_added: vec![],
        sections_removed: vec![],
        sections_updated: vec![],
        master_changed: false,
        requires_full_resync: false,
    };
    let after = compile_delta(&before, &after_doc, &assets, &delta).unwrap();
    assert_eq!(after.plan_version, 2);
    assert_eq!(after.tracks.len(), 2);
    assert!((after.tracks[0].gain - db_to_gain(-6.0)).abs() < 1e-6);
    assert_eq!(after.tracks[0].segments.len(), 1);
    assert_eq!(after.tracks[1].segments.len(), 1);
}

#[test]
fn missing_asset_is_a_structured_error() {
    let hash = hash('e');
    let doc = project(
        vec![track("trk_01")],
        vec![section(
            "sec_a",
            BEAT_TICKS,
            json!({ "trk_01": lane(vec![clip_none("clp_01", &hash, 0, 48_000, 0)]) }),
        )],
    );
    let error = compile(&doc, &bragi_model::AssetIndex::new(), 48_000, 1).unwrap_err();
    assert!(matches!(error, bragi_engine::PlanError::MissingAsset(_)));
}

#[test]
fn a_vocoder_segment_is_finite_and_reset_safe() {
    let hash = hash('f');
    let clip = clip(
        "clp_01",
        &hash,
        0,
        48_000,
        0,
        json!({ "mode": "stretch", "ratio": 0.5 }),
        0,
        0,
        0.0,
    );
    let plan = plan_for(
        vec![track("trk_01")],
        vec![section(
            "sec_a",
            BAR_TICKS,
            json!({ "trk_01": lane(vec![clip]) }),
        )],
        &hash,
        48_000,
    );
    let mut renderer = Renderer::new(Arc::new(plan), 128);
    renderer.transport_mut().play();
    let pcm = pcm(&hash, tone(48_000, 220.0, 0.5));
    let mut left = vec![0.0f32; 128];
    let mut right = vec![0.0f32; 128];
    for _ in 0..20 {
        renderer.process(&pcm, &mut [&mut left, &mut right]);
        assert!(
            left.iter()
                .chain(right.iter())
                .all(|sample| sample.is_finite())
        );
    }
    // Seek in the middle: the stream state must re-prime without panicking.
    renderer.transport_mut().seek(10_000);
    renderer.process(&pcm, &mut [&mut left, &mut right]);
    assert!(
        left.iter()
            .chain(right.iter())
            .all(|sample| sample.is_finite())
    );
}
