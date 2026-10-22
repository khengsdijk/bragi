//! `changed_spans(prev, next)` — the tick-accurate region-discipline spans (`specs/06-ai-planner.md` §7).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use bragi_model::generated::SectionId;
use bragi_model::{ChangedSpan, apply, changed_spans};
use common::{CLIP_A, HASH, SEC_A, TRK_A, assets, fixture, parse, user_batch};
use serde_json::{Value, json};

/// The short fade `region.clear` adds: 10 ms at 120 bpm is 19 ticks (rounded).
const CUT_FADE_TICKS: i64 = 19;

/// One eight-bar section with a single clip covering all of it.
fn long_clip_project() -> Value {
    json!({
        "schemaVersion": 1, "id": "prj_01",
        "meta": { "title": "Long", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
        "sources": [], "analyses": {},
        "tracks": [{ "id": "trk_0", "name": "Mix", "role": "full_mix", "color": "#8A8F98",
                     "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": [] }],
        "arrangement": {
            "timebase": { "ppq": 960,
                "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }],
                "timeSignatures": [{ "bar": 0, "numerator": 4, "denominator": 4 }] },
            "sections": [{
                "id": "sec_0", "kind": "verse", "label": "A", "lengthTicks": 30_720,
                "lanes": { "trk_0": {
                    "clips": [{
                        "id": "clp_0", "asset": HASH, "srcStart": 0, "srcEnd": 48_000, "start": 0,
                        "warp": { "mode": "beatgrid", "anchors": [
                            { "srcSample": 0, "tick": 0 }, { "srcSample": 48_000, "tick": 30_720 } ] },
                        "gainDb": 0, "pitchSemitones": 0, "fadeInTicks": 0, "fadeOutTicks": 0,
                        "fadeCurve": "equal_power",
                        "provenance": { "kind": "user", "createdAt": "2026-10-18T12:00:00Z" } }],
                    "automation": [] } },
                "transitionIn": { "kind": "cut", "lengthTicks": 0 } }],
            "master": { "fx": [], "automation": [], "gainDb": 0 } }
    })
}

fn span(track: &str, section: &str, start: i64, end: i64, edge_fade_only: bool) -> ChangedSpan {
    ChangedSpan {
        track_id: track.parse().unwrap(),
        section_id: section.parse::<SectionId>().unwrap(),
        start_tick: start,
        end_tick: end,
        edge_fade_only,
    }
}

#[test]
fn identical_documents_have_no_changed_spans() {
    let doc = fixture();
    assert!(changed_spans(&doc, &doc, &assets()).is_empty());
}

#[test]
fn clearing_two_bars_of_a_long_clip_reports_the_cleared_ticks_and_the_cut_fades() {
    let doc = parse(long_clip_project());
    let next = apply(
        &doc,
        &user_batch(vec![json!({ "op": "region.clear",
            "region": { "startTick": 11_520, "endTick": 19_200, "tracks": "all" } })]),
        &assets(),
    )
    .unwrap();

    let spans = changed_spans(&doc, &next, &assets());
    assert_eq!(
        spans,
        vec![
            span("trk_0", "sec_0", 11_520 - CUT_FADE_TICKS, 11_520, true),
            span("trk_0", "sec_0", 11_520, 19_200, false),
            span("trk_0", "sec_0", 19_200, 19_200 + CUT_FADE_TICKS, true),
        ]
    );
}

#[test]
fn adding_an_automation_curve_inside_a_region_reports_only_that_span() {
    let doc = fixture();
    let next = apply(
        &doc,
        &user_batch(vec![json!({
            "op": "automation.set",
            "scope": { "kind": "lane", "sectionId": SEC_A, "trackId": TRK_A },
            "target": "track:trk_0/gainDb",
            "points": [
                { "tick": 480, "value": 0.2, "curve": "linear" },
                { "tick": 960, "value": 0.8, "curve": "linear" } ] })]),
        &assets(),
    )
    .unwrap();

    let spans = changed_spans(&doc, &next, &assets());
    assert_eq!(spans, vec![span("trk_0", "sec_0", 480, 960, false)]);
}

#[test]
fn a_clip_gain_change_reports_the_clip_extent() {
    let doc = fixture();
    let next = apply(
        &doc,
        &user_batch(vec![json!({
            "op": "clip.update", "clipId": CLIP_A, "patch": { "gainDb": -3.0 } })]),
        &assets(),
    )
    .unwrap();

    let spans = changed_spans(&doc, &next, &assets());
    assert_eq!(spans, vec![span("trk_0", "sec_0", 0, 1_920, false)]);
}

#[test]
fn an_fx_added_to_an_otherwise_unchanged_clip_does_not_count_the_clip_extent() {
    let doc = parse(long_clip_project());
    let next = apply(
        &doc,
        &user_batch(vec![json!({
            "op": "fx.add", "scope": { "kind": "clip", "clipId": "clp_0" },
            "fx": { "id": "fx_01", "type": "eq3", "params": { "lowDb": 0 }, "bypass": false } })]),
        &assets(),
    )
    .unwrap();
    assert!(
        changed_spans(&doc, &next, &assets()).is_empty(),
        "a neutral fx added to an unchanged clip is inaudible until automation moves it"
    );
}

#[test]
fn an_fx_added_to_a_clip_with_automation_reports_only_the_automation_span() {
    let doc = parse(long_clip_project());
    let next = apply(
        &doc,
        &user_batch(vec![
            json!({
                "op": "fx.add", "scope": { "kind": "clip", "clipId": "clp_0" },
                "fx": { "id": "fx_01", "type": "eq3", "params": { "lowDb": 0 }, "bypass": false } }),
            json!({
                "op": "automation.set",
                "scope": { "kind": "lane", "sectionId": "sec_0", "trackId": "trk_0" },
                "target": "fx:fx_01/lowDb",
                "points": [
                    { "tick": 11_520, "value": 0.0, "curve": "linear" },
                    { "tick": 19_200, "value": 6.0, "curve": "linear" } ] }),
        ]),
        &assets(),
    )
    .unwrap();
    assert_eq!(
        changed_spans(&doc, &next, &assets()),
        vec![span("trk_0", "sec_0", 11_520, 19_200, false)]
    );
}

#[test]
fn a_different_section_set_is_reported_section_wide() {
    let doc = parse(long_clip_project());
    let mut next = doc.clone();
    next.arrangement
        .sections
        .push(next.arrangement.sections[0].clone());
    let spans = changed_spans(&doc, &next, &assets());
    assert_eq!(spans.len(), 2, "one span per (section, track)");
    assert!(spans.iter().all(|entry| !entry.edge_fade_only));
}
