//! Placement of an accepted extend candidate: the op batch that turns generated audio into a
//! source, a section and a clip (`specs/09-generation.md` §4.2, `specs/02-song-model.md` §4.2).
//!
//! The function is pure: it reads the document, never changes it, and returns the exact batch the
//! caller commits as a candidate (`specs/02-song-model.md` §7). The model applies the batch, so
//! placement is undoable like any other edit.
//!
//! A forward extend appends the new section after the last one; a backward extend inserts it at
//! index 0, which is the context range start (0). When the context ends on the last full bar line
//! before a mid-bar song end, the clip's source range advances by that partial bar, so the new
//! audio continues at the context end and the partial bar plays from the previous section.

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
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtendCandidate {
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
    pub candidate: ExtendCandidate,
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
/// # use bragi_model::placement::{ExtendCandidate, ExtendDirection, ExtendPlacementRequest, extend_placement};
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
/// #     candidate: ExtendCandidate {
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
            section_id: section_id.clone(),
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
    let mut anchors = vec![WarpAnchor {
        src_sample: src_start,
        tick: 0,
    }];
    let mut last_sample = src_start;
    let mut last_tick = 0_i64;
    let end = section_start.saturating_add(length);
    for bar in bar_lines_between(doc, section_start, end) {
        let tick = bar - section_start;
        let sample = src_start.saturating_add(samples_between(doc, section_start, bar));
        if sample > last_sample && sample < src_end && tick > last_tick {
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
        tick: length,
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
