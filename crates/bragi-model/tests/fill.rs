//! Fill placement: a generated source in a gap range, its clips and the stem mapping into that
//! range (`specs/09-generation.md` §4.3, `specs/02-song-model.md` §4.2, §6.4).
//!
//! Every test applies the batch through `bragi_model::apply` and re-validates the result, so the
//! helper and the op interpreter agree. Tests may `unwrap()`/`expect()` (`specs/13-agent-guide.md`
//! §3).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use bragi_model::canonical_json;
use bragi_model::generated::{
    AssetMeta, BatchId, ChannelCount, IsoDate, OpBatch, Project, Provenance, ProvenanceKind,
    SourceId, StemRole, TickRange, Warp,
};
use bragi_model::placement::{
    FillPlacementRequest, GeneratedCandidate, PlacementError, fill_placement,
};
use bragi_model::{AssetIndex, apply, derived_id, section_spans, validate};
use serde_json::{Value, json};

const CANDIDATE: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CANDIDATE_B: &str = "sha256:abababababababababababababababababababababababababababababababab";
const GEN_VOCALS: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const GEN_DRUMS: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const GEN_RESIDUAL: &str =
    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
/// One bar of 4/4 at 120 bpm: 3840 ticks, 96 000 samples.
const BAR_TICKS: i64 = 3_840;
const BAR_SAMPLES: u64 = 96_000;
/// The candidate is the gap (one bar) plus a half bar of overlap on each side.
const CANDIDATE_SAMPLES: u64 = 2 * BAR_SAMPLES;

fn assets() -> AssetIndex {
    [CANDIDATE, CANDIDATE_B, GEN_VOCALS, GEN_DRUMS, GEN_RESIDUAL]
        .into_iter()
        .map(|hash| {
            serde_json::from_value::<AssetMeta>(json!({
                "hash": hash,
                "mime": "audio/flac",
                "bytes": 1,
                "sampleRate": 48_000,
                "channels": 2,
                "durationSamples": CANDIDATE_SAMPLES
            }))
            .expect("valid AssetMeta")
        })
        .collect()
}

/// Two one-bar sections with an empty mix lane.
fn song() -> Project {
    serde_json::from_value(json!({
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
            "sections": [
                { "id": "sec_0", "kind": "verse", "label": "Verse", "lengthTicks": BAR_TICKS,
                  "lanes": {}, "transitionIn": { "kind": "cut", "lengthTicks": 0 } },
                { "id": "sec_1", "kind": "chorus", "label": "Chorus", "lengthTicks": BAR_TICKS,
                  "lanes": {}, "transitionIn": { "kind": "cut", "lengthTicks": 0 } }
            ],
            "master": { "fx": [], "automation": [], "gainDb": 0 }
        }
    }))
    .expect("a valid fixture project")
}

fn candidate(source: &str) -> GeneratedCandidate {
    let asset = if source == "src_b" {
        CANDIDATE_B
    } else {
        CANDIDATE
    };
    GeneratedCandidate {
        source_id: source.parse::<SourceId>().unwrap(),
        original_asset: asset.parse().unwrap(),
        working_asset: asset.parse().unwrap(),
        duration_samples: CANDIDATE_SAMPLES,
        channels: ChannelCount::try_from(2).unwrap(),
        label: "Generated: fill".to_owned(),
        provenance: Provenance {
            created_at: "2026-10-18T12:00:00Z".parse::<IsoDate>().unwrap(),
            job_id: None,
            kind: ProvenanceKind::Generation,
            model: Some("ace-step".to_owned()),
            model_version: Some("1.5.0".to_owned()),
            prompt: Some("fill the gap".to_owned()),
        },
    }
}

