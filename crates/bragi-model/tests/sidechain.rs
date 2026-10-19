//! `sidechainSource` on `FxInstance` (02 §3.7, §4.2, §5).
//!
//! The field is routing, not a catalogue parameter: only `sidechain_duck` may carry it, the
//! source must be an existing track other than the duck's own track, `fx.update` can clear it with
//! `null`, and removing the source track clears every reference to it.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use bragi_model::generated::{FxInstance, Project};
use bragi_model::{ApplyError, ValidationCode, apply, validate};
use common::{CLIP_A, SEC_A, TRK_A, TRK_B, assets, fixture, user_batch};
use serde_json::{Value, json};

fn run(doc: &Project, ops: Vec<Value>) -> Project {
    let batch = user_batch(ops);
    let next = apply(doc, &batch, &assets()).expect("the batch should apply");
    validate(&next, &assets()).expect("the result should be valid");
    next
}

fn apply_error(doc: &Project, ops: Vec<Value>) -> ApplyError {
    apply(doc, &user_batch(ops), &assets()).expect_err("the batch should be rejected")
}

fn duck(id: &str, source: &str) -> FxInstance {
    serde_json::from_value(json!({
        "id": id,
        "type": "sidechain_duck",
        "params": { "amountDb": 9.0, "releaseMs": 120.0 },
        "bypass": false,
        "sidechainSource": source
    }))
    .expect("a sidechain_duck instance")
}

fn fx<'a>(doc: &'a Project, id: &str) -> &'a FxInstance {
    doc.tracks
        .iter()
        .flat_map(|track| track.fx.0.iter())
        .chain(
            doc.arrangement
                .sections
                .iter()
                .flat_map(|section| section.lanes.values())
                .flat_map(|lane| lane.clips.iter())
                .flat_map(|clip| clip.fx.iter())
                .flat_map(|chain| chain.0.iter()),
        )
        .chain(doc.arrangement.master.fx.0.iter())
        .find(|instance| instance.id.as_str() == id)
        .expect("the fx exists")
}

#[test]
fn fx_add_stores_a_sidechain_source_on_the_duck() {
    let next = run(
        &fixture(),
        vec![json!({
            "op": "fx.add",
            "scope": { "kind": "track", "trackId": TRK_A },
            "fx": { "id": "fx_duck", "type": "sidechain_duck",
                    "params": { "amountDb": 9.0 }, "bypass": false,
                    "sidechainSource": TRK_B }
        })],
    );
    assert_eq!(
        fx(&next, "fx_duck")
            .sidechain_source
            .as_ref()
            .unwrap()
            .as_str(),
        TRK_B
    );
}

#[test]
fn fx_add_rejects_a_source_on_another_effect_type() {
    let error = apply_error(
        &fixture(),
        vec![json!({
            "op": "fx.add",
            "scope": { "kind": "track", "trackId": TRK_A },
            "fx": { "id": "fx_gain", "type": "gain", "params": { "db": -3.0 },
                    "bypass": false, "sidechainSource": TRK_B }
        })],
    );
    assert_eq!(error.code(), ValidationCode::FxParam);
}

#[test]
fn fx_add_rejects_an_unknown_source_track() {
    let error = apply_error(
        &fixture(),
        vec![json!({
            "op": "fx.add",
            "scope": { "kind": "track", "trackId": TRK_A },
            "fx": { "id": "fx_duck", "type": "sidechain_duck",
                    "params": {}, "bypass": false, "sidechainSource": "trk_ghost" }
        })],
    );
    assert_eq!(error.code(), ValidationCode::UnknownTrack);
}

#[test]
fn fx_add_rejects_the_duck_s_own_track_as_source() {
    let error = apply_error(
        &fixture(),
        vec![json!({
            "op": "fx.add",
            "scope": { "kind": "track", "trackId": TRK_A },
            "fx": { "id": "fx_duck", "type": "sidechain_duck",
                    "params": {}, "bypass": false, "sidechainSource": TRK_A }
        })],
    );
    assert_eq!(error.code(), ValidationCode::FxParam);
}

#[test]
fn fx_update_sets_and_nulls_the_source() {
    let doc = run(
        &fixture(),
        vec![json!({
            "op": "fx.add",
            "scope": { "kind": "track", "trackId": TRK_A },
            "fx": { "id": "fx_duck", "type": "sidechain_duck",
                    "params": {}, "bypass": false, "sidechainSource": TRK_B }
        })],
    );
    let next = run(
        &doc,
        vec![json!({
            "op": "fx.update", "fxId": "fx_duck", "paramsPatch": {},
            "sidechainSource": TRK_B
        })],
    );
    assert_eq!(
        fx(&next, "fx_duck")
            .sidechain_source
            .as_ref()
            .unwrap()
            .as_str(),
        TRK_B
    );

    // An update that does not mention the field leaves the routing alone.
    let untouched = run(
        &next,
        vec![json!({
            "op": "fx.update", "fxId": "fx_duck", "paramsPatch": { "amountDb": 3.0 }
        })],
    );
    assert_eq!(
        fx(&untouched, "fx_duck")
            .sidechain_source
            .as_ref()
            .unwrap()
            .as_str(),
        TRK_B
    );

    let cleared = run(
        &untouched,
        vec![json!({
            "op": "fx.update", "fxId": "fx_duck", "paramsPatch": {},
            "sidechainSource": null
        })],
    );
    assert!(fx(&cleared, "fx_duck").sidechain_source.is_none());
}

