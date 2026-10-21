//! Mapping a generated source's stems onto the song's existing tracks
//! (`specs/09-generation.md` §4.2, §9 check 2, `specs/02-song-model.md` §6).
//!
//! The generated source is placed by `extend_placement`; later `standard` analysis of its asset
//! reports a separation effect, and `analysis.apply` maps the stems into the placement section,
//! removes the mix-only generated lane, and does nothing when separation failed. Tests may
//! `unwrap()`/`expect()` (`specs/13-agent-guide.md` §3).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use bragi_model::canonical_json;
use bragi_model::generated::{
    AssetMeta, BatchId, ChannelCount, IsoDate, OpBatch, Project, Provenance, ProvenanceKind,
    SourceId, StemRole, TickRange,
};
use bragi_model::placement::{
    ExtendCandidate, ExtendDirection, ExtendPlacementRequest, extend_placement,
};
use bragi_model::{AssetIndex, apply, derived_id, validate};
use serde_json::{Value, json};

const SRC: &str = "src_orig";
const GEN: &str = "src_gen";
/// 10 s at 48 kHz: five bars at 120 bpm.
const DURATION: u64 = 480_000;
/// The generated candidate: four bars at 48 kHz.
const CANDIDATE_SAMPLES: u64 = 384_000;

fn hash(byte: char) -> String {
    format!("sha256:{}", byte.to_string().repeat(64))
}

fn mix() -> String {
    hash('a')
}
fn vocals() -> String {
    hash('b')
}
fn drums() -> String {
    hash('c')
}
fn residual() -> String {
    hash('d')
}
fn candidate() -> String {
    hash('e')
}
fn gen_vocals() -> String {
    hash('f')
}
fn gen_drums() -> String {
    hash('0')
}
fn gen_residual() -> String {
    hash('1')
}
fn gen_strings() -> String {
    hash('2')
}

fn asset_index() -> AssetIndex {
    let hashes = [
        mix(),
        vocals(),
        drums(),
        residual(),
        candidate(),
        gen_vocals(),
        gen_drums(),
        gen_residual(),
        gen_strings(),
    ];
    AssetIndex::from_metas(hashes.into_iter().map(|hash| {
        serde_json::from_value::<AssetMeta>(json!({
            "hash": hash,
            "mime": "audio/flac",
            "bytes": 1,
            "sampleRate": 48_000,
            "channels": 2,
            "durationSamples": if hash == candidate() { CANDIDATE_SAMPLES } else { DURATION }
        }))
        .expect("valid AssetMeta")
    }))
}