/// The gap starts half a bar into the first section and ends half a bar into the second.
fn crossing_request(source: &str) -> FillPlacementRequest {
    FillPlacementRequest {
        gap_range: TickRange {
            start_tick: BAR_TICKS / 2,
            end_tick: BAR_TICKS + BAR_TICKS / 2,
        },
        candidate: candidate(source),
        // The processed audio starts half a bar inside the left context and ends half a bar
        // inside the right one.
        start_offset_samples: -(BAR_SAMPLES as i64 / 2),
        end_offset_samples: BAR_SAMPLES as i64 / 2,
        crossfade_ticks: 480,
        batch_id: "bat_fill".parse::<BatchId>().unwrap(),
        label: "Fill gap".to_owned(),
        created_at: "2026-10-18T12:00:00Z".parse::<IsoDate>().unwrap(),
    }
}

fn apply_batch(doc: &Project, batch: &OpBatch) -> Project {
    let next = apply(doc, batch, &assets()).expect("the fill batch applies");
    validate(&next, &assets()).expect("the filled document validates");
    next
}

fn generated_lane<'a>(
    doc: &'a Project,
    section: usize,
    source_id: &str,
) -> &'a [bragi_model::generated::Clip] {
    let track = doc
        .tracks
        .iter()
        .find(|track| track.role == StemRole::Generated)
        .unwrap_or_else(|| panic!("a generated track for {source_id}"));
    doc.arrangement.sections[section]
        .lanes
        .0
        .get(&track.id)
        .map(|lane| lane.clips.as_slice())
        .unwrap_or(&[])
}

#[test]
fn a_gap_crossing_a_boundary_gets_one_clip_per_section() {
    let doc = song();
    let batch = fill_placement(&doc, &crossing_request("src_fill")).unwrap();
    assert_eq!(batch.ops.len(), 4, "source, generated track, two clips");

    let next = apply_batch(&doc, &batch);
    assert_eq!(next.arrangement.sections.len(), 2, "no section is added");

    let source = &next.sources[0];
    let placement = source.placement.as_ref().expect("a placement");
    assert_eq!(placement.section_id.to_string(), "sec_0");
    assert_eq!(
        placement
            .range
            .as_ref()
            .map(|range| (range.start_tick, range.end_tick)),
        Some((BAR_TICKS / 2, BAR_TICKS + BAR_TICKS / 2))
    );
    assert_eq!(placement.src_start_samples, Some(BAR_SAMPLES / 2));

    let first = generated_lane(&next, 0, "src_fill");
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].start, BAR_TICKS / 2);
    assert_eq!(first[0].src_start, BAR_SAMPLES / 2);
    assert_eq!(first[0].src_end, BAR_SAMPLES);
    assert_eq!(first[0].fade_in_ticks, 480);
    assert_eq!(first[0].fade_out_ticks, 0);
    assert!(matches!(first[0].warp, Warp::Beatgrid(_)));

    // The second clip continues the same source window at local 0: the audio runs across the join.
    let second = generated_lane(&next, 1, "src_fill");
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].start, 0);
    assert_eq!(second[0].src_start, BAR_SAMPLES);
    assert_eq!(second[0].src_end, BAR_SAMPLES + BAR_SAMPLES / 2);
    assert_eq!(second[0].fade_in_ticks, 0);
    assert_eq!(second[0].fade_out_ticks, 480);

    // Both clips derive from the source, so two fills in one section cannot collide.
    assert_eq!(
        first[0].id.to_string(),
        derived_id(
            "clp_",
            "src_fill",
            &format!("fill:sec_0:{}", track_id(&next, StemRole::Generated))
        )
    );
}

fn track_id(doc: &Project, role: StemRole) -> String {
    doc.tracks
        .iter()
        .find(|track| track.role == role)
        .map_or_else(String::new, |track| track.id.to_string())
}

fn analysis_op(source: &str, stage: &str, effects: Value) -> Value {
    let mut blob: String = stage.bytes().map(|byte| format!("{byte:02x}")).collect();
    blob.push_str(&"0".repeat(64 - blob.len()));
    json!({
        "op": "analysis.apply",
        "sourceId": source,
        "stage": stage,
        "blob": format!("sha256:{blob}"),
        "effects": effects
    })
}

