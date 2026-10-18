//! One test per v1 op (`specs/02-song-model.md` §4.2), plus the error and lock paths.
//!
//! `analysis.apply` and `region.adopt` are out of scope for WP-0.3; the last tests assert they are
//! rejected with a structured `unsupported_op` rather than silently ignored.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use bragi_model::generated::{Project, SectionKind, TransitionKind};
use bragi_model::{ApplyError, ValidationCode, apply, section_spans, validate};
use common::{CLIP_A, SEC_A, SEC_B, TRK_A, TRK_B, assets, batch, fixture, user_batch};
use serde_json::{Value, json};

/// Runs a user batch and asserts it succeeded and left a valid document.
fn run(doc: &Project, ops: Vec<Value>) -> Project {
    let batch = user_batch(ops);
    let next = apply(doc, &batch, &assets()).expect("the batch should apply");
    validate(&next, &assets()).expect("the result should be valid");
    next
}

fn section<'a>(doc: &'a Project, id: &str) -> &'a bragi_model::generated::SectionInstance {
    doc.arrangement
        .sections
        .iter()
        .find(|section| section.id.to_string() == id)
        .expect("the section exists")
}

fn clip_ids(doc: &Project, section_id: &str, track_id: &str) -> Vec<String> {
    let instance = section(doc, section_id);
    instance
        .lanes
        .0
        .get(&track_id.parse().unwrap())
        .map(|lane| lane.clips.iter().map(|clip| clip.id.to_string()).collect())
        .unwrap_or_default()
}

#[test]
fn project_set_meta_patches_only_the_given_fields() {
    let doc = fixture();
    let next = run(
        &doc,
        vec![json!({ "op": "project.set_meta", "title": "Renamed", "tags": ["a", "b"] })],
    );
    assert_eq!(next.meta.title, "Renamed");
    assert_eq!(next.meta.tags.0, vec!["a", "b"]);
    assert_eq!(next.meta.description, None);
}

#[test]
fn track_add_inserts_at_the_index() {
    let doc = fixture();
    let next = run(
        &doc,
        vec![json!({ "op": "track.add", "index": 0, "track": {
            "id": "trk_new", "name": "Strings", "role": "strings", "color": "#8A8F98",
            "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": [] } })],
    );
    assert_eq!(next.tracks[0].id.to_string(), "trk_new");
    assert_eq!(next.tracks.len(), 3);
}

#[test]
fn track_remove_drops_the_track_and_its_lanes() {
    let doc = fixture();
    let next = run(
        &doc,
        vec![json!({ "op": "track.remove", "trackId": TRK_B })],
    );
    assert_eq!(next.tracks.len(), 1);
    assert!(
        section(&next, SEC_A)
            .lanes
            .0
            .contains_key(&TRK_A.parse().unwrap())
    );
    assert!(
        !section(&next, SEC_A)
            .lanes
            .0
            .contains_key(&TRK_B.parse().unwrap())
    );
}

#[test]
fn track_update_patches_the_mixer() {
    let doc = fixture();
    let next = run(
        &doc,
        vec![json!({ "op": "track.update", "trackId": TRK_A,
            "patch": { "gainDb": -4.5, "pan": -1.0, "name": "Drums" } })],
    );
    let track = next
        .tracks
        .iter()
        .find(|t| t.id.to_string() == TRK_A)
        .unwrap();
    assert_eq!(track.gain_db, -4.5);
    assert_eq!(track.pan, -1.0);
    assert_eq!(track.name, "Drums");
}

