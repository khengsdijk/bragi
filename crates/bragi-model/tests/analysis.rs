//! `analysis.apply`: order-independent recording and the progressive merge
//! (`specs/02-song-model.md` §6, `specs/12-roadmap.md` WP-1.8).
//!
//! Two acceptance criteria live here:
//!
//! 1. **Every permutation of stage arrival yields the same document** —
//!    [`every_stage_order_produces_the_same_document`] does all 5040 orders of the seven
//!    effect-bearing stages, and [`a_random_analysis_agrees_under_a_random_order`] is the
//!    property test over random analysis content and a random order.
//! 2. **A late `structure` on an edited document yields `meta.suggestedSections` instead of
//!    re-splitting** — [`late_structure_on_an_edited_document_suggests_sections`].
//!
//! Tests may `unwrap()`, `expect()` and `panic!` (`specs/13-agent-guide.md` §3).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use bragi_model::canonical_json;
use bragi_model::generated::{
    AnalysisEffect, AssetMeta, OpBatch, Project, SectionInstance, SectionKind, StemRole, Warp,
};
use bragi_model::{AssetIndex, ValidationCode, apply, derived_id, section_spans, validate};
use insta::assert_json_snapshot;
use proptest::prelude::*;
use serde_json::{Value, json};

/// The fixture source: 10 s at 48 kHz.
const SRC: &str = "src_01";
/// The fixture source's length in samples (10 s).
const DURATION: u64 = 480_000;

fn hash(byte: char) -> String {
    format!("sha256:{}", byte.to_string().repeat(64))
}

fn mix_hash() -> String {
    hash('a')
}
fn vocals_hash() -> String {
    hash('b')
}
fn drums_hash() -> String {
    hash('c')
}
fn residual_hash() -> String {
    hash('d')
}
/// A distinct, valid blob hash per stage, so the recorded `blobs` map is exercised too.
fn stage_blob(stage: &str) -> String {
    let seed = stage.bytes().fold(7_u32, |acc, byte| {
        acc.wrapping_mul(31).wrapping_add(u32::from(byte))
    });
    format!("sha256:{seed:08x}{}", "e".repeat(56))
}

fn asset_index(duration_samples: u64) -> AssetIndex {
    let metas = [mix_hash(), vocals_hash(), drums_hash(), residual_hash()]
        .into_iter()
        .map(|hash| {
            serde_json::from_value::<AssetMeta>(json!({
                "hash": hash,
                "mime": "audio/flac",
                "bytes": 1,
                "sampleRate": 48_000,
                "channels": 2,
                "durationSamples": duration_samples
            }))
            .expect("valid AssetMeta")
        });
    AssetIndex::from_metas(metas)
}

