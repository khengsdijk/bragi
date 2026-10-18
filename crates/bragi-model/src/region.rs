//! Resolving a [`Region`] — the universal selection — into per-section, per-track slices.
//!
//! `region.clear` and `key.transpose` (region scope) are defined on top of this
//! (`specs/02-song-model.md` §3.8, §4.2). A region's ticks are **absolute** arrangement ticks;
//! lanes are section-relative, so every slice carries both frames.

use serde::{Deserialize, Serialize};

use crate::assets::AssetIndex;
use crate::clipmath::clip_end_local;
use crate::generated::{ClipId, Project, Region, RegionTracks, SectionId, TrackId};
use crate::spans::section_spans;
use crate::time::TempoCtx;

/// One section × track intersection of a region.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionSlice {
    /// The section the slice lies in.
    pub section_id: SectionId,
    /// Its index in `arrangement.sections`.
    pub section_index: usize,
    /// The track the slice targets.
    pub track_id: TrackId,
    /// Absolute start tick of the slice (clamped to the section).
    pub start_tick: i64,
    /// Absolute end tick of the slice (clamped to the section).
    pub end_tick: i64,
    /// `start_tick` in the section's frame (`start_tick - span.start_tick`).
    pub local_start_tick: i64,
    /// `end_tick` in the section's frame.
    pub local_end_tick: i64,
    /// Clips in the lane that overlap the slice.
    pub clip_ids: Vec<ClipId>,
}

impl RegionSlice {
    /// Whether a clip at section-relative `[clip_start, clip_end)` overlaps this slice.
    #[must_use]
    pub fn overlaps_local(&self, clip_start: i64, clip_end: i64) -> bool {
        clip_start < self.local_end_tick && self.local_start_tick < clip_end
    }
}

/// A region split into section- and track-aligned slices.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRegion {
    /// The region's absolute start tick.
    pub start_tick: i64,
    /// The region's absolute end tick.
    pub end_tick: i64,
    /// The region's optional frequency range, in hertz.
    pub freq_range: Option<[f64; 2]>,
    /// One slice per (section, track) the region covers, section-major.
    pub slices: Vec<RegionSlice>,
}

impl ResolvedRegion {
    /// Every clip the region covers, once each.
    #[must_use]
    pub fn clip_ids(&self) -> Vec<ClipId> {
        let mut seen = std::collections::BTreeSet::new();
        let mut out = Vec::new();
        for slice in &self.slices {
            for clip_id in &slice.clip_ids {
                if seen.insert(clip_id.to_string()) {
                    out.push(clip_id.clone());
                }
            }
        }
        out
    }

    /// Every track the region targets, once each, in first-seen order.
    #[must_use]
    pub fn track_ids(&self) -> Vec<TrackId> {
        let mut seen = std::collections::BTreeSet::new();
        let mut out = Vec::new();
        for slice in &self.slices {
            if seen.insert(slice.track_id.to_string()) {
                out.push(slice.track_id.clone());
            }
        }
        out
    }
}

/// Splits `region` into the (section, track) slices it covers.
///
/// `assets` is needed to derive clip end ticks; the signature in `specs/02-song-model.md` §8 did
/// not carry it, and 02 §8 is updated by this work package to match this function.
///
/// ```
/// # use bragi_model::generated::{Project, Region};
/// # let doc: Project = serde_json::from_value(serde_json::json!({
/// #     "schemaVersion": 1, "id": "prj_01",
/// #     "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
/// #     "sources": [], "analyses": {},
/// #     "tracks": [{ "id": "trk_01", "name": "Mix", "role": "full_mix", "color": "#8A8F98",
/// #                  "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": [] }],
/// #     "arrangement": { "timebase": { "ppq": 960,
/// #         "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }],
/// #         "timeSignatures": [{ "bar": 0, "numerator": 4, "denominator": 4 }] },
/// #         "sections": [
/// #             { "id": "sec_a", "kind": "intro", "label": "A", "lengthTicks": 3840,
/// #               "lanes": {}, "transitionIn": { "kind": "cut", "lengthTicks": 0 } },
/// #             { "id": "sec_b", "kind": "verse", "label": "B", "lengthTicks": 3840,
/// #               "lanes": {}, "transitionIn": { "kind": "cut", "lengthTicks": 0 } } ],
/// #         "master": { "fx": [], "automation": [], "gainDb": 0 } }
/// # })).unwrap();
/// let region: Region = serde_json::from_value(serde_json::json!({
///     "startTick": 1920, "endTick": 5760, "tracks": "all" })).unwrap();
/// let resolved = bragi_model::resolve_region(&doc, &region, &bragi_model::AssetIndex::new());
/// assert_eq!(resolved.slices.len(), 2, "one slice per section");
/// assert_eq!(resolved.slices[0].clip_ids, vec![]);
/// assert_eq!(resolved.slices[1].local_end_tick, 1920);
/// ```
#[must_use]
pub fn resolve_region(doc: &Project, region: &Region, assets: &AssetIndex) -> ResolvedRegion {
    let track_ids: Vec<TrackId> = match &region.tracks {
        RegionTracks::All(_) => doc.tracks.iter().map(|track| track.id.clone()).collect(),
        RegionTracks::TrackIdList(list) => list.0.clone(),
    };
    let freq_range = region.freq_range.as_ref().map(|range| range.0);
    let mut slices = Vec::new();
    let tempo = TempoCtx::from_project(doc);
    for span in section_spans(doc) {
        let start = region.start_tick.max(span.start_tick);
        let end = region.end_tick.min(span.end_tick);
        if start >= end {
            continue;
        }
        let section = &doc.arrangement.sections[span.index];
        for track_id in &track_ids {
            let clip_ids = section.lanes.get(track_id).map_or_else(Vec::new, |lane| {
                lane.clips
                    .iter()
                    .filter(|clip| {
                        let clip_end = clip_end_local(clip, &tempo, assets, span.start_tick)
                            .unwrap_or(span.end_tick);
                        clip.start < end - span.start_tick && start - span.start_tick < clip_end
                    })
                    .map(|clip| clip.id.clone())
                    .collect()
            });
            slices.push(RegionSlice {
                section_id: span.id.clone(),
                section_index: span.index,
                track_id: track_id.clone(),
                start_tick: start,
                end_tick: end,
                local_start_tick: start - span.start_tick,
                local_end_tick: end - span.start_tick,
                clip_ids,
            });
        }
    }
    ResolvedRegion {
        start_tick: region.start_tick,
        end_tick: region.end_tick,
        freq_range,
        slices,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn region_outside_the_arrangement_is_empty() {
        let doc: Project = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "id": "prj_01",
            "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
            "sources": [], "analyses": {}, "tracks": [],
            "arrangement": { "timebase": { "ppq": 960,
                "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }], "timeSignatures": [] },
                "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } }
        }))
        .unwrap();
        let region: Region = serde_json::from_value(
            serde_json::json!({ "startTick": 0, "endTick": 10, "tracks": "all" }),
        )
        .unwrap();
        let resolved = resolve_region(&doc, &region, &AssetIndex::new());
        assert!(resolved.slices.is_empty());
    }
}
