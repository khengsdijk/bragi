//! `region.adopt` (`specs/02-song-model.md` §5.4): copying a region across commits.
//!
//! The source document is supplied through `CommitDocs`; `apply` (with no commits) must fail the
//! op with `unknown_commit` rather than silently doing nothing.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::collections::HashMap;

use bragi_model::generated::{Clip, CommitId, FadeCurve, Project, TrackId};
use bragi_model::{
    ApplyError, TempoCtx, ValidationCode, apply, apply_with, canonical_json, clip_end_local,
    section_spans, validate,
};
use common::{SEC_A, SEC_B, TRK_A, TRK_B, assets, build_project, fixture, user_batch};
use serde_json::{Value, json};

/// The commit ID every adopt test points at.
const COMMIT: &str = "cmt_01JAB3QK7M9P2V6XWN0T4Y8ZB5";
/// A commit ID that is deliberately never supplied.
const MISSING_COMMIT: &str = "cmt_01JAB3QK7M9P2V6XWN0T4Y8ZB6";

fn commit_id(id: &str) -> CommitId {
    id.parse().unwrap()
}

fn commits(source: &Project) -> HashMap<CommitId, Project> {
    HashMap::from([(commit_id(COMMIT), source.clone())])
}

fn adopt(from: &str, start: i64, end: i64, tracks: Value) -> Value {
    json!({
        "op": "region.adopt",
        "fromCommit": from,
        "region": { "startTick": start, "endTick": end, "tracks": tracks }
    })
}

/// Applies a user batch with `source` available, then asserts the result validates.
fn run(doc: &Project, source: &Project, ops: Vec<Value>) -> Project {
    let next = apply_with(doc, &user_batch(ops), &assets(), &commits(source))
        .expect("the batch should apply");
    validate(&next, &assets()).expect("the result should be valid");
    next
}

/// Applies an ordinary user batch (no commits).
fn edit(doc: &Project, ops: Vec<Value>) -> Project {
    apply(doc, &user_batch(ops), &assets()).expect("the edit should apply")
}

/// One clip with its absolute arrangement span.
struct AbsoluteClip {
    track: String,
    start: i64,
    end: i64,
    clip: Clip,
}

fn absolute_clips(doc: &Project) -> Vec<AbsoluteClip> {
    let tempo = TempoCtx::from_project(doc);
    let index = assets();
    let mut out = Vec::new();
    for span in section_spans(doc) {
        for (track, lane) in &doc.arrangement.sections[span.index].lanes.0 {
            for clip in &lane.clips {
                let end =
                    clip_end_local(clip, &tempo, &index, span.start_tick).unwrap_or(clip.start);
                out.push(AbsoluteClip {
                    track: track.to_string(),
                    start: span.start_tick + clip.start,
                    end: span.start_tick + end,
                    clip: clip.clone(),
                });
            }
        }
    }
    out
}

fn track_clips(doc: &Project, track: &str) -> Vec<AbsoluteClip> {
    absolute_clips(doc)
        .into_iter()
        .filter(|item| item.track.as_str() == track)
        .collect()
}

fn lane_clips<'a>(doc: &'a Project, section: &str, track: &str) -> &'a [Clip] {
    doc.arrangement
        .sections
        .iter()
        .find(|instance| instance.id.to_string() == section)
        .unwrap()
        .lanes
        .0
        .get(&track.parse::<TrackId>().unwrap())
        .map_or(&[], |lane| lane.clips.as_slice())
}

/// The clip's content without its identity and the boundary fades.
fn content(clip: &Clip) -> Value {
    let mut value = serde_json::to_value(clip).unwrap();
    let object = value.as_object_mut().unwrap();
    object.remove("id");
    object.remove("fadeInTicks");
    object.remove("fadeOutTicks");
    object.remove("fadeCurve");
    value
}

/// The 10 ms fade at 120 bpm is 19 ticks (`CUT_FADE_SECS` / one tick).
const FADE_TICKS: u64 = 19;

#[test]
fn adopting_from_an_identical_document_keeps_the_content_and_adds_fades() {
    let doc = fixture();
    let source = fixture();
    let next = run(
        &doc,
        &source,
        vec![adopt(COMMIT, 1_920, 3_840, json!("all"))],
    );

    // The clip outside the region is untouched.
    let before = absolute_clips(&doc);
    let after = absolute_clips(&next);
    let outside = before
        .iter()
        .find(|item| item.start == 0 && item.end == 1_920)
        .unwrap();
    let still_there = after
        .iter()
        .find(|item| item.clip.id == outside.clip.id)
        .expect("the clip outside the region keeps its ID");
    assert!(content(&outside.clip) == content(&still_there.clip));

    // The clip inside the region is copied with the same content apart from the fades.
    let original = before
        .iter()
        .find(|item| item.start == 1_920 && item.track == TRK_A)
        .unwrap();
    let copy = after
        .iter()
        .find(|item| item.start == 1_920 && item.track == TRK_A)
        .unwrap();
    assert!(content(&original.clip) == content(&copy.clip));
    assert_eq!(copy.clip.fade_in_ticks, FADE_TICKS);
    assert_eq!(copy.clip.fade_out_ticks, FADE_TICKS);
    assert_eq!(copy.clip.fade_curve, FadeCurve::EqualPower);

    // Two runs produce byte-identical documents: the derived IDs are deterministic.
    let again = run(
        &doc,
        &source,
        vec![adopt(COMMIT, 1_920, 3_840, json!("all"))],
    );
    assert_eq!(canonical_json(&next), canonical_json(&again));
}