#[test]
fn fx_add_update_reorder_remove_in_every_scope() {
    let doc = fixture();
    let next = run(
        &doc,
        vec![
            json!({ "op": "fx.add", "scope": { "kind": "track", "trackId": TRK_A },
                "fx": { "id": "fx_1", "type": "eq3", "params": { "lowDb": 0 }, "bypass": false } }),
            json!({ "op": "fx.add", "scope": { "kind": "master" },
                "fx": { "id": "fx_2", "type": "limiter", "params": { "ceilingDb": -1 }, "bypass": false } }),
            json!({ "op": "fx.add", "scope": { "kind": "clip", "clipId": CLIP_A },
                "fx": { "id": "fx_3", "type": "gain", "params": { "db": -1 }, "bypass": false } }),
        ],
    );
    let track = next
        .tracks
        .iter()
        .find(|t| t.id.to_string() == TRK_A)
        .unwrap();
    assert_eq!(track.fx.0.len(), 1);
    assert_eq!(next.arrangement.master.fx.0.len(), 1);
    let clip = section(&next, SEC_A).lanes.0[&TRK_A.parse().unwrap()]
        .clips
        .iter()
        .find(|c| c.id.to_string() == CLIP_A)
        .unwrap();
    assert_eq!(clip.fx.as_ref().unwrap().0.len(), 1);

    let next = run(
        &next,
        vec![
            json!({ "op": "fx.update", "fxId": "fx_1", "paramsPatch": { "lowDb": 3 }, "bypass": true }),
            json!({ "op": "fx.add", "scope": { "kind": "track", "trackId": TRK_A },
                "fx": { "id": "fx_4", "type": "gain", "params": { "db": 0 }, "bypass": false } }),
            json!({ "op": "fx.reorder", "fxId": "fx_4", "newIndex": 0 }),
        ],
    );
    let track = next
        .tracks
        .iter()
        .find(|t| t.id.to_string() == TRK_A)
        .unwrap();
    assert_eq!(track.fx.0.len(), 2);
    assert_eq!(track.fx.0[0].id.to_string(), "fx_4");
    let eq = track
        .fx
        .0
        .iter()
        .find(|fx| fx.id.to_string() == "fx_1")
        .unwrap();
    assert!(eq.bypass);
    assert_eq!(eq.params.0["lowDb"], 3.0);

    let next = run(
        &next,
        vec![
            json!({ "op": "fx.remove", "fxId": "fx_1" }),
            json!({ "op": "fx.remove", "fxId": "fx_2" }),
            json!({ "op": "fx.remove", "fxId": "fx_3" }),
        ],
    );
    assert!(
        next.tracks
            .iter()
            .find(|t| t.id.to_string() == TRK_A)
            .unwrap()
            .fx
            .0
            .iter()
            .all(|fx| fx.id.to_string() != "fx_1")
    );
    assert!(next.arrangement.master.fx.0.is_empty());
}

#[test]
fn section_insert_places_the_section_at_the_index() {
    let doc = fixture();
    let next = run(
        &doc,
        vec![
            json!({ "op": "section.insert", "index": 1, "section": new_section("sec_new", 1920) }),
        ],
    );
    assert_eq!(next.arrangement.sections.len(), 3);
    assert_eq!(next.arrangement.sections[1].id.to_string(), "sec_new");
    assert_eq!(section_spans(&next)[1].start_tick, 3840);
}

#[test]
fn section_remove_closes_the_gap() {
    let doc = fixture();
    let next = run(
        &doc,
        vec![json!({ "op": "section.remove", "sectionId": SEC_A, "closeGap": true })],
    );
    assert_eq!(next.arrangement.sections.len(), 1);
    assert_eq!(section_spans(&next)[0].start_tick, 0);
}

#[test]
fn section_move_reanchors_master_automation() {
    let doc = run(
        &fixture(),
        vec![
            json!({ "op": "automation.set", "scope": { "kind": "master" },
            "target": "master:gainDb",
            "points": [ { "tick": 5000, "value": 0.5, "curve": "linear" } ] }),
        ],
    );
    let next = run(
        &doc,
        vec![json!({ "op": "section.move", "sectionId": SEC_A, "toIndex": 1 })],
    );
    assert_eq!(next.arrangement.sections[0].id.to_string(), SEC_B);
    // The point was 1160 ticks into sec_b; sec_b now starts at 0, so the point follows it.
    let point = &next.arrangement.master.automation.0[0].points.0[0];
    assert_eq!(point.tick, 1160);
}

