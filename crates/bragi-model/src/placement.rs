//! Placement of generated audio: the op batches that turn a candidate into a source, a section
//! and clips (`specs/09-generation.md` §4.2–4.4, `specs/02-song-model.md` §4.2).
//!
//! The functions are pure: they read the document, never change it, and return the exact batch
//! the caller commits as a candidate (`specs/02-song-model.md` §7). The model applies the batch,
//! so placement is undoable like any other edit.
//!
//! A forward extend appends the new section after the last one; a backward extend inserts it at
//! index 0, which is the context range start (0). When the context ends on the last full bar line
//! before a mid-bar song end, the clip's source range advances by that partial bar, so the new
//! audio continues at the context end and the partial bar plays from the previous section.
//!
//! A **fill** owns a gap range inside the existing sections: one clip per section the gap crosses,
//! on the `generated` track. A **transition** owns no lane audio at all; it sets the incoming
//! section's `transitionIn` to `generated` so the engine plays the asset over the boundary
//! (`specs/03-audio-engine.md` §5.5).

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::INTERNAL_SAMPLE_RATE_HZ;
use crate::analysis::{kind_label, role_color, role_name};
use crate::canonical::derived_id;
use crate::generated::{
    AssetHash, BatchAuthor, BatchId, ChannelCount, Clip, ClipAddOp, ClipId, FadeCurve, FxChain,
    IsoDate, LaneMap, Op, OpBatch, Project, Provenance, SectionId, SectionInsertOp,
    SectionInstance, SectionKind, SectionSetTransitionOp, Source, SourceAddOp, SourceId,
    SourceKind, SourcePlacement, StemRole, SystemAuthor, SystemAuthorKind, TickRange, Track,
    TrackAddOp, TrackId, TrackOrigin, Transition, TransitionKind, Warp, WarpAnchor, WarpBeatgrid,
    WarpBeatgridMode,
};
use crate::time::{TempoCtx, bar_beat_to_ticks, bar_ticks, ticks_to_bar_beat};

/// Which end of the song the candidate extends.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtendDirection {
    /// After the last section.
    Forward,
    /// Before the first section.
    Backward,
}

/// The generated audio a candidate offers.
///
/// Extend, fill and transition placement all take the same candidate: the bytes the model
/// returned, their 48 kHz working copy, its length and the provenance the document records
/// (`specs/09-generation.md` §8).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneratedCandidate {
    /// The generated source's new ID (`src_…`); it must not exist yet.
    pub source_id: SourceId,
    /// The bytes the model returned.
    pub original_asset: AssetHash,
    /// The 48 kHz working copy used for playback.
    pub working_asset: AssetHash,
    /// Length of the working asset in samples at 48 kHz.
    pub duration_samples: u64,
    /// Mono or stereo.
    pub channels: ChannelCount,
    /// "Generated: dreamy outro".
    pub label: String,
    /// `kind: "generation"` with the model, version, prompt and job (09 §8).
    pub provenance: Provenance,
}

/// Everything `extend_placement` needs. The caller provides the batch identity and timestamp so the
/// candidate commit is reproducible and the helper stays pure.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtendPlacementRequest {
    /// Forward (outro) or backward (intro).
    pub direction: ExtendDirection,
    /// The bar-aligned context rendered for the model, in absolute ticks (03 §9).
    pub context_range: TickRange,
    /// The candidate audio and its provenance.
    pub candidate: GeneratedCandidate,
    /// Where the processed candidate starts relative to the context edge, in samples; negative
    /// starts inside the overlap (`GateResult.splice_offset_samples`, 09 §6).
    #[serde(default)]
    pub splice_offset: i64,
    /// The number of new bars the user asked for.
    pub bars: u32,
    /// The crossfade the gate applied at the splice, in ticks.
    #[serde(default)]
    pub crossfade_ticks: u64,
    /// Overrides the guessed kind; `outro` is the only kind the UI asks for (09 §4.2).
    #[serde(default)]
    pub section_kind: Option<SectionKind>,
    /// The candidate batch's ID.
    pub batch_id: BatchId,
    /// The candidate batch's history label.
    pub label: String,
    /// The candidate batch's timestamp.
    pub created_at: IsoDate,
}

