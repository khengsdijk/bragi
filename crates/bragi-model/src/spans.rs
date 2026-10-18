//! Absolute positions of the arrangement's sections.
//!
//! Section positions are **derived**, never stored (`specs/02-song-model.md` §3.5): section *i*
//! starts at the sum of the `lengthTicks` of the sections before it.

use serde::{Deserialize, Serialize};

use crate::generated::{Project, SectionId};

/// One section's absolute extent in arrangement ticks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionSpan {
    /// The section's ID.
    pub id: SectionId,
    /// Its index in `arrangement.sections`.
    pub index: usize,
    /// Absolute start tick (the sum of the lengths before it).
    pub start_tick: i64,
    /// Absolute end tick (`start_tick + length_ticks`).
    pub end_tick: i64,
    /// The section's own length.
    pub length_ticks: u64,
}

impl SectionSpan {
    /// Whether absolute `tick` falls inside this section (half-open: `start <= tick < end`).
    #[must_use]
    pub fn contains(&self, tick: i64) -> bool {
        self.start_tick <= tick && tick < self.end_tick
    }
}

/// The absolute span of every section, in order (`specs/02-song-model.md` §8).
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
/// #         "sections": [
/// #             { "id": "sec_a", "kind": "intro", "label": "A", "lengthTicks": 3840,
/// #               "lanes": {}, "transitionIn": { "kind": "cut", "lengthTicks": 0 } },
/// #             { "id": "sec_b", "kind": "verse", "label": "B", "lengthTicks": 7680,
/// #               "lanes": {}, "transitionIn": { "kind": "cut", "lengthTicks": 0 } } ],
/// #         "master": { "fx": [], "automation": [], "gainDb": 0 } }
/// # })).unwrap();
/// let spans = bragi_model::section_spans(&doc);
/// assert_eq!(spans[0].start_tick, 0);
/// assert_eq!(spans[1].start_tick, 3840);
/// assert_eq!(spans[1].end_tick, 3840 + 7680);
/// ```
#[must_use]
pub fn section_spans(doc: &Project) -> Vec<SectionSpan> {
    let mut spans = Vec::with_capacity(doc.arrangement.sections.len());
    let mut start = 0_i64;
    for (index, section) in doc.arrangement.sections.iter().enumerate() {
        let length = i64::try_from(section.length_ticks.get()).unwrap_or(i64::MAX);
        let end = start.saturating_add(length);
        spans.push(SectionSpan {
            id: section.id.clone(),
            index,
            start_tick: start,
            end_tick: end,
            length_ticks: section.length_ticks.get(),
        });
        start = end;
    }
    spans
}

/// The total length of the arrangement in ticks (the end of the last section).
#[must_use]
pub fn total_ticks(doc: &Project) -> i64 {
    doc.arrangement
        .sections
        .iter()
        .map(|section| i64::try_from(section.length_ticks.get()).unwrap_or(i64::MAX))
        .fold(0_i64, i64::saturating_add)
}

/// The index of the section containing absolute `tick`, if any.
#[must_use]
pub fn section_index_at(doc: &Project, tick: i64) -> Option<usize> {
    let mut start = 0_i64;
    for (index, section) in doc.arrangement.sections.iter().enumerate() {
        let length = i64::try_from(section.length_ticks.get()).unwrap_or(i64::MAX);
        if start <= tick && tick < start.saturating_add(length) {
            return Some(index);
        }
        start = start.saturating_add(length);
    }
    None
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn empty_arrangement_has_no_spans() {
        let doc: Project = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "id": "prj_01",
            "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
            "sources": [], "analyses": {}, "tracks": [],
            "arrangement": { "timebase": { "ppq": 960,
                "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }], "timeSignatures": [] },
                "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } }
        }))
        .unwrap();
        assert!(section_spans(&doc).is_empty());
        assert_eq!(total_ticks(&doc), 0);
    }
}
