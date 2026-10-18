//! Shared helpers for the `bragi-model` integration tests.
//!
//! The documents are built with `serde_json` and parsed into the generated types, so a test says
//! exactly what it is testing. Everything here is deterministically valid: `validate` passes on
//! every document these helpers build, which is what lets the fuzz test start from a known-good
//! state.
//!
//! Each test binary includes this module with `mod common;`, so its items are only reachable from
//! within that binary.
#![allow(dead_code, unreachable_pub)]

use bragi_model::AssetIndex;
use bragi_model::generated::{AssetMeta, Op, OpBatch, Project};
use serde_json::{Value, json};

/// The single asset every clip in these fixtures references.
pub const HASH: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

/// The asset's length in samples (10 s at 48 kHz).
pub const DURATION_SAMPLES: u64 = 480_000;

/// PMT: one bar of 4/4 is 3840 ticks, one second at 120 bpm is 1920 ticks.
pub const BAR_TICKS: u64 = 3_840;
/// Ticks in one second at 120 bpm.
pub const SECOND_TICKS: i64 = 1_920;

/// Metadata for the fixture asset.
pub fn asset_meta() -> AssetMeta {
    serde_json::from_value(json!({
        "hash": HASH,
        "mime": "audio/flac",
        "bytes": 1,
        "sampleRate": 48_000,
        "channels": 2,
        "durationSamples": DURATION_SAMPLES
    }))
    .expect("valid AssetMeta")
}

/// An [`AssetIndex`] holding [`asset_meta`].
pub fn assets() -> AssetIndex {
    AssetIndex::from_metas([asset_meta()])
}

/// A clip JSON value with beatgrid anchors from `start` to `start + ticks`.
pub fn clip_json_ticks(id: &str, start: i64, ticks: i64) -> Value {
    json!({
        "id": id,
        "asset": HASH,
        "srcStart": 0,
        "srcEnd": 48_000,
        "start": start,
        "warp": { "mode": "beatgrid", "anchors": [
            { "srcSample": 0, "tick": start },
            { "srcSample": 48_000, "tick": start + ticks } ] },
        "gainDb": 0,
        "pitchSemitones": 0,
        "fadeInTicks": 0,
        "fadeOutTicks": 0,
        "fadeCurve": "equal_power",
        "provenance": { "kind": "user", "createdAt": "2026-10-18T12:00:00Z" }
    })
}

/// A clip JSON value with beatgrid anchors from `start` to `start + SECOND_TICKS`.
pub fn clip_json(id: &str, start: i64) -> Value {
    clip_json_ticks(id, start, SECOND_TICKS)
}

/// A lane JSON value with non-overlapping clips laid consecutively.
pub fn lane_json(section: usize, track: usize, length: u64) -> Value {
    let mut clips = Vec::new();
    let mut start = 0_i64;
    let mut index = 0;
    while start + SECOND_TICKS <= length as i64 {
        clips.push(clip_json(&format!("clp_{section}{track}{index}"), start));
        start += SECOND_TICKS;
        index += 1;
    }
    json!({ "clips": clips, "automation": [] })
}

/// A valid document as JSON: `tracks` tracks and `sections` sections of one or two bars each.
///
/// Every track's lane in every section has at least one non-overlapping beatgrid clip, so any op
/// that targets a clip or a section has something to target.
pub fn project_json(tracks: usize, sections: usize, seed: u64) -> Value {
    let tracks = tracks.max(1);
    let sections = sections.max(1);
    let track_values: Vec<Value> = (0..tracks)
        .map(|track| {
            json!({
                "id": format!("trk_{track}"),
                "name": format!("Track {track}"),
                "role": if track == 0 { "full_mix" } else { "other" },
                "color": "#8A8F98",
                "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": []
            })
        })
        .collect();
    let section_values: Vec<Value> = (0..sections)
        .map(|section| {
            let bars = 1 + (seed >> section) % 2;
            let length = bars * BAR_TICKS;
            let mut lanes = serde_json::Map::new();
            for track in 0..tracks {
                lanes.insert(format!("trk_{track}"), lane_json(section, track, length));
            }
            json!({
                "id": format!("sec_{section}"),
                "kind": "verse",
                "label": format!("S{section}"),
                "lengthTicks": length,
                "lanes": lanes,
                "transitionIn": { "kind": "cut", "lengthTicks": 0 }
            })
        })
        .collect();
    json!({
        "schemaVersion": 1,
        "id": "prj_01",
        "meta": { "title": "Fixture", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
        "sources": [],
        "analyses": {},
        "tracks": track_values,
        "arrangement": {
            "timebase": {
                "ppq": 960,
                "tempoMap": [ { "tick": 0, "bpm": 120, "curve": "step" } ],
                "timeSignatures": [ { "bar": 0, "numerator": 4, "denominator": 4 } ]
            },
            "sections": section_values,
            "master": { "fx": [], "automation": [], "gainDb": 0 }
        }
    })
}

/// A valid document with `tracks` tracks and `sections` sections of one or two bars each.
pub fn build_project(tracks: usize, sections: usize, seed: u64) -> Project {
    parse(project_json(tracks, sections, seed))
}

/// Parses a project from JSON, panicking with the error when it is not schema-valid.
pub fn parse(value: Value) -> Project {
    serde_json::from_value(value).expect("a valid fixture project")
}

/// Parses a project from JSON, returning the error when it is not schema-valid.
pub fn try_parse(value: Value) -> Result<Project, serde_json::Error> {
    serde_json::from_value(value)
}

/// A project for the op tests: two tracks, two one-bar sections, deterministic clip IDs.
pub fn fixture() -> Project {
    build_project(2, 2, 0)
}

/// A 10-minute project (about 300 bars) with 12 tracks, for the performance test.
pub fn ten_minute_project() -> Project {
    let mut project = build_project(12, 30, 0);
    // 30 sections × 2 bars = 60 bars; take each clip and stretch the layout to ~10 minutes by
    // giving every section 10 bars.
    for section in &mut project.arrangement.sections {
        section.length_ticks = (10 * BAR_TICKS).try_into().expect("non-zero");
    }
    project
}

/// An op batch with the given ops, authored by `author`, with a fixed ID.
pub fn batch(author: Value, ops: Vec<Value>) -> OpBatch {
    serde_json::from_value(json!({
        "id": "bat_01",
        "label": "Test batch",
        "createdAt": "2026-10-18T12:00:00Z",
        "author": author,
        "ops": ops
    }))
    .expect("a valid batch")
}

/// A user-authored batch.
pub fn user_batch(ops: Vec<Value>) -> OpBatch {
    batch(json!({ "kind": "user" }), ops)
}

/// An op parsed from JSON.
pub fn op(value: Value) -> Op {
    serde_json::from_value(value).expect("a valid op")
}

/// The first section's ID in the fixture.
pub const SEC_A: &str = "sec_0";
/// The second section's ID in the fixture.
pub const SEC_B: &str = "sec_1";
/// The first track's ID in the fixture.
pub const TRK_A: &str = "trk_0";
/// The second track's ID in the fixture.
pub const TRK_B: &str = "trk_1";
/// The first clip in the first section's first lane.
pub const CLIP_A: &str = "clp_000";