/// A project with one uploaded source and no tracks or sections.
fn base_doc() -> Project {
    serde_json::from_value(json!({
        "schemaVersion": 1,
        "id": "prj_01",
        "meta": { "title": "Fixture", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
        "sources": [{
            "id": SRC,
            "kind": "upload",
            "originalAsset": mix_hash(),
            "workingAsset": mix_hash(),
            "durationSamples": DURATION,
            "channels": 2,
            "label": "song.wav",
            "provenance": { "kind": "user", "createdAt": "2026-10-18T12:00:00Z" }
        }],
        "analyses": {},
        "tracks": [],
        "arrangement": {
            "timebase": {
                "ppq": 960,
                "tempoMap": [ { "tick": 0, "bpm": 120, "curve": "step" } ],
                "timeSignatures": [ { "bar": 0, "numerator": 4, "denominator": 4 } ]
            },
            "sections": [],
            "master": { "fx": [], "automation": [], "gainDb": 0 }
        }
    }))
    .expect("a valid fixture project")
}

fn batch(author: Value, ops: Vec<Value>) -> OpBatch {
    serde_json::from_value(json!({
        "id": "bat_01",
        "label": "Analysis",
        "createdAt": "2026-10-18T12:00:00Z",
        "author": author,
        "ops": ops
    }))
    .expect("a valid batch")
}

/// Applies one system-authored op and asserts the result validates.
fn run_op(doc: &Project, op: Value, assets: &AssetIndex) -> Project {
    run_batch(
        doc,
        json!({ "kind": "system", "reason": "analysis" }),
        op,
        assets,
    )
}

/// Applies one user-authored op and asserts the result validates.
fn run_user_op(doc: &Project, op: Value, assets: &AssetIndex) -> Project {
    run_batch(doc, json!({ "kind": "user" }), op, assets)
}

fn run_batch(doc: &Project, author: Value, op: Value, assets: &AssetIndex) -> Project {
    let next = apply(doc, &batch(author, vec![op]), assets).expect("the op applies");
    validate(&next, assets).expect("the result validates");
    next
}

/// Applies one op per batch, so each stage arrives on its own as it does in the product.
fn run_order(doc: &Project, ops: &[Value], order: &[usize], assets: &AssetIndex) -> Project {
    let mut current = doc.clone();
    for index in order {
        current = run_op(&current, ops[*index].clone(), assets);
    }
    current
}

// --- stage ops -------------------------------------------------------------------------------

fn apply_op(stage: &str, effects: Value) -> Value {
    json!({
        "op": "analysis.apply",
        "sourceId": SRC,
        "stage": stage,
        "blob": stage_blob(stage),
        "effects": effects
    })
}

fn ingest_op() -> Value {
    apply_op("ingest", json!([]))
}

fn rhythm_op(bpm: f64) -> Value {
    apply_op(
        "rhythm",
        json!([{
            "kind": "tempo",
            "tempoMap": [ { "tick": 0, "bpm": bpm, "curve": "step" } ],
            "timeSignatures": [ { "bar": 0, "numerator": 4, "denominator": 4 } ]
        }]),
    )
}

/// A `structure` op from consecutive `[startSec, endSec)` sections.
fn structure_op(boundaries: &[f64], kinds: &[&str]) -> Value {
    let sections: Vec<Value> = boundaries
        .windows(2)
        .zip(kinds)
        .map(|(window, kind)| {
            json!({
                "startSec": window[0],
                "endSec": window[1],
                "kind": kind,
                "confidence": 0.9
            })
        })
        .collect();
    apply_op(
        "structure",
        json!([{ "kind": "sections", "sections": sections }]),
    )
}

/// The three-section structure used throughout: intro, verse, chorus over 10 s at 120 bpm.
fn example_structure() -> Value {
    structure_op(&[0.0, 2.0, 6.0, 10.0], &["intro", "verse", "chorus"])
}

fn separation_op() -> Value {
    apply_op(
        "separation",
        json!([{
            "kind": "separation",
            "stems": [
                { "role": "vocals", "asset": vocals_hash(), "rmsDb": -18.0 },
                { "role": "drums", "asset": drums_hash(), "rmsDb": -14.0 }
            ],
            "residual": residual_hash()
        }]),
    )
}

fn tag_op() -> Value {
    apply_op(
        "tag",
        json!([{ "kind": "tags", "genres": ["synthwave"], "moods": ["nostalgic"] }]),
    )
}

fn describe_op() -> Value {
    apply_op(
        "describe",
        json!([{ "kind": "description", "description": "A nocturnal synthwave drive." }]),
    )
}

fn harmony_op() -> Value {
    apply_op(
        "harmony",
        json!([{ "kind": "key", "tonic": "F#", "mode": "minor" }]),
    )
}

/// All seven stages that carry a document effect, in the canonical order.
fn canonical_ops() -> Vec<Value> {
    vec![
        ingest_op(),
        rhythm_op(120.0),
        example_structure(),
        separation_op(),
        tag_op(),
        describe_op(),
        harmony_op(),
    ]
}

// --- acceptance criterion 1: permutations ----------------------------------------------------

fn permutations(count: usize) -> Vec<Vec<usize>> {
    fn walk(items: &mut Vec<usize>, start: usize, out: &mut Vec<Vec<usize>>) {
        if start == items.len() {
            out.push(items.clone());
            return;
        }
        for index in start..items.len() {
            items.swap(start, index);
            walk(items, start + 1, out);
            items.swap(start, index);
        }
    }
    let mut out = Vec::new();
    let mut current: Vec<usize> = (0..count).collect();
    walk(&mut current, 0, &mut out);
    out
}

#[test]
fn every_stage_order_produces_the_same_document() {
    let assets = asset_index(DURATION);
    let ops = canonical_ops();
    let reference = run_order(&base_doc(), &ops, &[0, 1, 2, 3, 4, 5, 6], &assets);

    let orders = permutations(ops.len());
    assert_eq!(orders.len(), 5040, "seven stages have 5040 arrival orders");
    for order in orders {
        if order == [0, 1, 2, 3, 4, 5, 6] {
            continue;
        }
        let doc = run_order(&base_doc(), &ops, &order, &assets);
        assert_eq!(
            canonical_json(&doc),
            canonical_json(&reference),
            "arrival order {order:?} produced a different document"
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 32, ..ProptestConfig::default() })]

    /// Property test over the *content* of the analysis and the arrival order: the document
    /// depends on the set of finished stages, never on the order.
    #[test]
    fn a_random_analysis_agrees_under_a_random_order(
        bpm in 80.0f64..160.0,
        bars in prop::collection::vec(1u32..5u32, 1..4),
        kinds in prop::collection::vec(section_kind(), 1..4),
        stems in prop::collection::vec(stem_role(), 1..4),
        keys in prop::collection::vec(any::<u64>(), 7),
    ) {
        let mut boundaries = vec![0.0f64];
        let mut start = 0.0f64;
        for bar in &bars {
            // Two seconds per unit, so a run can also overrun the 10 s fixture: the model clamps.
            start += f64::from(*bar) * 2.0;
            boundaries.push(start);
        }
        let section_kinds: Vec<String> = boundaries
            .windows(2)
            .enumerate()
            .map(|(index, _)| kinds[index % kinds.len()].to_owned())
            .collect();
        let section_kinds: Vec<&str> = section_kinds.iter().map(String::as_str).collect();

        let mut roles: Vec<&str> = Vec::new();
        for role in &stems {
            if !roles.contains(&role.as_str()) {
                roles.push(role.as_str());
            }
        }
        let stem_values: Vec<Value> = roles
            .iter()
            .enumerate()
            .map(|(index, role)| {
                json!({
                    "role": role,
                    "asset": if index == 0 { vocals_hash() } else { drums_hash() },
                    "rmsDb": -16.0
                })
            })
            .collect();

        let ops = vec![
            ingest_op(),
            rhythm_op(bpm),
            structure_op(&boundaries, &section_kinds),
            apply_op("separation", json!([{
                "kind": "separation", "stems": stem_values, "residual": residual_hash()
            }])),
            tag_op(),
            describe_op(),
            harmony_op(),
        ];

        let mut order: Vec<usize> = (0..ops.len()).collect();
        order.sort_by_key(|index| keys[*index]);

        let assets = asset_index(DURATION);
        let reference = run_order(&base_doc(), &ops, &[0, 1, 2, 3, 4, 5, 6], &assets);
        let doc = run_order(&base_doc(), &ops, &order, &assets);
        prop_assert_eq!(canonical_json(&doc), canonical_json(&reference), "order {:?}", order);
    }
}

