//! Live preview: transient drag state applied to a shadow plan
//! (`specs/03-audio-engine.md` §5.3).
//!
//! During a drag the UI sends one lightweight patch. The engine clones the
//! current plan and applies the patch to the clone — no document is parsed and
//! no other track is rebuilt — and installs it. `set_preview(None)` restores the
//! base plan. This is deliberately a *cheap plan clone* rather than a
//! recompile: the spec says "without recompiling the whole document", and a plan
//! clone is a few `Vec` copies on the planner thread, not an op-batch `apply`.
//!
//! ```
//! use bragi_engine::preview::{PreviewPatch, apply};
//! # fn plan() -> bragi_engine::plan::RenderPlan {
//! #   let doc: bragi_model::generated::Project = serde_json::from_value(serde_json::json!({
//! #     "schemaVersion": 1, "id": "prj_01",
//! #     "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
//! #     "sources": [], "analyses": {},
//! #     "tracks": [{ "id": "trk_01", "name": "T", "role": "full_mix", "color": "#8A8F98",
//! #                  "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": [] }],
//! #     "arrangement": { "timebase": { "ppq": 960,
//! #         "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }], "timeSignatures": [] },
//! #         "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } } })).unwrap();
//! #   bragi_engine::plan::compile(&doc, &bragi_model::AssetIndex::new(), 48_000, 1).unwrap()
//! # }
//! # use bragi_model::generated::TrackId;
//! # let track: TrackId = "trk_01".parse().unwrap();
//! let mut plan = plan();
//! apply(&mut plan, &PreviewPatch::TrackGain { track_id: track, db: -6.0 });
//! assert!((plan.tracks[0].gain - 0.501).abs() < 0.01);
//! ```

use bragi_model::generated::{ClipId, SectionId, TrackId};

use crate::plan::{RenderPlan, db_to_gain};

/// One transient drag patch (`specs/03-audio-engine.md` §5.3).
///
/// `clipOffset` carries **samples**, not ticks: the UI owns the tempo map
/// (through `bragi-model`) and converts before sending, so the engine never has
/// to interpret musical time on the audio side.
#[derive(Clone, Debug, PartialEq)]
pub enum PreviewPatch {
    /// Live track gain in dB.
    TrackGain {
        /// The track.
        track_id: TrackId,
        /// The gain in dB.
        db: f64,
    },
    /// Live track pan, `-1..=1`.
    TrackPan {
        /// The track.
        track_id: TrackId,
        /// The pan.
        pan: f64,
    },
    /// Live track mute.
    TrackMute {
        /// The track.
        track_id: TrackId,
        /// Whether it is muted.
        mute: bool,
    },
    /// Live clip nudge, in output samples (see the type docs).
    ClipOffset {
        /// The clip.
        clip_id: ClipId,
        /// Signed sample offset.
        delta_samples: i64,
    },
    /// Live section reorder: the section moves to `to_index`.
    MoveSection {
        /// The section.
        section_id: SectionId,
        /// Its new index.
        to_index: usize,
    },
}

/// Applies `patch` to `plan` in place.
///
/// A patch that names something the plan does not contain is a no-op, which is
/// what a drag past a deleted clip should be.
pub fn apply(plan: &mut RenderPlan, patch: &PreviewPatch) {
    match patch {
        PreviewPatch::TrackGain { track_id, db } => {
            if let Some(track) = plan.tracks.iter_mut().find(|track| &track.id == track_id) {
                track.gain = db_to_gain(*db);
            }
        }
        PreviewPatch::TrackPan { track_id, pan } => {
            if let Some(track) = plan.tracks.iter_mut().find(|track| &track.id == track_id) {
                track.pan = pan.clamp(-1.0, 1.0) as f32;
            }
        }
        PreviewPatch::TrackMute { track_id, mute } => {
            if let Some(track) = plan.tracks.iter_mut().find(|track| &track.id == track_id) {
                track.mute = *mute;
            }
        }
        PreviewPatch::ClipOffset {
            clip_id,
            delta_samples,
        } => {
            for track in &mut plan.tracks {
                for segment in &mut track.segments {
                    if &segment.clip_id != clip_id {
                        continue;
                    }
                    segment.dst_start = shift(segment.dst_start, *delta_samples);
                    segment.dst_end = shift(segment.dst_end, *delta_samples);
                    segment.clip_start = shift(segment.clip_start, *delta_samples);
                    segment.clip_end = shift(segment.clip_end, *delta_samples);
                }
                track.segments.sort_by_key(|segment| segment.dst_start);
            }
        }
        PreviewPatch::MoveSection {
            section_id,
            to_index,
        } => move_section(plan, section_id, *to_index),
    }
}

