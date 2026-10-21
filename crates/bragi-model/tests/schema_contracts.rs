//! The cross-language schema contract tests (specs/12-roadmap.md WP-0.2).
//!
//! The same documents are tested in TypeScript (`packages/schemas/src/__tests__/contracts.test.ts`)
//! and Python (`services/workers/bragi_common/tests/test_schema_contracts.py`), which is the point:
//! one JSON Schema set, three sets of generated types, one behaviour.
//!
//! Proofs here:
//! 1. `fixtures/projects/example-02-10.json` — the example document in specs/02-song-model.md §10 —
//!    deserializes into `bragi_model::generated::Project`.
//! 2. JSON → typed → JSON round-trips losslessly for that document and for one example per root type.
//! 3. Every invalid document in `fixtures/projects/invalid-cases.json` is rejected in Rust when the
//!    case says Rust must reject it, and accepted when it says otherwise (see that file's `comment`:
//!    typify does not range-check numbers, so those cases are Ajv's and Pydantic's).
//! 4. `generated::ROOT_TYPES` equals the set of `packages/schemas/examples/*.json`.
//!
//! Tests may `unwrap()`, `expect()` and `panic!` (specs/13-agent-guide.md §3).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use bragi_model::generated as g;
use serde_json::Value;

/// The repository root, from this crate's manifest directory.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the repository root exists")
}

/// `packages/schemas/examples/`.
fn examples_dir() -> PathBuf {
    repo_root().join("packages/schemas/examples")
}

/// The root type names that have an example file, sorted.
fn example_names() -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for entry in fs::read_dir(examples_dir()).expect("examples/ exists") {
        let path = entry.expect("readable").path();
        if path.extension().is_some_and(|ext| ext == "json") {
            names.insert(path.file_stem().unwrap().to_string_lossy().into_owned());
        }
    }
    names
}

/// Reads and parses a JSON file.
fn read_json(path: &Path) -> Value {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// JSON equality in the sense the acceptance criterion means: objects compare key-wise with order
/// ignored, numbers compare numerically (`0` and `0.0` are equal, because `typify` turns every
/// `number` into `f64`), and a boolean is never equal to a number.
fn json_eq(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => match (a.as_f64(), b.as_f64()) {
            (Some(a), Some(b)) => a == b,
            _ => false,
        },
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| json_eq(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, v)| b.get(k).is_some_and(|w| json_eq(v, w)))
        }
        _ => left == right,
    }
}

/// Deserializes `value` as a `T` and serializes it straight back.
fn reserialize<T: serde::de::DeserializeOwned + serde::Serialize>(
    value: Value,
) -> Result<Value, String> {
    let typed: T = serde_json::from_value(value).map_err(|e| e.to_string())?;
    serde_json::to_value(typed).map_err(|e| e.to_string())
}

