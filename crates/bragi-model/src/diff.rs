//! `diff(prev, next) -> EngineDelta`: what the audio engine has to change
//! (`specs/01-architecture.md` §5, `specs/02-song-model.md` §8).
//!
//! The engine never receives a whole document on an edit; it receives the delta. A section or track
//! that changed is sent whole (they are small), so the engine can rebuild its render plan without
//! reconciling nested entities.
//!
//! `EngineDelta` is a Rust-to-Rust contract, not a JSON Schema one: `specs/01-architecture.md` §7
//! puts engine-facing types in Rust. Its shape was not specified in 02 §8, so this work package
//! defines it there; WP-1.1 may extend it additively.

use serde::{Deserialize, Serialize};

use crate::generated::{Project, SectionId, SectionInstance, Source, SourceId, Track, TrackId};

/// Everything the engine needs to move from one document to the next.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineDelta {
    /// The project the delta belongs to.
    pub project_id: crate::generated::ProjectId,
    /// True when the timebase (tempo map or time signatures) changed.
    pub timebase_changed: bool,
    /// True when the project metadata changed (the engine usually ignores this).
    pub meta_changed: bool,
    /// Sources present in `next` but not `prev`.
    pub sources_added: Vec<Source>,
    /// IDs of sources present in `prev` but not `next`.
    pub sources_removed: Vec<SourceId>,
    /// Tracks present in `next` but not `prev`.
    pub tracks_added: Vec<Track>,
    /// IDs of tracks removed.
    pub tracks_removed: Vec<TrackId>,
    /// Tracks present in both whose contents changed.
    pub tracks_updated: Vec<Track>,
    /// Sections present in `next` but not `prev`.
    pub sections_added: Vec<SectionInstance>,
    /// IDs of sections removed.
    pub sections_removed: Vec<SectionId>,
    /// Sections present in both whose contents changed.
    pub sections_updated: Vec<SectionInstance>,
    /// True when the master chain or its automation changed.
    pub master_changed: bool,
    /// True when the engine must rebuild its whole render plan rather than patch it (a structural
    /// change: the timebase, the source set, or the section/track set).
    pub requires_full_resync: bool,
}

impl EngineDelta {
    /// Whether the delta carries no change at all.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        !self.timebase_changed
            && !self.meta_changed
            && !self.master_changed
            && self.sources_added.is_empty()
            && self.sources_removed.is_empty()
            && self.tracks_added.is_empty()
            && self.tracks_removed.is_empty()
            && self.tracks_updated.is_empty()
            && self.sections_added.is_empty()
            && self.sections_removed.is_empty()
            && self.sections_updated.is_empty()
    }
}

/// Computes the delta between two documents (`specs/02-song-model.md` §8).
///
/// ```
/// # use bragi_model::{diff, AssetIndex, apply};
/// # use bragi_model::generated::{OpBatch, Project};
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
/// # let batch: OpBatch = serde_json::from_value(serde_json::json!({
/// #   "id": "bat_01", "label": "L", "createdAt": "2026-10-18T12:00:00Z",
/// #   "author": { "kind": "user" },
/// #   "ops": [{ "op": "track.update", "trackId": "trk_01", "patch": { "gainDb": -3 } }] })).unwrap();
/// let next = apply(&doc, &batch, &AssetIndex::new()).unwrap();
/// let delta = diff(&doc, &next);
/// assert_eq!(delta.tracks_updated.len(), 1);
/// assert!(!delta.requires_full_resync);
/// assert!(diff(&next, &next).is_empty());
/// ```
#[must_use]
pub fn diff(prev: &Project, next: &Project) -> EngineDelta {
    let timebase_changed = value(&prev.arrangement.timebase) != value(&next.arrangement.timebase);
    let meta_changed = value(&prev.meta) != value(&next.meta);
    let master_changed = value(&prev.arrangement.master) != value(&next.arrangement.master);

    let mut sources_added = Vec::new();
    let mut sources_removed = Vec::new();
    for source in &next.sources {
        if !prev.sources.iter().any(|s| s.id == source.id) {
            sources_added.push(source.clone());
        }
    }
    for source in &prev.sources {
        if !next.sources.iter().any(|s| s.id == source.id) {
            sources_removed.push(source.id.clone());
        }
    }

    let mut tracks_added = Vec::new();
    let mut tracks_removed = Vec::new();
    let mut tracks_updated = Vec::new();
    for track in &next.tracks {
        match prev.tracks.iter().find(|t| t.id == track.id) {
            None => tracks_added.push(track.clone()),
            Some(before) if value(before) != value(track) => tracks_updated.push(track.clone()),
            Some(_) => {}
        }
    }
    for track in &prev.tracks {
        if !next.tracks.iter().any(|t| t.id == track.id) {
            tracks_removed.push(track.id.clone());
        }
    }

    let mut sections_added = Vec::new();
    let mut sections_removed = Vec::new();
    let mut sections_updated = Vec::new();
    for section in &next.arrangement.sections {
        match prev
            .arrangement
            .sections
            .iter()
            .find(|s| s.id == section.id)
        {
            None => sections_added.push(section.clone()),
            Some(before) if value(before) != value(section) => {
                sections_updated.push(section.clone());
            }
            Some(_) => {}
        }
    }
    for section in &prev.arrangement.sections {
        if !next.arrangement.sections.iter().any(|s| s.id == section.id) {
            sections_removed.push(section.id.clone());
        }
    }

    let requires_full_resync = timebase_changed
        || !sources_added.is_empty()
        || !sources_removed.is_empty()
        || !tracks_added.is_empty()
        || !tracks_removed.is_empty()
        || !sections_added.is_empty()
        || !sections_removed.is_empty();

    EngineDelta {
        project_id: next.id.clone(),
        timebase_changed,
        meta_changed,
        sources_added,
        sources_removed,
        tracks_added,
        tracks_removed,
        tracks_updated,
        sections_added,
        sections_removed,
        sections_updated,
        master_changed,
        requires_full_resync,
    }
}

fn value<T: Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}
