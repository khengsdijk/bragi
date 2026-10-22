//! `wasm-bindgen` bindings for [`bragi_model`]: the handle-based API the UI calls
//! (`specs/02-song-model.md` §8).
//!
//! Documents cross the WASM boundary as JSON strings and are then held in a thread-local slab;
//! later calls pass the integer handle, so the hot paths ([`section_spans`], [`ticks_to_seconds`])
//! never re-serialise the document.
//!
//! The generated npm package (`packages/model-wasm`) is produced by
//! `wasm-bindgen --target web` over this crate; it is generated output and is never hand-edited
//! (`specs/13-agent-guide.md` §1).
#![allow(missing_docs)] // the wasm-bindgen glue is not part of the documented public API.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use bragi_model::SummaryFocus;
use bragi_model::generated::{AssetHash, AssetMeta, CommitId, OpBatch, Project, Region};
use bragi_model::placement::{
    ExtendPlacementRequest, FillPlacementRequest, TransitionPlacementRequest,
};
use bragi_model::{
    AssetIndex, changed_spans as model_changed_spans, diff as model_diff,
    section_spans as model_spans,
};
use bragi_model::{
    ContextEdge, apply as model_apply, apply_with as model_apply_with,
    bar_aligned_context_range as model_context_range, canonical_json as model_canonical_json,
    commit_id as model_commit_id, extend_placement as model_extend_placement,
    fill_placement as model_fill_placement, resolve_region as model_resolve_region,
    seconds_to_ticks as model_seconds_to_ticks, summarize_for_llm as model_summarize,
    ticks_to_seconds as model_ticks_to_seconds, transition_placement as model_transition_placement,
    validate as model_validate,
};
use wasm_bindgen::prelude::*;

/// A loaded document and the asset metadata that travels with it.
struct LoadedDoc {
    project: Project,
    assets: AssetIndex,
}

thread_local! {
    static DOCS: RefCell<HashMap<u32, LoadedDoc>> = RefCell::new(HashMap::new());
    static NEXT_HANDLE: Cell<u32> = const { Cell::new(1) };
}

/// Loads a project document (JSON) and returns its handle.
///
/// The caller owns the handle and must call [`free_doc`]. The asset index starts empty and is
/// filled with [`asset_add`].
#[wasm_bindgen(js_name = loadProject)]
pub fn load_project(json: &str) -> Result<u32, String> {
    let project: Project = serde_json::from_str(json).map_err(|error| error.to_string())?;
    let handle = NEXT_HANDLE.with(|next| {
        let handle = next.get();
        next.set(handle.wrapping_add(1).max(1));
        handle
    });
    DOCS.with(|docs| {
        docs.borrow_mut().insert(
            handle,
            LoadedDoc {
                project,
                assets: AssetIndex::new(),
            },
        );
    });
    Ok(handle)
}

/// Drops a handle. Returns whether it existed.
#[wasm_bindgen(js_name = freeDoc)]
pub fn free_doc(handle: u32) -> bool {
    DOCS.with(|docs| docs.borrow_mut().remove(&handle).is_some())
}

/// How many documents are currently loaded (used by the tests to prove `freeDoc` works).
#[wasm_bindgen(js_name = docCount)]
pub fn doc_count() -> usize {
    DOCS.with(|docs| docs.borrow().len())
}

/// Adds asset metadata (a JSON array of `AssetMeta`) to a handle's index.
#[wasm_bindgen(js_name = assetAdd)]
pub fn asset_add(handle: u32, assets_json: &str) -> Result<(), String> {
    let metas: Vec<AssetMeta> =
        serde_json::from_str(assets_json).map_err(|error| error.to_string())?;
    DOCS.with(|docs| {
        let mut docs = docs.borrow_mut();
        let doc = docs
            .get_mut(&handle)
            .ok_or_else(|| format!("unknown handle {handle}"))?;
        for meta in metas {
            doc.assets.insert(meta);
        }
        Ok(())
    })
}