/// Everything `fill_placement` needs (`specs/09-generation.md` §4.3).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FillPlacementRequest {
    /// The erased gap, in absolute arrangement ticks. It may cross section boundaries.
    pub gap_range: TickRange,
    /// The candidate audio and its provenance.
    pub candidate: GeneratedCandidate,
    /// Where the processed audio starts relative to the gap start, in samples: negative when it
    /// starts inside the left context and that overlap is skipped (`GateResult.startOffsetSamples`,
    /// 09 §6). A positive value would leave a hole and is rejected.
    #[serde(default)]
    pub start_offset_samples: i64,
    /// Where the processed audio ends relative to the gap end, in samples: positive when it
    /// continues into the right context and that tail is trimmed. A negative value would leave a
    /// hole and is rejected.
    #[serde(default)]
    pub end_offset_samples: i64,
    /// The crossfade the gate applied at each splice, in ticks; the clips fade over it.
    #[serde(default)]
    pub crossfade_ticks: u64,
    /// The candidate batch's ID.
    pub batch_id: BatchId,
    /// The candidate batch's history label.
    pub label: String,
    /// The candidate batch's timestamp.
    pub created_at: IsoDate,
}

/// Everything `transition_placement` needs (`specs/09-generation.md` §4.4).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransitionPlacementRequest {
    /// The section that is entered; the asset bridges the boundary before it.
    pub section_id: SectionId,
    /// The candidate audio and its provenance. It gets no lane clip: the engine plays it from
    /// `transitionIn`.
    pub candidate: GeneratedCandidate,
    /// The generated piece's length, in ticks (its `lengthBars` at the boundary's tempo).
    pub length_ticks: u64,
    /// The candidate batch's ID.
    pub batch_id: BatchId,
    /// The candidate batch's history label.
    pub label: String,
    /// The candidate batch's timestamp.
    pub created_at: IsoDate,
}

/// Why a placement request cannot be turned into a batch.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum PlacementError {
    /// A candidate must add at least one bar.
    #[error("an extend candidate needs at least one bar")]
    NoBars,
    /// The generated asset has no samples.
    #[error("the candidate asset is empty")]
    EmptyCandidate,
    /// The requested splice point is past the candidate's end.
    #[error("the splice point leaves no audio in the candidate")]
    NoAudio,
    /// The gap range is empty in samples.
    #[error("the gap range covers no samples")]
    EmptyGap,
    /// The gap range lies outside the arrangement.
    #[error("the gap range lies outside the arrangement")]
    OutsideSong,
    /// The processed audio does not cover the gap at one of its edges.
    #[error("the processed audio leaves a hole at a gap edge")]
    GapNotCovered,
    /// A generated transition needs a positive length.
    #[error("a generated transition needs a positive length")]
    NoLength,
    /// A section has no boundary before it.
    #[error("section {0} is the first section and has no boundary before it")]
    NoBoundary(SectionId),
    /// A deterministic ID could not be built.
    #[error("cannot derive a {prefix} id for {parent}:{child}")]
    Id {
        /// The ID prefix (`sec_`, `trk_`, `clp_`).
        prefix: &'static str,
        /// The parent the ID derives from.
        parent: String,
        /// The child name.
        child: String,
    },
}

impl PlacementError {
    fn id(prefix: &'static str, parent: &str, child: &str) -> Self {
        Self::Id {
            prefix,
            parent: parent.to_owned(),
            child: child.to_owned(),
        }
    }
}