#[test]
fn adopt_replaces_exactly_the_regions_content() {
    let doc = fixture();
    // Give the source clips at [0, 1920) and [1920, 3840) distinct gains.
    let source = edit(
        &fixture(),
        vec![
            json!({ "op": "clip.update", "clipId": "clp_000", "patch": { "gainDb": -11 } }),
            json!({ "op": "clip.update", "clipId": "clp_001", "patch": { "gainDb": -12 } }),
        ],
    );
    let next = run(&doc, &source, vec![adopt(COMMIT, 960, 2_880, json!("all"))]);

    let clips = lane_clips(&next, SEC_A, TRK_A);
    assert_eq!(clips.len(), 4, "head + two copies + tail");

    // Content outside the region keeps its IDs and samples.
    let head = clips
        .iter()
        .find(|clip| clip.id.to_string() == "clp_000")
        .expect("the head before the region is untouched");
    assert_eq!(head.start, 0);
    assert_eq!(head.src_start, 0);
    assert_eq!(head.src_end, 24_000);
    assert_eq!(head.gain_db, 0.0);
    let tail = clips
        .iter()
        .find(|clip| clip.id.to_string() == "clp_001")
        .expect("the tail after the region is untouched");
    assert_eq!(tail.start, 2_880);
    assert_eq!(tail.src_start, 24_000);
    assert_eq!(tail.gain_db, 0.0);

    // Content inside the region comes from the source and is cut at both edges.
    let first = clips.iter().find(|clip| clip.start == 960).unwrap();
    assert_eq!(first.gain_db, -11.0);
    assert_eq!(first.src_start, 24_000);
    assert_eq!(first.src_end, 48_000);
    assert_eq!(first.fade_in_ticks, FADE_TICKS);
    assert_eq!(first.fade_out_ticks, 0);
    let second = clips.iter().find(|clip| clip.start == 1_920).unwrap();
    assert_eq!(second.gain_db, -12.0);
    assert_eq!(second.src_start, 0);
    assert_eq!(second.src_end, 24_000);
    assert_eq!(second.fade_in_ticks, 0);
    assert_eq!(second.fade_out_ticks, FADE_TICKS);
}

#[test]
fn an_unknown_commit_is_reported_with_the_ops_index() {
    let doc = fixture();
    let before = canonical_json(&doc);
    let err = apply(
        &doc,
        &user_batch(vec![
            json!({ "op": "project.set_meta", "title": "Should not stick" }),
            adopt(MISSING_COMMIT, 0, 1_920, json!("all")),
        ]),
        &assets(),
    )
    .unwrap_err();
    assert_eq!(err.code(), ValidationCode::UnknownCommit);
    assert_eq!(err.errors()[0].op_index, 1);
    assert!(matches!(err, ApplyError::Op(_)));
    assert_eq!(before, canonical_json(&doc));
}

#[test]
fn a_moved_source_section_is_matched_by_absolute_ticks() {
    let doc = fixture();
    // Mark every clip of the source's first section, then move that section second. The target's
    // sec_1 (3840..7680) now overlaps the source's sec_0, so a tick-based match copies gain -9.
    let source = edit(
        &fixture(),
        vec![
            json!({ "op": "clip.update", "clipId": "clp_000", "patch": { "gainDb": -9 } }),
            json!({ "op": "clip.update", "clipId": "clp_001", "patch": { "gainDb": -9 } }),
            json!({ "op": "clip.update", "clipId": "clp_010", "patch": { "gainDb": -9 } }),
            json!({ "op": "clip.update", "clipId": "clp_011", "patch": { "gainDb": -9 } }),
            json!({ "op": "section.move", "sectionId": SEC_A, "toIndex": 1 }),
        ],
    );
    assert_eq!(
        section_spans(&source)[1].id.to_string(),
        SEC_A,
        "the source's first section now starts at 3840"
    );
    assert_eq!(section_spans(&source)[1].start_tick, 3_840);

    let next = run(
        &doc,
        &source,
        vec![adopt(COMMIT, 3_840, 5_760, json!("all"))],
    );

    // The copy lands in the target's sec_1 (which covers 3840..7680) at local tick 0.
    let clips = lane_clips(&next, SEC_B, TRK_A);
    let copied = clips.iter().find(|clip| clip.start == 0).unwrap();
    assert_eq!(
        copied.gain_db, -9.0,
        "content came from the source's absolute range"
    );
    assert_eq!(copied.fade_in_ticks, FADE_TICKS);
    // The target's own clip that starts at the region end keeps its content.
    let kept = clips.iter().find(|clip| clip.start == 1_920).unwrap();
    assert_eq!(kept.id.to_string(), "clp_101");
    assert_eq!(kept.gain_db, 0.0);
}

