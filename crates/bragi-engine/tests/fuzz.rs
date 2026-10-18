//! Fuzz: random plans and random transport sequences must never panic, and the
//! output must always be finite (`specs/03-audio-engine.md` §11).
//!
//! The generated document is always schema-valid — that is `bragi-model`'s
//! contract and WP-0.3's fuzz — so this file covers the engine's own arithmetic:
//! clip windows, warps, fades, gains, pitch and the transport.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::sync::Arc;

use bragi_engine::plan::compile;
use bragi_engine::render::Renderer;
use common::*;
use proptest::prelude::*;
use serde_json::json;

fn warp_json(mode: u8, ratio: f64, anchors: &[(u64, i64)]) -> serde_json::Value {
    match mode % 3 {
        0 => json!({ "mode": "none" }),
        1 => beatgrid(anchors),
        _ => json!({ "mode": "stretch", "ratio": ratio }),
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn random_plan_renders_finite(
        section_ticks in 1u64..7_680,
        src_start in 0u64..400_000,
        src_len in 1u64..400_000,
        start in -500i64..500,
        fade_in in 0u64..4_000,
        fade_out in 0u64..4_000,
        gain_db in -60f64..12.0,
        pitch in -12f32..12.0,
        ratio in 0.3f64..3.0,
        mode in 0u8..3,
        anchor_count in 2usize..5,
        gain_automation in proptest::bool::ANY,
    ) {
        let hash = hash('0');
        let src_end = src_start + src_len;
        let anchors: Vec<(u64, i64)> = (0..anchor_count)
            .map(|index| {
                let base = src_start + (index as u64 * src_len / anchor_count as u64);
                (base, (index as i64) * 960)
            })
            .collect();
        let mut clip = clip(
            "clp_01",
            &hash,
            src_start,
            src_end,
            start,
            warp_json(mode, ratio, &anchors),
            fade_in,
            fade_out,
            gain_db,
        );
        clip["pitchSemitones"] = json!(pitch);
        clip["reverse"] = json!(mode == 2);
        let lane_json = if gain_automation {
            lane_with_gain(vec![clip], &[(0, 0.0), ((section_ticks / 2) as i64, -12.0)])
        } else {
            lane(vec![clip])
        };
        let doc = project(
            vec![track("trk_01")],
            vec![section("sec_a", section_ticks, json!({ "trk_01": lane_json }))],
        );
        let asset_index = assets(&hash, src_end.max(1));
        let plan = compile(&doc, &asset_index, 48_000, 1).unwrap();
        let source = pcm(&hash, tone(src_end.max(1) as usize, 220.0, 0.4));

        let mut renderer = Renderer::new(Arc::new(plan), 128);
        renderer.transport_mut().play();
        let mut left = [0.0f32; 128];
        let mut right = [0.0f32; 128];
        for _ in 0..40 {
            renderer.process(&source, &mut [&mut left, &mut right]);
            prop_assert!(left.iter().chain(right.iter()).all(|sample| sample.is_finite()));
        }
    }

    #[test]
    fn random_transport_commands_never_panic(
        seek in 0u64..200_000,
        loop_start in 0u64..200_000,
        loop_len in 1u64..50_000,
        actions in proptest::collection::vec(0u8..8, 1..40),
    ) {
        let hash = hash('1');
        let clip = clip_none("clp_01", &hash, 0, 480_000, 0);
        let doc = project(
            vec![track("trk_01")],
            vec![section("sec_a", BAR_TICKS * 5, json!({ "trk_01": lane(vec![clip]) }))],
        );
        let plan = compile(&doc, &assets(&hash, 480_000), 48_000, 1).unwrap();
        let source = pcm(&hash, tone(480_000, 110.0, 0.4));
        let mut renderer = Renderer::new(Arc::new(plan), 128);
        let mut left = [0.0f32; 128];
        let mut right = [0.0f32; 128];
        for action in actions {
            match action {
                0 => renderer.transport_mut().play(),
                1 => renderer.transport_mut().pause(),
                2 => renderer.transport_mut().stop(),
                3 => renderer.transport_mut().seek(seek),
                4 => renderer
                    .transport_mut()
                    .set_loop(Some((loop_start, loop_start + loop_len))),
                5 => renderer.transport_mut().set_loop(None),
                6 => {
                    renderer.transport_mut().scrub_begin();
                    renderer.transport_mut().scrub_to(seek);
                    renderer.transport_mut().scrub_end();
                }
                _ => renderer.transport_mut().set_auditioning(true),
            }
            renderer.process(&source, &mut [&mut left, &mut right]);
            prop_assert!(left.iter().chain(right.iter()).all(|sample| sample.is_finite()));
        }
    }
}