/// Validates the handle's document; returns `null` when valid, else a JSON error array.
#[wasm_bindgen(js_name = validateDoc)]
pub fn validate_doc(handle: u32) -> Result<Option<String>, String> {
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let doc = docs
            .get(&handle)
            .ok_or_else(|| format!("unknown handle {handle}"))?;
        match model_validate(&doc.project, &doc.assets) {
            Ok(()) => Ok(None),
            Err(errors) => Ok(Some(
                serde_json::to_string(&errors).map_err(|error| error.to_string())?,
            )),
        }
    })
}

/// Applies an op batch to the handle's document and returns the new document JSON.
///
/// The stored document is replaced on success. On failure the stored document is unchanged and the
/// error is the JSON array of `{ opIndex, code, message }`.
#[wasm_bindgen(js_name = applyBatch)]
pub fn apply_batch(handle: u32, batch_json: &str) -> Result<String, String> {
    let batch: OpBatch = serde_json::from_str(batch_json).map_err(|error| error.to_string())?;
    DOCS.with(|docs| {
        let mut docs = docs.borrow_mut();
        let doc = docs
            .get_mut(&handle)
            .ok_or_else(|| format!("unknown handle {handle}"))?;
        let next = model_apply(&doc.project, &batch, &doc.assets).map_err(|error| {
            serde_json::to_string(&error.errors()).unwrap_or_else(|_| error.to_string())
        })?;
        doc.project = next;
        serde_json::to_string(&doc.project).map_err(|error| error.to_string())
    })
}

/// Applies an op batch that may read other commits to the handle's document and returns the new
/// document JSON.
///
/// `commit_handles_json` is a JSON object `{ "cmt_…": <document handle> }`; the commit's document is
/// cloned out of the cache before the target handle is updated, so a commit may be the target's own
/// handle. The stored document is replaced on success, exactly like [`apply_batch`]; on failure it
/// is unchanged and the error is the JSON array of `{ opIndex, code, message }`.
#[wasm_bindgen(js_name = applyBatchWith)]
pub fn apply_batch_with(
    handle: u32,
    batch_json: &str,
    commit_handles_json: &str,
) -> Result<String, String> {
    let batch: OpBatch = serde_json::from_str(batch_json).map_err(|error| error.to_string())?;
    let handles: HashMap<String, u32> =
        serde_json::from_str(commit_handles_json).map_err(|error| error.to_string())?;
    let commits =
        DOCS.with(|docs| {
            let docs = docs.borrow();
            let mut commits: HashMap<CommitId, Project> = HashMap::with_capacity(handles.len());
            for (id, commit_handle) in &handles {
                let commit: CommitId = id.parse().map_err(
                    |error: bragi_model::generated::error::ConversionError| error.to_string(),
                )?;
                let doc = docs
                    .get(commit_handle)
                    .ok_or_else(|| format!("unknown handle {commit_handle}"))?;
                commits.insert(commit, doc.project.clone());
            }
            Ok::<_, String>(commits)
        })?;
    DOCS.with(|docs| {
        let mut docs = docs.borrow_mut();
        let doc = docs
            .get_mut(&handle)
            .ok_or_else(|| format!("unknown handle {handle}"))?;
        let next =
            model_apply_with(&doc.project, &batch, &doc.assets, &commits).map_err(|error| {
                serde_json::to_string(&error.errors()).unwrap_or_else(|_| error.to_string())
            })?;
        doc.project = next;
        serde_json::to_string(&doc.project).map_err(|error| error.to_string())
    })
}

/// The handle's document as JSON.
#[wasm_bindgen(js_name = documentJson)]
pub fn document_json(handle: u32) -> Result<String, String> {
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let doc = docs
            .get(&handle)
            .ok_or_else(|| format!("unknown handle {handle}"))?;
        serde_json::to_string(&doc.project).map_err(|error| error.to_string())
    })
}

/// The canonical JSON of the handle's document.
#[wasm_bindgen(js_name = canonicalJson)]
pub fn canonical_json(handle: u32) -> Result<String, String> {
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let doc = docs
            .get(&handle)
            .ok_or_else(|| format!("unknown handle {handle}"))?;
        Ok(model_canonical_json(&doc.project))
    })
}