/// Builds the op batch for one accepted extend candidate (09 §4.2 step 4).
///
/// The batch adds the generated `Source` (a placed source, 02 §6), a `generated` track when none
/// exists yet, the new section and its clip. A backward extend also gives the section that now
/// follows the new one a crossfade, because the engine reads the transition from the incoming
/// section (02 §3.5).
///
/// ```
/// # use bragi_model::generated::{BatchId, ChannelCount, IsoDate, ProvenanceKind, SourceId};
/// # use bragi_model::placement::{ExtendDirection, ExtendPlacementRequest, GeneratedCandidate, extend_placement};
/// # use bragi_model::generated::{Project, TickRange};
/// # let doc: Project = serde_json::from_value(serde_json::json!({
/// #     "schemaVersion": 1, "id": "prj_01",
/// #     "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
/// #     "sources": [], "analyses": {}, "tracks": [],
/// #     "arrangement": { "timebase": { "ppq": 960,
/// #         "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }],
/// #         "timeSignatures": [{ "bar": 0, "numerator": 4, "denominator": 4 }] },
/// #         "sections": [{ "id": "sec_a", "kind": "verse", "label": "Verse", "lengthTicks": 3840,
/// #             "lanes": {}, "transitionIn": { "kind": "cut", "lengthTicks": 0 } }],
/// #         "master": { "fx": [], "automation": [], "gainDb": 0 } }
/// # })).unwrap();
/// # let hash: bragi_model::generated::AssetHash = format!("sha256:{}", "a".repeat(64)).parse().unwrap();
/// # let request = ExtendPlacementRequest {
/// #     direction: ExtendDirection::Forward,
/// #     context_range: TickRange { start_tick: 0, end_tick: 3840 },
/// #     candidate: GeneratedCandidate {
/// #         source_id: "src_gen".parse().unwrap(),
/// #         original_asset: hash.clone(), working_asset: hash, duration_samples: 96_000,
/// #         channels: ChannelCount::try_from(2).unwrap(), label: "Generated".to_owned(),
/// #         provenance: bragi_model::generated::Provenance {
/// #             kind: ProvenanceKind::Generation, created_at: "2026-10-18T12:00:00Z".parse().unwrap(),
/// #             job_id: None, model: None, model_version: None, prompt: None },
/// #     },
/// #     splice_offset: 0, bars: 1, crossfade_ticks: 0, section_kind: None,
/// #     batch_id: "bat_01".parse().unwrap(), label: "Extend".to_owned(),
/// #     created_at: "2026-10-18T12:00:00Z".parse().unwrap(),
/// # };
/// let batch = extend_placement(&doc, &request).unwrap();
/// assert_eq!(batch.ops.len(), 4, "source, generated track, section, clip");
/// ```
pub fn extend_placement(
    doc: &Project,
    request: &ExtendPlacementRequest,
) -> Result<OpBatch, PlacementError> {
    if request.bars == 0 {
        return Err(PlacementError::NoBars);
    }
    if request.candidate.duration_samples == 0 {
        return Err(PlacementError::EmptyCandidate);
    }

    let backward = request.direction == ExtendDirection::Backward;
    let total = crate::spans::total_ticks(doc);
    let section_start = if backward { 0 } else { total };
    let length = bars_ticks(doc, section_start, request.bars);

    // On a song that ends mid-bar the context ends on the last full bar line; start the candidate
    // there and let the partial bar play from the previous section (the placement note in WP-2.7).
    let partial = if backward {
        0_u64
    } else {
        u64::try_from((section_start - request.context_range.end_tick).max(0)).unwrap_or(0)
    };
    let partial_samples = samples_between(doc, section_start - partial as i64, section_start);
    // The processed candidate starts at `context edge + spliceOffset` (09 §6). The clip starts at
    // the section edge, which is `partial` later; skip whatever lies before it.
    let offset_at_section = i64::try_from(partial_samples)
        .unwrap_or(i64::MAX)
        .saturating_sub(request.splice_offset);
    let src_start = u64::try_from(offset_at_section.max(0))
        .unwrap_or(u64::MAX)
        .min(request.candidate.duration_samples);
    let wanted = samples_between(doc, section_start, section_start + length);
    let src_end = src_start
        .saturating_add(wanted)
        .min(request.candidate.duration_samples);
    if src_start >= src_end {
        return Err(PlacementError::NoAudio);
    }

    let kind = request.section_kind.unwrap_or_else(|| {
        if backward {
            SectionKind::Intro
        } else {
            doc.arrangement
                .sections
                .last()
                .map_or(SectionKind::Custom, |section| section.kind)
        }
    });
    let label = section_label(doc, kind);
    let Some(section_id) = section_id(derived_id(
        "sec_",
        request.candidate.source_id.as_str(),
        "extend",
    )) else {
        return Err(PlacementError::id(
            "sec_",
            request.candidate.source_id.as_str(),
            "extend",
        ));
    };

    let (track_id, add_track) = generated_track(doc, &request.candidate.source_id)?;
    let Some(clip_id) = clip_id(derived_id("clp_", section_id.as_str(), track_id.as_str())) else {
        return Err(PlacementError::id(
            "clp_",
            section_id.as_str(),
            track_id.as_str(),
        ));
    };

    let fade = request.crossfade_ticks;
    let transition = Transition {
        asset: None,
        kind: if fade > 0 {
            TransitionKind::Crossfade
        } else {
            TransitionKind::Cut
        },
        length_ticks: fade,
    };
    let clip = Clip {
        asset: request.candidate.working_asset.clone(),
        fade_curve: FadeCurve::EqualPower,
        fade_in_ticks: if backward { 0 } else { fade },
        fade_out_ticks: if backward { fade } else { 0 },
        fx: None,
        gain_db: 0.0,
        id: clip_id,
        pitch_semitones: 0.0,
        provenance: request.candidate.provenance.clone(),
        reverse: None,
        src_end,
        src_start,
        start: 0,
        warp: warp(doc, section_start, length, src_start, src_end),
    };

    let source = Source {
        channels: request.candidate.channels.clone(),
        duration_samples: request.candidate.duration_samples,
        id: request.candidate.source_id.clone(),
        kind: SourceKind::Generated,
        label: request.candidate.label.clone(),
        original_asset: request.candidate.original_asset.clone(),
        placement: Some(SourcePlacement {
            range: None,
            section_id: section_id.clone(),
            src_start_samples: None,
        }),
        provenance: Some(request.candidate.provenance.clone()),
        working_asset: request.candidate.working_asset.clone(),
    };

    let index = if backward {
        0
    } else {
        doc.arrangement.sections.len()
    };
    let mut ops = vec![Op::SourceAddOp(SourceAddOp {
        index: None,
        op: crate::generated::SourceAddOpOp::SourceAdd,
        source,
    })];
    if let Some(track) = add_track {
        ops.push(Op::TrackAddOp(TrackAddOp {
            index: None,
            op: crate::generated::TrackAddOpOp::TrackAdd,
            track,
        }));
    }
    ops.push(Op::SectionInsertOp(SectionInsertOp {
        index: u64::try_from(index).unwrap_or(0),
        op: crate::generated::SectionInsertOpOp::SectionInsert,
        section: SectionInstance {
            derived_from: None,
            energy_target: None,
            id: section_id.clone(),
            kind,
            label,
            length_ticks: std::num::NonZeroU64::new(u64::try_from(length).unwrap_or(0))
                .ok_or(PlacementError::NoAudio)?,
            lanes: LaneMap(std::collections::HashMap::new()),
            locked: None,
            transition_in: if backward {
                Transition {
                    asset: None,
                    kind: TransitionKind::Cut,
                    length_ticks: 0,
                }
            } else {
                transition
            },
        },
    }));
    ops.push(Op::ClipAddOp(ClipAddOp {
        clip,
        op: crate::generated::ClipAddOpOp::ClipAdd,
        section_id,
        track_id,
    }));

    if backward && let Some(following) = doc.arrangement.sections.first() {
        ops.push(Op::SectionSetTransitionOp(SectionSetTransitionOp {
            op: crate::generated::SectionSetTransitionOpOp::SectionSetTransition,
            section_id: following.id.clone(),
            transition: Transition {
                asset: None,
                kind: if fade > 0 {
                    TransitionKind::Crossfade
                } else {
                    TransitionKind::Cut
                },
                length_ticks: fade,
            },
        }));
    }

    Ok(OpBatch {
        author: BatchAuthor::SystemAuthor(SystemAuthor {
            kind: SystemAuthorKind::System,
            reason: "generate.extend".to_owned(),
        }),
        created_at: request.created_at.clone(),
        id: request.batch_id.clone(),
        intent: None,
        label: request.label.clone(),
        ops,
    })
}

