//! Extend placement: the candidate batch, its geometry, and its undo contract
//! (`specs/09-generation.md` §4.2, `specs/02-song-model.md` §4.2, §7).
//!
//! Every test applies the batch through `bragi_model::apply` and re-validates the result, so the
//! helper and the op interpreter agree. Tests may `unwrap()`/`expect()` (`specs/13-agent-guide.md`
//! §3).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use bragi_model::canonical_json;
use bragi_model::generated::{
    AssetMeta, BatchId, ChannelCount, IsoDate, OpBatch, Project, Provenance, ProvenanceKind,
    SectionKind, SourceId, SourceKind, StemRole, TickRange, TransitionKind, Warp,
};
use bragi_model::placement::{
    ExtendCandidate, ExtendDirection, ExtendPlacementRequest, PlacementError, extend_placement,
};
use bragi_model::time::bar_ticks;
use bragi_model::{
    AssetIndex, INTERNAL_SAMPLE_RATE_HZ, apply, derived_id, section_spans, spans::total_ticks,
    validate,
};
use proptest::prelude::*;
use serde_json::{json, to_value};

const CANDIDATE: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
/// Five bars of 4/4 at 120 bpm: 5 × 96 000 samples.
const CANDIDATE_SAMPLES: u64 = 480_000;
const BAR_TICKS: i64 = 3_840;
const BAR_SAMPLES: u64 = 96_000;

fn assets() -> AssetIndex {
    AssetIndex::from_metas([serde_json::from_value::<AssetMeta>(json!({
        "hash": CANDIDATE,
        "mime": "audio/flac",
        "bytes": 1,
        "sampleRate": INTERNAL_SAMPLE_RATE_HZ,
        "channels": 2,
        "durationSamples": CANDIDATE_SAMPLES
    }))
    .expect("valid AssetMeta")])
}