#[test]
fn section_duplicate_deep_copies_with_new_ids() {
    let doc = fixture();
    let next = run(
        &doc,
        vec![
            json!({ "op": "section.duplicate", "sectionId": SEC_A, "toIndex": 2, "newId": "sec_dup" }),
        ],
    );
    assert_eq!(next.arrangement.sections.len(), 3);
    let copy = section(&next, "sec_dup");
    assert_eq!(copy.derived_from.as_ref().unwrap().to_string(), SEC_A);
    let ids = clip_ids(&next, "sec_dup", TRK_A);
    assert_eq!(ids.len(), 2);
    assert!(ids.iter().all(|id| id.starts_with("clp_") && id != CLIP_A));
}

#[test]
fn section_resize_trim_cuts_clips_with_a_fade() {
    let doc = fixture();
    let next = run(
        &doc,
        vec![
            json!({ "op": "section.resize", "sectionId": SEC_A, "lengthTicks": 1000, "mode": "trim" }),
        ],
    );
    let resized = section(&next, SEC_A);
    assert_eq!(resized.length_ticks.get(), 1000);
    let clips = &resized.lanes.0[&TRK_A.parse().unwrap()].clips;
    assert_eq!(clips.len(), 1);
    // 1000 ticks into a clip whose 48 000 samples span 1920 ticks is 25 000 samples.
    assert_eq!(clips[0].src_end, 25_000);
    assert!(clips[0].fade_out_ticks > 0);
}

#[test]
fn section_resize_loop_tiles_whole_bars() {
    let doc = fixture();
    let next = run(
        &doc,
        vec![
            json!({ "op": "section.resize", "sectionId": SEC_A, "lengthTicks": 7680, "mode": "loop" }),
        ],
    );
    let resized = section(&next, SEC_A);
    assert_eq!(resized.length_ticks.get(), 7680);
    assert_eq!(resized.lanes.0[&TRK_A.parse().unwrap()].clips.len(), 4);
}

#[test]
fn section_resize_stretch_scales_the_warp() {
    let doc = fixture();
    let next = run(
        &doc,
        vec![
            json!({ "op": "section.resize", "sectionId": SEC_A, "lengthTicks": 7680, "mode": "stretch" }),
        ],
    );
    let clips = &section(&next, SEC_A).lanes.0[&TRK_A.parse().unwrap()].clips;
    assert_eq!(clips[0].start, 0);
    assert_eq!(clips[1].start, 3840);
}

#[test]
fn section_split_splits_clips_at_the_boundary() {
    let doc = fixture();
    let next = run(
        &doc,
        vec![
            json!({ "op": "section.split", "sectionId": SEC_A, "atTick": 1920, "newId": "sec_split" }),
        ],
    );
    assert_eq!(next.arrangement.sections.len(), 3);
    assert_eq!(section(&next, SEC_A).length_ticks.get(), 1920);
    let right = section(&next, "sec_split");
    assert_eq!(right.length_ticks.get(), 1920);
    assert_eq!(right.transition_in.kind, TransitionKind::Cut);
    // The clip that started at the boundary moved to the right section, start 0.
    assert_eq!(right.lanes.0[&TRK_A.parse().unwrap()].clips[0].start, 0);
}

#[test]
fn section_merge_requires_adjacency_and_concatenates() {
    let doc = fixture();
    let next = run(
        &doc,
        vec![json!({ "op": "section.merge", "sectionIdA": SEC_A, "sectionIdB": SEC_B })],
    );
    assert_eq!(next.arrangement.sections.len(), 1);
    assert_eq!(section(&next, SEC_A).length_ticks.get(), 7680);
    // sec_b's four clips moved into sec_a, shifted by 3840 ticks.
    let clips = &section(&next, SEC_A).lanes.0[&TRK_A.parse().unwrap()].clips;
    assert_eq!(clips.len(), 4);
    assert_eq!(clips[2].start, 3840);

    let err = apply(
        &doc,
        &user_batch(vec![
            json!({ "op": "section.merge", "sectionIdA": SEC_B, "sectionIdB": SEC_A }),
        ]),
        &assets(),
    )
    .unwrap_err();
    assert_eq!(err.code(), ValidationCode::IndexOutOfRange);
}