#[test]
fn fx_update_rejects_a_source_on_another_effect_type() {
    let doc = run(
        &fixture(),
        vec![json!({
            "op": "fx.add",
            "scope": { "kind": "track", "trackId": TRK_A },
            "fx": { "id": "fx_gain", "type": "gain", "params": { "db": 0 }, "bypass": false }
        })],
    );
    let error = apply_error(
        &doc,
        vec![json!({
            "op": "fx.update", "fxId": "fx_gain", "paramsPatch": {},
            "sidechainSource": TRK_B
        })],
    );
    assert_eq!(error.code(), ValidationCode::FxParam);
}

#[test]
fn fx_update_rejects_a_self_source() {
    let doc = run(
        &fixture(),
        vec![json!({
            "op": "fx.add",
            "scope": { "kind": "track", "trackId": TRK_A },
            "fx": { "id": "fx_duck", "type": "sidechain_duck",
                    "params": {}, "bypass": false, "sidechainSource": TRK_B }
        })],
    );
    let error = apply_error(
        &doc,
        vec![json!({
            "op": "fx.update", "fxId": "fx_duck", "paramsPatch": {},
            "sidechainSource": TRK_A
        })],
    );
    assert_eq!(error.code(), ValidationCode::FxParam);
}

#[test]
fn track_remove_clears_every_source_that_points_at_it() {
    let doc = run(
        &fixture(),
        vec![
            json!({
                "op": "fx.add",
                "scope": { "kind": "track", "trackId": TRK_A },
                "fx": { "id": "fx_ducktrack", "type": "sidechain_duck",
                        "params": {}, "bypass": false, "sidechainSource": TRK_B }
            }),
            json!({
                "op": "fx.add",
                "scope": { "kind": "clip", "clipId": CLIP_A },
                "fx": { "id": "fx_duckclip", "type": "sidechain_duck",
                        "params": {}, "bypass": false, "sidechainSource": TRK_B }
            }),
            json!({
                "op": "fx.add",
                "scope": { "kind": "master" },
                "fx": { "id": "fx_duckmaster", "type": "sidechain_duck",
                        "params": {}, "bypass": false, "sidechainSource": TRK_B }
            }),
        ],
    );
    let next = run(
        &doc,
        vec![json!({ "op": "track.remove", "trackId": TRK_B })],
    );
    assert!(next.tracks.iter().all(|track| track.id.as_str() != TRK_B));
    assert!(fx(&next, "fx_ducktrack").sidechain_source.is_none());
    assert!(fx(&next, "fx_duckclip").sidechain_source.is_none());
    assert!(fx(&next, "fx_duckmaster").sidechain_source.is_none());
    // The clip itself is still on its track.
    assert!(
        next.arrangement.sections[0].lanes.0[&TRK_A.parse().unwrap()]
            .clips
            .iter()
            .any(|clip| clip.id.as_str() == CLIP_A)
    );
    let _ = SEC_A;
}

#[test]
fn validation_reports_a_dangling_source_as_an_unknown_track() {
    let mut doc = fixture();
    doc.tracks[0].fx.0.push(duck("fx_duck", "trk_ghost"));
    let errors = validate(&doc, &assets()).expect_err("the source track does not exist");
    assert!(
        errors
            .iter()
            .any(|error| error.code == ValidationCode::UnknownTrack)
    );
}

#[test]
fn validation_rejects_a_source_on_another_effect_type_and_a_self_source() {
    let mut doc = fixture();
    let mut gain: FxInstance = serde_json::from_value(json!({
        "id": "fx_gain", "type": "gain", "params": {},
        "bypass": false, "sidechainSource": TRK_B
    }))
    .unwrap();
    gain.sidechain_source = Some(TRK_B.parse().unwrap());
    doc.tracks[0].fx.0.push(gain);
    let errors = validate(&doc, &assets()).expect_err("gain cannot carry a source");
    assert!(
        errors
            .iter()
            .any(|error| error.code == ValidationCode::FxParam)
    );

    let mut doc = fixture();
    doc.tracks[0].fx.0.push(duck("fx_duck", TRK_A));
    let errors = validate(&doc, &assets()).expect_err("a track cannot key itself");
    assert!(
        errors
            .iter()
            .any(|error| error.code == ValidationCode::FxParam)
    );
}

/// Absent and `null` must survive a serde round trip unchanged: commit ids hash the batch JSON.
#[test]
fn fx_update_sidechain_source_round_trips_absent_and_null() {
    for json in [
        r#"{"op":"fx.update","fxId":"fx_01J000000000000000000DUCK1","paramsPatch":{}}"#,
        r#"{"op":"fx.update","fxId":"fx_01J000000000000000000DUCK1","paramsPatch":{},"sidechainSource":null}"#,
        r#"{"op":"fx.update","fxId":"fx_01J000000000000000000DUCK1","paramsPatch":{},"sidechainSource":"trk_drums"}"#,
    ] {
        let op: bragi_model::generated::FxUpdateOp = serde_json::from_str(json).expect("parses");
        let back: serde_json::Value = serde_json::to_value(&op).expect("serialises");
        let expected: serde_json::Value = serde_json::from_str(json).expect("valid json");
        assert_eq!(back, expected, "{json}");
    }
}