/// Builds the op batch that places one accepted extend candidate (09 §4.2).
///
/// The request is JSON (`ExtendPlacementRequest`); the batch is JSON (`OpBatch`). The handle's
/// document is not changed: the caller commits the batch, so placement is undoable (02 §7).
#[wasm_bindgen(js_name = extendPlacement)]
pub fn extend_placement(handle: u32, request_json: &str) -> Result<String, String> {
    let request: ExtendPlacementRequest =
        serde_json::from_str(request_json).map_err(|error| error.to_string())?;
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let doc = docs
            .get(&handle)
            .ok_or_else(|| format!("unknown handle {handle}"))?;
        let batch =
            model_extend_placement(&doc.project, &request).map_err(|error| error.to_string())?;
        serde_json::to_string(&batch).map_err(|error| error.to_string())
    })
}

/// Builds the op batch that fills an erased gap with a generated candidate (09 §4.3).
///
/// The request is JSON (`FillPlacementRequest`); the batch is JSON (`OpBatch`). The handle's
/// document is not changed: the caller commits the batch, so placement is undoable (02 §7).
#[wasm_bindgen(js_name = fillPlacement)]
pub fn fill_placement(handle: u32, request_json: &str) -> Result<String, String> {
    let request: FillPlacementRequest =
        serde_json::from_str(request_json).map_err(|error| error.to_string())?;
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let doc = docs
            .get(&handle)
            .ok_or_else(|| format!("unknown handle {handle}"))?;
        let batch =
            model_fill_placement(&doc.project, &request).map_err(|error| error.to_string())?;
        serde_json::to_string(&batch).map_err(|error| error.to_string())
    })
}

/// Builds the op batch that gives a section a generated transition (09 §4.4).
///
/// The request is JSON (`TransitionPlacementRequest`); the batch is JSON (`OpBatch`). The handle's
/// document is not changed: the caller commits the batch, so the transition is undoable (02 §7).
#[wasm_bindgen(js_name = transitionPlacement)]
pub fn transition_placement(handle: u32, request_json: &str) -> Result<String, String> {
    let request: TransitionPlacementRequest =
        serde_json::from_str(request_json).map_err(|error| error.to_string())?;
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let doc = docs
            .get(&handle)
            .ok_or_else(|| format!("unknown handle {handle}"))?;
        let batch = model_transition_placement(&doc.project, &request)
            .map_err(|error| error.to_string())?;
        serde_json::to_string(&batch).map_err(|error| error.to_string())
    })
}

/// A bar-aligned context range of about `seconds` seconds at one song edge, as JSON
/// (`{ startTick, endTick }`).
///
/// `edge` is `"start"` (an intro) or `"end"` (a continuation). Generation always speaks bars, so
/// the UI asks the model for the bar lines instead of doing the arithmetic in TypeScript
/// (`specs/03-audio-engine.md` §9, `specs/09-generation.md` §4.2).
#[wasm_bindgen(js_name = barAlignedContextRange)]
pub fn bar_aligned_context_range(handle: u32, edge: &str, seconds: f64) -> Result<String, String> {
    let edge = match edge {
        "start" => ContextEdge::Start,
        "end" => ContextEdge::End,
        other => return Err(format!("unknown context edge {other:?}")),
    };
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let doc = docs
            .get(&handle)
            .ok_or_else(|| format!("unknown handle {handle}"))?;
        let range = model_context_range(&doc.project, edge, seconds);
        serde_json::to_string(&range).map_err(|error| error.to_string())
    })
}

/// The absolute span of every section, as JSON.
#[wasm_bindgen(js_name = sectionSpans)]
pub fn section_spans(handle: u32) -> Result<String, String> {
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let doc = docs
            .get(&handle)
            .ok_or_else(|| format!("unknown handle {handle}"))?;
        serde_json::to_string(&model_spans(&doc.project)).map_err(|error| error.to_string())
    })
}

