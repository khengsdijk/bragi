//! Shared helpers for the engine's integration tests.
//!
//! Everything here is a *generated* fixture: sine/DC/impulse PCM and a JSON
//! document assembled in code, so no audio file is needed (13 §6).

#![allow(dead_code, unreachable_pub, clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use bragi_engine::engine::Engine;
use bragi_engine::pcm::{MemoryPcm, PcmBuffer, PcmSource};
use bragi_engine::plan::RenderPlan;
use bragi_engine::render::Renderer;
use bragi_model::AssetIndex;
use bragi_model::generated::{AssetHash, AssetMeta, Project};
use serde_json::{Value, json};

/// The asset hash every fixture uses unless it needs two.
pub fn hash(byte: char) -> AssetHash {
    AssetHash::try_from(format!("sha256:{}", byte.to_string().repeat(64))).unwrap()
}

/// Asset metadata for a stereo 48 kHz asset of `frames` frames.
pub fn meta(hash: &AssetHash, frames: u64) -> AssetMeta {
    serde_json::from_value(json!({
        "hash": hash,
        "mime": "audio/wav",
        "bytes": frames * 8,
        "sampleRate": 48_000,
        "channels": 2,
        "durationSamples": frames,
    }))
    .unwrap()
}

/// An asset index holding `hash` with `frames` frames.
pub fn assets(hash: &AssetHash, frames: u64) -> AssetIndex {
    AssetIndex::from_metas([meta(hash, frames)])
}

/// A stereo sine buffer at 48 kHz.
pub fn tone(frames: usize, frequency: f32, amplitude: f32) -> PcmBuffer {
    let mut samples = Vec::with_capacity(frames * 2);
    for frame in 0..frames {
        let value = (frame as f32 * std::f32::consts::TAU * frequency / 48_000.0).sin() * amplitude;
        samples.push(value);
        samples.push(value);
    }
    PcmBuffer::new(samples, 2, 48_000)
}

/// A stereo buffer where every sample is `value`.
pub fn dc(frames: usize, value: f32) -> PcmBuffer {
    PcmBuffer::new(vec![value; frames * 2], 2, 48_000)
}

/// A stereo buffer that is zero except for single-frame impulses at `points`.
pub fn impulses(frames: usize, points: &[(usize, f32)]) -> PcmBuffer {
    let mut samples = vec![0.0f32; frames * 2];
    for (point, value) in points {
        if *point < frames {
            samples[point * 2] = *value;
            samples[point * 2 + 1] = *value;
        }
    }
    PcmBuffer::new(samples, 2, 48_000)
}

/// A `MemoryPcm` with one asset.
pub fn pcm(hash: &AssetHash, buffer: PcmBuffer) -> MemoryPcm {
    let mut pcm = MemoryPcm::new();
    pcm.insert(hash.clone(), buffer);
    pcm
}

/// A default track JSON object.
pub fn track(id: &str) -> Value {
    json!({
        "id": id, "name": id, "role": "full_mix", "color": "#8A8F98",
        "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": []
    })
}

/// A track with explicit mix parameters.
pub fn track_with(id: &str, gain_db: f64, pan: f64, mute: bool, solo: bool) -> Value {
    json!({
        "id": id, "name": id, "role": "full_mix", "color": "#8A8F98",
        "gainDb": gain_db, "pan": pan, "mute": mute, "solo": solo, "hidden": false, "fx": []
    })
}

/// A lane JSON object with `clips` and optional automation.
pub fn lane(clips: Vec<Value>) -> Value {
    json!({ "clips": clips, "automation": [] })
}

/// A lane with gain automation points `(tick, db)` relative to the section.
pub fn lane_with_gain(clips: Vec<Value>, points: &[(i64, f64)]) -> Value {
    json!({
        "clips": clips,
        "automation": [{
            "target": "track:trk_01/gainDb",
            "points": points.iter().map(|(tick, value)| json!({
                "tick": tick, "value": value, "curve": "linear"
            })).collect::<Vec<_>>()
        }]
    })
}

/// A section JSON object. `lanes` maps track IDs to lanes.
pub fn section(id: &str, length_ticks: u64, lanes: Value) -> Value {
    json!({
        "id": id, "kind": "custom", "label": id, "lengthTicks": length_ticks,
        "lanes": lanes, "transitionIn": { "kind": "cut", "lengthTicks": 0 }
    })
}