fn section_kind() -> impl Strategy<Value = String> {
    prop::sample::select(vec![
        "intro".to_owned(),
        "verse".to_owned(),
        "chorus".to_owned(),
        "bridge".to_owned(),
        "outro".to_owned(),
    ])
}

fn stem_role() -> impl Strategy<Value = String> {
    prop::sample::select(vec![
        "vocals".to_owned(),
        "drums".to_owned(),
        "bass".to_owned(),
        "other".to_owned(),
    ])
}

// --- acceptance criterion 2: a late structure on an edited document ---------------------------

#[test]
fn late_structure_on_an_edited_document_suggests_sections() {
    let assets = asset_index(DURATION);
    let mut doc = base_doc();
    for op in [ingest_op(), rhythm_op(120.0), separation_op()] {
        doc = run_op(&doc, op, &assets);
    }

    // The user splits the song themselves before structure arrives.
    let analysed_id = derived_id("sec_", SRC, "section:0");
    doc = run_user_op(
        &doc,
        json!({ "op": "section.split", "sectionId": analysed_id, "atTick": 3840,
                "newId": "sec_user" }),
        &assets,
    );
    let before = serde_json::to_value(&doc.arrangement.sections).unwrap();

    let next = run_op(&doc, example_structure(), &assets);

    // The arrangement is untouched: no re-split and no new sections.
    assert_eq!(
        serde_json::to_value(&next.arrangement.sections).unwrap(),
        before,
        "a late structure must not touch an edited arrangement"
    );
    assert!(
        !next
            .arrangement
            .sections
            .iter()
            .any(|section| section.id.to_string() == derived_id("sec_", SRC, "section:1")),
        "the analysed sections were applied instead of suggested"
    );

    // The analysed sections became suggestions instead.
    let suggestions = next
        .meta
        .suggested_sections
        .as_ref()
        .expect("the late structure wrote suggestions");
    assert_eq!(suggestions.0.len(), 3);
    let spans: Vec<(u64, u64)> = suggestions
        .0
        .iter()
        .map(|suggestion| (suggestion.start_tick, suggestion.end_tick))
        .collect();
    assert_eq!(spans, vec![(0, 3840), (3840, 11520), (11520, 19200)]);
    assert_eq!(suggestions.0[0].kind, SectionKind::Intro);
    assert_eq!(suggestions.0[1].kind, SectionKind::Verse);
    assert_eq!(suggestions.0[2].kind, SectionKind::Chorus);
    assert_eq!(suggestions.0[0].label, "Intro");
    assert_eq!(suggestions.0[1].start_sec, 2.0);
    assert_eq!(suggestions.0[1].end_sec, 6.0);
    assert_eq!(suggestions.0[1].source_id.to_string(), SRC);

    // The stage is recorded even though its structure was not applied.
    let analysis = &next.analyses.0[&SRC.parse().unwrap()];
    assert_eq!(
        analysis.effects.as_ref().map(|list| list.0.len()),
        Some(3),
        "tempo, separation and sections"
    );
}