fn base_doc() -> Project {
    serde_json::from_value(json!({
        "schemaVersion": 1,
        "id": "prj_01",
        "meta": { "title": "Fixture", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
        "sources": [{
            "id": SRC,
            "kind": "upload",
            "originalAsset": mix(),
            "workingAsset": mix(),
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

fn batch(ops: Vec<Value>) -> OpBatch {
    serde_json::from_value(json!({
        "id": "bat_01",
        "label": "Analysis",
        "createdAt": "2026-10-18T12:00:00Z",
        "author": { "kind": "system", "reason": "analysis" },
        "ops": ops
    }))
    .expect("a valid batch")
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
    let next = apply(doc, &batch(vec![op]), &asset_index()).expect("the op applies");
    validate(&next, &asset_index()).expect("the result validates");
    next
}

/// The original song analysed through ingest, rhythm and separation (the WP-1.8 baseline).
fn analysed_song() -> Project {
    let mut doc = base_doc();
    doc = apply_op(&doc, analysis_op(SRC, "ingest", json!([])));
    doc = apply_op(
        &doc,
        analysis_op(
            SRC,
            "rhythm",
            json!([{
                "kind": "tempo",
                "tempoMap": [ { "tick": 0, "bpm": 120, "curve": "step" } ],
                "timeSignatures": [ { "bar": 0, "numerator": 4, "denominator": 4 } ]
            }]),
        ),
    );
    apply_op(
        &doc,
        analysis_op(
            SRC,
            "separation",
            json!([{
                "kind": "separation",
                "stems": [
                    { "role": "vocals", "asset": vocals() },
                    { "role": "drums", "asset": drums() }
                ],
                "residual": residual()
            }]),
        ),
    )
}

fn placement_request(doc: &Project) -> ExtendPlacementRequest {
    ExtendPlacementRequest {
        direction: ExtendDirection::Forward,
        context_range: TickRange {
            start_tick: 0,
            end_tick: bragi_model::spans::total_ticks(doc),
        },
        candidate: ExtendCandidate {
            source_id: GEN.parse::<SourceId>().unwrap(),
            original_asset: candidate().parse().unwrap(),
            working_asset: candidate().parse().unwrap(),
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
        splice_offset: 0,
        bars: 2,
        crossfade_ticks: 0,
        section_kind: None,
        batch_id: "bat_extend".parse::<BatchId>().unwrap(),
        label: "Extend: 2 bars".to_owned(),
        created_at: "2026-10-18T12:00:00Z".parse::<IsoDate>().unwrap(),
    }
}

/// The song with the generated source placed but not yet analysed.
fn placed_song() -> (Project, String) {
    let doc = analysed_song();
    let batch = extend_placement(&doc, &placement_request(&doc)).expect("a placement batch");
    let next = apply(&doc, &batch, &asset_index()).expect("the placement applies");
    let section = derived_id("sec_", GEN, "extend");
    (next, section)
}

fn generated_separation() -> Value {
    analysis_op(
        GEN,
        "separation",
        json!([{
            "kind": "separation",
            "stems": [
                { "role": "drums", "asset": gen_drums() },
                { "role": "vocals", "asset": gen_vocals() },
                { "role": "strings", "asset": gen_strings() }
            ],
            "residual": gen_residual()
        }]),
    )
}

#[test]
fn stems_map_onto_matching_tracks_and_the_generated_lane_disappears() {
    let (doc, section_id) = placed_song();
    let generated_track = doc
        .tracks
        .iter()
        .find(|track| track.role == StemRole::Generated)
        .expect("placement created a generated track")
        .id
        .clone();
    let before_tracks = doc.tracks.len();
    let mix_track_clips = doc
        .arrangement
        .sections
        .iter()
        .flat_map(|section| section.lanes.0.values())
        .flat_map(|lane| lane.clips.iter())
        .filter(|clip| clip.asset.as_str() == candidate())
        .count();
    assert_eq!(mix_track_clips, 1);

    let next = apply_op(&doc, generated_separation());
    let section = next
        .arrangement
        .sections
        .iter()
        .find(|section| section.id.to_string() == section_id)
        .expect("the placement section survives");

    // The mix-only generated lane and its track are gone (09 §9 check 2).
    assert!(
        !next.tracks.iter().any(|track| track.id == generated_track),
        "the generated track was removed"
    );
    assert!(
        !section
            .lanes
            .0
            .values()
            .flat_map(|lane| lane.clips.iter())
            .any(|clip| clip.asset.as_str() == candidate())
    );

    // Two existing tracks were reused and `strings` was created once.
    assert_eq!(
        next.tracks
            .iter()
            .filter(|track| track.role == StemRole::Vocals)
            .count(),
        1
    );
    assert_eq!(
        next.tracks
            .iter()
            .filter(|track| track.role == StemRole::Drums)
            .count(),
        1
    );
    assert_eq!(
        next.tracks
            .iter()
            .filter(|track| track.role == StemRole::Strings)
            .count(),
        1
    );
    assert_eq!(next.tracks.len(), before_tracks, "one added, one removed");

    // Every mapped stem has one clip in the placement section, with a separation provenance.
    for (role, asset) in [
        (StemRole::Vocals, gen_vocals()),
        (StemRole::Drums, gen_drums()),
        (StemRole::Strings, gen_strings()),
        (StemRole::Residual, gen_residual()),
    ] {
        let track = next
            .tracks
            .iter()
            .find(|track| track.role == role)
            .unwrap_or_else(|| panic!("a {role} track"));
        let lane = section
            .lanes
            .0
            .get(&track.id)
            .unwrap_or_else(|| panic!("a {role} lane"));
        assert_eq!(lane.clips.len(), 1, "{role}");
        let clip = &lane.clips[0];
        assert_eq!(clip.asset.as_str(), asset);
        assert_eq!(
            clip.id.to_string(),
            derived_id("clp_", &section_id, track.id.as_str())
        );
        assert_eq!(
            clip.provenance.kind,
            ProvenanceKind::Separation,
            "mapped stems carry separation provenance"
        );
    }
}

#[test]
fn a_failed_separation_keeps_the_generated_lane() {
    let (doc, section_id) = placed_song();
    // `ingest` and `tag` report no separation effect: separation failed or never ran.
    let next = apply_op(&doc, analysis_op(GEN, "ingest", json!([])));
    let next = apply_op(
        &next,
        analysis_op(
            GEN,
            "tag",
            json!([{ "kind": "tags", "genres": [], "moods": [] }]),
        ),
    );

    let generated = next
        .tracks
        .iter()
        .find(|track| track.role == StemRole::Generated)
        .expect("the generated track stays");
    let section = next
        .arrangement
        .sections
        .iter()
        .find(|section| section.id.to_string() == section_id)
        .unwrap();
    let lane = section.lanes.0.get(&generated.id).expect("the lane stays");
    assert_eq!(lane.clips.len(), 1);
    assert_eq!(lane.clips[0].asset.as_str(), candidate());
}

#[test]
fn the_mapping_is_order_independent_and_idempotent() {
    let (doc, _) = placed_song();
    let ingest = analysis_op(GEN, "ingest", json!([]));
    let tag = analysis_op(
        GEN,
        "tag",
        json!([{ "kind": "tags", "genres": ["generated"], "moods": [] }]),
    );
    let separation = generated_separation();

    let mut canonical = apply_op(&doc, ingest.clone());
    canonical = apply_op(&canonical, tag.clone());
    canonical = apply_op(&canonical, separation.clone());

    let mut permuted = apply_op(&doc, separation.clone());
    permuted = apply_op(&permuted, tag);
    permuted = apply_op(&permuted, ingest);
    assert_eq!(canonical_json(&canonical), canonical_json(&permuted));

    // Re-delivery (a retry or a reconnect) changes nothing.
    let again = apply_op(&canonical, separation);
    assert_eq!(canonical_json(&canonical), canonical_json(&again));
}

#[test]
fn a_new_stage_does_not_disturb_the_mapped_clips() {
    let (doc, section_id) = placed_song();
    let mapped = apply_op(&doc, generated_separation());
    let later = apply_op(
        &mapped,
        analysis_op(
            GEN,
            "tag",
            json!([{ "kind": "tags", "genres": ["outro"], "moods": [] }]),
        ),
    );
    let before = mapped
        .arrangement
        .sections
        .iter()
        .find(|section| section.id.to_string() == section_id)
        .map(|section| serde_json::to_value(&section.lanes).unwrap())
        .unwrap();
    let after = later
        .arrangement
        .sections
        .iter()
        .find(|section| section.id.to_string() == section_id)
        .map(|section| serde_json::to_value(&section.lanes).unwrap())
        .unwrap();
    assert_eq!(before, after);
    assert!(later.meta.tags.0.iter().any(|tag| tag == "outro"));
}
