//! Canonical JSON and content-addressed IDs.
//!
//! [`canonical_json`] is the stable byte representation used for hashing
//! (`specs/02-song-model.md` §8). Unlike `serde_json::to_string`, it is independent of the
//! iteration order of the generated `HashMap` fields and of whether a number was written as `0`
//! or `0.0` (Q15 in `specs/15-open-questions.md`), so two logically equal documents always hash
//! the same.
//!
//! [`commit_id`] is the identifier in 02 §2.1: `cmt_` followed by the first 26 characters of the
//! base32 (RFC 4648) SHA-256 of the canonical JSON of `(parents, batch, snapshotHash)`.

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::generated::{AssetHash, CommitId, OpBatch, Project};

/// RFC 4648 base32, upper case, without padding.
const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// How many characters of the base32 digest an ID keeps.
const ID_CHARS: usize = 26;

/// Encodes `data` as lower-case-free RFC 4648 base32 without padding.
///
/// ```
/// assert_eq!(bragi_model::base32(b"foobar"), "MZXW6YTBOI");
/// ```
#[must_use]
pub fn base32(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(5) * 8);
    let mut accumulator: u32 = 0;
    let mut bits: u32 = 0;
    for byte in data {
        accumulator = (accumulator << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(char::from(BASE32[((accumulator >> bits) & 0x1f) as usize]));
        }
        accumulator &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(char::from(
            BASE32[((accumulator << (5 - bits)) & 0x1f) as usize],
        ));
    }
    out
}

/// SHA-256 of `bytes`.
#[must_use]
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

/// The canonical JSON of an already-parsed value: sorted keys, no whitespace, normalised numbers.
///
/// ```
/// let value = serde_json::json!({ "b": 1, "a": 0.0 });
/// assert_eq!(bragi_model::canonical_value(&value), r#"{"a":0,"b":1}"#);
/// ```
#[must_use]
pub fn canonical_value(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

/// The canonical JSON of a document — the bytes the commit hash is taken over.
///
/// ```
/// # use bragi_model::generated::Project;
/// # let doc: Project = serde_json::from_value(serde_json::json!({
/// #     "schemaVersion": 1, "id": "prj_01",
/// #     "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
/// #     "sources": [], "analyses": {},
/// #     "tracks": [{ "id": "trk_01", "name": "Mix", "role": "full_mix", "color": "#8A8F98",
/// #                  "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": [] }],
/// #     "arrangement": { "timebase": { "ppq": 960,
/// #         "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }],
/// #         "timeSignatures": [{ "bar": 0, "numerator": 4, "denominator": 4 }] },
/// #         "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } }
/// # })).unwrap();
/// let json = bragi_model::canonical_json(&doc);
/// assert!(json.starts_with(r#"{"analyses":{},"arrangement":"#));
/// assert!(!json.contains('\n'));
/// // Two calls are byte-identical.
/// assert_eq!(json, bragi_model::canonical_json(&doc));
/// ```
#[must_use]
pub fn canonical_json(doc: &Project) -> String {
    // Serialising a `Project` cannot fail: it has no non-string map keys and no fallible values.
    let value = serde_json::to_value(doc).unwrap_or(Value::Null);
    canonical_value(&value)
}

/// The commit identifier: `cmt_` + 26 chars of the base32 SHA-256 of the canonical JSON of
/// `(parents, batch, snapshotHash)` (`specs/02-song-model.md` §2.1).
///
/// ```
/// # use bragi_model::generated::{BatchId, OpBatch};
/// # let batch: OpBatch = serde_json::from_value(serde_json::json!({
/// #     "id": "bat_01", "label": "L", "createdAt": "2026-10-18T12:00:00Z",
/// #     "author": { "kind": "user" }, "ops": [] })).unwrap();
/// let snapshot: bragi_model::generated::AssetHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000".parse().unwrap();
/// let id = bragi_model::commit_id(&[], &batch, &snapshot);
/// assert!(id.to_string().starts_with("cmt_"));
/// assert_eq!(id.to_string().len(), 4 + 26);
/// ```
#[must_use]
pub fn commit_id(parents: &[CommitId], batch: &OpBatch, snapshot: &AssetHash) -> CommitId {
    let mut map = serde_json::Map::new();
    map.insert(
        "parents".to_string(),
        Value::Array(
            parents
                .iter()
                .map(|parent| Value::String(parent.to_string()))
                .collect(),
        ),
    );
    map.insert(
        "batch".to_string(),
        serde_json::to_value(batch).unwrap_or(Value::Null),
    );
    map.insert(
        "snapshotHash".to_string(),
        Value::String(snapshot.to_string()),
    );
    let digest = sha256(canonical_value(&Value::Object(map)).as_bytes());
    // The string is `cmt_` + 26 RFC 4648 base32 characters, which always matches `^cmt_[0-9A-Za-z]{1,64}$`.
    #[allow(clippy::expect_used)]
    format!("cmt_{}", &base32(&digest)[..ID_CHARS])
        .parse()
        .expect("a valid commit id")
}

/// A deterministic derived ID for content copied by `section.duplicate`/`section.split`, where the
/// op names the new section but not the IDs of the clips it copies (Q14).
///
/// The ID is `prefix` + 26 chars of the base32 SHA-256 of `"derive:{parent}:{original}"`, which is
/// always a valid `clp_`/`fx_` ID and is unique as long as the new parent is unique.
///
/// ```
/// let a = bragi_model::derived_id("clp_", "sec_new", "clp_old");
/// let b = bragi_model::derived_id("clp_", "sec_new", "clp_old");
/// assert_eq!(a, b);
/// assert!(a.starts_with("clp_"));
/// assert_ne!(a, bragi_model::derived_id("clp_", "sec_other", "clp_old"));
/// ```
#[must_use]
pub fn derived_id(prefix: &str, parent: &str, original: &str) -> String {
    let digest = sha256(format!("derive:{parent}:{original}").as_bytes());
    format!("{prefix}{}", &base32(&digest)[..ID_CHARS])
}

/// Writes `value` into `out` in canonical form.
fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => write_number(number, out),
        Value::String(text) => push_json_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                push_json_string(key, out);
                out.push(':');
                write_canonical(&map[*key], out);
            }
            out.push('}');
        }
    }
}