#[test]
fn a_pristine_structure_splits_and_clears_previous_suggestions() {
    let assets = asset_index(DURATION);
    let mut doc = base_doc();
    for op in [ingest_op(), rhythm_op(120.0)] {
        doc = run_op(&doc, op, &assets);
    }

    // Suggestions written by an earlier conflict.
    let suggestion: bragi_model::generated::SectionSuggestion = serde_json::from_value(json!({
        "sourceId": SRC, "startSec": 0.0, "endSec": 1.0, "startTick": 0, "endTick": 1920,
        "kind": "intro", "label": "Intro"
    }))
    .unwrap();
    doc.meta.suggested_sections = Some(bragi_model::generated::SectionSuggestionList(vec![
        suggestion,
    ]));

    let next = run_op(&doc, example_structure(), &assets);
    assert_eq!(next.arrangement.sections.len(), 3);
    assert_eq!(next.arrangement.sections[0].label, "Intro");
    assert_eq!(next.arrangement.sections[1].label, "Verse");
    assert_eq!(next.arrangement.sections[2].label, "Chorus");
    assert!(
        next.meta.suggested_sections.is_none(),
        "a pristine structure clears the suggestions it applied"
    );
    let expected = derived_id("sec_", SRC, "section:1");
    assert_eq!(next.arrangement.sections[1].id.to_string(), expected);
}