#[test]
fn section_update_and_set_transition() {
    let doc = fixture();
    let next = run(
        &doc,
        vec![
            json!({ "op": "section.update", "sectionId": SEC_A,
                "patch": { "kind": "chorus", "label": "Chorus", "locked": true } }),
            json!({ "op": "section.set_transition", "sectionId": SEC_B,
                "transition": { "kind": "crossfade", "lengthTicks": 960 } }),
        ],
    );
    let a = section(&next, SEC_A);
    assert_eq!(a.kind, SectionKind::Chorus);
    assert_eq!(a.label, "Chorus");
    assert_eq!(a.locked, Some(true));
    assert_eq!(
        section(&next, SEC_B).transition_in.kind,
        TransitionKind::Crossfade
    );
}

#[test]
fn clip_add_update_remove() {
    let doc = fixture();
    let new_clip = common::clip_json("clp_added", 3840);
    let next = run(
        &doc,
        vec![json!({ "op": "clip.add", "sectionId": SEC_B, "trackId": TRK_A, "clip": new_clip })],
    );
    assert!(clip_ids(&next, SEC_B, TRK_A).contains(&"clp_added".to_string()));

    let next = run(
        &next,
        vec![json!({ "op": "clip.update", "clipId": "clp_added",
            "patch": { "gainDb": -6, "fadeInTicks": 240, "fadeCurve": "linear" } })],
    );
    let instance = section(&next, SEC_B);
    let clip = instance.lanes.0[&TRK_A.parse().unwrap()]
        .clips
        .iter()
        .find(|c| c.id.to_string() == "clp_added")
        .unwrap();
    assert_eq!(clip.gain_db, -6.0);
    assert_eq!(clip.fade_in_ticks, 240);

    let next = run(
        &next,
        vec![json!({ "op": "clip.remove", "clipId": "clp_added" })],
    );
    assert!(!clip_ids(&next, SEC_B, TRK_A).contains(&"clp_added".to_string()));
}

#[test]
fn clip_split_matches_the_sample() {
    let doc = fixture();
    let next = run(
        &doc,
        vec![json!({ "op": "clip.split", "clipId": CLIP_A, "atTick": 960, "newId": "clp_second" })],
    );
    let clips = &section(&next, SEC_A).lanes.0[&TRK_A.parse().unwrap()].clips;
    let first = clips.iter().find(|c| c.id.to_string() == CLIP_A).unwrap();
    let second = clips
        .iter()
        .find(|c| c.id.to_string() == "clp_second")
        .unwrap();
    assert_eq!(first.src_end, 24_000);
    assert_eq!(second.start, 960);
    assert_eq!(second.src_start, 24_000);
    assert_eq!(second.src_end, 48_000);
}

#[test]
fn clip_replace_swaps_one_clip_for_many() {
    let doc = common::build_project(1, 1, 0);
    let next = run(
        &doc,
        vec![json!({ "op": "clip.replace", "clipId": CLIP_A, "clips": [
            common::clip_json_ticks("clp_r1", 0, 960),
            common::clip_json_ticks("clp_r2", 960, 960) ] })],
    );
    let ids = clip_ids(&next, SEC_A, TRK_A);
    assert!(!ids.contains(&CLIP_A.to_string()));
    assert!(ids.contains(&"clp_r1".to_string()) && ids.contains(&"clp_r2".to_string()));
}