fn shift(value: u64, delta: i64) -> u64 {
    if delta >= 0 {
        value.saturating_add(delta as u64)
    } else {
        value.saturating_sub(delta.unsigned_abs())
    }
}

fn move_section(plan: &mut RenderPlan, section_id: &SectionId, to_index: usize) {
    let Some(from) = plan
        .sections
        .iter()
        .position(|section| &section.id == section_id)
    else {
        return;
    };
    let to_index = to_index.min(plan.sections.len().saturating_sub(1));
    if from == to_index {
        return;
    }

    let old_starts: Vec<u64> = plan.sections.iter().map(|section| section.start).collect();
    let lengths: Vec<u64> = plan
        .sections
        .iter()
        .map(|section| section.end.saturating_sub(section.start))
        .collect();

    let mut order: Vec<usize> = (0..plan.sections.len()).collect();
    let moved = order.remove(from);
    order.insert(to_index, moved);

    let mut start = 0u64;
    let mut new_starts = vec![0u64; plan.sections.len()];
    let mut reordered = Vec::with_capacity(plan.sections.len());
    for (position, &old_index) in order.iter().enumerate() {
        new_starts[old_index] = start;
        let mut section = plan.sections[old_index].clone();
        section.start = start;
        section.end = start + lengths[old_index];
        start = section.end;
        reordered.push(section);
        let _ = position;
    }

    // A segment shifts by its own section's start delta, and its section index
    // is remapped to the new order.
    let mut old_to_new = vec![0usize; plan.sections.len()];
    for (position, &old_index) in order.iter().enumerate() {
        old_to_new[old_index] = position;
    }
    for track in &mut plan.tracks {
        for segment in &mut track.segments {
            let old_index = segment.section.min(new_starts.len().saturating_sub(1));
            let delta = new_starts[old_index] as i64 - old_starts[old_index] as i64;
            segment.dst_start = shift(segment.dst_start, delta);
            segment.dst_end = shift(segment.dst_end, delta);
            segment.clip_start = shift(segment.clip_start, delta);
            segment.clip_end = shift(segment.clip_end, delta);
            segment.section = old_to_new[old_index];
        }
        track.segments.sort_by_key(|segment| segment.dst_start);
    }
    plan.sections = reordered;
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use bragi_model::generated::Project;

    fn document() -> Project {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "id": "prj_01",
            "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
            "sources": [], "analyses": {},
            "tracks": [{ "id": "trk_01", "name": "T", "role": "full_mix", "color": "#8A8F98",
                         "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": [] }],
            "arrangement": { "timebase": { "ppq": 960,
                "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }], "timeSignatures": [] },
                "sections": [
                  { "id": "sec_a", "kind": "intro", "label": "A", "lengthTicks": 3840,
                    "lanes": { "trk_01": { "clips": [{ "id": "clp_a",
                        "asset": format!("sha256:{}", "0".repeat(64)),
                        "srcStart": 0, "srcEnd": 48000, "start": 0, "warp": { "mode": "none" },
                        "gainDb": 0, "pitchSemitones": 0, "fadeInTicks": 0, "fadeOutTicks": 0,
                        "fadeCurve": "equal_power",
                        "provenance": { "kind": "user", "createdAt": "2026-10-18T12:00:00Z" } }],
                        "automation": [] } }, "transitionIn": { "kind": "cut", "lengthTicks": 0 } },
                  { "id": "sec_b", "kind": "verse", "label": "B", "lengthTicks": 1920,
                    "lanes": { "trk_01": { "clips": [{ "id": "clp_b",
                        "asset": format!("sha256:{}", "0".repeat(64)),
                        "srcStart": 0, "srcEnd": 24000, "start": 0, "warp": { "mode": "none" },
                        "gainDb": 0, "pitchSemitones": 0, "fadeInTicks": 0, "fadeOutTicks": 0,
                        "fadeCurve": "equal_power",
                        "provenance": { "kind": "user", "createdAt": "2026-10-18T12:00:00Z" } }],
                        "automation": [] } }, "transitionIn": { "kind": "cut", "lengthTicks": 0 } }],
                "master": { "fx": [], "automation": [], "gainDb": 0 } }
        }))
        .unwrap()
    }

    fn plan() -> RenderPlan {
        let hash =
            bragi_model::generated::AssetHash::try_from(format!("sha256:{}", "0".repeat(64)))
                .unwrap();
        let meta: bragi_model::generated::AssetMeta = serde_json::from_value(serde_json::json!({
            "hash": hash, "mime": "audio/wav", "bytes": 1, "sampleRate": 48000,
            "channels": 2, "durationSamples": 480000
        }))
        .unwrap();
        crate::plan::compile(
            &document(),
            &bragi_model::AssetIndex::from_metas([meta]),
            48_000,
            1,
        )
        .unwrap()
    }

    #[test]
    fn track_patches_change_the_mix_parameters() {
        let mut plan = plan();
        let track: TrackId = "trk_01".parse().unwrap();
        apply(
            &mut plan,
            &PreviewPatch::TrackGain {
                track_id: track.clone(),
                db: -6.0,
            },
        );
        apply(
            &mut plan,
            &PreviewPatch::TrackPan {
                track_id: track.clone(),
                pan: 1.0,
            },
        );
        apply(
            &mut plan,
            &PreviewPatch::TrackMute {
                track_id: track,
                mute: true,
            },
        );
        assert!((plan.tracks[0].gain - 0.501).abs() < 0.01);
        assert_eq!(plan.tracks[0].pan, 1.0);
        assert!(plan.tracks[0].mute);
    }

    #[test]
    fn clip_offset_moves_every_piece_of_a_clip() {
        let mut plan = plan();
        let clip: ClipId = "clp_a".parse().unwrap();
        let before = plan.tracks[0].segments[0].dst_start;
        apply(
            &mut plan,
            &PreviewPatch::ClipOffset {
                clip_id: clip,
                delta_samples: 100,
            },
        );
        assert_eq!(plan.tracks[0].segments[0].dst_start, before + 100);
    }

    #[test]
    fn moving_a_section_shifts_its_clips_and_reorders_the_spans() {
        let mut plan = plan();
        let section: SectionId = "sec_a".parse().unwrap();
        apply(
            &mut plan,
            &PreviewPatch::MoveSection {
                section_id: section,
                to_index: 1,
            },
        );
        assert_eq!(plan.sections[1].id.as_str(), "sec_a");
        // Section B (1 s at 120 bpm) now starts at 0, so A's clip moved to 48000.
        let clip_a: ClipId = "clp_a".parse().unwrap();
        let moved = plan.tracks[0]
            .segments
            .iter()
            .find(|segment| segment.clip_id == clip_a)
            .unwrap();
        assert_eq!(moved.dst_start, 48_000);
    }

    #[test]
    fn unknown_ids_are_no_ops() {
        let mut plan = plan();
        let before = plan.tracks[0].gain;
        let track: TrackId = "trk_missing".parse().unwrap();
        apply(
            &mut plan,
            &PreviewPatch::TrackGain {
                track_id: track,
                db: -12.0,
            },
        );
        assert_eq!(plan.tracks[0].gain, before);
    }
}