#[test]
fn project_set_meta_clears_the_suggestions() {
    let assets = asset_index(DURATION);
    let mut doc = base_doc();
    for op in [ingest_op(), rhythm_op(120.0)] {
        doc = run_op(&doc, op, &assets);
    }
    doc = run_user_op(
        &doc,
        json!({ "op": "section.update",
                "sectionId": derived_id("sec_", SRC, "section:0"),
                "patch": { "label": "Mine" } }),
        &assets,
    );
    doc = run_op(&doc, example_structure(), &assets);
    assert!(doc.meta.suggested_sections.is_some());

    let next = run_user_op(
        &doc,
        json!({ "op": "project.set_meta", "suggestedSections": [] }),
        &assets,
    );
    assert!(next.meta.suggested_sections.is_none());
}

// --- idempotence, geometry and labels --------------------------------------------------------

#[test]
fn redelivering_every_stage_changes_nothing() {
    let assets = asset_index(DURATION);
    let ops = canonical_ops();
    let doc = run_order(&base_doc(), &ops, &[0, 1, 2, 3, 4, 5, 6], &assets);
    // The same seven stages arrive again, in a different order (a retry, a reconnect).
    let again = run_order(&doc, &ops, &[6, 3, 0, 5, 1, 4, 2], &assets);
    assert_eq!(canonical_json(&again), canonical_json(&doc));
}

#[test]
fn the_harmony_key_effect_is_recorded_and_idempotent() {
    let assets = asset_index(DURATION);
    let mut doc = run_op(&base_doc(), ingest_op(), &assets);
    let before_sections = serde_json::to_value(&doc.arrangement.sections).unwrap();
    doc = run_op(&doc, harmony_op(), &assets);

    let analysis = &doc.analyses.0[&SRC.parse().unwrap()];
    let effects = analysis
        .effects
        .as_ref()
        .expect("the key effect is recorded");
    assert_eq!(effects.0.len(), 1, "harmony owns exactly one effect");
    assert!(
        matches!(&effects.0[0], AnalysisEffect::KeyEffect(key)
            if key.tonic.as_str() == "F#"
                && key.mode == bragi_model::generated::KeyMode::Minor),
        "the recorded effect is the key: {:?}",
        effects.0
    );
    // A key is not an arrangement fact: recording it changes no section or clip.
    assert_eq!(
        serde_json::to_value(&doc.arrangement.sections).unwrap(),
        before_sections
    );

    // A re-delivery merges by kind, so the list keeps one key effect and the document is equal.
    let again = run_op(&doc, harmony_op(), &assets);
    assert_eq!(canonical_json(&again), canonical_json(&doc));
    let effects = again.analyses.0[&SRC.parse().unwrap()]
        .effects
        .as_ref()
        .expect("still one key effect");
    assert_eq!(effects.0.len(), 1);

    // The key is optional for harmony: an older harmony op with no effects still applies and keeps
    // the recorded key.
    let empty = run_op(&doc, apply_op("harmony", json!([])), &assets);
    let effects = empty
        .analyses
        .values()
        .next()
        .expect("one analysis")
        .effects
        .as_ref();
    assert_eq!(effects.map(|list| list.0.len()), Some(1));

    // A stage that must carry its effect still does (02 §6).
    let err = apply(
        &doc,
        &batch(
            json!({ "kind": "system", "reason": "analysis" }),
            vec![apply_op("describe", json!([]))],
        ),
        &assets,
    )
    .unwrap_err();
    assert_eq!(err.code(), ValidationCode::AnalysisEffects);
}

#[test]
fn boundaries_snap_to_the_nearest_bar() {
    let assets = asset_index(DURATION);
    let mut doc = base_doc();
    for op in [ingest_op(), rhythm_op(140.0), example_structure()] {
        doc = run_op(&doc, op, &assets);
    }
    // 10 s at 140 bpm is 22 400 ticks; the nearest bars are 0, 3840, 11520 and the total rounds
    // up to 23 040 (six bars), so nothing is cut off.
    let spans = section_spans(&doc);
    let lengths: Vec<u64> = spans.iter().map(|span| span.length_ticks).collect();
    assert_eq!(lengths, vec![3840, 7680, 11520]);
    assert_eq!(spans.last().map(|span| span.end_tick), Some(23_040));
}