/// Builds the op batch that fills an erased gap with generated audio (09 §4.3).
///
/// The batch adds the generated `Source` — placed in the gap range, so `analysis.apply` maps its
/// stems into that span only (02 §6.4) — the `generated` track when none exists yet, and one clip
/// per section the gap crosses. A gap that spans a section boundary is split at the boundary,
/// because a clip never bleeds into the next section (02 §3.5); the clips share the candidate's
/// source window, so the audio runs continuously across the join.
///
/// `start_offset_samples` is negative when the processed audio starts inside the left overlap and
/// that head is skipped; the clips also skip it. Its absolute value is recorded as the placement's
/// `srcStartSamples`, so the later stem mapping starts at the same sample. A positive start offset
/// or a negative end offset leaves a hole in the gap and is rejected (`GapNotCovered`).
///
/// ```
/// # use bragi_model::generated::{BatchId, ChannelCount, IsoDate, Project, ProvenanceKind, SourceId, TickRange};
/// # use bragi_model::placement::{FillPlacementRequest, GeneratedCandidate, fill_placement};
/// # let doc: Project = serde_json::from_value(serde_json::json!({
/// #     "schemaVersion": 1, "id": "prj_01",
/// #     "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
/// #     "sources": [], "analyses": {}, "tracks": [],
/// #     "arrangement": { "timebase": { "ppq": 960,
/// #         "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }],
/// #         "timeSignatures": [{ "bar": 0, "numerator": 4, "denominator": 4 }] },
/// #         "sections": [{ "id": "sec_a", "kind": "verse", "label": "Verse", "lengthTicks": 7680,
/// #             "lanes": {}, "transitionIn": { "kind": "cut", "lengthTicks": 0 } }],
/// #         "master": { "fx": [], "automation": [], "gainDb": 0 } }
/// # })).unwrap();
/// # let hash: bragi_model::generated::AssetHash = format!("sha256:{}", "a".repeat(64)).parse().unwrap();
/// # let candidate = GeneratedCandidate {
/// #     source_id: "src_fill".parse().unwrap(),
/// #     original_asset: hash.clone(), working_asset: hash, duration_samples: 192_000,
/// #     channels: ChannelCount::try_from(2).unwrap(), label: "Generated: fill".to_owned(),
/// #     provenance: bragi_model::generated::Provenance {
/// #         kind: ProvenanceKind::Generation, created_at: "2026-10-18T12:00:00Z".parse().unwrap(),
/// #         job_id: None, model: None, model_version: None, prompt: None },
/// # };
/// # let request = FillPlacementRequest {
/// #     gap_range: TickRange { start_tick: 1920, end_tick: 5760 },
/// #     candidate, start_offset_samples: -48_000, end_offset_samples: 48_000,
/// #     crossfade_ticks: 480, batch_id: "bat_fill".parse().unwrap(),
/// #     label: "Fill gap".to_owned(),
/// #     created_at: "2026-10-18T12:00:00Z".parse().unwrap(),
/// # };
/// let batch = fill_placement(&doc, &request).unwrap();
/// assert_eq!(batch.ops.len(), 3, "source, generated track, one clip");
/// ```
pub fn fill_placement(
    doc: &Project,
    request: &FillPlacementRequest,
) -> Result<OpBatch, PlacementError> {
    if request.candidate.duration_samples == 0 {
        return Err(PlacementError::EmptyCandidate);
    }
    let gap_start = request.gap_range.start_tick;
    let gap_end = request.gap_range.end_tick;
    if gap_start < 0 || gap_end <= gap_start || gap_end > crate::spans::total_ticks(doc) {
        return Err(PlacementError::OutsideSong);
    }
    if request.start_offset_samples > 0 || request.end_offset_samples < 0 {
        return Err(PlacementError::GapNotCovered);
    }
    let gap_samples = samples_between(doc, gap_start, gap_end);
    if gap_samples == 0 {
        return Err(PlacementError::EmptyGap);
    }
    // The processed audio starts `-start_offset` samples before the gap; the clip skips that head.
    let skip = request.start_offset_samples.unsigned_abs();
    let src_start = skip.min(request.candidate.duration_samples);
    let src_end = src_start
        .saturating_add(gap_samples)
        .min(request.candidate.duration_samples);
    if src_start >= src_end {
        return Err(PlacementError::NoAudio);
    }

    let spans = crate::spans::section_spans(doc);
    let anchor = spans
        .iter()
        .rposition(|span| span.start_tick <= gap_start)
        .ok_or(PlacementError::OutsideSong)?;
    let (track_id, add_track) = generated_track(doc, &request.candidate.source_id)?;

    let mut clips = Vec::new();
    for span in spans.iter().skip(anchor) {
        if span.start_tick >= gap_end {
            break;
        }
        let slice_start = gap_start.max(span.start_tick);
        let slice_end = gap_end.min(span.end_tick);
        if slice_end <= slice_start {
            continue;
        }
        let slice_src_start =
            src_start.saturating_add(samples_between(doc, gap_start, slice_start));
        let slice_src_end = src_start
            .saturating_add(samples_between(doc, gap_start, slice_end))
            .min(src_end);
        if slice_src_end <= slice_src_start {
            continue;
        }
        let local_start = slice_start - span.start_tick;
        let local_end = slice_end - span.start_tick;
        let child = format!("fill:{}:{}", span.id, track_id);
        let Some(clip_id) = clip_id(derived_id(
            "clp_",
            request.candidate.source_id.as_str(),
            &child,
        )) else {
            return Err(PlacementError::id(
                "clp_",
                request.candidate.source_id.as_str(),
                &child,
            ));
        };
        clips.push(ClipAddOp {
            clip: Clip {
                asset: request.candidate.working_asset.clone(),
                fade_curve: FadeCurve::EqualPower,
                fade_in_ticks: if slice_start == gap_start {
                    request.crossfade_ticks
                } else {
                    0
                },
                fade_out_ticks: if slice_end == gap_end {
                    request.crossfade_ticks
                } else {
                    0
                },
                fx: None,
                gain_db: 0.0,
                id: clip_id,
                pitch_semitones: 0.0,
                provenance: request.candidate.provenance.clone(),
                reverse: None,
                src_end: slice_src_end,
                src_start: slice_src_start,
                start: local_start,
                warp: warp_span(
                    doc,
                    span.start_tick,
                    local_start,
                    local_end,
                    slice_src_start,
                    slice_src_end,
                ),
            },
            op: crate::generated::ClipAddOpOp::ClipAdd,
            section_id: span.id.clone(),
            track_id: track_id.clone(),
        });
    }
    if clips.is_empty() {
        return Err(PlacementError::NoAudio);
    }

    let source = source_for(
        &request.candidate,
        SourcePlacement {
            range: Some(TickRange {
                start_tick: gap_start - spans[anchor].start_tick,
                end_tick: gap_end - spans[anchor].start_tick,
            }),
            section_id: spans[anchor].id.clone(),
            src_start_samples: Some(src_start),
        },
    );
    let mut ops = vec![Op::SourceAddOp(SourceAddOp {
        index: None,
        op: crate::generated::SourceAddOpOp::SourceAdd,
        source,
    })];
    if let Some(track) = add_track {
        ops.push(Op::TrackAddOp(TrackAddOp {
            index: None,
            op: crate::generated::TrackAddOpOp::TrackAdd,
            track,
        }));
    }
    ops.extend(clips.into_iter().map(Op::ClipAddOp));

    Ok(OpBatch {
        author: BatchAuthor::SystemAuthor(SystemAuthor {
            kind: SystemAuthorKind::System,
            reason: "generate.inpaint".to_owned(),
        }),
        created_at: request.created_at.clone(),
        id: request.batch_id.clone(),
        intent: None,
        label: request.label.clone(),
        ops,
    })
}

