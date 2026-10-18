//! One test per invariant in `specs/02-song-model.md` §4.3.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use bragi_model::generated::{AutomationList, FxInstance, Lane, Project};
use bragi_model::{AssetIndex, ValidationCode, validate};
use common::{assets, fixture, parse, project_json};
use serde_json::json;

fn codes(doc: &Project, assets: &AssetIndex) -> Vec<ValidationCode> {
    validate(doc, assets)
        .expect_err("the document should be invalid")
        .into_iter()
        .map(|error| error.code)
        .collect()
}

#[test]
fn a_valid_fixture_has_no_errors() {
    validate(&fixture(), &assets()).expect("the fixture is valid");
}

#[test]
fn invariant_1_a_lane_must_name_an_existing_track() {
    let mut doc = fixture();
    doc.arrangement.sections[0].lanes.0.insert(
        "trk_zz".parse().unwrap(),
        Lane {
            clips: Vec::new(),
            automation: AutomationList(Vec::new()),
        },
    );
    assert!(codes(&doc, &assets()).contains(&ValidationCode::UnknownTrack));
}

#[test]
fn invariant_2_clip_ranges_must_be_non_empty_and_fit_the_asset() {
    let mut doc = fixture();
    let clip = &mut doc.arrangement.sections[0]
        .lanes
        .0
        .get_mut(&"trk_0".parse().unwrap())
        .unwrap()
        .clips[0];
    clip.src_start = clip.src_end;
    assert!(codes(&doc, &assets()).contains(&ValidationCode::ClipRange));

    let mut doc = fixture();
    let clip = &mut doc.arrangement.sections[0]
        .lanes
        .0
        .get_mut(&"trk_0".parse().unwrap())
        .unwrap()
        .clips[0];
    clip.src_end = common::DURATION_SAMPLES + 1;
    assert!(codes(&doc, &assets()).contains(&ValidationCode::ClipRange));
}

#[test]
fn an_unknown_asset_is_reported() {
    let mut doc = fixture();
    let clip = &mut doc.arrangement.sections[0]
        .lanes
        .0
        .get_mut(&"trk_0".parse().unwrap())
        .unwrap()
        .clips[0];
    clip.asset = format!("sha256:{}", "2".repeat(64)).parse().unwrap();
    assert!(codes(&doc, &assets()).contains(&ValidationCode::UnknownAsset));
}

#[test]
fn invariant_3_overlaps_need_matching_fades() {
    let mut doc = fixture();
    let lane = doc.arrangement.sections[0]
        .lanes
        .0
        .get_mut(&"trk_0".parse().unwrap())
        .unwrap();
    let mut extra = lane.clips[0].clone();
    extra.id = "clp_999".parse().unwrap();
    extra.fade_in_ticks = 0;
    extra.fade_out_ticks = 0;
    lane.clips.push(extra);
    assert!(codes(&doc, &assets()).contains(&ValidationCode::OverlapWithoutFade));

    // With matching fades covering the overlap, it is allowed.
    let mut doc = fixture();
    let lane = doc.arrangement.sections[0]
        .lanes
        .0
        .get_mut(&"trk_0".parse().unwrap())
        .unwrap();
    let mut extra = lane.clips[0].clone();
    extra.id = "clp_999".parse().unwrap();
    extra.fade_in_ticks = 1920;
    lane.clips[0].fade_out_ticks = 1920;
    lane.clips.push(extra);
    validate(&doc, &assets()).expect("the overlap is covered by fades");
}

#[test]
fn invariant_4_the_tempo_map_must_be_sorted_start_at_zero_and_in_range() {
    let mut doc = fixture();
    doc.arrangement.timebase.tempo_map.0.clear();
    assert!(codes(&doc, &assets()).contains(&ValidationCode::TempoMap));

    let mut doc = fixture();
    doc.arrangement.timebase.tempo_map.0[0].bpm = 500.0;
    assert!(codes(&doc, &assets()).contains(&ValidationCode::TempoMap));

    let mut doc = fixture();
    doc.arrangement.timebase.tempo_map.0[0].tick = 100;
    assert!(codes(&doc, &assets()).contains(&ValidationCode::TempoMap));
}

#[test]
fn invariant_5_fx_params_must_be_in_the_catalogue() {
    let mut doc = fixture();
    let fx: FxInstance = serde_json::from_value(json!({
        "id": "fx_bad", "type": "gain", "params": { "db": 100 }, "bypass": false }))
    .unwrap();
    doc.tracks[0].fx.0.push(fx);
    assert!(codes(&doc, &assets()).contains(&ValidationCode::FxParam));

    let mut doc = fixture();
    let fx: FxInstance = serde_json::from_value(json!({
        "id": "fx_bad", "type": "gain", "params": { "nope": 1 }, "bypass": false }))
    .unwrap();
    doc.tracks[0].fx.0.push(fx);
    assert!(codes(&doc, &assets()).contains(&ValidationCode::FxParam));
}

#[test]
fn invariant_6_locked_sections_are_only_enforced_on_ai_batches() {
    // The AI path is tested in `ops.rs`; here we pin that `validate` itself does not reject a
    // locked section (it is not about lock state at all).
    let mut doc = fixture();
    doc.arrangement.sections[0].locked = Some(true);
    validate(&doc, &assets()).expect("a locked section is valid on its own");
}

#[test]
fn invariant_7_ids_must_be_unique() {
    let mut doc = fixture();
    let lane = doc.arrangement.sections[0]
        .lanes
        .0
        .get_mut(&"trk_0".parse().unwrap())
        .unwrap();
    let first = lane.clips[0].id.clone();
    lane.clips[1].id = first;
    assert!(codes(&doc, &assets()).contains(&ValidationCode::DuplicateId));

    let mut doc = fixture();
    let duplicate = doc.tracks[0].clone();
    doc.tracks.push(duplicate);
    assert!(codes(&doc, &assets()).contains(&ValidationCode::DuplicateId));

    let mut doc = fixture();
    let duplicate = doc.arrangement.sections[0].clone();
    doc.arrangement.sections.push(duplicate);
    assert!(codes(&doc, &assets()).contains(&ValidationCode::DuplicateId));
}

#[test]
fn float_bounds_the_schema_cannot_express_are_checked() {
    let mut doc = fixture();
    doc.tracks[0].pan = 2.0;
    assert!(codes(&doc, &assets()).contains(&ValidationCode::NumericRange));

    let mut doc = fixture();
    doc.arrangement.sections[0].energy_target =
        Some(serde_json::from_value(json!([{ "tick": 0, "value": 1.5 }])).unwrap());
    assert!(codes(&doc, &assets()).contains(&ValidationCode::NumericRange));
}

#[test]
fn errors_are_sorted_and_carry_the_shape_the_spec_promises() {
    let mut doc = parse(project_json(1, 1, 0));
    doc.tracks[0].pan = 3.0;
    doc.arrangement.timebase.tempo_map.0.clear();
    let errors = validate(&doc, &assets()).unwrap_err();
    assert!(errors.len() >= 2);
    let json = serde_json::to_value(&errors).unwrap();
    assert!(json[0].get("opIndex").is_some());
    assert!(json[0].get("code").is_some());
    assert!(json[0].get("message").is_some());
    // Sorted by (opIndex, code, message); `tempo_map` precedes `numeric_range` in that order.
    assert_eq!(errors[0].code, ValidationCode::TempoMap);
    assert!(
        errors
            .iter()
            .any(|error| error.code == ValidationCode::NumericRange)
    );
}