#[test]
fn recurring_kinds_are_numbered() {
    let assets = asset_index(DURATION);
    let mut doc = base_doc();
    for op in [
        ingest_op(),
        rhythm_op(120.0),
        structure_op(
            &[0.0, 2.0, 4.0, 6.0, 8.0, 10.0],
            &["verse", "chorus", "verse", "chorus", "outro"],
        ),
    ] {
        doc = run_op(&doc, op, &assets);
    }
    let labels: Vec<String> = doc
        .arrangement
        .sections
        .iter()
        .map(|section| section.label.clone())
        .collect();
    assert_eq!(
        labels,
        vec!["Verse 1", "Chorus 1", "Verse 2", "Chorus 2", "Outro"]
    );
}

#[test]
fn a_beat_grid_clip_gets_anchors_at_its_bar_starts() {
    let assets = asset_index(DURATION);
    let mut doc = base_doc();
    for op in [ingest_op(), rhythm_op(120.0), example_structure()] {
        doc = run_op(&doc, op, &assets);
    }
    let mix = derived_id("trk_", SRC, "full_mix");
    // The verse section (bars 1..4, 3840 ticks long) anchors at its start, bar 2 and its end.
    let verse = &doc.arrangement.sections[1];
    let clip = &verse.lanes.0[&mix.parse().unwrap()].clips[0];
    match &clip.warp {
        Warp::Beatgrid(beatgrid) => {
            let anchors: Vec<(u64, i64)> = beatgrid
                .anchors
                .iter()
                .map(|anchor| (anchor.src_sample, anchor.tick))
                .collect();
            assert_eq!(anchors, vec![(96_000, 0), (192_000, 3840), (288_000, 7680)]);
        }
        other => panic!("expected a beat grid, got {other:?}"),
    }
    // Every clip's source range covers its section and fits the asset.
    for section in &doc.arrangement.sections {
        let clip = &section.lanes.0[&mix.parse().unwrap()].clips[0];
        assert!(clip.src_start < clip.src_end);
        assert!(clip.src_end <= DURATION);
    }
}

#[test]
fn without_a_beat_grid_clips_play_at_source_speed() {
    let assets = asset_index(DURATION);
    let mut doc = base_doc();
    doc = run_op(&doc, ingest_op(), &assets);
    let mix = derived_id("trk_", SRC, "full_mix");
    let clip = &doc.arrangement.sections[0].lanes.0[&mix.parse().unwrap()].clips[0];
    assert!(
        matches!(clip.warp, Warp::None(_)),
        "no tempo effect means no grid"
    );
    // The single section spans the whole 10 s asset.
    assert_eq!(clip.src_start, 0);
    assert_eq!(clip.src_end, DURATION);
}

// --- the merge on edited documents -----------------------------------------------------------

#[test]
fn ingest_keeps_a_preexisting_arrangement_and_fills_its_lanes() {
    let assets = asset_index(DURATION);
    let mut doc = base_doc();
    let mix_track = derived_id("trk_", SRC, "full_mix");
    // The user already has a section, and content in what will become the mix lane.
    doc.arrangement.sections = vec![
        serde_json::from_value::<SectionInstance>(json!({
            "id": "sec_user",
            "kind": "custom",
            "label": "My part",
            "lengthTicks": 3840,
            "lanes": {
                mix_track.clone(): {
                    "clips": [{
                        "id": "clp_user",
                        "asset": mix_hash(),
                        "srcStart": 0,
                        "srcEnd": 48_000,
                        "start": 0,
                        "warp": { "mode": "none" },
                        "gainDb": 0,
                        "pitchSemitones": 0,
                        "fadeInTicks": 0,
                        "fadeOutTicks": 0,
                        "fadeCurve": "equal_power",
                        "provenance": { "kind": "user", "createdAt": "2026-10-18T12:00:00Z" }
                    }],
                    "automation": []
                }
            },
            "transitionIn": { "kind": "cut", "lengthTicks": 0 }
        }))
        .expect("a valid section"),
    ];

    let next = run_op(&doc, ingest_op(), &assets);
    assert_eq!(
        next.arrangement.sections.len(),
        1,
        "the user's section stays"
    );
    assert_eq!(next.arrangement.sections[0].id.to_string(), "sec_user");
    let lane = &next.arrangement.sections[0].lanes.0[&mix_track.parse().unwrap()];
    assert_eq!(lane.clips.len(), 1);
    assert_eq!(
        lane.clips[0].id.to_string(),
        "clp_user",
        "existing lane content is never overwritten"
    );
    assert!(
        next.tracks
            .iter()
            .any(|track| track.role == StemRole::FullMix)
    );
}