/// Builds the op batch that gives a section a generated transition (09 §4.4).
///
/// The batch adds the generated `Source` — placement-owned, so analysing it can never append a
/// baseline block or a lane clip, because it has none (02 §6.4) — and sets the incoming section's
/// `transitionIn` to `generated` with the working asset and `length_ticks`. The engine plays that
/// asset as an overlay centred on the boundary (03 §5.5). The asset stays in the track-free
/// master path, so the transition is heard whether or not any track has material across the join.
///
/// ```
/// # use bragi_model::generated::{BatchId, ChannelCount, Project, ProvenanceKind, SectionId, TickRange};
/// # use bragi_model::placement::{GeneratedCandidate, TransitionPlacementRequest, transition_placement};
/// # let doc: Project = serde_json::from_value(serde_json::json!({
/// #     "schemaVersion": 1, "id": "prj_01",
/// #     "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
/// #     "sources": [], "analyses": {}, "tracks": [],
/// #     "arrangement": { "timebase": { "ppq": 960,
/// #         "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }],
/// #         "timeSignatures": [{ "bar": 0, "numerator": 4, "denominator": 4 }] },
/// #         "sections": [
/// #             { "id": "sec_a", "kind": "verse", "label": "Verse", "lengthTicks": 3840,
/// #               "lanes": {}, "transitionIn": { "kind": "cut", "lengthTicks": 0 } },
/// #             { "id": "sec_b", "kind": "chorus", "label": "Chorus", "lengthTicks": 3840,
/// #               "lanes": {}, "transitionIn": { "kind": "cut", "lengthTicks": 0 } } ],
/// #         "master": { "fx": [], "automation": [], "gainDb": 0 } }
/// # })).unwrap();
/// # let hash: bragi_model::generated::AssetHash = format!("sha256:{}", "a".repeat(64)).parse().unwrap();
/// # let candidate = GeneratedCandidate {
/// #     source_id: "src_join".parse().unwrap(),
/// #     original_asset: hash.clone(), working_asset: hash, duration_samples: 96_000,
/// #     channels: ChannelCount::try_from(2).unwrap(), label: "Generated: transition".to_owned(),
/// #     provenance: bragi_model::generated::Provenance {
/// #         kind: ProvenanceKind::Generation, created_at: "2026-10-18T12:00:00Z".parse().unwrap(),
/// #         job_id: None, model: None, model_version: None, prompt: None },
/// # };
/// # let request = TransitionPlacementRequest {
/// #     section_id: "sec_b".parse::<SectionId>().unwrap(), candidate, length_ticks: 1920,
/// #     batch_id: "bat_join".parse().unwrap(), label: "Smooth with AI".to_owned(),
/// #     created_at: "2026-10-18T12:00:00Z".parse().unwrap(),
/// # };
/// let batch = transition_placement(&doc, &request).unwrap();
/// assert_eq!(batch.ops.len(), 2, "source, section.set_transition");
/// ```
pub fn transition_placement(
    doc: &Project,
    request: &TransitionPlacementRequest,
) -> Result<OpBatch, PlacementError> {
    if request.candidate.duration_samples == 0 {
        return Err(PlacementError::EmptyCandidate);
    }
    if request.length_ticks == 0 {
        return Err(PlacementError::NoLength);
    }
    let spans = crate::spans::section_spans(doc);
    let Some(span) = spans.iter().find(|span| span.id == request.section_id) else {
        return Err(PlacementError::NoBoundary(request.section_id.clone()));
    };
    if span.index == 0 {
        return Err(PlacementError::NoBoundary(request.section_id.clone()));
    }

    let source = source_for(
        &request.candidate,
        SourcePlacement {
            range: None,
            section_id: request.section_id.clone(),
            src_start_samples: None,
        },
    );
    let ops = vec![
        Op::SourceAddOp(SourceAddOp {
            index: None,
            op: crate::generated::SourceAddOpOp::SourceAdd,
            source,
        }),
        Op::SectionSetTransitionOp(SectionSetTransitionOp {
            op: crate::generated::SectionSetTransitionOpOp::SectionSetTransition,
            section_id: request.section_id.clone(),
            transition: Transition {
                asset: Some(request.candidate.working_asset.clone()),
                kind: TransitionKind::Generated,
                length_ticks: request.length_ticks,
            },
        }),
    ];
    Ok(OpBatch {
        author: BatchAuthor::SystemAuthor(SystemAuthor {
            kind: SystemAuthorKind::System,
            reason: "generate.transition".to_owned(),
        }),
        created_at: request.created_at.clone(),
        id: request.batch_id.clone(),
        intent: None,
        label: request.label.clone(),
        ops,
    })
}

