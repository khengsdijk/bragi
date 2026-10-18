//! `diff(prev, next) -> EngineDelta` (`specs/02-song-model.md` §8).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use bragi_model::{apply, diff};
use common::{SEC_A, TRK_A, assets, fixture, user_batch};
use serde_json::json;

#[test]
fn identical_documents_have_an_empty_delta() {
    let doc = fixture();
    assert!(diff(&doc, &doc).is_empty());
}

#[test]
fn a_track_patch_is_a_track_update() {
    let doc = fixture();
    let next = apply(
        &doc,
        &user_batch(vec![
            json!({ "op": "track.update", "trackId": TRK_A, "patch": { "gainDb": -3 } }),
        ]),
        &assets(),
    )
    .unwrap();
    let delta = diff(&doc, &next);
    assert_eq!(delta.tracks_updated.len(), 1);
    assert_eq!(delta.tracks_updated[0].gain_db, -3.0);
    assert!(delta.tracks_added.is_empty() && delta.tracks_removed.is_empty());
    assert!(!delta.requires_full_resync);
    assert!(!delta.is_empty());
}

#[test]
fn a_project_meta_change_is_metadata_only() {
    let doc = fixture();
    let next = apply(
        &doc,
        &user_batch(vec![json!({ "op": "project.set_meta", "title": "New" })]),
        &assets(),
    )
    .unwrap();
    let delta = diff(&doc, &next);
    assert!(delta.meta_changed);
    assert!(!delta.requires_full_resync);
    assert!(delta.sections_added.is_empty());
}

#[test]
fn adding_a_section_is_structural() {
    let doc = fixture();
    let next = apply(
        &doc,
        &user_batch(vec![json!({ "op": "section.duplicate", "sectionId": SEC_A, "toIndex": 2, "newId": "sec_dup" })]),
        &assets(),
    )
    .unwrap();
    let delta = diff(&doc, &next);
    assert_eq!(delta.sections_added.len(), 1);
    assert!(delta.requires_full_resync);
}

#[test]
fn removing_a_track_is_structural() {
    let doc = fixture();
    let next = apply(
        &doc,
        &user_batch(vec![json!({ "op": "track.remove", "trackId": TRK_A })]),
        &assets(),
    )
    .unwrap();
    let delta = diff(&doc, &next);
    assert_eq!(delta.tracks_removed.len(), 1);
    assert!(delta.requires_full_resync);
}

#[test]
fn a_tempo_change_is_a_timebase_change() {
    let doc = fixture();
    let next = apply(
        &doc,
        &user_batch(vec![
            json!({ "op": "tempo.set", "tempoMap": [ { "tick": 0, "bpm": 90, "curve": "step" } ] }),
        ]),
        &assets(),
    )
    .unwrap();
    let delta = diff(&doc, &next);
    assert!(delta.timebase_changed);
    assert!(delta.requires_full_resync);
}

#[test]
fn a_master_change_is_flagged() {
    let doc = fixture();
    let next = apply(
        &doc,
        &user_batch(vec![json!({ "op": "automation.set", "scope": { "kind": "master" },
            "target": "master:gainDb", "points": [ { "tick": 0, "value": 0.5, "curve": "step" } ] })]),
        &assets(),
    )
    .unwrap();
    let delta = diff(&doc, &next);
    assert!(delta.master_changed);
    assert!(!delta.requires_full_resync);
}

#[test]
fn a_section_edit_is_a_section_update_not_a_resync() {
    let doc = fixture();
    let next = apply(
        &doc,
        &user_batch(vec![
            json!({ "op": "section.update", "sectionId": SEC_A, "patch": { "label": "New" } }),
        ]),
        &assets(),
    )
    .unwrap();
    let delta = diff(&doc, &next);
    assert_eq!(delta.sections_updated.len(), 1);
    assert!(delta.sections_updated[0].label == "New");
    assert!(!delta.requires_full_resync);
}