/// A clip with `warp: none`.
pub fn clip_none(id: &str, asset: &AssetHash, src_start: u64, src_end: u64, start: i64) -> Value {
    clip(
        id,
        asset,
        src_start,
        src_end,
        start,
        json!({ "mode": "none" }),
        0,
        0,
        0.0,
    )
}

/// A clip with all parameters explicit.
#[allow(clippy::too_many_arguments)]
pub fn clip(
    id: &str,
    asset: &AssetHash,
    src_start: u64,
    src_end: u64,
    start: i64,
    warp: Value,
    fade_in_ticks: u64,
    fade_out_ticks: u64,
    gain_db: f64,
) -> Value {
    json!({
        "id": id, "asset": asset, "srcStart": src_start, "srcEnd": src_end, "start": start,
        "warp": warp, "gainDb": gain_db, "pitchSemitones": 0,
        "fadeInTicks": fade_in_ticks, "fadeOutTicks": fade_out_ticks,
        "fadeCurve": "equal_power",
        "provenance": { "kind": "user", "createdAt": "2026-10-18T12:00:00Z" }
    })
}

/// A beatgrid warp from `(srcSample, tick)` anchors.
pub fn beatgrid(anchors: &[(u64, i64)]) -> Value {
    json!({
        "mode": "beatgrid",
        "anchors": anchors
            .iter()
            .map(|(src, tick)| json!({ "srcSample": src, "tick": tick }))
            .collect::<Vec<_>>()
    })
}

/// A whole project object at 120 bpm, 4/4.
pub fn project(tracks: Vec<Value>, sections: Vec<Value>) -> Project {
    serde_json::from_value(json!({
        "schemaVersion": 1,
        "id": "prj_01",
        "meta": { "title": "Engine test", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
        "sources": [],
        "analyses": {},
        "tracks": tracks,
        "arrangement": {
            "timebase": {
                "ppq": 960,
                "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }],
                "timeSignatures": [{ "bar": 0, "numerator": 4, "denominator": 4 }]
            },
            "sections": sections,
            "master": { "fx": [], "automation": [], "gainDb": 0 }
        }
    }))
    .unwrap()
}

/// Renders a plan from the top for `frames` frames into interleaved stereo.
pub fn render_plan(
    plan: &RenderPlan,
    pcm: &dyn PcmSource,
    frames: usize,
    block: usize,
) -> Vec<f32> {
    let mut renderer = Renderer::new(Arc::new(plan.clone()), block);
    renderer.transport_mut().set_length(plan.length_samples);
    renderer.transport_mut().play();
    render_output(&mut renderer, pcm, frames, block)
}

/// Renders an engine into interleaved stereo.
pub fn render_engine(
    engine: &mut Engine,
    pcm: &dyn PcmSource,
    frames: usize,
    block: usize,
) -> Vec<f32> {
    let mut left = vec![0.0f32; block];
    let mut right = vec![0.0f32; block];
    let mut out = Vec::with_capacity(frames * 2);
    let mut rendered = 0;
    while rendered < frames {
        let count = (frames - rendered).min(block);
        engine.process(pcm, &mut [&mut left[..count], &mut right[..count]]);
        for index in 0..count {
            out.push(left[index]);
            out.push(right[index]);
        }
        rendered += count;
    }
    out
}

fn render_output(
    renderer: &mut Renderer,
    pcm: &dyn PcmSource,
    frames: usize,
    block: usize,
) -> Vec<f32> {
    let mut left = vec![0.0f32; block];
    let mut right = vec![0.0f32; block];
    let mut out = Vec::with_capacity(frames * 2);
    let mut rendered = 0;
    while rendered < frames {
        let count = (frames - rendered).min(block);
        renderer.process(pcm, &mut [&mut left[..count], &mut right[..count]]);
        for index in 0..count {
            out.push(left[index]);
            out.push(right[index]);
        }
        rendered += count;
    }
    out
}

/// 4/4 at 120 bpm: one bar is 3840 ticks and 96 000 samples at 48 kHz.
pub const BAR_TICKS: u64 = 3840;
/// 4/4 at 120 bpm: one beat is 960 ticks and 24 000 samples at 48 kHz.
pub const BEAT_TICKS: u64 = 960;
/// Samples per beat at 120 bpm / 48 kHz.
pub const BEAT_SAMPLES: u64 = 24_000;