/// The `Source` record of a generated candidate, with its placement.
fn source_for(candidate: &GeneratedCandidate, placement: SourcePlacement) -> Source {
    Source {
        channels: candidate.channels.clone(),
        duration_samples: candidate.duration_samples,
        id: candidate.source_id.clone(),
        kind: SourceKind::Generated,
        label: candidate.label.clone(),
        original_asset: candidate.original_asset.clone(),
        placement: Some(placement),
        provenance: Some(candidate.provenance.clone()),
        working_asset: candidate.working_asset.clone(),
    }
}

/// The boolean is `true` when the track has to be added by the batch.
fn generated_track(
    doc: &Project,
    source_id: &SourceId,
) -> Result<(TrackId, Option<Track>), PlacementError> {
    if let Some(track) = doc
        .tracks
        .iter()
        .find(|track| track.role == StemRole::Generated)
    {
        return Ok((track.id.clone(), None));
    }
    let Some(id) = track_id(derived_id("trk_", source_id.as_str(), "generated")) else {
        return Err(PlacementError::id("trk_", source_id.as_str(), "generated"));
    };
    Ok((
        id.clone(),
        Some(Track {
            color: role_color(StemRole::Generated),
            fx: FxChain(Vec::new()),
            gain_db: 0.0,
            hidden: false,
            id,
            mute: false,
            name: role_name(&StemRole::Generated).to_owned(),
            origin: Some(TrackOrigin {
                source_id: source_id.clone(),
                stem: Some(StemRole::Generated),
            }),
            pan: 0.0,
            role: StemRole::Generated,
            solo: false,
        }),
    ))
}