#[test]
fn late_separation_adds_tracks_and_fills_empty_lanes_only() {
    let assets = asset_index(DURATION);
    let mut doc = base_doc();
    for op in [ingest_op(), rhythm_op(120.0), example_structure()] {
        doc = run_op(&doc, op, &assets);
    }
    // The user edits a label, which makes the arrangement no longer pristine.
    doc = run_user_op(
        &doc,
        json!({ "op": "section.update",
                "sectionId": derived_id("sec_", SRC, "section:0"),
                "patch": { "label": "Mine" } }),
        &assets,
    );
    let mix = derived_id("trk_", SRC, "full_mix");
    let mix_clips_before: Vec<String> = doc.arrangement.sections[0].lanes.0[&mix.parse().unwrap()]
        .clips
        .iter()
        .map(|clip| clip.id.to_string())
        .collect();

    let next = run_op(&doc, separation_op(), &assets);

    assert_eq!(next.tracks.len(), 4, "mix, vocals, drums and residual");
    for section in &next.arrangement.sections {
        assert_eq!(section.lanes.0.len(), 4, "every stem lane was filled");
    }
    let mix_clips_after: Vec<String> = next.arrangement.sections[0].lanes.0[&mix.parse().unwrap()]
        .clips
        .iter()
        .map(|clip| clip.id.to_string())
        .collect();
    assert_eq!(
        mix_clips_after, mix_clips_before,
        "existing clips are untouched"
    );
    assert_eq!(next.arrangement.sections[0].label, "Mine");
    assert_eq!(
        next.meta
            .suggested_sections
            .as_ref()
            .map(|list| list.0.len()),
        None,
        "separation alone suggests nothing"
    );
}

#[test]
fn tags_and_description_merge_into_the_metadata() {
    let assets = asset_index(DURATION);
    let mut doc = base_doc();
    doc.meta.tags.0.push("mine".to_owned());
    for op in [ingest_op(), tag_op(), describe_op()] {
        doc = run_op(&doc, op, &assets);
    }
    assert_eq!(
        doc.meta.tags.0,
        vec![
            "mine".to_owned(),
            "synthwave".to_owned(),
            "nostalgic".to_owned()
        ]
    );
    assert_eq!(
        doc.meta.description.as_deref(),
        Some("A nocturnal synthwave drive.")
    );
}

#[test]
fn a_later_stage_does_not_resurrect_a_removed_tag() {
    let assets = asset_index(DURATION);
    let mut doc = base_doc();
    for op in [ingest_op(), tag_op()] {
        doc = run_op(&doc, op, &assets);
    }
    // The user curates the tags, then separation (which carries no tags) arrives.
    doc = run_user_op(
        &doc,
        json!({ "op": "project.set_meta", "tags": ["mine"] }),
        &assets,
    );
    doc = run_op(&doc, separation_op(), &assets);
    assert_eq!(doc.meta.tags.0, vec!["mine".to_owned()]);
}

// --- errors ----------------------------------------------------------------------------------