#[test]
fn a_source_track_missing_from_the_target_is_skipped() {
    let source = build_project(2, 2, 0);
    let doc = edit(
        &fixture(),
        vec![json!({ "op": "track.remove", "trackId": TRK_B })],
    );
    let next = run(&doc, &source, vec![adopt(COMMIT, 0, 1_920, json!("all"))]);

    assert_eq!(next.tracks.len(), 1);
    for section in &next.arrangement.sections {
        assert!(
            !section
                .lanes
                .0
                .contains_key(&TRK_B.parse::<TrackId>().unwrap()),
            "no lane is created for the source-only track"
        );
    }
    assert!(!track_clips(&next, TRK_A).is_empty());
}

#[test]
fn automation_in_the_range_comes_from_the_source() {
    let doc = edit(
        &fixture(),
        vec![
            json!({ "op": "automation.set", "scope": { "kind": "lane", "sectionId": SEC_A, "trackId": TRK_A },
                "target": "track:trk_0/gainDb",
                "points": [ { "tick": 0, "value": 0.1, "curve": "step" },
                            { "tick": 1000, "value": 0.2, "curve": "step" } ] }),
            json!({ "op": "automation.set", "scope": { "kind": "master" },
                "target": "master:gainDb",
                "points": [ { "tick": 1000, "value": 0.1, "curve": "step" },
                            { "tick": 5000, "value": 0.9, "curve": "step" } ] }),
        ],
    );
    let source = edit(
        &fixture(),
        vec![
            json!({ "op": "automation.set", "scope": { "kind": "lane", "sectionId": SEC_A, "trackId": TRK_A },
                "target": "track:trk_0/gainDb",
                "points": [ { "tick": 0, "value": 0.7, "curve": "step" },
                            { "tick": 1000, "value": 0.8, "curve": "step" } ] }),
            json!({ "op": "automation.set", "scope": { "kind": "lane", "sectionId": SEC_B, "trackId": TRK_A },
                "target": "track:trk_0/gainDb",
                "points": [ { "tick": 500, "value": 0.6, "curve": "step" } ] }),
            json!({ "op": "automation.set", "scope": { "kind": "master" },
                "target": "master:gainDb",
                "points": [ { "tick": 1000, "value": 0.3, "curve": "step" },
                            { "tick": 4340, "value": 0.4, "curve": "step" } ] }),
        ],
    );
    let next = run(&doc, &source, vec![adopt(COMMIT, 0, 5_000, json!("all"))]);

    let lane = |section: &str| {
        next.arrangement
            .sections
            .iter()
            .find(|instance| instance.id.to_string() == section)
            .unwrap()
            .lanes
            .0
            .get(&TRK_A.parse::<TrackId>().unwrap())
            .unwrap()
            .automation
            .clone()
    };
    let points = |section: &str| {
        lane(section)
            .0
            .iter()
            .find(|entry| entry.target.to_string() == "track:trk_0/gainDb")
            .unwrap()
            .points
            .0
            .clone()
    };
    let sec_a = points(SEC_A);
    assert_eq!(sec_a.len(), 2);
    assert_eq!(sec_a[0].value, 0.7);
    assert_eq!(sec_a[1].value, 0.8);
    let sec_b = points(SEC_B);
    assert_eq!(sec_b.len(), 1);
    assert_eq!(sec_b[0].tick, 500);
    assert_eq!(sec_b[0].value, 0.6);

    let master = next.arrangement.master.automation.0[0].points.0.clone();
    // 1000 and 4340 come from the source; 5000 was outside the region and stays.
    assert_eq!(master.len(), 3);
    assert_eq!(master[0].value, 0.3);
    assert_eq!(master[1].value, 0.4);
    assert_eq!(master[2].value, 0.9);
    assert_eq!(master[2].tick, 5_000);
}

#[test]
fn an_ai_adopt_may_not_modify_a_locked_section() {
    let doc = edit(
        &fixture(),
        vec![json!({ "op": "section.update", "sectionId": SEC_A, "patch": { "locked": true } })],
    );
    let batch = common::batch(
        json!({ "kind": "ai", "planId": "pln_01", "model": "test" }),
        vec![adopt(COMMIT, 0, 1_920, json!("all"))],
    );
    let err = apply_with(&doc, &batch, &assets(), &commits(&fixture())).unwrap_err();
    assert_eq!(err.code(), ValidationCode::LockedSection);
}
