//! Transition placement: a generated source with no lane clip, and the section's `generated`
//! transition (`specs/09-generation.md` §4.4, `specs/02-song-model.md` §3.5, §6.4).
//!
//! Tests may `unwrap()`/`expect()` (`specs/13-agent-guide.md` §3).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use bragi_model::canonical_json;
use bragi_model::generated::{
    AssetMeta, BatchId, ChannelCount, IsoDate, OpBatch, Project, Provenance, ProvenanceKind,
    SectionId, SourceId, StemRole, TransitionKind,
};
use bragi_model::placement::{
    GeneratedCandidate, PlacementError, TransitionPlacementRequest, transition_placement,
};
use bragi_model::{AssetIndex, apply, validate};
use serde_json::{Value, json};

const CANDIDATE: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const STEM: &str = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const RESIDUAL: &str = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const BAR_TICKS: u64 = 3_840;
const CANDIDATE_SAMPLES: u64 = 96_000;
/// Half a bar at 120 bpm.
const LENGTH_TICKS: u64 = 1_920;

fn assets() -> AssetIndex {
    [CANDIDATE, STEM, RESIDUAL]
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
                { "id": "sec_a", "kind": "verse", "label": "Verse", "lengthTicks": BAR_TICKS,
                  "lanes": {}, "transitionIn": { "kind": "cut", "lengthTicks": 0 } },
                { "id": "sec_b", "kind": "chorus", "label": "Chorus", "lengthTicks": BAR_TICKS,
                  "lanes": {}, "transitionIn": { "kind": "crossfade", "lengthTicks": 480 } }
            ],
            "master": { "fx": [], "automation": [], "gainDb": 0 }
        }
    }))
    .expect("a valid fixture project")
}

fn request(section: &str) -> TransitionPlacementRequest {
    TransitionPlacementRequest {
        section_id: section.parse::<SectionId>().unwrap(),
        candidate: GeneratedCandidate {
            source_id: "src_join".parse::<SourceId>().unwrap(),
            original_asset: CANDIDATE.parse().unwrap(),
            working_asset: CANDIDATE.parse().unwrap(),
            duration_samples: CANDIDATE_SAMPLES,
            channels: ChannelCount::try_from(2).unwrap(),
            label: "Generated: transition".to_owned(),
            provenance: Provenance {
                created_at: "2026-10-18T12:00:00Z".parse::<IsoDate>().unwrap(),
                job_id: None,
                kind: ProvenanceKind::Generation,
                model: Some("ace-step".to_owned()),
                model_version: Some("1.5.0".to_owned()),
                prompt: Some("smooth the join".to_owned()),
            },
        },
        length_ticks: LENGTH_TICKS,
        batch_id: "bat_join".parse::<BatchId>().unwrap(),
        label: "Smooth with AI".to_owned(),
        created_at: "2026-10-18T12:00:00Z".parse::<IsoDate>().unwrap(),
    }
}