#[test]
fn automation_set_replaces_the_covered_range_then_clear() {
    let doc = run(
        &fixture(),
        vec![
            json!({ "op": "automation.set", "scope": { "kind": "lane", "sectionId": SEC_A, "trackId": TRK_A },
            "target": "track:trk_0/gainDb",
            "points": [ { "tick": 0, "value": 0.0, "curve": "step" },
                        { "tick": 960, "value": 1.0, "curve": "linear" } ] }),
        ],
    );
    // Replace the range [0, 960] the new points span: both original points go, the new ones stay.
    let next = run(
        &doc,
        vec![
            json!({ "op": "automation.set", "scope": { "kind": "lane", "sectionId": SEC_A, "trackId": TRK_A },
            "target": "track:trk_0/gainDb",
            "points": [ { "tick": 0, "value": 7.0, "curve": "step" },
                        { "tick": 960, "value": 8.0, "curve": "step" } ] }),
        ],
    );
    let lane = &section(&next, SEC_A).lanes.0[&TRK_A.parse().unwrap()];
    assert_eq!(lane.automation.0[0].points.0.len(), 2);
    assert_eq!(lane.automation.0[0].points.0[0].value, 7.0);

    let next = run(
        &next,
        vec![
            json!({ "op": "automation.clear", "scope": { "kind": "lane", "sectionId": SEC_A, "trackId": TRK_A },
            "target": "track:trk_0/gainDb" }),
        ],
    );
    assert!(
        section(&next, SEC_A).lanes.0[&TRK_A.parse().unwrap()]
            .automation
            .0
            .is_empty()
    );
}

#[test]
fn automation_clear_honours_a_range() {
    let doc = run(
        &fixture(),
        vec![
            json!({ "op": "automation.set", "scope": { "kind": "master" }, "target": "master:gainDb",
            "points": [ { "tick": 0, "value": 0.0, "curve": "step" },
                        { "tick": 9999, "value": 1.0, "curve": "step" } ] }),
        ],
    );
    let next = run(
        &doc,
        vec![
            json!({ "op": "automation.clear", "scope": { "kind": "master" }, "target": "master:gainDb",
            "range": { "startTick": 0, "endTick": 1000 } }),
        ],
    );
    let points = &next.arrangement.master.automation.0[0].points.0;
    assert_eq!(points.len(), 1);
    assert_eq!(points[0].tick, 9999);
}

#[test]
fn tempo_set_replaces_the_map() {
    let doc = fixture();
    let next = run(
        &doc,
        vec![json!({ "op": "tempo.set", "tempoMap": [
            { "tick": 0, "bpm": 90, "curve": "step" },
            { "tick": 3840, "bpm": 140, "curve": "linear" } ] })],
    );
    assert_eq!(next.arrangement.timebase.tempo_map.0.len(), 2);
    // Beatgrid clips follow the tempo only through their anchors, which are unchanged.
    assert_eq!(clip_ids(&next, SEC_A, TRK_A).len(), 2);
}

#[test]
fn key_transpose_is_additive_in_both_scopes() {
    let doc = fixture();
    let next = run(
        &doc,
        vec![json!({ "op": "key.transpose", "semitones": 2, "scope": "all" })],
    );
    let all_pitched = next
        .arrangement
        .sections
        .iter()
        .flat_map(|s| s.lanes.0.values())
        .flat_map(|lane| &lane.clips)
        .all(|clip| clip.pitch_semitones == 2.0);
    assert!(all_pitched);

    let region = json!({ "startTick": 0, "endTick": 1920, "tracks": "all" });
    let next = run(
        &next,
        vec![json!({ "op": "key.transpose", "semitones": 3, "scope": region })],
    );
    let first = &section(&next, SEC_A).lanes.0[&TRK_A.parse().unwrap()].clips[0];
    let second = &section(&next, SEC_A).lanes.0[&TRK_A.parse().unwrap()].clips[1];
    assert_eq!(first.pitch_semitones, 5.0);
    assert_eq!(second.pitch_semitones, 2.0);
}

#[test]
fn region_clear_trims_and_fades() {
    let doc = fixture();
    let next = run(
        &doc,
        vec![json!({ "op": "region.clear",
            "region": { "startTick": 960, "endTick": 2880, "tracks": "all" } })],
    );
    let clips = &section(&next, SEC_A).lanes.0[&TRK_A.parse().unwrap()].clips;
    // The first clip lost its head (new start 960) and the second lost its tail.
    assert_eq!(clips[0].start, 960);
    assert!(clips[0].fade_in_ticks > 0);
    assert_eq!(clips[1].start, 1920);
    assert!(clips[1].fade_out_ticks > 0);
}

