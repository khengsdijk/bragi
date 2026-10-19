//! Property-based fuzzing (`specs/12-roadmap.md` WP-0.3, acceptance criterion 2).
//!
//! For random valid documents and random batches, `apply` must never panic, and whenever it
//! succeeds the result must re-validate. That is exactly the promise of a *validated* input: the
//! model is total, and the invariants hold after every batch.
//!
//! The number of cases defaults to 10 000 (the acceptance criterion) and can be dialled down while
//! iterating:
//!
//! ```text
//! BRAGI_FUZZ_CASES=100 cargo test -p bragi-model --test fuzz
//! ```
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::collections::HashMap;

use bragi_model::generated::{CommitId, Project, TrackId};
use bragi_model::{apply_with, canonical_json, section_spans, validate};
use common::{assets, build_project, user_batch};
use proptest::prelude::*;
use serde_json::{Value, json};

/// The commit ID every fuzz `region.adopt` points at.
const COMMIT: &str = "cmt_01JAB3QK7M9P2V6XWN0T4Y8ZB5";

/// The fuzz iteration count: 10 000 unless `BRAGI_FUZZ_CASES` says otherwise.
fn cases() -> u32 {
    std::env::var("BRAGI_FUZZ_CASES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(10_000)
}

/// Builds a batch of ops that reference the documents's real IDs.
///
/// Half the ops are "should always apply" edits; the rest are the tricky reshape ops, which may
/// legitimately fail (for example a split outside a clip). Both are interesting: one must keep the
/// document valid, the other must fail cleanly instead of panicking.
fn build_ops(doc: &Project, seed: u64, count: usize) -> Vec<Value> {
    let sections = doc.arrangement.sections.len();
    let tracks = doc.tracks.len();
    let mut ops = Vec::with_capacity(count);
    for index in 0..count {
        let bits = seed.rotate_left((index as u32 * 7) % 63);
        let choice = bits % 13;
        let section = (bits >> 8) as usize % sections;
        let track = (bits >> 20) as usize % tracks;
        let section_id = format!("sec_{section}");
        let track_id: TrackId = format!("trk_{track}").parse().unwrap();
        let length = doc.arrangement.sections[section].length_ticks.get();
        let clip = doc.arrangement.sections[section]
            .lanes
            .0
            .get(&track_id)
            .and_then(|lane| lane.clips.first())
            .map(|clip| (clip.id.to_string(), clip.start));
        let op = match choice {
            0 => json!({ "op": "project.set_meta", "title": format!("T{index}") }),
            1 => json!({ "op": "track.update", "trackId": track_id,
                "patch": { "gainDb": ((bits >> 28) % 20) as f64 - 10.0 } }),
            2 => json!({ "op": "section.update", "sectionId": section_id,
                "patch": { "label": format!("L{index}") } }),
            3 => match &clip {
                Some((clip_id, _)) => json!({ "op": "clip.update", "clipId": clip_id,
                    "patch": { "gainDb": -3.0 } }),
                None => continue,
            },
            4 => json!({ "op": "automation.set", "scope": { "kind": "master" },
                "target": "master:gainDb",
                "points": [ { "tick": (bits >> 28) % 6000, "value": 0.5, "curve": "step" } ] }),
            5 => json!({ "op": "tempo.set", "tempoMap": [
                { "tick": 0, "bpm": 60.0 + ((bits >> 28) % 80) as f64, "curve": "step" } ] }),
            6 => json!({ "op": "fx.add", "scope": { "kind": "track", "trackId": track_id },
                "fx": { "id": format!("fx_{index}"), "type": "gain",
                        "params": { "db": -2.0 }, "bypass": false } }),
            7 => json!({ "op": "section.move", "sectionId": section_id,
                "toIndex": ((bits >> 28) as usize % sections) as u64 }),
            8 => json!({ "op": "section.duplicate", "sectionId": section_id,
                "toIndex": sections as u64, "newId": format!("sec_d{index}") }),
            9 => json!({ "op": "section.split", "sectionId": section_id,
                "atTick": (length / 2).max(1), "newId": format!("sec_sp{index}") }),
            10 => match &clip {
                Some((clip_id, start)) => json!({ "op": "clip.split", "clipId": clip_id,
                    "atTick": start + 960, "newId": format!("clp_sp{index}") }),
                None => continue,
            },
            11 => json!({ "op": "region.clear", "region": {
                "startTick": (bits >> 28) % 6000, "endTick": ((bits >> 28) % 6000) + 500,
                "tracks": "all" } }),
            // Adopt from the source document the test supplied for this run. The structure of
            // that document may differ, which is the interesting part.
            _ => json!({ "op": "region.adopt", "fromCommit": COMMIT, "region": {
                "startTick": (bits >> 28) % 6000, "endTick": ((bits >> 28) % 6000) + 500,
                "tracks": "all" } }),
        };
        ops.push(op);
    }
    ops
}

proptest! {
    #![proptest_config(ProptestConfig { cases: cases(), ..ProptestConfig::default() })]

    #[test]
    fn random_batches_never_produce_invalid_documents(
        tracks in 1usize..4,
        sections in 1usize..4,
        source_tracks in 1usize..4,
        source_sections in 1usize..4,
        doc_seed in any::<u64>(),
        ops_seed in any::<u64>(),
        source_seed in any::<u64>(),
        count in 0usize..8,
    ) {
        let doc = build_project(tracks, sections, doc_seed);
        let assets = assets();
        prop_assert!(validate(&doc, &assets).is_ok(), "the generated document is valid");

        // An earlier document of the run: the source of every `region.adopt` in the batch. Its
        // track and section structure may differ from the target's.
        let source = build_project(source_tracks, source_sections, source_seed);
        prop_assert!(validate(&source, &assets).is_ok(), "the source document is valid");
        let commit: CommitId = COMMIT.parse().unwrap();
        let commits = HashMap::from([(commit, source)]);

        let batch = user_batch(build_ops(&doc, ops_seed, count));
        match apply_with(&doc, &batch, &assets, &commits) {
            Ok(next) => {
                prop_assert!(
                    validate(&next, &assets).is_ok(),
                    "apply produced an invalid document"
                );
                // The query paths must not panic on the result either.
                let _ = section_spans(&next);
                prop_assert!(!canonical_json(&next).is_empty());
            }
            Err(_) => {
                // A rejected batch is atomic: the input document is untouched.
                prop_assert!(validate(&doc, &assets).is_ok());
            }
        }
    }
}