fn batch(ops: Vec<Value>) -> OpBatch {
    serde_json::from_value(json!({
        "id": "bat_analysis",
        "label": "Analysis",
        "createdAt": "2026-10-18T12:00:00Z",
        "author": { "kind": "system", "reason": "analysis" },
        "ops": ops
    }))
    .expect("a valid batch")
}

fn apply_op(doc: &Project, op: Value) -> Project {
    let next = apply(doc, &batch(vec![op]), &assets()).expect("the op applies");
    validate(&next, &assets()).expect("the result validates");
    next
}

fn separation_op(source: &str) -> Value {
    analysis_op(
        source,
        "separation",
        json!([{
            "kind": "separation",
            "stems": [
                { "role": "drums", "asset": GEN_DRUMS },
                { "role": "vocals", "asset": GEN_VOCALS }
            ],
            "residual": GEN_RESIDUAL
        }]),
    )
}

fn placed_crossing() -> Project {
    let doc = song();
    let batch = fill_placement(&doc, &crossing_request("src_fill")).unwrap();
    apply_batch(&doc, &batch)
}

#[test]
fn stems_are_mapped_into_the_gap_range_only() {
    let doc = placed_crossing();
    let generated = doc
        .tracks
        .iter()
        .find(|track| track.role == StemRole::Generated)
        .expect("a generated track")
        .id
        .clone();
    let next = apply_op(&doc, separation_op("src_fill"));

    assert!(
        !next.tracks.iter().any(|track| track.id == generated),
        "the mix-only generated track is gone (09 §9 check 2)"
    );
    for role in [StemRole::Drums, StemRole::Vocals, StemRole::Residual] {
        let id = track_id(&next, role);
        assert!(!id.is_empty(), "a {role} track");
        for (index, (local, src)) in [(BAR_TICKS / 2, BAR_SAMPLES / 2), (0, BAR_SAMPLES)]
            .into_iter()
            .enumerate()
        {
            let lane = next.arrangement.sections[index]
                .lanes
                .0
                .get(
                    &next
                        .tracks
                        .iter()
                        .find(|track| track.id.to_string() == id)
                        .unwrap()
                        .id,
                )
                .unwrap_or_else(|| panic!("a {role} lane in section {index}"));
            assert_eq!(lane.clips.len(), 1, "{role} in section {index}");
            let clip = &lane.clips[0];
            assert_eq!(clip.start, local, "{role} local start");
            assert_eq!(clip.src_start, src, "{role} src start");
            assert_eq!(
                clip.id.to_string(),
                derived_id("clp_", "src_fill", &format!("fill:sec_{index}:{id}")),
                "{role} clip id is per source"
            );
            assert_eq!(clip.provenance.kind, ProvenanceKind::Separation);
        }
    }

    // Nothing was mapped outside the gap: the two sections' other bars stay empty on the stems.
    let drums = next
        .tracks
        .iter()
        .find(|track| track.role == StemRole::Drums)
        .unwrap();
    assert_eq!(
        next.arrangement.sections[0].lanes.0[&drums.id]
            .clips
            .iter()
            .map(|clip| clip.start)
            .collect::<Vec<_>>(),
        vec![BAR_TICKS / 2]
    );
    assert_eq!(
        next.arrangement.sections[1].lanes.0[&drums.id]
            .clips
            .iter()
            .map(|clip| clip.start)
            .collect::<Vec<_>>(),
        vec![0]
    );
}

#[test]
fn the_mapping_is_order_independent() {
    let doc = placed_crossing();
    let ingest = analysis_op("src_fill", "ingest", json!([]));
    let tag = analysis_op(
        "src_fill",
        "tag",
        json!([{ "kind": "tags", "genres": ["generated"], "moods": [] }]),
    );
    let separation = separation_op("src_fill");

    let mut first = apply_op(&doc, ingest.clone());
    first = apply_op(&first, separation.clone());
    first = apply_op(&first, tag.clone());

    let mut second = apply_op(&doc, separation.clone());
    second = apply_op(&second, tag);
    second = apply_op(&second, ingest);

    assert_eq!(canonical_json(&first), canonical_json(&second));
}