/// The ticks covered by `bars` bars starting at the bar that contains `tick`.
fn bars_ticks(doc: &Project, tick: i64, bars: u32) -> i64 {
    let ppq = *doc.arrangement.timebase.ppq;
    let signatures = &doc.arrangement.timebase.time_signatures;
    let (first, _) = ticks_to_bar_beat(doc, tick);
    let mut length = 0_i64;
    for offset in 0..u64::from(bars) {
        length = length.saturating_add(bar_ticks(signatures, first.saturating_add(offset), ppq));
    }
    length.max(1)
}

/// Samples between two absolute ticks at 48 kHz.
fn samples_between(doc: &Project, start: i64, end: i64) -> u64 {
    let tempo = TempoCtx::from_project(doc);
    let seconds = tempo.ticks_to_seconds(end) - tempo.ticks_to_seconds(start);
    if !seconds.is_finite() || seconds <= 0.0 {
        return 0;
    }
    (seconds * f64::from(INTERNAL_SAMPLE_RATE_HZ)).round() as u64
}

/// A beat grid through the clip's start, every bar line inside it and its end, so a tempo change
/// across the new section is followed rather than linearly interpolated.
fn warp(doc: &Project, section_start: i64, length: i64, src_start: u64, src_end: u64) -> Warp {
    warp_span(doc, section_start, 0, length, src_start, src_end)
}