/// Parses `value` as the named root type and returns it as JSON again.
fn reserialize_root(name: &str, value: Value) -> Result<Value, String> {
    match name {
        "AnalysisApplyOp" => reserialize::<g::AnalysisApplyOp>(value),
        "AnalysisRef" => reserialize::<g::AnalysisRef>(value),
        "ApiError" => reserialize::<g::ApiError>(value),
        "Arrangement" => reserialize::<g::Arrangement>(value),
        "AssetMeta" => reserialize::<g::AssetMeta>(value),
        "AuthModeResponse" => reserialize::<g::AuthModeResponse>(value),
        "Automation" => reserialize::<g::Automation>(value),
        "AutomationClearOp" => reserialize::<g::AutomationClearOp>(value),
        "AutomationSetOp" => reserialize::<g::AutomationSetOp>(value),
        "Clip" => reserialize::<g::Clip>(value),
        "ClipAddOp" => reserialize::<g::ClipAddOp>(value),
        "ClipRemoveOp" => reserialize::<g::ClipRemoveOp>(value),
        "ClipReplaceOp" => reserialize::<g::ClipReplaceOp>(value),
        "ClipSplitOp" => reserialize::<g::ClipSplitOp>(value),
        "ClipUpdateOp" => reserialize::<g::ClipUpdateOp>(value),
        "Commit" => reserialize::<g::Commit>(value),
        "DescriptionResult" => reserialize::<g::DescriptionResult>(value),
        "DrumSplitResult" => reserialize::<g::DrumSplitResult>(value),
        "EmbeddingResult" => reserialize::<g::EmbeddingResult>(value),
        "FxAddOp" => reserialize::<g::FxAddOp>(value),
        "FxCatalog" => reserialize::<g::FxCatalog>(value),
        "FxInstance" => reserialize::<g::FxInstance>(value),
        "FxRemoveOp" => reserialize::<g::FxRemoveOp>(value),
        "FxReorderOp" => reserialize::<g::FxReorderOp>(value),
        "FxUpdateOp" => reserialize::<g::FxUpdateOp>(value),
        "GenerateExtendParams" => reserialize::<g::GenerateExtendParams>(value),
        "GenerateExtendResult" => reserialize::<g::GenerateExtendResult>(value),
        "HarmonyResult" => reserialize::<g::HarmonyResult>(value),
        "IngestResult" => reserialize::<g::IngestResult>(value),
        "JobEvent" => reserialize::<g::JobEvent>(value),
        "JobRequest" => reserialize::<g::JobRequest>(value),
        "KeyTransposeOp" => reserialize::<g::KeyTransposeOp>(value),
        "LoudnessEnergyResult" => reserialize::<g::LoudnessEnergyResult>(value),
        "LyricsResult" => reserialize::<g::LyricsResult>(value),
        "MacroCatalog" => reserialize::<g::MacroCatalog>(value),
        "Op" => reserialize::<g::Op>(value),
        "OpBatch" => reserialize::<g::OpBatch>(value),
        "PreviewResult" => reserialize::<g::PreviewResult>(value),
        "Project" => reserialize::<g::Project>(value),
        "ProjectSetMetaOp" => reserialize::<g::ProjectSetMetaOp>(value),
        "Refs" => reserialize::<g::Refs>(value),
        "Region" => reserialize::<g::Region>(value),
        "RegionAdoptOp" => reserialize::<g::RegionAdoptOp>(value),
        "RegionClearOp" => reserialize::<g::RegionClearOp>(value),
        "RhythmResult" => reserialize::<g::RhythmResult>(value),
        "SectionDuplicateOp" => reserialize::<g::SectionDuplicateOp>(value),
        "SectionInsertOp" => reserialize::<g::SectionInsertOp>(value),
        "SectionInstance" => reserialize::<g::SectionInstance>(value),
        "SectionMergeOp" => reserialize::<g::SectionMergeOp>(value),
        "SectionMoveOp" => reserialize::<g::SectionMoveOp>(value),
        "SectionRemoveOp" => reserialize::<g::SectionRemoveOp>(value),
        "SectionResizeOp" => reserialize::<g::SectionResizeOp>(value),
        "SectionSetTransitionOp" => reserialize::<g::SectionSetTransitionOp>(value),
        "SectionSplitOp" => reserialize::<g::SectionSplitOp>(value),
        "SectionSummary" => reserialize::<g::SectionSummary>(value),
        "SectionUpdateOp" => reserialize::<g::SectionUpdateOp>(value),
        "SeparationResult" => reserialize::<g::SeparationResult>(value),
        "Source" => reserialize::<g::Source>(value),
        "SourceAddOp" => reserialize::<g::SourceAddOp>(value),
        "StemActivityResult" => reserialize::<g::StemActivityResult>(value),
        "StemEnergyResult" => reserialize::<g::StemEnergyResult>(value),
        "StructureResult" => reserialize::<g::StructureResult>(value),
        "TagResult" => reserialize::<g::TagResult>(value),
        "TempoSetOp" => reserialize::<g::TempoSetOp>(value),
        "Track" => reserialize::<g::Track>(value),
        "TrackAddOp" => reserialize::<g::TrackAddOp>(value),
        "TrackRemoveOp" => reserialize::<g::TrackRemoveOp>(value),
        "TrackUpdateOp" => reserialize::<g::TrackUpdateOp>(value),
        "TranscribeResult" => reserialize::<g::TranscribeResult>(value),
        other => Err(format!("no Rust type registered for {other}")),
    }
}

#[test]
fn every_root_type_has_an_example_and_a_rust_type() {
    let declared: BTreeSet<String> = g::ROOT_TYPES.iter().map(|s| (*s).to_string()).collect();
    assert_eq!(declared, example_names());
    for name in &declared {
        let value = read_json(&examples_dir().join(format!("{name}.json")));
        reserialize_root(name, value)
            .unwrap_or_else(|e| panic!("{name} does not deserialize into its Rust type: {e}"));
    }
}

#[test]
fn the_spec_example_deserializes_into_project() {
    let path = repo_root().join("fixtures/projects/example-02-10.json");
    let value = read_json(&path);
    let project: g::Project = serde_json::from_value(value.clone()).expect("a valid Project");
    assert_eq!(project.id.to_string(), "prj_01JAB3QK7M9P2V6XWN0T4Y8ZB5");
    assert_eq!(project.tracks.len(), 1);
}

#[test]
fn every_example_round_trips_losslessly() {
    for name in example_names() {
        let value = read_json(&examples_dir().join(format!("{name}.json")));
        let back = reserialize_root(&name, value.clone())
            .unwrap_or_else(|e| panic!("{name} does not deserialize: {e}"));
        assert!(
            json_eq(&back, &value),
            "{name} lost or changed a value:\n input: {value}\noutput: {back}"
        );

        // Serializing the typed value twice is byte-identical.
        let once = serde_json::to_string(&back).unwrap();
        let twice = serde_json::to_string(&serde_json::from_str::<Value>(&once).unwrap()).unwrap();
        assert_eq!(
            once, twice,
            "{name} is not stable across two serializations"
        );
    }
}

#[derive(serde::Deserialize)]
struct InvalidCases {
    cases: Vec<InvalidCase>,
}

#[derive(serde::Deserialize)]
struct InvalidCase {
    name: String,
    #[serde(rename = "type")]
    type_name: String,
    why: String,
    #[serde(rename = "checkedBy")]
    checked_by: Vec<String>,
    document: Value,
}

#[test]
fn invalid_documents_are_rejected() {
    let path = repo_root().join("fixtures/projects/invalid-cases.json");
    let cases: InvalidCases = serde_json::from_value(read_json(&path)).expect("a cases file");
    assert!(cases.cases.len() >= 10, "too few invalid cases");
    for case in cases.cases {
        let result = reserialize_root(&case.type_name, case.document);
        if case.checked_by.iter().any(|language| language == "rust") {
            assert!(
                result.is_err(),
                "{} should be rejected: {}",
                case.name,
                case.why
            );
        } else {
            assert!(
                result.is_ok(),
                "{} is expected to be accepted: {}",
                case.name,
                case.why
            );
        }
    }
}