#[test]
fn a_gap_inside_one_section_is_one_clip() {
    let doc = song();
    let mut request = crossing_request("src_inside");
    request.gap_range = TickRange {
        start_tick: BAR_TICKS / 4,
        end_tick: BAR_TICKS / 2,
    };
    // One quarter bar of gap; the candidate's overlaps are ignored, its head is skipped.
    request.start_offset_samples = -(BAR_SAMPLES as i64 / 4);
    request.end_offset_samples = BAR_SAMPLES as i64 / 4;
    let batch = fill_placement(&doc, &request).unwrap();
    assert_eq!(batch.ops.len(), 3, "source, generated track, one clip");
    let next = apply_batch(&doc, &batch);
    let clips = generated_lane(&next, 0, "src_inside");
    assert_eq!(clips.len(), 1);
    assert_eq!(clips[0].src_start, BAR_SAMPLES / 4);
    assert_eq!(clips[0].src_end, BAR_SAMPLES / 2);
    assert_eq!(clips[0].fade_in_ticks, 480);
    assert_eq!(clips[0].fade_out_ticks, 480);
}

#[test]
fn two_fills_in_one_section_keep_both_mappings() {
    let doc = song();
    let mut first = crossing_request("src_a");
    first.gap_range = TickRange {
        start_tick: BAR_TICKS / 8,
        end_tick: BAR_TICKS / 4,
    };
    let mut second = crossing_request("src_b");
    second.gap_range = TickRange {
        start_tick: 3 * BAR_TICKS / 4,
        end_tick: 7 * BAR_TICKS / 8,
    };
    let first = apply_batch(&doc, &fill_placement(&doc, &first).unwrap());
    let both = apply_batch(&first, &fill_placement(&first, &second).unwrap());

    // Map `src_b` first, then `src_a`; the other order maps `src_a` first.
    let a = apply_op(&both, separation_op("src_a"));
    let a = apply_op(&a, separation_op("src_b"));
    let b = apply_op(&both, separation_op("src_b"));
    let b = apply_op(&b, separation_op("src_a"));

    assert_eq!(canonical_json(&a), canonical_json(&b));
    assert!(
        !a.tracks
            .iter()
            .any(|track| track.role == StemRole::Generated),
        "the shared generated track is removed once both fills are mapped"
    );
    let drums = a
        .tracks
        .iter()
        .find(|track| track.role == StemRole::Drums)
        .expect("a drums track");
    let starts: Vec<i64> = a.arrangement.sections[0].lanes.0[&drums.id]
        .clips
        .iter()
        .map(|clip| clip.start)
        .collect();
    assert_eq!(starts, vec![BAR_TICKS / 8, 3 * BAR_TICKS / 4]);
}

#[test]
fn fill_rejects_unusable_requests() {
    let doc = song();

    let mut empty = crossing_request("src_fill");
    empty.candidate.duration_samples = 0;
    assert_eq!(
        fill_placement(&doc, &empty).unwrap_err(),
        PlacementError::EmptyCandidate
    );

    let mut outside = crossing_request("src_fill");
    outside.gap_range = TickRange {
        start_tick: BAR_TICKS,
        end_tick: 3 * BAR_TICKS,
    };
    assert_eq!(
        fill_placement(&doc, &outside).unwrap_err(),
        PlacementError::OutsideSong
    );

    let mut short = crossing_request("src_fill");
    short.end_offset_samples = -(BAR_SAMPLES as i64 / 2);
    assert_eq!(
        fill_placement(&doc, &short).unwrap_err(),
        PlacementError::GapNotCovered
    );

    let mut past = crossing_request("src_fill");
    past.start_offset_samples = 1_000;
    assert_eq!(
        fill_placement(&doc, &past).unwrap_err(),
        PlacementError::GapNotCovered
    );

    let mut no_audio = crossing_request("src_fill");
    no_audio.start_offset_samples = -(CANDIDATE_SAMPLES as i64);
    assert_eq!(
        fill_placement(&doc, &no_audio).unwrap_err(),
        PlacementError::NoAudio
    );

    // An asset shorter than "left overlap + gap" cannot cover the gap even though it has samples.
    let mut too_short = crossing_request("src_fill");
    too_short.candidate.duration_samples = 100_000;
    assert_eq!(
        fill_placement(&doc, &too_short).unwrap_err(),
        PlacementError::NoAudio
    );
}

