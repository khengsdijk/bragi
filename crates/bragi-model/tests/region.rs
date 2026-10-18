//! `resolve_region` (`specs/02-song-model.md` §3.8).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use bragi_model::generated::Region;
use bragi_model::{AssetIndex, resolve_region, section_spans};
use common::{BAR_TICKS, CLIP_A, SEC_A, SEC_B, TRK_A, TRK_B, assets, fixture};
use serde_json::json;

fn region(value: serde_json::Value) -> Region {
    serde_json::from_value(value).unwrap()
}

#[test]
fn a_region_splits_per_section_and_track() {
    let doc = fixture();
    let region = region(json!({ "startTick": 0, "endTick": 7680, "tracks": "all" }));
    let resolved = resolve_region(&doc, &region, &assets());
    assert_eq!(resolved.slices.len(), 4, "2 sections x 2 tracks");
    assert_eq!(resolved.slices[0].section_id.to_string(), SEC_A);
    assert_eq!(resolved.slices[0].track_id.to_string(), TRK_A);
    assert_eq!(resolved.slices[0].clip_ids.len(), 2);
    assert!(resolved.clip_ids().contains(&CLIP_A.parse().unwrap()));
    assert_eq!(resolved.track_ids().len(), 2);
}

#[test]
fn a_track_list_limits_the_slices() {
    let doc = fixture();
    let region = region(json!({ "startTick": 0, "endTick": 7680, "tracks": [TRK_B] }));
    let resolved = resolve_region(&doc, &region, &assets());
    assert_eq!(resolved.slices.len(), 2);
    assert!(
        resolved
            .slices
            .iter()
            .all(|slice| slice.track_id.to_string() == TRK_B)
    );
}

#[test]
fn a_region_inside_one_section_is_clamped_to_it() {
    let doc = fixture();
    let region = region(json!({ "startTick": 1000, "endTick": 2000, "tracks": "all" }));
    let resolved = resolve_region(&doc, &region, &assets());
    assert_eq!(resolved.slices.len(), 2, "only sec_a is touched");
    let slice = &resolved.slices[0];
    assert_eq!(slice.local_start_tick, 1000);
    assert_eq!(slice.local_end_tick, 2000);
    // The clip spanning [0, 1920) overlaps the slice.
    assert!(slice.clip_ids.contains(&CLIP_A.parse().unwrap()));
}

#[test]
fn a_region_covering_a_whole_section_keeps_its_freq_range() {
    let doc = fixture();
    let region = region(json!({
        "startTick": 0, "endTick": BAR_TICKS as i64, "tracks": "all", "freqRange": [200, 4000] }));
    let resolved = resolve_region(&doc, &region, &assets());
    assert_eq!(resolved.freq_range, Some([200.0, 4000.0]));
    assert_eq!(resolved.slices.len(), 2);
    assert_eq!(resolved.slices[0].section_index, 0);
    assert_eq!(resolved.slices[0].section_id.to_string(), SEC_A);
}

#[test]
fn an_empty_region_yields_no_slices() {
    let doc = fixture();
    let region = region(json!({ "startTick": 10, "endTick": 10, "tracks": "all" }));
    let resolved = resolve_region(&doc, &region, &AssetIndex::new());
    assert!(resolved.slices.is_empty());
    // Sanity: spans still line up.
    assert_eq!(section_spans(&doc).len(), 2);
    let _ = SEC_B;
}
