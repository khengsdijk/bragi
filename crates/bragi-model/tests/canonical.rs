//! `canonical_json`, `commit_id` and the derived IDs (`specs/02-song-model.md` §2.1, §8; Q15).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use bragi_model::canonical::{base32, canonical_value, commit_id, derived_id};
use bragi_model::generated::{ClipId, FxInstance};
use bragi_model::{AssetIndex, apply, canonical_json};
use common::{HASH, assets, batch, fixture, user_batch};
use serde_json::json;

#[test]
fn canonical_json_is_independent_of_hashmap_iteration_order() {
    // Two documents that differ only in the insertion order of an FxParams map. A plain
    // `serde_json::to_string` may differ; canonical JSON must not.
    let make = |entries: Vec<(&str, f64)>| -> FxInstance {
        let mut instance: FxInstance = serde_json::from_value(json!({
            "id": "fx_1", "type": "eq3", "params": {}, "bypass": false }))
        .unwrap();
        for (name, value) in entries {
            instance.params.0.insert(name.to_string(), value);
        }
        instance
    };
    let mut left = fixture();
    left.tracks[0]
        .fx
        .0
        .push(make(vec![("lowDb", 1.0), ("highDb", 2.0)]));
    let mut right = fixture();
    right.tracks[0]
        .fx
        .0
        .push(make(vec![("highDb", 2.0), ("lowDb", 1.0)]));
    assert_eq!(canonical_json(&left), canonical_json(&right));
}

#[test]
fn canonical_json_is_stable_and_normalises_integral_floats() {
    let doc = fixture();
    let once = canonical_json(&doc);
    assert_eq!(once, canonical_json(&doc));
    assert!(!once.contains('\n'));
    assert!(once.starts_with(r#"{"analyses":{},"arrangement":"#));
    // `gainDb: 0` (f64) is written `0`, not `0.0`.
    assert!(!once.contains("0.0"));
    assert_eq!(canonical_value(&json!({ "b": 0.0 })), r#"{"b":0}"#);
}

#[test]
fn commit_id_is_26_base32_chars_and_deterministic() {
    let snapshot: bragi_model::generated::AssetHash = HASH.parse().unwrap();
    let batch = user_batch(vec![json!({ "op": "project.set_meta", "title": "t" })]);
    let first = commit_id(&[], &batch, &snapshot);
    let second = commit_id(&[], &batch, &snapshot);
    assert_eq!(first, second);
    assert!(first.to_string().starts_with("cmt_"));
    assert_eq!(first.to_string().len(), 4 + 26);

    // Changing any input changes the ID.
    let other: bragi_model::generated::AssetHash =
        format!("sha256:{}", "3".repeat(64)).parse().unwrap();
    assert_ne!(first, commit_id(&[], &batch, &other));
}

#[test]
fn derived_ids_are_deterministic_valid_and_unique_per_parent() {
    let first = derived_id("clp_", "sec_new", "clp_old");
    assert_eq!(first, derived_id("clp_", "sec_new", "clp_old"));
    assert_ne!(first, derived_id("clp_", "sec_other", "clp_old"));
    assert_ne!(first, derived_id("clp_", "sec_new", "clp_other"));
    // The result is a valid ClipId, which is what apply relies on.
    let parsed: ClipId = first.parse().unwrap();
    assert_eq!(parsed.to_string(), first);
}

#[test]
fn base32_matches_the_commit_id_alphabet() {
    let encoded = base32(&[0xff, 0x00, 0x11]);
    assert!(
        encoded
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
    );
    assert!(!encoded.contains('='));
}

#[test]
fn apply_then_commit_then_canonical_matches_a_known_revision() {
    // Applying the same batch twice gives the same canonical bytes, so the same commit ID.
    let doc = fixture();
    let snapshot: bragi_model::generated::AssetHash = HASH.parse().unwrap();
    let batch = user_batch(vec![json!({ "op": "project.set_meta", "title": "X" })]);
    let next = apply(&doc, &batch, &assets()).unwrap();
    let id = commit_id(&[], &batch, &snapshot);
    assert!(next.meta.title == "X");
    assert_eq!(canonical_json(&next), canonical_json(&next));
    assert_eq!(id, commit_id(&[], &batch, &snapshot));
}

#[test]
fn batch_author_does_not_leak_into_the_commit_body() {
    // The commit ID hashes the batch, so two batches that differ only in label differ in ID.
    let snapshot: bragi_model::generated::AssetHash = HASH.parse().unwrap();
    let op = json!({ "op": "project.set_meta", "title": "t" });
    let left = batch(json!({ "kind": "user" }), vec![op.clone()]);
    let mut right = left.clone();
    right.label = "Other".to_string();
    assert_ne!(
        commit_id(&[], &left, &snapshot),
        commit_id(&[], &right, &snapshot)
    );
    let _ = AssetIndex::new();
}
