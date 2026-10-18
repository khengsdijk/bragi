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

use bragi_engine::engine::Engine;
use bragi_engine::plan::compile;
use bragi_engine::preview::PreviewPatch;
use bragi_engine::render::Renderer;
use bragi_engine::rt::alloc_guard::{self, TrackingAllocator};
use bragi_model::generated::{AssetHash, Project};
use common::*;
use serde_json::json;

#[global_allocator]
static ALLOCATOR: TrackingAllocator<System> = TrackingAllocator::new(System);

const BLOCK: usize = 128;

/// 12 tracks, each with a direct clip, a stretched clip and a clip whose PCM is
/// missing (the underrun path).
fn twelve_track_document(hash: &AssetHash, missing: &AssetHash) -> Project {
    let mut tracks = Vec::new();
    let mut lanes = serde_json::Map::new();
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
    project(tracks, vec![section("sec_a", BAR_TICKS * 5, json!(lanes))])
}

#[test]
fn process_never_allocates() {
    let asset = hash('0');
    let missing = hash('f');
    let doc = twelve_track_document(&asset, &missing);
    let mut asset_index = assets(&asset, 480_000);
    asset_index.insert(meta(&missing, 480_000));
    let plan = compile(&doc, &asset_index, 48_000, 1).unwrap();
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