/// [`warp`] for a clip that starts at `local_start` inside its section: the anchors are still
/// section-relative, and the source position advances from `src_start`.
fn warp_span(
    doc: &Project,
    section_start: i64,
    local_start: i64,
    local_end: i64,
    src_start: u64,
    src_end: u64,
) -> Warp {
    let mut anchors = vec![WarpAnchor {
        src_sample: src_start,
        tick: local_start,
    }];
    let mut last_sample = src_start;
    let mut last_tick = local_start;
    let span_start = section_start.saturating_add(local_start);
    let span_end = section_start.saturating_add(local_end);
    for bar in bar_lines_between(doc, span_start, span_end) {
        let tick = bar - section_start;
        let sample = src_start.saturating_add(samples_between(doc, span_start, bar));
        if sample > last_sample && sample < src_end && tick > last_tick && tick < local_end {
            anchors.push(WarpAnchor {
                src_sample: sample,
                tick,
            });
            last_sample = sample;
            last_tick = tick;
        }
    }
    anchors.push(WarpAnchor {
        src_sample: src_end,
        tick: local_end,
    });
    Warp::Beatgrid(WarpBeatgrid {
        anchors,
        mode: WarpBeatgridMode::Beatgrid,
    })
}

/// Every bar line strictly inside `(start, end)`.
fn bar_lines_between(doc: &Project, start: i64, end: i64) -> Vec<i64> {
    let ppq = *doc.arrangement.timebase.ppq;
    let signatures = &doc.arrangement.timebase.time_signatures;
    let (start_bar, beat) = ticks_to_bar_beat(doc, start);
    let mut bar = if beat > 0.0 {
        start_bar.saturating_add(1)
    } else {
        start_bar
    };
    let mut tick = bar_beat_to_ticks(doc, bar, 0.0);
    if tick <= start {
        bar = bar.saturating_add(1);
        tick = bar_beat_to_ticks(doc, bar, 0.0);
    }
    let mut lines = Vec::new();
    // A document is not bounded; cap the loop rather than allocate without limit on a bad input.
    while tick < end && lines.len() < 1_000_000 {
        if tick > start {
            lines.push(tick);
        }
        tick = tick.saturating_add(bar_ticks(signatures, bar, ppq).max(1));
        bar = bar.saturating_add(1);
    }
    lines
}

/// "Verse 2" for a recurring kind, "Intro" when it is new.
fn section_label(doc: &Project, kind: SectionKind) -> String {
    let count = doc
        .arrangement
        .sections
        .iter()
        .filter(|section| section.kind == kind)
        .count();
    let label = kind_label(kind);
    if count == 0 {
        label.to_owned()
    } else {
        format!("{label} {}", count + 1)
    }
}

fn section_id(text: String) -> Option<SectionId> {
    text.parse().ok()
}

fn track_id(text: String) -> Option<TrackId> {
    text.parse().ok()
}

fn clip_id(text: String) -> Option<ClipId> {
    text.parse().ok()
}