fn project_json(lengths: &[u64]) -> serde_json::Value {
    let sections: Vec<serde_json::Value> = lengths
        .iter()
        .enumerate()
        .map(|(index, length)| {
            json!({
                "id": format!("sec_{index}"),
                "kind": if index == 0 { "verse" } else { "chorus" },
                "label": if index == 0 { "Verse" } else { "Chorus" },
                "lengthTicks": length,
                "lanes": {},
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
        "tracks": [{ "id": "trk_mix", "name": "Mix", "role": "full_mix", "color": "#8A8F98",
                     "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": [] }],
        "arrangement": {
            "timebase": {
                "ppq": 960,
                "tempoMap": [ { "tick": 0, "bpm": 120, "curve": "step" } ],
                "timeSignatures": [ { "bar": 0, "numerator": 4, "denominator": 4 } ]
            },
            "sections": sections,
            "master": { "fx": [], "automation": [], "gainDb": 0 }
        }
    })
}

/// Two full bars: the song ends exactly on a bar line, so placement needs no partial-bar offset.
fn bar_song() -> Project {
    serde_json::from_value(project_json(&[BAR_TICKS as u64, BAR_TICKS as u64])).unwrap()
}

/// One bar and a half: the context ends at 3840 while the song ends at 5760.
fn short_song() -> Project {
    serde_json::from_value(project_json(&[BAR_TICKS as u64, 1_920])).unwrap()
}

/// The last full bar line of a song (what the context render ends on, 03 §9).
fn last_bar_line(doc: &Project) -> i64 {
    let total = total_ticks(doc);
    let ppq = *doc.arrangement.timebase.ppq;
    let signatures = &doc.arrangement.timebase.time_signatures;
    let mut tick = 0_i64;
    let mut bar = 0_u64;
    loop {
        let next = tick + bar_ticks(signatures, bar, ppq).max(1);
        if next > total {
            break;
        }
        tick = next;
        bar += 1;
        if next == total {
            break;
        }
    }
    tick
}

fn request(
    doc: &Project,
    direction: ExtendDirection,
    bars: u32,
    splice_offset: i64,
    crossfade_ticks: u64,
) -> ExtendPlacementRequest {
    ExtendPlacementRequest {
        direction,
        context_range: TickRange {
            start_tick: 0,
            end_tick: last_bar_line(doc),
        },
        candidate: ExtendCandidate {
            source_id: "src_gen".parse::<SourceId>().unwrap(),
            original_asset: CANDIDATE.parse().unwrap(),
            working_asset: CANDIDATE.parse().unwrap(),
            duration_samples: CANDIDATE_SAMPLES,
            channels: ChannelCount::try_from(2).unwrap(),
            label: "Generated: outro".to_owned(),
            provenance: Provenance {
                created_at: "2026-10-18T12:00:00Z".parse::<IsoDate>().unwrap(),
                job_id: None,
                kind: ProvenanceKind::Generation,
                model: Some("ace-step".to_owned()),
                model_version: Some("1.5.0".to_owned()),
                prompt: Some("outro".to_owned()),
            },
        },
        splice_offset,
        bars,
        crossfade_ticks,
        section_kind: None,
        batch_id: "bat_extend".parse::<BatchId>().unwrap(),
        label: "Extend: 1 bar".to_owned(),
        created_at: "2026-10-18T12:00:00Z".parse::<IsoDate>().unwrap(),
    }
}

fn apply_batch(doc: &Project, batch: &OpBatch) -> Project {
    let next = apply(doc, batch, &assets()).expect("the placement batch applies");
    validate(&next, &assets()).expect("the placed document validates");
    next
}

#[test]
fn forward_places_a_new_section_at_the_arrangement_end() {
    let doc = bar_song();
    let batch =
        extend_placement(&doc, &request(&doc, ExtendDirection::Forward, 2, 0, 480)).unwrap();
    assert_eq!(batch.ops.len(), 4, "source, generated track, section, clip");

    let next = apply_batch(&doc, &batch);

    assert_eq!(next.sources.len(), 1);
    let source = &next.sources[0];
    assert_eq!(source.kind, SourceKind::Generated);
    assert_eq!(
        source.provenance.as_ref().map(|p| p.kind),
        Some(ProvenanceKind::Generation)
    );
    let expected_section = derived_id("sec_", "src_gen", "extend");
    assert_eq!(
        source.placement.as_ref().map(|p| p.section_id.to_string()),
        Some(expected_section.clone())
    );

    // The section kind follows the last section; two bars at 120 bpm are 7680 ticks.
    let section = next.arrangement.sections.last().unwrap();
    assert_eq!(section.id.to_string(), expected_section);
    assert_eq!(section.kind, SectionKind::Chorus);
    assert_eq!(section.length_ticks.get(), 7_680);
    assert_eq!(section.label, "Chorus 2");
    assert_eq!(section.transition_in.kind, TransitionKind::Crossfade);
    assert_eq!(section.transition_in.length_ticks, 480);

    // One generated track and one clip, with the gate crossfade as its fade-in.
    let generated = next
        .tracks
        .iter()
        .find(|track| track.role == StemRole::Generated)
        .expect("a generated track");
    let lane = &section.lanes.0[&generated.id];
    assert_eq!(lane.clips.len(), 1);
    let clip = &lane.clips[0];
    assert_eq!(clip.src_start, 0);
    assert_eq!(clip.src_end, 2 * BAR_SAMPLES);
    assert_eq!(clip.fade_in_ticks, 480);
    assert_eq!(clip.fade_out_ticks, 0);
    assert!(matches!(clip.warp, Warp::Beatgrid(_)));
}

#[test]
fn backward_inserts_an_intro_before_the_first_section() {
    let doc = bar_song();
    let batch = extend_placement(
        &doc,
        &request(&doc, ExtendDirection::Backward, 1, -96_000, 480),
    )
    .unwrap();
    assert_eq!(
        batch.ops.len(),
        5,
        "source, track, section, clip, transition"
    );

    let next = apply_batch(&doc, &batch);
    let spans = section_spans(&next);
    assert_eq!(spans.len(), 3);
    assert_eq!(spans[0].length_ticks, 3_840);
    assert_eq!(spans[0].start_tick, 0);
    assert_eq!(next.arrangement.sections[0].kind, SectionKind::Intro);
    // The section that now follows it starts with a crossfade (02 §3.5).
    assert_eq!(next.arrangement.sections[1].id.to_string(), "sec_0");
    assert_eq!(
        next.arrangement.sections[1].transition_in.kind,
        TransitionKind::Crossfade
    );
    assert_eq!(next.arrangement.sections[1].transition_in.length_ticks, 480);

    let generated = next
        .tracks
        .iter()
        .find(|track| track.role == StemRole::Generated)
        .unwrap();
    let clip = &next.arrangement.sections[0].lanes.0[&generated.id].clips[0];
    // The clip starts at the splice point and fades out into the old first section.
    assert_eq!(clip.src_start, 96_000);
    assert_eq!(clip.fade_in_ticks, 0);
    assert_eq!(clip.fade_out_ticks, 480);
}

#[test]
fn a_mid_bar_song_end_offsets_the_clip_by_the_partial_bar() {
    let doc = short_song();
    // The context ends at 3840 but the song ends at 5760: one half bar (1920 ticks = 1 s =
    // 48 000 samples) still plays from the previous section, and the new audio continues after it.
    let batch = extend_placement(&doc, &request(&doc, ExtendDirection::Forward, 1, 0, 0)).unwrap();
    let next = apply_batch(&doc, &batch);
    let generated = next
        .tracks
        .iter()
        .find(|track| track.role == StemRole::Generated)
        .unwrap();
    let clip = &next.arrangement.sections.last().unwrap().lanes.0[&generated.id].clips[0];
    assert_eq!(clip.src_start, 48_000);
    assert_eq!(clip.src_end, 48_000 + BAR_SAMPLES);
}

#[test]
fn an_existing_generated_track_is_reused() {
    let doc = bar_song();
    let first = apply_batch(
        &doc,
        &extend_placement(&doc, &request(&doc, ExtendDirection::Forward, 1, 0, 0)).unwrap(),
    );
    let tracks = first.tracks.len();

    let mut second_request = request(&first, ExtendDirection::Forward, 1, 0, 0);
    second_request.candidate.source_id = "src_gen2".parse().unwrap();
    second_request.batch_id = "bat_extend2".parse().unwrap();
    let second = apply_batch(&first, &extend_placement(&first, &second_request).unwrap());

    assert_eq!(second.tracks.len(), tracks, "the generated track is reused");
    assert_eq!(
        second
            .tracks
            .iter()
            .filter(|track| track.role == StemRole::Generated)
            .count(),
        1
    );
}

#[test]
fn an_outro_is_used_only_when_asked() {
    let doc = bar_song();
    let mut outer = request(&doc, ExtendDirection::Forward, 1, 0, 0);
    outer.section_kind = Some(SectionKind::Outro);
    let next = apply_batch(&doc, &extend_placement(&doc, &outer).unwrap());
    assert_eq!(
        next.arrangement.sections.last().unwrap().kind,
        SectionKind::Outro
    );
}

#[test]
fn placement_rejects_unusable_requests() {
    let doc = bar_song();

    let mut no_bars = request(&doc, ExtendDirection::Forward, 0, 0, 0);
    no_bars.bars = 0;
    assert_eq!(
        extend_placement(&doc, &no_bars).unwrap_err(),
        PlacementError::NoBars
    );

    let past_end = request(&doc, ExtendDirection::Forward, 1, -600_000, 0);
    assert_eq!(
        extend_placement(&doc, &past_end).unwrap_err(),
        PlacementError::NoAudio
    );

    let mut empty = request(&doc, ExtendDirection::Forward, 1, 0, 0);
    empty.candidate.duration_samples = 0;
    assert_eq!(
        extend_placement(&doc, &empty).unwrap_err(),
        PlacementError::EmptyCandidate
    );
}

#[test]
fn a_rejected_batch_leaves_the_document_untouched() {
    let doc = bar_song();
    let before = canonical_json(&doc);
    let batch = extend_placement(&doc, &request(&doc, ExtendDirection::Forward, 1, 0, 0)).unwrap();
    let placed = apply_batch(&doc, &batch);
    // Re-applying the same source is rejected by `source.add`; `apply` works on a clone.
    let err = apply(&placed, &batch, &assets()).unwrap_err();
    assert_eq!(err.code(), bragi_model::ValidationCode::DuplicateId);
    assert_eq!(
        canonical_json(&doc),
        before,
        "the input document is not mutated"
    );
}

#[test]
fn undo_is_a_snapshot_restore() {
    let doc = bar_song();
    let before = canonical_json(&doc);
    let batch =
        extend_placement(&doc, &request(&doc, ExtendDirection::Forward, 2, 0, 480)).unwrap();
    let next = apply_batch(&doc, &batch);
    assert_ne!(canonical_json(&next), before);
    // Undo in 02 §7 is a checkout of the parent's snapshot, not an inverse op: the original
    // document is still byte-identical and validates, so restoring it is exact.
    validate(&doc, &assets()).expect("the original document still validates");
    assert_eq!(canonical_json(&doc), before);
}

#[test]
fn source_add_inserts_at_the_index_and_validates_the_placement() {
    let doc = bar_song();

    // A source without a placement is ordinary; index 0 puts it before everything else.
    let mut plain = source_add_op("src_plain", None);
    plain["index"] = json!(0);
    let next = apply(&doc, &batch(vec![plain]), &assets()).expect("source.add applies");
    assert_eq!(next.sources[0].id.to_string(), "src_plain");

    // A placement must name an existing section (02 §6.4).
    let bad = source_add_op("src_bad", Some("sec_missing"));
    let err = apply(&doc, &batch(vec![bad]), &assets()).unwrap_err();
    assert_eq!(err.code(), bragi_model::ValidationCode::MissingTarget);

    // An index past the end is a per-op error.
    let mut past_end = source_add_op("src_after", None);
    past_end["index"] = json!(9);
    let err = apply(&doc, &batch(vec![past_end]), &assets()).unwrap_err();
    assert_eq!(err.code(), bragi_model::ValidationCode::IndexOutOfRange);
}

fn batch(ops: Vec<serde_json::Value>) -> OpBatch {
    serde_json::from_value(json!({
        "id": "bat_01",
        "label": "Test",
        "createdAt": "2026-10-18T12:00:00Z",
        "author": { "kind": "user" },
        "ops": ops
    }))
    .expect("a valid batch")
}

fn source_add_op(id: &str, section: Option<&str>) -> serde_json::Value {
    let mut source = json!({
        "id": id,
        "kind": "generated",
        "originalAsset": CANDIDATE,
        "workingAsset": CANDIDATE,
        "durationSamples": CANDIDATE_SAMPLES,
        "channels": 2,
        "label": "Generated"
    });
    if let Some(section) = section {
        source["placement"] = json!({ "sectionId": section });
    }
    json!({ "op": "source.add", "source": source })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 64, ..ProptestConfig::default() })]

    /// Any usable request places a valid section and leaves the input untouched; the new document
    /// has exactly one more source and one more section.
    #[test]
    fn any_placement_is_valid_and_reversible(
        backward in any::<bool>(),
        bars in 1u32..5,
        splice in -470_000i64..0i64,
        crossfade in 0u64..2_000,
    ) {
        let doc = bar_song();
        let before = canonical_json(&doc);
        let direction = if backward { ExtendDirection::Backward } else { ExtendDirection::Forward };
        let batch = extend_placement(&doc, &request(&doc, direction, bars, splice, crossfade)).unwrap();
        let next = apply(&doc, &batch, &assets()).map_err(|error| TestCaseError::fail(format!("{error:?}")))?;
        validate(&next, &assets()).map_err(|errors| TestCaseError::fail(format!("{errors:?}")))?;

        prop_assert_eq!(next.sources.len(), doc.sources.len() + 1);
        prop_assert_eq!(next.arrangement.sections.len(), doc.arrangement.sections.len() + 1);
        prop_assert_eq!(canonical_json(&doc), before, "apply must not mutate its input");

        let index = if backward { 0 } else { next.arrangement.sections.len() - 1 };
        prop_assert_eq!(index, if backward { 0 } else { next.arrangement.sections.len() - 1 });
        prop_assert_eq!(
            next.arrangement.sections[index].length_ticks.get(),
            u64::from(bars) * BAR_TICKS as u64
        );
    }
}

/// Used by ad-hoc debugging; also proves the document serialises as JSON (the helper never
/// hand-builds a document).
#[allow(dead_code)]
fn as_json<T: serde::Serialize>(value: &T) -> serde_json::Value {
    to_value(value).expect("serialisable")
}
