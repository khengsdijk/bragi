//! Snapshot tests (`insta`) for the shapes the UI and the engine consume.
//!
//! These pin the *serialized* form of the derived types, so an accidental rename or a changed field
//! order is visible in review. The full-document snapshots are intentionally avoided (they are
//! large and change with every fixture tweak); the query results are small and stable.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::collections::HashMap;

use bragi_model::generated::{CommitId, FxInstance, Region, TrackId};
use bragi_model::{apply, apply_with, diff, resolve_region, section_spans, validate};
use common::{SEC_A, TRK_A, assets, fixture, user_batch};
use insta::assert_json_snapshot;
use serde_json::json;

/// Applies a `region.adopt` from a copy of the fixture and returns the target section's lane.
fn adopted_lane() -> serde_json::Value {
    let commit: CommitId = "cmt_01JAB3QK7M9P2V6XWN0T4Y8ZB5".parse().unwrap();
    let commits = HashMap::from([(commit.clone(), fixture())]);
    let batch = user_batch(vec![json!({
        "op": "region.adopt", "fromCommit": commit.to_string(),
        "region": { "startTick": 960, "endTick": 2880, "tracks": "all" } })]);
    let next = apply_with(&fixture(), &batch, &assets(), &commits).unwrap();
    let track: TrackId = TRK_A.parse().unwrap();
    let lane = next
        .arrangement
        .sections
        .iter()
        .find(|section| section.id.to_string() == SEC_A)
        .unwrap()
        .lanes
        .0
        .get(&track)
        .unwrap();
    serde_json::to_value(lane.clips.clone()).unwrap()
}

#[test]
fn section_spans_snapshot() {
    assert_json_snapshot!("section_spans", section_spans(&fixture()));
}

#[test]
fn resolved_region_snapshot() {
    let region: Region =
        serde_json::from_value(json!({ "startTick": 0, "endTick": 7680, "tracks": "all" }))
            .unwrap();
    assert_json_snapshot!(
        "resolved_region",
        resolve_region(&fixture(), &region, &assets())
    );
}

#[test]
fn engine_delta_snapshot() {
    let doc = fixture();
    let next = apply(
        &doc,
        &user_batch(vec![
            json!({ "op": "track.update", "trackId": TRK_A, "patch": { "gainDb": -3 } }),
            json!({ "op": "section.update", "sectionId": SEC_A, "patch": { "label": "Chorus" } }),
        ]),
        &assets(),
    )
    .unwrap();
    // Serialize through `serde_json::to_value` so the snapshot is key-order-stable:
    // `SectionInstance.lanes` is a HashMap, and insta's own `Content` serialization
    // preserves its (per-instance, non-deterministic) iteration order, which made this
    // snapshot flaky. `serde_json`'s default Map is BTree-backed and sorts the keys.
    assert_json_snapshot!(
        "engine_delta",
        serde_json::to_value(diff(&doc, &next)).unwrap()
    );
}

#[test]
fn region_adopt_snapshot() {
    assert_json_snapshot!("region_adopt", adopted_lane());
}

#[test]
fn validation_errors_snapshot() {
    let mut doc = fixture();
    let fx: FxInstance = serde_json::from_value(json!({
        "id": "fx_bad", "type": "gain", "params": { "db": 100 }, "bypass": false }))
    .unwrap();
    doc.tracks[0].pan = 2.0;
    doc.tracks[0].fx.0.push(fx);
    assert_json_snapshot!("validation_errors", validate(&doc, &assets()).unwrap_err());
}
