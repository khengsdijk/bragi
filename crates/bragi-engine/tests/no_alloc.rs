//! Acceptance criterion 3: no allocation on the audio thread
//! (`specs/03-audio-engine.md` §11).
//!
//! This integration test installs the engine's tracking allocator as the binary's
//! `#[global_allocator]` (only this test binary is affected) and asserts that a
//! long, varied `process` run records **zero** guarded allocations. `process`
//! raises the guard itself, so the counter covers exactly the audio-thread paths:
//! direct and stretched segments, a missing chunk, loop wraps, seeks, mute ramps
//! and master limiting.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

mod common;

use std::alloc::System;
use std::sync::Arc;

use bragi_dsp::fx::{FxKind, create};
use bragi_engine::engine::Engine;
use bragi_engine::plan::{compile, compile_delta, quality_for};
use bragi_engine::preview::PreviewPatch;
use bragi_engine::render::{PreparedPlan, Renderer};
use bragi_engine::rt::alloc_guard::{self, TrackingAllocator};
use bragi_model::diff;
use bragi_model::generated::{AssetHash, Project};
use common::*;
use serde_json::json;

#[global_allocator]
static ALLOCATOR: TrackingAllocator<System> = TrackingAllocator::new(System);

const BLOCK: usize = 128;

/// Every catalogue kind the DSP crate can build right now. The other batches
/// add arms to `create` and this list follows without a test edit.
fn supported_kinds() -> Vec<FxKind> {
    FxKind::ALL
        .into_iter()
        .filter(|kind| create(*kind, 48_000, BLOCK).is_ok())
        .collect()
}

fn gain_params(kind: FxKind, db: f64) -> Vec<(&'static str, f64)> {
    if kind == FxKind::Gain {
        vec![("db", db)]
    } else {
        Vec::new()
    }
}

/// 12 tracks, each with a direct clip, a stretched clip and a clip whose PCM is
/// missing (the underrun path), plus an fx chain built from every supported
/// kind on the tracks and on the master.
fn twelve_track_document(hash: &AssetHash, missing: &AssetHash, db: f64) -> Project {
    let mut tracks = Vec::new();
    let mut lanes = serde_json::Map::new();
    let kinds = supported_kinds();
    for index in 0..12 {
        let id = format!("trk_{index:02}");
        tracks.push(track(&id));
        let clips = vec![
            clip_none("clp_direct", hash, 0, 480_000, 0),
            clip(
                "clp_stretch",
                hash,
                0,
                480_000,
                96_000,
                json!({ "mode": "stretch", "ratio": 0.75 }),
                480,
                480,
                -3.0,
            ),
            clip_none("clp_missing", missing, 0, 480_000, 288_000),
        ];
        lanes.insert(id, lane(clips));
    }
    let mut doc = project(tracks, vec![section("sec_a", BAR_TICKS * 5, json!(lanes))]);
    if !kinds.is_empty() {
        for (index, track) in doc.tracks.iter_mut().enumerate() {
            let kind = kinds[index % kinds.len()];
            let id = format!("fx_t{index}");
            track
                .fx
                .0
                .push(fx_instance(&id, kind.name(), &gain_params(kind, db), false));
        }
        for (index, kind) in kinds.iter().enumerate() {
            let id = format!("fx_m{index}");
            doc.arrangement.master.fx.0.push(fx_instance(
                &id,
                kind.name(),
                &gain_params(*kind, db),
                false,
            ));
        }
    }
    doc
}

#[test]
fn process_never_allocates() {
    let asset = hash('0');
    let missing = hash('f');
    let doc = twelve_track_document(&asset, &missing, -3.0);
    let updated_doc = twelve_track_document(&asset, &missing, -6.0);
    let mut asset_index = assets(&asset, 480_000);
    asset_index.insert(meta(&missing, 480_000));
    let plan = compile(&doc, &asset_index, 48_000, 1).unwrap();
    let delta = diff(&doc, &updated_doc);
    let updated_plan = compile_delta(&plan, &updated_doc, &asset_index, &delta).unwrap();
    let source = pcm(&asset, tone(480_000, 220.0, 0.4));

    let mut renderer = Renderer::new(Arc::new(plan), BLOCK);
    let mut engine = Engine::new(compile(&doc, &asset_index, 48_000, 1).unwrap(), BLOCK);
    let mut left = [0.0f32; BLOCK];
    let mut right = [0.0f32; BLOCK];
    let track_id: bragi_model::generated::TrackId = "trk_00".parse().unwrap();

    let mut run = |renderer: &mut Renderer, engine: &mut Engine| {
        renderer.transport_mut().set_length(2_880_000);
        renderer.transport_mut().play();
        engine.transport_mut().set_length(2_880_000);
        engine.transport_mut().play();
        for block in 0..400 {
            if block == 100 {
                renderer.transport_mut().set_loop(Some((48_000, 144_000)));
                engine.transport_mut().set_loop(Some((48_000, 144_000)));
            }
            if block == 200 {
                renderer.transport_mut().seek(600_000);
                engine.transport_mut().seek(600_000);
            }
            if block == 250 {
                // `set_preview` is a planner-side call; it is allowed to
                // allocate, and its allocations are outside any guard.
                engine.set_preview(Some(PreviewPatch::TrackMute {
                    track_id: track_id.clone(),
                    mute: true,
                }));
            }
            if block == 300 {
                // A param-only fx update: recompile the plan off the audio
                // thread and carry the live effects across. `set_prepared` is
                // a control-side call, so its allocations are outside the
                // guard that `process` raises.
                let prepared =
                    PreparedPlan::new(Arc::new(updated_plan.clone()), quality_for(false), BLOCK);
                let previous = renderer.set_prepared(prepared);
                drop(previous);
                engine
                    .apply_delta(&updated_doc, &asset_index, &delta)
                    .unwrap();
            }
            renderer.process(&source, &mut [&mut left, &mut right]);
            engine.process(&source, &mut [&mut left, &mut right]);
        }
    };

    // Warm-up, then the measured run.
    run(&mut renderer, &mut engine);
    alloc_guard::reset_violations();
    run(&mut renderer, &mut engine);
    let violations = alloc_guard::Guard::violations();
    println!("guarded allocations over 800 process calls: {violations}");
    alloc_guard::assert_clean();
}

