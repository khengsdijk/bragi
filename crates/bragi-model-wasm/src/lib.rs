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

use bragi_model::generated::{AssetHash, AssetMeta, CommitId, OpBatch, Project, Region};
use bragi_model::{AssetIndex, diff as model_diff, section_spans as model_spans};
use bragi_model::{
    apply as model_apply, canonical_json as model_canonical_json, commit_id as model_commit_id,
    resolve_region as model_resolve_region, seconds_to_ticks as model_seconds_to_ticks,
    ticks_to_seconds as model_ticks_to_seconds, validate as model_validate,
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
        assert_eq!(ticks_to_seconds(handle, 960).unwrap(), 0.5);
        assert_eq!(seconds_to_ticks(handle, 0.5).unwrap(), 960);
        assert!(free_doc(handle));
        assert!(!free_doc(handle));
        assert_eq!(doc_count(), 0);
    }
}