#[test]
fn undo_is_a_snapshot_restore_and_a_rejected_batch_does_not_mutate() {
    let doc = song();
    let before = canonical_json(&doc);
    let batch = fill_placement(&doc, &crossing_request("src_fill")).unwrap();
    let placed = apply_batch(&doc, &batch);
    assert_ne!(canonical_json(&placed), before);
    // Re-applying the batch re-adds the same source: the op rejects it, and the input is intact.
    let err = apply(&placed, &batch, &assets()).unwrap_err();
    assert_eq!(err.code(), bragi_model::ValidationCode::DuplicateId);
    assert_eq!(canonical_json(&doc), before);
    validate(&doc, &assets()).expect("the original document still validates");
}

#[test]
fn a_placement_without_a_usable_range_is_invalid() {
    let doc = song();
    let mut op = json!({
        "op": "source.add",
        "source": {
            "id": "src_bad",
            "kind": "generated",
            "originalAsset": CANDIDATE,
            "workingAsset": CANDIDATE,
            "durationSamples": CANDIDATE_SAMPLES,
            "channels": 2,
            "label": "Generated",
            "placement": { "sectionId": "sec_0", "range": { "startTick": 0, "endTick": BAR_TICKS } }
        }
    });
    // A ranged placement needs the sample that plays at its start.
    let err = apply(&doc, &batch(vec![op.clone()]), &assets()).unwrap_err();
    assert_eq!(err.code(), bragi_model::ValidationCode::NumericRange);

    op["source"]["placement"]["srcStartSamples"] = json!(0);
    let next = apply(&doc, &batch(vec![op]), &assets()).expect("the ranged placement applies");
    assert_eq!(
        section_spans(&next)[0].start_tick,
        0,
        "the placement adds no section"
    );
}

proptest::proptest! {
    #![proptest_config(proptest::prelude::ProptestConfig { cases: 64, ..proptest::prelude::ProptestConfig::default() })]

    /// Any gap inside the song places a valid document without adding a section; the clip count is
    /// the number of sections the gap crosses.
    #[test]
    fn any_gap_places_a_valid_document_without_a_section(
        start in 0i64..(2 * BAR_TICKS - 1),
        length in 1i64..BAR_TICKS,
        skip in 0u64..(CANDIDATE_SAMPLES / 2),
    ) {
        use proptest::prelude::*;
        let doc = song();
        let mut request = crossing_request("src_prop");
        request.gap_range = TickRange {
            start_tick: start,
            end_tick: (start + length).min(2 * BAR_TICKS),
        };
        // The gap is at most one bar (96 000 samples), so a head skip of up to half the candidate
        // still leaves the gap covered (the tail only has to exist).
        request.start_offset_samples = -(skip as i64);
        request.end_offset_samples = 0;
        let batch = fill_placement(&doc, &request).unwrap();
        let next = apply(&doc, &batch, &assets()).map_err(|error| TestCaseError::fail(format!("{error:?}")))?;
        validate(&next, &assets()).map_err(|errors| TestCaseError::fail(format!("{errors:?}")))?;
        prop_assert_eq!(next.arrangement.sections.len(), doc.arrangement.sections.len());
        prop_assert_eq!(next.sources.len(), doc.sources.len() + 1);
        let crossing = request.gap_range.end_tick > BAR_TICKS && request.gap_range.start_tick < BAR_TICKS;
        let clips = next.arrangement.sections.iter()
            .flat_map(|section| section.lanes.0.values())
            .flat_map(|lane| lane.clips.iter())
            .count();
        prop_assert_eq!(clips, if crossing { 2 } else { 1 });
    }
}