#[test]
fn unsupported_ops_are_rejected_structurally() {
    let doc = fixture();
    for op in [
        json!({ "op": "analysis.apply", "sourceId": "src_1", "stage": "rhythm",
        "blob": common::HASH, "effects": [] }),
        json!({ "op": "region.adopt", "fromCommit": "cmt_01JAB3QK7M9P2V6XWN0T4Y8ZB5",
        "region": { "startTick": 0, "endTick": 30720, "tracks": "all" } }),
    ] {
        let err = apply(&doc, &user_batch(vec![op]), &assets()).unwrap_err();
        assert_eq!(err.code(), ValidationCode::UnsupportedOp);
        assert_eq!(err.errors()[0].op_index, 0);
    }
}

#[test]
fn ai_batches_may_not_modify_locked_sections() {
    let doc = run(
        &fixture(),
        vec![json!({ "op": "section.update", "sectionId": SEC_A, "patch": { "locked": true } })],
    );
    let batch = batch(
        json!({ "kind": "ai", "planId": "pln_01", "model": "test" }),
        vec![json!({ "op": "section.update", "sectionId": SEC_A, "patch": { "label": "AI" } })],
    );
    let err = apply(&doc, &batch, &assets()).unwrap_err();
    assert_eq!(err.code(), ValidationCode::LockedSection);

    // A user batch may still edit it.
    let next = run(
        &doc,
        vec![json!({ "op": "section.update", "sectionId": SEC_A, "patch": { "label": "Mine" } })],
    );
    assert_eq!(section(&next, SEC_A).label, "Mine");
}

#[test]
fn a_failed_batch_leaves_the_document_untouched() {
    let doc = fixture();
    let before = bragi_model::canonical_json(&doc);
    let err = apply(
        &doc,
        &user_batch(vec![
            json!({ "op": "project.set_meta", "title": "Should not stick" }),
            json!({ "op": "track.update", "trackId": "trk_missing", "patch": { "gainDb": 1 } }),
        ]),
        &assets(),
    )
    .unwrap_err();
    assert_eq!(err.code(), ValidationCode::MissingTarget);
    assert_eq!(err.errors()[0].op_index, 1);
    assert_eq!(before, bragi_model::canonical_json(&doc));
}

#[test]
fn index_out_of_range_is_reported_per_op() {
    let doc = fixture();
    let err = apply(
        &doc,
        &user_batch(vec![json!({ "op": "section.insert", "index": 99,
            "section": new_section("sec_late", 1920) })]),
        &assets(),
    )
    .unwrap_err();
    assert_eq!(err.code(), ValidationCode::IndexOutOfRange);
}

#[test]
fn duplicate_ids_are_rejected() {
    let doc = fixture();
    let err = apply(
        &doc,
        &user_batch(vec![json!({ "op": "track.add", "track": {
            "id": TRK_A, "name": "Dup", "role": "other", "color": "#8A8F98",
            "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": [] } })]),
        &assets(),
    )
    .unwrap_err();
    assert_eq!(err.code(), ValidationCode::DuplicateId);
}

#[test]
fn invalid_invariants_are_an_apply_error_not_a_panic() {
    // A tempo map that does not start at 0 is a document-level invariant failure.
    let doc = fixture();
    let err = apply(
        &doc,
        &user_batch(vec![json!({ "op": "tempo.set", "tempoMap": [
            { "tick": 100, "bpm": 120, "curve": "step" } ] })]),
        &assets(),
    )
    .unwrap_err();
    assert!(matches!(err, ApplyError::Invariants(_)));
    assert_eq!(err.code(), ValidationCode::TempoMap);
}

fn new_section(id: &str, length: u64) -> Value {
    json!({ "id": id, "kind": "custom", "label": id, "lengthTicks": length,
        "lanes": {}, "transitionIn": { "kind": "cut", "lengthTicks": 0 } })
}