#[test]
fn audition_switching_between_four_warm_plans_never_allocates() {
    let h = hash('5');
    let index = assets(&h, 480_000);
    let document = |gain_db: f64, with_fx: bool, mute: bool| {
        let mut first = track_with("trk_01", gain_db, 0.0, mute, false);
        if with_fx {
            first["fx"] = json!([{
                "id": "fx_candidate", "type": "gain", "params": { "db": -6.0 }, "bypass": false
            }]);
        }
        project(
            vec![first, track_with("trk_02", -6.0, 0.0, false, false)],
            vec![section(
                "sec_a",
                BAR_TICKS * 5,
                json!({
                    "trk_01": lane(vec![clip_none("clp_01", &h, 0, 480_000, 0)]),
                    "trk_02": lane(vec![clip_none("clp_02", &h, 0, 480_000, 0)]),
                }),
            )],
        )
    };
    let documents = [
        document(0.0, false, false),
        document(-6.0, false, false),
        document(0.0, true, false),
        document(0.0, false, true),
    ];
    let plans: Vec<_> = documents
        .iter()
        .enumerate()
        .map(|(version, doc)| compile(doc, &index, 48_000, version as u64 + 1).unwrap())
        .collect();
    let source = pcm(&h, tone(480_000, 220.0, 0.4));

    let mut engine = Engine::new(plans[0].clone(), BLOCK);
    for (slot, plan) in plans
        .iter()
        .enumerate()
        .take(bragi_engine::MAX_WARM_PLANS)
        .skip(1)
    {
        // Warming is a planner-side call: it allocates, outside any guard.
        assert!(engine.warm(slot, plan.clone()));
    }
    engine.transport_mut().play();
    let mut left = [0.0f32; BLOCK];
    let mut right = [0.0f32; BLOCK];
    for _ in 0..50 {
        engine.process(&source, &mut [&mut left, &mut right]);
    }

    alloc_guard::reset_violations();
    for block in 0..400 {
        if block % 20 == 10 {
            let slot = (block / 20) % bragi_engine::MAX_WARM_PLANS;
            assert!(engine.audition(if slot == 0 { None } else { Some(slot) }));
        }
        engine.process(&source, &mut [&mut left, &mut right]);
    }
    let violations = alloc_guard::Guard::violations();
    println!("guarded allocations over 400 audition blocks: {violations}");
    alloc_guard::assert_clean();
}

#[test]
fn plugin_delay_compensation_never_allocates_on_the_audio_thread() {
    let h = hash('a');
    let doc = |with_saturation: bool| {
        let mut doc = project(
            vec![track("trk_01"), track("trk_02")],
            vec![section(
                "sec_a",
                BAR_TICKS * 5,
                json!({
                    "trk_01": lane(vec![clip_none("clp_01", &h, 0, 480_000, 0)]),
                    "trk_02": lane(vec![clip_none("clp_02", &h, 0, 480_000, 0)]),
                }),
            )],
        );
        if with_saturation {
            doc.tracks[0]
                .fx
                .0
                .push(fx_instance("fx_sat", "saturation", &[], false));
        }
        doc.arrangement
            .master
            .fx
            .0
            .push(fx_instance("fx_lim", "limiter", &[], false));
        doc
    };
    let with_sat = doc(true);
    let without_sat = doc(false);
    let asset_index = assets(&h, 480_000);
    let first = compile(&with_sat, &asset_index, 48_000, 1).unwrap();
    let second = compile(&without_sat, &asset_index, 48_000, 1).unwrap();
    let source = pcm(&h, tone(480_000, 220.0, 0.4));

    let mut renderer = Renderer::new(Arc::new(first), BLOCK);
    renderer.transport_mut().play();
    let mut left = [0.0f32; BLOCK];
    let mut right = [0.0f32; BLOCK];
    // Fill the compensation delay lines and the master limiter.
    for _ in 0..8 {
        renderer.process(&source, &mut [&mut left, &mut right]);
    }
    alloc_guard::reset_violations();

    // 30 frames of compensation disappear; the delay line is carried over.
    let prepared = PreparedPlan::new(Arc::new(second), quality_for(false), BLOCK);
    let previous = renderer.set_prepared(prepared);
    drop(previous);
    for _ in 0..64 {
        renderer.process(&source, &mut [&mut left, &mut right]);
    }
    // ...and comes back, with the compensation depth changing again.
    let prepared = PreparedPlan::new(
        Arc::new(compile(&with_sat, &asset_index, 48_000, 2).unwrap()),
        quality_for(false),
        BLOCK,
    );
    let previous = renderer.set_prepared(prepared);
    drop(previous);
    for _ in 0..64 {
        renderer.process(&source, &mut [&mut left, &mut right]);
    }

    let violations = alloc_guard::Guard::violations();
    println!("guarded allocations with PDC and a plan swap: {violations}");
    alloc_guard::assert_clean();
}