/// Seconds elapsed at `ticks`, using the handle's tempo map.
#[wasm_bindgen(js_name = ticksToSeconds)]
pub fn ticks_to_seconds(handle: u32, ticks: i64) -> Result<f64, String> {
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let doc = docs
            .get(&handle)
            .ok_or_else(|| format!("unknown handle {handle}"))?;
        Ok(model_ticks_to_seconds(&doc.project, ticks))
    })
}

/// The tick at which `seconds` has elapsed, using the handle's tempo map.
#[wasm_bindgen(js_name = secondsToTicks)]
pub fn seconds_to_ticks(handle: u32, seconds: f64) -> Result<i64, String> {
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let doc = docs
            .get(&handle)
            .ok_or_else(|| format!("unknown handle {handle}"))?;
        Ok(model_seconds_to_ticks(&doc.project, seconds))
    })
}

/// Resolves a region (JSON) into section- and track-aligned slices, as JSON.
#[wasm_bindgen(js_name = resolveRegion)]
pub fn resolve_region(handle: u32, region_json: &str) -> Result<String, String> {
    let region: Region = serde_json::from_str(region_json).map_err(|error| error.to_string())?;
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let doc = docs
            .get(&handle)
            .ok_or_else(|| format!("unknown handle {handle}"))?;
        serde_json::to_string(&model_resolve_region(&doc.project, &region, &doc.assets))
            .map_err(|error| error.to_string())
    })
}

/// The engine delta between two loaded documents, as JSON.
#[wasm_bindgen(js_name = diffDocs)]
pub fn diff_docs(prev: u32, next: u32) -> Result<String, String> {
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let prev = docs
            .get(&prev)
            .ok_or_else(|| format!("unknown handle {prev}"))?;
        let next = docs
            .get(&next)
            .ok_or_else(|| format!("unknown handle {next}"))?;
        serde_json::to_string(&model_diff(&prev.project, &next.project))
            .map_err(|error| error.to_string())
    })
}

/// The tick-accurate changed spans between two loaded documents, as JSON
/// (`specs/06-ai-planner.md` §7).
///
/// The two documents must have the same section set, order and lengths; a different set is
/// reported section-wide per track. The asset indexes of both handles are merged, because a
/// document that added a clip may know an asset the other does not.
#[wasm_bindgen(js_name = changedSpans)]
pub fn changed_spans(prev: u32, next: u32) -> Result<String, String> {
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let prev = docs
            .get(&prev)
            .ok_or_else(|| format!("unknown handle {prev}"))?;
        let next = docs
            .get(&next)
            .ok_or_else(|| format!("unknown handle {next}"))?;
        let assets = AssetIndex::from_metas(
            prev.assets
                .iter()
                .chain(next.assets.iter())
                .map(|(_, meta)| meta.clone()),
        );
        serde_json::to_string(&model_changed_spans(&prev.project, &next.project, &assets))
            .map_err(|error| error.to_string())
    })
}

/// The compact LLM context for the handle's document (`specs/06-ai-planner.md` §2).
///
/// `focus_json` is a `SummaryFocus` (`{}` or an empty string means the whole song); the result is
/// the line-oriented data block the planner puts in its prompt. A stale focus ID is reported as the
/// same JSON array of `{ opIndex, code, message }` the op API uses.
#[wasm_bindgen(js_name = summarizeForLlm)]
pub fn summarize_for_llm(handle: u32, focus_json: &str) -> Result<String, String> {
    let focus: SummaryFocus = if focus_json.trim().is_empty() {
        SummaryFocus::default()
    } else {
        serde_json::from_str(focus_json).map_err(|error| error.to_string())?
    };
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let doc = docs
            .get(&handle)
            .ok_or_else(|| format!("unknown handle {handle}"))?;
        model_summarize(&doc.project, &focus).map_err(|error| {
            serde_json::to_string(&error.errors()).unwrap_or_else(|_| error.to_string())
        })
    })
}