fn apply_batch(doc: &Project, batch: &OpBatch) -> Project {
    let next = apply(doc, batch, &assets()).expect("the transition batch applies");
    validate(&next, &assets()).expect("the result validates");
    next
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

fn apply_op(doc: &Project, op: Value) -> Project {
    let batch: OpBatch = serde_json::from_value(json!({
        "id": "bat_analysis",
        "label": "Analysis",
        "createdAt": "2026-10-18T12:00:00Z",
        "author": { "kind": "system", "reason": "analysis" },
        "ops": [op]
    }))
    .expect("a valid batch");
    let next = apply(doc, &batch, &assets()).expect("the op applies");
    validate(&next, &assets()).expect("the result validates");
    next
}

#[test]
fn the_batch_adds_a_placeless_source_and_sets_the_transition() {
    let doc = song();
    let batch = transition_placement(&doc, &request("sec_b")).unwrap();
    assert_eq!(batch.ops.len(), 2, "source.add, section.set_transition");

    let next = apply_batch(&doc, &batch);
    assert_eq!(next.sources.len(), 1);
    let source = &next.sources[0];
    assert_eq!(source.kind, bragi_model::generated::SourceKind::Generated);
    let placement = source.placement.as_ref().expect("a placement");
    assert_eq!(placement.section_id.to_string(), "sec_b");
    assert!(placement.range.is_none(), "a transition owns no range");
    assert!(placement.src_start_samples.is_none());

    let section = next
        .arrangement
        .sections
        .iter()
        .find(|section| section.id.to_string() == "sec_b")
        .unwrap();
    assert_eq!(section.transition_in.kind, TransitionKind::Generated);
    assert_eq!(section.transition_in.length_ticks, LENGTH_TICKS);
    assert_eq!(
        section
            .transition_in
            .asset
            .as_ref()
            .map(|asset| asset.as_str()),
        Some(CANDIDATE)
    );
    // The first section is untouched and no lane holds the asset: a transition is not a clip.
    assert_eq!(
        next.arrangement.sections[0].transition_in.kind,
        TransitionKind::Cut
    );
    assert!(!next.arrangement.sections.iter().any(|section| {
        section
            .lanes
            .0
            .values()
            .flat_map(|lane| lane.clips.iter())
            .any(|clip| clip.asset.as_str() == CANDIDATE)
    }));
    assert!(
        !next
            .tracks
            .iter()
            .any(|track| track.role == StemRole::Generated),
        "no generated track is created"
    );
    assert_eq!(next.arrangement.sections.len(), 2);
}

trait AssetHashExt {
    fn as_str(&self) -> &str;
}

impl AssetHashExt for bragi_model::generated::AssetHash {
    fn as_str(&self) -> &str {
        self.as_ref()
    }
}

#[test]
fn analysing_the_transition_asset_adds_no_block_and_no_clip() {
    let doc = song();
    let placed = apply_batch(
        &doc,
        &transition_placement(&doc, &request("sec_b")).unwrap(),
    );
    let next = apply_op(&placed, analysis_op("src_join", "ingest", json!([])));
    let next = apply_op(
        &next,
        analysis_op(
            "src_join",
            "separation",
            json!([{
                "kind": "separation",
                "stems": [{ "role": "vocals", "asset": STEM }],
                "residual": RESIDUAL
            }]),
        ),
    );

    assert_eq!(
        next.arrangement.sections.len(),
        2,
        "a placed source never appends a baseline section"
    );
    assert!(
        next.tracks
            .iter()
            .all(|track| track.role == StemRole::FullMix),
        "no stem track is created for a transition asset"
    );
    assert!(
        !next.arrangement.sections.iter().any(|section| section
            .lanes
            .0
            .values()
            .flat_map(|lane| lane.clips.iter())
            .any(|clip| clip.asset.as_str() == STEM || clip.asset.as_str() == RESIDUAL)),
        "the transition asset is never mapped into a lane"
    );
}

#[test]
fn transition_rejects_unusable_requests() {
    let doc = song();

    assert_eq!(
        transition_placement(&doc, &request("sec_a")).unwrap_err(),
        PlacementError::NoBoundary("sec_a".parse().unwrap())
    );
    assert_eq!(
        transition_placement(&doc, &request("sec_missing")).unwrap_err(),
        PlacementError::NoBoundary("sec_missing".parse().unwrap())
    );

    let mut zero = request("sec_b");
    zero.length_ticks = 0;
    assert_eq!(
        transition_placement(&doc, &zero).unwrap_err(),
        PlacementError::NoLength
    );

    let mut empty = request("sec_b");
    empty.candidate.duration_samples = 0;
    assert_eq!(
        transition_placement(&doc, &empty).unwrap_err(),
        PlacementError::EmptyCandidate
    );
}

#[test]
fn the_helper_is_deterministic_and_undo_restores_the_exact_bytes() {
    let doc = song();
    let before = canonical_json(&doc);
    let batch = transition_placement(&doc, &request("sec_b")).unwrap();
    let again = transition_placement(&doc, &request("sec_b")).unwrap();
    assert_eq!(
        serde_json::to_value(&batch).unwrap(),
        serde_json::to_value(&again).unwrap(),
        "the batch is a pure function of the document and the request"
    );

    let next = apply_batch(&doc, &batch);
    assert_ne!(canonical_json(&next), before);
    assert_eq!(
        canonical_json(&doc),
        before,
        "apply does not mutate its input"
    );
    validate(&doc, &assets()).expect("the original document still validates");
}
