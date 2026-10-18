//! Acceptance criterion 4: 12-track playback has no underruns at the target
//! buffer sizes (`specs/03-audio-engine.md` §3.1/§3.2, §11).
//!
//! The offline renderer is much faster than real time, so "no underrun" here is
//! two checks: every PCM read is satisfied (`underruns == 0`) and the whole
//! 60-second, 12-track, 72-segment arrangement renders in less wall time than it
//! plays. The measured realtime factor is printed, because it is a budget the
//! report needs.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

mod common;

use std::sync::Arc;
use std::time::Instant;

use bragi_engine::plan::compile;
use bragi_engine::render::Renderer;
use bragi_engine::{NATIVE_BUFFER_FRAMES, QUANTUM_FRAMES};
use common::*;
use serde_json::json;

const TRACKS: usize = 12;
const SONG_SECONDS: usize = 60;
/// 60 s at 48 kHz.
const SONG_FRAMES: usize = 48_000 * SONG_SECONDS;
/// A 10 s clip; six of them tile the minute.
const CLIP_FRAMES: u64 = 480_000;

fn document(hash: &bragi_model::generated::AssetHash) -> bragi_model::generated::Project {
    let mut tracks = Vec::new();
    let mut lanes = serde_json::Map::new();
    for index in 0..TRACKS {
        let id = format!("trk_{index:02}");
        tracks.push(track(&id));
        let clips: Vec<_> = (0..6)
            .map(|tile| {
                // 5 bars per 10 s tile: 19 200 ticks.
                clip_none(
                    &format!("clp_{index}{tile}"),
                    hash,
                    0,
                    CLIP_FRAMES,
                    (tile as i64) * 19_200,
                )
            })
            .collect();
        lanes.insert(id, lane(clips));
    }
    project(tracks, vec![section("sec_a", BAR_TICKS * 30, json!(lanes))])
}

#[test]
fn twelve_tracks_render_without_underruns_at_both_buffer_sizes() {
    let hash = hash('0');
    let doc = document(&hash);
    let plan = compile(&doc, &assets(&hash, CLIP_FRAMES), 48_000, 1).unwrap();
    assert_eq!(plan.length_samples as usize, SONG_FRAMES);
    assert_eq!(plan.segment_count(), TRACKS * 6);

    let source = pcm(&hash, tone(CLIP_FRAMES as usize, 110.0, 0.3));

    for block in [QUANTUM_FRAMES, NATIVE_BUFFER_FRAMES] {
        let mut renderer = Renderer::new(Arc::new(plan.clone()), block);
        renderer.transport_mut().play();
        let mut left = vec![0.0f32; block];
        let mut right = vec![0.0f32; block];
        let start = Instant::now();
        let mut frames = 0usize;
        let mut underruns = 0u64;
        while frames < SONG_FRAMES {
            let count = (SONG_FRAMES - frames).min(block);
            let stats = renderer.process(&source, &mut [&mut left[..count], &mut right[..count]]);
            underruns += stats.underruns;
            assert!(
                left[..count].iter().all(|sample| sample.is_finite()),
                "non-finite output at {frames}"
            );
            frames += count;
        }
        let elapsed = start.elapsed().as_secs_f64();
        let realtime_factor = elapsed / SONG_SECONDS as f64;
        println!(
            "12 tracks @ {block} frames: {:.3} s for {SONG_SECONDS} s audio \
             (realtime factor {realtime_factor:.4}), underruns {underruns}",
            elapsed
        );
        assert_eq!(underruns, 0, "every chunk is resident, so no read may miss");
        assert_eq!(renderer.transport().playhead() as usize, SONG_FRAMES);
        assert!(
            realtime_factor < 1.0,
            "12-track playback must have headroom: {realtime_factor:.4}x realtime"
        );
    }
}