#[test]
fn a_missing_chunk_does_not_allocate() {
    let hash = hash('1');
    let doc = project(
        vec![track("trk_01")],
        vec![section(
            "sec_a",
            BAR_TICKS,
            json!({ "trk_01": lane(vec![clip_none("clp_01", &hash, 0, 480_000, 0)]) }),
        )],
    );
    let plan = compile(&doc, &assets(&hash, 480_000), 48_000, 1).unwrap();
    let empty = bragi_engine::pcm::MemoryPcm::new();
    let mut renderer = Renderer::new(Arc::new(plan), BLOCK);
    renderer.transport_mut().play();
    let mut left = [0.0f32; BLOCK];
    let mut right = [0.0f32; BLOCK];
    renderer.process(&empty, &mut [&mut left, &mut right]);
    alloc_guard::reset_violations();
    for _ in 0..50 {
        renderer.process(&empty, &mut [&mut left, &mut right]);
    }
    alloc_guard::assert_clean();
    assert!(renderer.stats().underruns > 0);
}

/// A reordered four-section song whose boundaries are all discontinuous. The
/// part at `crossfade_part` enters through a `crossfade`; the others use `cut`.
fn reordered_document(
    hash: &AssetHash,
    order: [usize; 4],
    crossfade_part: usize,
    crossfade_ticks: u64,
) -> Project {
    // One beat per section at 120 bpm; the source windows jump by half a 55 Hz
    // period so no boundary is contiguous.
    const OFFSETS: [u64; 4] = [654, 25_090, 49_526, 73_962];
    let sections = order
        .iter()
        .map(|part| {
            let offset = OFFSETS[*part];
            let clip = clip_none(
                &format!("clp_{part}"),
                hash,
                offset,
                offset + BEAT_SAMPLES,
                0,
            );
            let (kind, ticks) = if *part == crossfade_part {
                ("crossfade", crossfade_ticks)
            } else {
                ("cut", 0)
            };
            json!({
                "id": format!("sec_{part}"), "kind": "custom", "label": "S",
                "lengthTicks": BEAT_TICKS,
                "lanes": { "trk_01": lane(vec![clip]) },
                "transitionIn": { "kind": kind, "lengthTicks": ticks }
            })
        })
        .collect();
    project(vec![track("trk_01")], sections)
}

#[test]
fn section_boundary_crossfades_never_allocate_on_the_audio_thread() {
    let h = hash('2');
    let doc = reordered_document(&h, [1, 0, 2, 3], 2, BEAT_TICKS / 4);
    let moved = reordered_document(&h, [0, 1, 2, 3], 2, BEAT_TICKS / 4);
    let asset_index = assets(&h, 100_000);
    let plan = compile(&doc, &asset_index, 48_000, 1).unwrap();
    let moved_plan = compile(&moved, &asset_index, 48_000, 2).unwrap();
    let source = pcm(&h, tone(100_000, 55.0, 0.4));

    let mut renderer = Renderer::new(Arc::new(plan), BLOCK);
    renderer.transport_mut().play();
    let mut left = [0.0f32; BLOCK];
    let mut right = [0.0f32; BLOCK];
    // Warm up through the first boundary so the ramps have settled.
    for _ in 0..100 {
        renderer.process(&source, &mut [&mut left, &mut right]);
    }
    alloc_guard::reset_violations();
    for block in 0..750 {
        if block == 200 {
            // Into the middle of the 1/4-beat crossfade at sample 48 000.
            renderer.transport_mut().seek(46_000);
        }
        if block == 400 {
            // A section move is structural; the planner may allocate, the audio
            // thread may not.
            let prepared =
                PreparedPlan::new(Arc::new(moved_plan.clone()), quality_for(false), BLOCK);
            let previous = renderer.set_prepared(prepared);
            drop(previous);
        }
        renderer.process(&source, &mut [&mut left, &mut right]);
    }
    let violations = alloc_guard::Guard::violations();
    println!("guarded allocations over 750 boundary blocks: {violations}");
    alloc_guard::assert_clean();
    assert!(
        renderer.plan().tracks[0]
            .segments
            .iter()
            .any(|segment| segment.boundary_in.is_some())
    );
}