/// Writes a number with an integral `f64` written without a fractional part.
fn write_number(number: &serde_json::Number, out: &mut String) {
    if let Some(int) = number.as_i64() {
        out.push_str(&int.to_string());
    } else if let Some(uint) = number.as_u64() {
        out.push_str(&uint.to_string());
    } else if let Some(float) = number.as_f64() {
        // 2^53; below it every integral `f64` is exact and prints without a fractional part.
        if float.fract() == 0.0 && float.abs() <= 9_007_199_254_740_992.0 {
            out.push_str(&(float as i64).to_string());
        } else {
            out.push_str(&float.to_string());
        }
    }
}

/// Appends `text` as a JSON string literal.
fn push_json_string(text: &str, out: &mut String) {
    match serde_json::to_string(text) {
        Ok(quoted) => out.push_str(&quoted),
        Err(_) => out.push_str("\"\""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_matches_rfc4648_vectors() {
        assert_eq!(base32(b""), "");
        assert_eq!(base32(b"f"), "MY");
        assert_eq!(base32(b"fo"), "MZXQ");
        assert_eq!(base32(b"foo"), "MZXW6");
        assert_eq!(base32(b"foob"), "MZXW6YQ");
        assert_eq!(base32(b"fooba"), "MZXW6YTB");
        assert_eq!(base32(b"foobar"), "MZXW6YTBOI");
    }

    #[test]
    fn sha256_matches_a_known_digest() {
        let digest = sha256(b"abc");
        assert_eq!(
            digest[..4],
            [0xba, 0x78, 0x16, 0xbf],
            "SHA-256(\"abc\") starts with ba7816bf"
        );
    }

    #[test]
    fn canonical_normalises_numbers_and_sorts_keys() {
        let value = serde_json::json!({ "z": [1, 2.5], "a": 0.0, "b": -0.0 });
        assert_eq!(canonical_value(&value), r#"{"a":0,"b":0,"z":[1,2.5]}"#);
    }
}