/// The commit ID for `(parents, batch, snapshotHash)`, all as JSON/strings.
#[wasm_bindgen(js_name = commitId)]
pub fn commit_id(
    parents_json: &str,
    batch_json: &str,
    snapshot_hash: &str,
) -> Result<String, String> {
    let parents: Vec<CommitId> =
        serde_json::from_str(parents_json).map_err(|error| error.to_string())?;
    let batch: OpBatch = serde_json::from_str(batch_json).map_err(|error| error.to_string())?;
    let snapshot: AssetHash = snapshot_hash
        .parse()
        .map_err(|error: bragi_model::generated::error::ConversionError| error.to_string())?;
    Ok(model_commit_id(&parents, &batch, &snapshot).to_string())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn project_json() -> String {
        serde_json::json!({
            "schemaVersion": 1, "id": "prj_01",
            "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
            "sources": [], "analyses": {},
            "tracks": [{ "id": "trk_01", "name": "Mix", "role": "full_mix", "color": "#8A8F98",
                         "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": [] }],
            "arrangement": { "timebase": { "ppq": 960,
                "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }],
                "timeSignatures": [{ "bar": 0, "numerator": 4, "denominator": 4 }] },
                "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } }
        })
        .to_string()
    }

    #[test]
    fn handles_load_apply_and_free() {
        let handle = load_project(&project_json()).unwrap();
        assert!(validate_doc(handle).unwrap().is_none());
        let batch = serde_json::json!({
            "id": "bat_01", "label": "L", "createdAt": "2026-10-18T12:00:00Z",
            "author": { "kind": "user" },
            "ops": [{ "op": "project.set_meta", "title": "Renamed" }] })
        .to_string();
        let next = apply_batch(handle, &batch).unwrap();
        assert!(next.contains("Renamed"));
        let summary = summarize_for_llm(handle, "{}").unwrap();
        assert!(summary.starts_with("SONG: \"Renamed\""));
        assert!(summary.contains("FOCUS: whole song"));
        assert_eq!(ticks_to_seconds(handle, 960).unwrap(), 0.5);
        assert_eq!(seconds_to_ticks(handle, 0.5).unwrap(), 960);
        assert!(free_doc(handle));
        assert!(!free_doc(handle));
        assert_eq!(doc_count(), 0);
    }

    /// A one-section document with one clip whose gain distinguishes the source from the target.
    fn clip_project_json(gain_db: f64) -> String {
        serde_json::json!({
            "schemaVersion": 1, "id": "prj_01",
            "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
            "sources": [], "analyses": {},
            "tracks": [{ "id": "trk_01", "name": "Mix", "role": "full_mix", "color": "#8A8F98",
                         "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": [] }],
            "arrangement": { "timebase": { "ppq": 960,
                "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }],
                "timeSignatures": [{ "bar": 0, "numerator": 4, "denominator": 4 }] },
                "sections": [{ "id": "sec_01", "kind": "verse", "label": "S", "lengthTicks": 3840,
                    "lanes": { "trk_01": { "clips": [{
                        "id": "clp_01", "asset": HASH, "srcStart": 0, "srcEnd": 48000, "start": 0,
                        "warp": { "mode": "beatgrid", "anchors": [
                            { "srcSample": 0, "tick": 0 }, { "srcSample": 48000, "tick": 1920 } ] },
                        "gainDb": gain_db, "pitchSemitones": 0, "fadeInTicks": 0, "fadeOutTicks": 0,
                        "fadeCurve": "equal_power",
                        "provenance": { "kind": "user", "createdAt": "2026-10-18T12:00:00Z" } }],
                        "automation": [] } },
                    "transitionIn": { "kind": "cut", "lengthTicks": 0 } }],
                "master": { "fx": [], "automation": [], "gainDb": 0 } }
        })
        .to_string()
    }

    const HASH: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const COMMIT: &str = "cmt_01JAB3QK7M9P2V6XWN0T4Y8ZB5";

    fn asset_json() -> String {
        serde_json::json!([{
            "hash": HASH, "mime": "audio/flac", "bytes": 1,
            "sampleRate": 48000, "channels": 2, "durationSamples": 480000
        }])
        .to_string()
    }

    #[test]
    fn apply_batch_with_adopts_from_another_handle() {
        let target = load_project(&clip_project_json(0.0)).unwrap();
        asset_add(target, &asset_json()).unwrap();
        let source = load_project(&clip_project_json(-6.0)).unwrap();
        asset_add(source, &asset_json()).unwrap();

        let batch = serde_json::json!({
            "id": "bat_01", "label": "Adopt", "createdAt": "2026-10-18T12:00:00Z",
            "author": { "kind": "user" },
            "ops": [{ "op": "region.adopt", "fromCommit": COMMIT,
                      "region": { "startTick": 0, "endTick": 960, "tracks": "all" } }] })
        .to_string();

        // Without the commit's handle the op fails with the structured `unknown_commit` code.
        let err = apply_batch_with(target, &batch, "{}").unwrap_err();
        assert!(err.contains("unknown_commit"), "unexpected error: {err}");

        let commit_handles = serde_json::json!({ COMMIT: source }).to_string();
        let next = apply_batch_with(target, &batch, &commit_handles).unwrap();
        assert!(next.contains("-6.0"), "the source clip's gain was copied");
        assert_eq!(document_json(target).unwrap(), next);

        assert!(free_doc(source));
        assert!(free_doc(target));
    }

    #[test]
    fn fill_and_transition_placement_are_pure_wasm_batches() {
        let doc = serde_json::json!({
            "schemaVersion": 1, "id": "prj_01",
            "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
            "sources": [], "analyses": {},
            "tracks": [{ "id": "trk_01", "name": "Mix", "role": "full_mix", "color": "#8A8F98",
                         "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": [] }],
            "arrangement": { "timebase": { "ppq": 960,
                "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }],
                "timeSignatures": [{ "bar": 0, "numerator": 4, "denominator": 4 }] },
                "sections": [
                    { "id": "sec_a", "kind": "verse", "label": "A", "lengthTicks": 3840,
                      "lanes": {}, "transitionIn": { "kind": "cut", "lengthTicks": 0 } },
                    { "id": "sec_b", "kind": "chorus", "label": "B", "lengthTicks": 3840,
                      "lanes": {}, "transitionIn": { "kind": "cut", "lengthTicks": 0 } }],
                "master": { "fx": [], "automation": [], "gainDb": 0 } }
        })
        .to_string();
        let handle = load_project(&doc).unwrap();
        let before = canonical_json(handle).unwrap();
        let candidate = serde_json::json!({
            "sourceId": "src_gen", "originalAsset": HASH, "workingAsset": HASH,
            "durationSamples": 192000, "channels": 2, "label": "Generated",
            "provenance": { "kind": "generation", "createdAt": "2026-10-18T12:00:00Z" }
        });
        let fill = serde_json::json!({
            "gapRange": { "startTick": 960, "endTick": 2880 },
            "candidate": candidate, "startOffsetSamples": -24000, "endOffsetSamples": 24000,
            "crossfadeTicks": 480, "batchId": "bat_fill", "label": "Fill",
            "createdAt": "2026-10-18T12:00:00Z"
        })
        .to_string();
        let batch = fill_placement(handle, &fill).unwrap();
        assert!(batch.contains("source.add") && batch.contains("clip.add"));
        assert_eq!(
            canonical_json(handle).unwrap(),
            before,
            "placement does not commit"
        );

        let transition = serde_json::json!({
            "sectionId": "sec_b", "candidate": candidate, "lengthTicks": 1920,
            "batchId": "bat_join", "label": "Smooth",
            "createdAt": "2026-10-18T12:00:00Z"
        })
        .to_string();
        let batch = transition_placement(handle, &transition).unwrap();
        assert!(batch.contains("section.set_transition") && batch.contains("generated"));
        assert_eq!(
            canonical_json(handle).unwrap(),
            before,
            "the transition does not commit"
        );

        let first = serde_json::json!({
            "sectionId": "sec_a", "candidate": candidate, "lengthTicks": 1920,
            "batchId": "bat_join", "label": "Smooth",
            "createdAt": "2026-10-18T12:00:00Z"
        })
        .to_string();
        let err = transition_placement(handle, &first).unwrap_err();
        assert!(err.contains("first section"), "unexpected error: {err}");
        assert!(free_doc(handle));
    }
}