#[test]
fn effects_must_match_their_stage() {
    let assets = asset_index(DURATION);
    let doc = base_doc();

    // A `sections` effect on the `rhythm` stage.
    let err = apply(
        &doc,
        &batch(
            json!({ "kind": "system", "reason": "analysis" }),
            vec![apply_op(
                "rhythm",
                json!([{ "kind": "sections", "sections": [
                    { "startSec": 0.0, "endSec": 1.0, "kind": "intro", "confidence": 0.5 } ] }]),
            )],
        ),
        &assets,
    )
    .unwrap_err();
    assert_eq!(err.code(), ValidationCode::AnalysisEffects);

    // A stage that owns no effect carrying one.
    let err = apply(
        &doc,
        &batch(
            json!({ "kind": "system", "reason": "analysis" }),
            vec![apply_op(
                "harmony",
                json!([{ "kind": "tags", "genres": [], "moods": [] }]),
            )],
        ),
        &assets,
    )
    .unwrap_err();
    assert_eq!(err.code(), ValidationCode::AnalysisEffects);

    // `rhythm` without its tempo effect.
    let err = apply(
        &doc,
        &batch(
            json!({ "kind": "system", "reason": "analysis" }),
            vec![apply_op("rhythm", json!([]))],
        ),
        &assets,
    )
    .unwrap_err();
    assert_eq!(err.code(), ValidationCode::AnalysisEffects);

    // An unknown source.
    let err = apply(
        &doc,
        &batch(
            json!({ "kind": "system", "reason": "analysis" }),
            vec![
                json!({ "op": "analysis.apply", "sourceId": "src_other", "stage": "tag",
                "blob": stage_blob("tag"), "effects": [] }),
            ],
        ),
        &assets,
    )
    .unwrap_err();
    assert_eq!(err.code(), ValidationCode::MissingTarget);
}

#[test]
fn effect_payloads_are_checked() {
    let assets = asset_index(DURATION);
    let doc = base_doc();

    // Unsorted analysed sections.
    let err = apply(
        &doc,
        &batch(
            json!({ "kind": "system", "reason": "analysis" }),
            vec![apply_op(
                "structure",
                json!([{ "kind": "sections", "sections": [
                    { "startSec": 0.0, "endSec": 4.0, "kind": "intro", "confidence": 0.5 },
                    { "startSec": 1.0, "endSec": 6.0, "kind": "verse", "confidence": 0.5 } ] }]),
            )],
        ),
        &assets,
    )
    .unwrap_err();
    assert_eq!(err.code(), ValidationCode::AnalysisEffects);

    // A duplicate stem role, and a role that is not a stem.
    for stems in [
        json!([{ "role": "vocals", "asset": vocals_hash() },
               { "role": "vocals", "asset": drums_hash() }]),
        json!([{ "role": "full_mix", "asset": vocals_hash() }]),
    ] {
        let err = apply(
            &doc,
            &batch(
                json!({ "kind": "system", "reason": "analysis" }),
                vec![apply_op(
                    "separation",
                    json!([{ "kind": "separation", "stems": stems, "residual": residual_hash() }]),
                )],
            ),
            &assets,
        )
        .unwrap_err();
        assert_eq!(err.code(), ValidationCode::AnalysisEffects);
    }

    // A tempo map that does not start at tick 0.
    let err = apply(
        &doc,
        &batch(
            json!({ "kind": "system", "reason": "analysis" }),
            vec![apply_op(
                "rhythm",
                json!([{ "kind": "tempo",
                    "tempoMap": [ { "tick": 960, "bpm": 120.0, "curve": "step" } ],
                    "timeSignatures": [ { "bar": 0, "numerator": 4, "denominator": 4 } ] }]),
            )],
        ),
        &assets,
    )
    .unwrap_err();
    assert_eq!(err.code(), ValidationCode::AnalysisEffects);
}

// --- snapshot --------------------------------------------------------------------------------

#[test]
fn the_full_analysis_document_snapshot() {
    let assets = asset_index(DURATION);
    let ops = canonical_ops();
    let doc = run_order(&base_doc(), &ops, &[6, 2, 0, 4, 1, 5, 3], &assets);
    // Serialized through `serde_json` so the HashMap-backed lane maps are key-sorted.
    assert_json_snapshot!("analysis_full", serde_json::to_value(doc).unwrap());
}
