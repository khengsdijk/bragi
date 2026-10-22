//! Tick-accurate changed spans: where two documents' lane audio differs.
//!
//! `diff` answers "what must the engine rebuild" and sends a changed section whole. Region
//! discipline needs the finer answer (`specs/06-ai-planner.md` §7): the ticks whose **audible
//! lane content** actually changed between two documents, per track and section. That is what
//! [`changed_spans`] reports.
//!
//! The comparison is computed from the model's own clip geometry ([`crate::clipmath`]) and tempo
//! map, not from the ops that produced the change: an op whose effect lands somewhere else is
//! caught, and a clip that `region.clear` split into two clips with unchanged alignment is equal
//! outside the cleared ticks.
//!
//! # The contract
//!
//! - Only documents with the **same section set, order and lengths** compare per section. When
//!   they differ the function is conservative: every section of `next` is reported whole, for
//!   every track. The planner treats such a change as song-wide anyway.
//! - Clips compare on audible content: the covering clips keyed by asset, the source sample at
//!   the interval start, gain, pitch, reverse, warp mode/ratio, clip fx (ignoring fx IDs) and the
//!   fade state at the interval start. Adjacent changed intervals merge per track; a merged
//!   interval whose only difference is fade state gets `edgeFadeOnly: true` (the ~10 ms
//!   [`crate::apply::CUT_FADE_SECS`] fade `region.clear` adds just outside its region).
//! - Lane automation is section-relative. A changed target spans from the point before the first
//!   differing point to the point after the last one (clamped to the section); a target that was
//!   added or removed spans its first to its last point.
//! - A clip-level fx change spans the clip's extent, **except** when the only fx change on an
//!   otherwise unchanged clip is entries added to its chain. An fx added at a neutral setting only
//!   bites where the automation curve moves it (`specs/06-ai-planner.md` §7), so the clip's own
//!   extent is not counted then and only the automation spans are.
//! - A clip whose asset metadata is missing (`clip_end_local` returns `None`) falls back to the
//!   whole section for that track, conservatively.
//!
//! ```
//! # use bragi_model::{changed_spans, AssetIndex};
//! # use bragi_model::generated::Project;
//! # let doc: Project = serde_json::from_value(serde_json::json!({
//! #     "schemaVersion": 1, "id": "prj_01",
//! #     "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
//! #     "sources": [], "analyses": {},
//! #     "tracks": [{ "id": "trk_01", "name": "Mix", "role": "full_mix", "color": "#8A8F98",
//! #                  "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": [] }],
//! #     "arrangement": { "timebase": { "ppq": 960,
//! #         "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }],
//! #         "timeSignatures": [{ "bar": 0, "numerator": 4, "denominator": 4 }] },
//! #         "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } }
//! # })).unwrap();
//! assert!(changed_spans(&doc, &doc, &AssetIndex::new()).is_empty());
//! ```

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::assets::AssetIndex;
use crate::clipmath::clip_end_local;
use crate::generated::{
    Automation, AutomationPoint, Clip, FadeCurve, FxChain, Lane, Project, SectionId, TrackId, Warp,
};
use crate::spans::section_spans;
use crate::time::TempoCtx;

/// One interval in arrangement ticks whose lane content differs between two documents.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedSpan {
    /// The track whose lane changed.
    pub track_id: TrackId,
    /// The section the interval lies in.
    pub section_id: SectionId,
    /// Absolute start tick (inclusive).
    pub start_tick: i64,
    /// Absolute end tick (exclusive).
    pub end_tick: i64,
    /// True when the only audible difference is fade state at the interval's edges (a cut's short
    /// fade), so a region check may ignore it when it touches the region.
    pub edge_fade_only: bool,
}

impl ChangedSpan {
    fn new(
        track_id: &TrackId,
        section_id: &SectionId,
        start_tick: i64,
        end_tick: i64,
        edge_fade_only: bool,
    ) -> Self {
        Self {
            track_id: track_id.clone(),
            section_id: section_id.clone(),
            start_tick,
            end_tick,
            edge_fade_only,
        }
    }
}

/// The intervals whose audible lane content differs between `prev` and `next`
/// (`specs/06-ai-planner.md` §7).
///
/// `assets` supplies the sample rates `clip_end_local` and `src_sample_at_local` need; callers
/// that hold both documents' asset indexes should merge them. Documents with a different section
/// set, order or length are reported section-wide per track (the crate's conservative fallback).
///
/// See the module documentation for what counts as audible content.
#[must_use]
pub fn changed_spans(prev: &Project, next: &Project, assets: &AssetIndex) -> Vec<ChangedSpan> {
    let prev_spans = section_spans(prev);
    let next_spans = section_spans(next);
    let same_sections = prev_spans.len() == next_spans.len()
        && prev_spans.iter().zip(&next_spans).all(|(a, b)| {
            a.id == b.id && a.start_tick == b.start_tick && a.length_ticks == b.length_ticks
        });
    if !same_sections {
        return conservative_spans(prev, next);
    }

    let prev_tempo = TempoCtx::from_project(prev);
    let next_tempo = TempoCtx::from_project(next);
    let mut out = Vec::new();
    for span in &prev_spans {
        let section = &prev.arrangement.sections[span.index];
        let Some(next_span) = next_spans.iter().find(|candidate| candidate.id == span.id) else {
            continue;
        };
        let next_section = &next.arrangement.sections[next_span.index];
        let tracks: BTreeSet<TrackId> = section
            .lanes
            .keys()
            .chain(next_section.lanes.keys())
            .cloned()
            .collect();
        for track_id in tracks {
            let prev_lane = section.lanes.get(&track_id);
            let next_lane = next_section.lanes.get(&track_id);
            let mut intervals = lane_intervals(
                prev_lane,
                next_lane,
                &prev_tempo,
                &next_tempo,
                assets,
                span.start_tick,
                span.end_tick,
            );
            intervals.sort_by_key(|interval| (interval.start, interval.end));
            for interval in merge(intervals) {
                out.push(ChangedSpan::new(
                    &track_id,
                    &span.id,
                    interval.start,
                    interval.end,
                    interval.edge_fade_only,
                ));
            }
        }
    }
    out
}

/// Whole-section spans for every track, used when the two documents are not section-comparable.
fn conservative_spans(prev: &Project, next: &Project) -> Vec<ChangedSpan> {
    let tracks: BTreeSet<TrackId> = prev
        .tracks
        .iter()
        .chain(&next.tracks)
        .map(|track| track.id.clone())
        .collect();
    let mut out = Vec::new();
    for span in section_spans(next) {
        for track_id in &tracks {
            out.push(ChangedSpan::new(
                track_id,
                &span.id,
                span.start_tick,
                span.end_tick,
                false,
            ));
        }
    }
    out
}

/// One changed interval inside a section, with its fade-only flag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Interval {
    start: i64,
    end: i64,
    edge_fade_only: bool,
}

/// The changed intervals of one lane pair inside a section.
fn lane_intervals(
    prev_lane: Option<&Lane>,
    next_lane: Option<&Lane>,
    prev_tempo: &TempoCtx<'_>,
    next_tempo: &TempoCtx<'_>,
    assets: &AssetIndex,
    section_start: i64,
    section_end: i64,
) -> Vec<Interval> {
    if prev_lane.is_none() && next_lane.is_none() {
        return Vec::new();
    }
    let mut intervals = Vec::new();

    // Missing asset metadata cannot be geometry-checked; report the section rather than guess.
    let prev_known = prev_lane
        .into_iter()
        .flat_map(|lane| &lane.clips)
        .all(|clip| clip_end_local(clip, prev_tempo, assets, section_start).is_some());
    let next_known = next_lane
        .into_iter()
        .flat_map(|lane| &lane.clips)
        .all(|clip| clip_end_local(clip, next_tempo, assets, section_start).is_some());
    if !prev_known || !next_known {
        return vec![Interval {
            start: section_start,
            end: section_end,
            edge_fade_only: false,
        }];
    }

    intervals.extend(clip_intervals(
        prev_lane,
        next_lane,
        prev_tempo,
        next_tempo,
        assets,
        section_start,
        section_end,
    ));
    intervals.extend(automation_intervals(
        prev_lane,
        next_lane,
        section_start,
        section_end,
    ));
    intervals
}

/// The changed intervals from clip content and fade state.
fn clip_intervals(
    prev_lane: Option<&Lane>,
    next_lane: Option<&Lane>,
    prev_tempo: &TempoCtx<'_>,
    next_tempo: &TempoCtx<'_>,
    assets: &AssetIndex,
    section_start: i64,
    section_end: i64,
) -> Vec<Interval> {
    let prev_clips: &[Clip] = prev_lane.map_or(&[], |lane| lane.clips.as_slice());
    let next_clips: &[Clip] = next_lane.map_or(&[], |lane| lane.clips.as_slice());
    // Additions to an otherwise unchanged clip's chain are the neutral-fx pattern: they bite
    // only where the automation moves, so both versions ignore that chain in the clip compare.
    let ignore = added_fx_clips(
        next_clips,
        next_tempo,
        prev_clips,
        prev_tempo,
        assets,
        section_start,
    );

    let mut boundaries = BTreeSet::new();
    boundaries.insert(section_start);
    boundaries.insert(section_end);
    for clip in prev_clips {
        if let Some(end) = clip_end_local(clip, prev_tempo, assets, section_start) {
            add_clip_boundaries(&mut boundaries, clip, end, section_start, section_end);
        }
    }
    for clip in next_clips {
        if let Some(end) = clip_end_local(clip, next_tempo, assets, section_start) {
            add_clip_boundaries(&mut boundaries, clip, end, section_start, section_end);
        }
    }

    let mut out = Vec::new();
    let ticks: Vec<i64> = boundaries.into_iter().collect();
    for pair in ticks.windows(2) {
        let [start, end] = [pair[0], pair[1]];
        if start >= end {
            continue;
        }
        let local = start - section_start;
        let prev_full = signature(
            prev_clips,
            prev_tempo,
            assets,
            section_start,
            local,
            &ignore,
            true,
        );
        let next_full = signature(
            next_clips,
            next_tempo,
            assets,
            section_start,
            local,
            &ignore,
            true,
        );
        if prev_full == next_full {
            continue;
        }
        let prev_content = signature(
            prev_clips,
            prev_tempo,
            assets,
            section_start,
            local,
            &ignore,
            false,
        );
        let next_content = signature(
            next_clips,
            next_tempo,
            assets,
            section_start,
            local,
            &ignore,
            false,
        );
        out.push(Interval {
            start,
            end,
            edge_fade_only: prev_content == next_content,
        });
    }
    out
}

/// Adds a clip's start/end and fade boundaries, clamped to the section.
fn add_clip_boundaries(
    boundaries: &mut BTreeSet<i64>,
    clip: &Clip,
    end_local: i64,
    section_start: i64,
    section_end: i64,
) {
    let clip_start = section_start + clip.start;
    let clip_end = section_start + end_local;
    let fade_in_end =
        section_start + clip.start + i64::try_from(clip.fade_in_ticks).unwrap_or(i64::MAX);
    let fade_out_start =
        section_start + end_local - i64::try_from(clip.fade_out_ticks).unwrap_or(i64::MAX);
    for tick in [clip_start, clip_end, fade_in_end, fade_out_start] {
        let clamped = tick.clamp(section_start, section_end);
        boundaries.insert(clamped);
    }
}

/// The clip IDs whose only change is fx entries appended to an unchanged clip.
///
/// `this` is the version whose extra entries are ignored; `other` is the version that must be a
/// prefix of it. The clip must be identical in every other field.
fn added_fx_clips(
    this: &[Clip],
    this_tempo: &TempoCtx<'_>,
    other: &[Clip],
    other_tempo: &TempoCtx<'_>,
    assets: &AssetIndex,
    section_start: i64,
) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for clip in this {
        let Some(previous) = other.iter().find(|candidate| candidate.id == clip.id) else {
            continue;
        };
        let this_fx = fx_entries(clip.fx.as_ref());
        let previous_fx = fx_entries(previous.fx.as_ref());
        if this_fx.len() <= previous_fx.len()
            || !this_fx.starts_with(&previous_fx)
            || !clips_equal_without_fx(
                clip,
                this_tempo,
                previous,
                other_tempo,
                assets,
                section_start,
            )
        {
            continue;
        }
        out.insert(clip.id.to_string());
    }
    out
}

/// Whether two clips are equal in every audible field except their fx chain.
fn clips_equal_without_fx(
    a: &Clip,
    a_tempo: &TempoCtx<'_>,
    b: &Clip,
    b_tempo: &TempoCtx<'_>,
    assets: &AssetIndex,
    section_start: i64,
) -> bool {
    let end = clip_end_local(a, a_tempo, assets, section_start);
    end == clip_end_local(b, b_tempo, assets, section_start)
        && a.asset == b.asset
        && a.src_start == b.src_start
        && a.src_end == b.src_end
        && a.start == b.start
        && a.gain_db.to_bits() == b.gain_db.to_bits()
        && a.pitch_semitones.to_bits() == b.pitch_semitones.to_bits()
        && a.reverse == b.reverse
        && a.fade_in_ticks == b.fade_in_ticks
        && a.fade_out_ticks == b.fade_out_ticks
        && a.fade_curve == b.fade_curve
        && warp_key(&a.warp) == warp_key(&b.warp)
}

/// One audible clip covering an interval, with the fade state at its start.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct ClipSig {
    asset: String,
    sample: u64,
    gain_bits: u64,
    pitch_bits: u64,
    reverse: bool,
    warp: String,
    fx: String,
    fade_in: Option<(u64, FadeCurve)>,
    fade_out: Option<(u64, FadeCurve)>,
}

/// The audible content of `clips` at section-relative tick `local`.
fn signature(
    clips: &[Clip],
    tempo: &TempoCtx<'_>,
    assets: &AssetIndex,
    section_start: i64,
    local: i64,
    ignore_fx: &BTreeSet<String>,
    with_fade: bool,
) -> Vec<ClipSig> {
    let mut out: Vec<ClipSig> = clips
        .iter()
        .filter_map(|clip| {
            let end = clip_end_local(clip, tempo, assets, section_start)?;
            if !(clip.start <= local && local < end) {
                return None;
            }
            let sample =
                crate::clipmath::src_sample_at_local(clip, tempo, assets, section_start, local)
                    .unwrap_or(u64::MAX);
            let mut fade_in = None;
            let mut fade_out = None;
            if with_fade {
                let fade_in_end =
                    clip.start + i64::try_from(clip.fade_in_ticks).unwrap_or(i64::MAX);
                if local < fade_in_end {
                    fade_in = Some((clip.fade_in_ticks, clip.fade_curve));
                }
                let fade_out_start = end - i64::try_from(clip.fade_out_ticks).unwrap_or(i64::MAX);
                if local >= fade_out_start {
                    fade_out = Some((clip.fade_out_ticks, clip.fade_curve));
                }
            }
            Some(ClipSig {
                asset: clip.asset.to_string(),
                sample,
                gain_bits: clip.gain_db.to_bits(),
                pitch_bits: clip.pitch_semitones.to_bits(),
                reverse: clip.reverse.unwrap_or(false),
                warp: warp_key(&clip.warp),
                fx: if ignore_fx.contains(clip.id.as_str()) {
                    String::new()
                } else {
                    fx_key(clip.fx.as_ref())
                },
                fade_in,
                fade_out,
            })
        })
        .collect();
    out.sort();
    out
}

/// The warp mode and ratio, which is all the interval comparison needs.
fn warp_key(warp: &Warp) -> String {
    match warp {
        Warp::None(_) => "none".to_string(),
        Warp::Beatgrid(_) => "beatgrid".to_string(),
        Warp::Stretch(stretch) => format!("stretch:{:016x}", stretch.ratio.to_bits()),
    }
}

/// The audible part of a clip fx chain: type, params, bypass and sidechain, without fx IDs.
fn fx_key(chain: Option<&FxChain>) -> String {
    fx_entries(chain)
        .iter()
        .map(|entry| {
            format!(
                "{}|{:?}|{}|{}",
                entry.kind, entry.params, entry.bypass, entry.sidechain
            )
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// The comparable entries of a clip fx chain.
fn fx_entries(chain: Option<&FxChain>) -> Vec<FxEntry> {
    chain
        .into_iter()
        .flat_map(|chain| chain.0.iter())
        .map(|fx| {
            let mut params: Vec<(String, u64)> = fx
                .params
                .iter()
                .map(|(name, value)| (name.clone(), value.to_bits()))
                .collect();
            params.sort();
            FxEntry {
                kind: fx.type_.to_string(),
                params,
                bypass: fx.bypass,
                sidechain: fx
                    .sidechain_source
                    .as_ref()
                    .map(ToString::to_string)
                    .unwrap_or_default(),
            }
        })
        .collect()
}

/// One clip fx entry without its ID.
#[derive(Clone, Debug, PartialEq, Eq)]
struct FxEntry {
    kind: String,
    params: Vec<(String, u64)>,
    bypass: bool,
    sidechain: String,
}

/// The changed intervals of a lane's automation, in arrangement ticks.
fn automation_intervals(
    prev_lane: Option<&Lane>,
    next_lane: Option<&Lane>,
    section_start: i64,
    section_end: i64,
) -> Vec<Interval> {
    let prev = automation_map(prev_lane);
    let next = automation_map(next_lane);
    let targets: BTreeSet<&String> = prev.keys().chain(next.keys()).collect();
    let mut out = Vec::new();
    for target in targets {
        let before = prev.get(target).copied();
        let after = next.get(target).copied();
        if points_equal(before, after) {
            continue;
        }
        let Some((start, end)) = automation_window(before, after) else {
            continue;
        };
        let start = (section_start + start).clamp(section_start, section_end);
        let end = (section_start + end).clamp(section_start, section_end);
        out.push(Interval {
            start: start.min(end),
            end: start.max(end),
            edge_fade_only: false,
        });
    }
    out
}

/// The points of every automation target in a lane.
fn automation_map(lane: Option<&Lane>) -> BTreeMap<String, &[AutomationPoint]> {
    lane.map(|lane| {
        lane.automation
            .0
            .iter()
            .map(|Automation { target, points }| (target.to_string(), points.0.as_slice()))
            .collect()
    })
    .unwrap_or_default()
}

/// Whether two point lists are equal (or both absent) as far as this comparison is concerned.
fn points_equal(before: Option<&[AutomationPoint]>, after: Option<&[AutomationPoint]>) -> bool {
    match (before, after) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| points_match(x, y))
        }
        _ => false,
    }
}

fn points_match(a: &AutomationPoint, b: &AutomationPoint) -> bool {
    a.tick == b.tick && a.value.to_bits() == b.value.to_bits() && a.curve == b.curve
}

/// The section-relative span from the point before the first difference to the point after the
/// last one; an added or removed target spans its first to its last point.
fn automation_window(
    before: Option<&[AutomationPoint]>,
    after: Option<&[AutomationPoint]>,
) -> Option<(i64, i64)> {
    match (before, after) {
        (Some(points), None) | (None, Some(points)) => {
            let first = points.first()?.tick;
            let last = points.last()?.tick;
            Some((first.min(last), first.max(last)))
        }
        (Some(a), Some(b)) => {
            let prefix = a
                .iter()
                .zip(b)
                .take_while(|(x, y)| points_match(x, y))
                .count();
            let max_suffix = a.len().min(b.len()).saturating_sub(prefix);
            let suffix = a
                .iter()
                .rev()
                .zip(b.iter().rev())
                .take(max_suffix)
                .take_while(|(x, y)| points_match(x, y))
                .count();
            let first_old = a.get(prefix)?;
            let first_new = b.get(prefix)?;
            let last_old_index = a.len().saturating_sub(suffix + 1);
            let last_new_index = b.len().saturating_sub(suffix + 1);
            let last_old = a.get(last_old_index)?;
            let last_new = b.get(last_new_index)?;
            let start = if prefix > 0 {
                a.get(prefix - 1)?.tick
            } else {
                first_old.tick.min(first_new.tick)
            };
            let end = if suffix > 0 {
                a.get(a.len() - suffix).map_or(last_old.tick, |point| {
                    point.tick.max(
                        b.get(b.len() - suffix)
                            .map_or(point.tick, |other| other.tick),
                    )
                })
            } else {
                last_old.tick.max(last_new.tick)
            };
            Some((start.min(end), start.max(end)))
        }
        (None, None) => None,
    }
}

/// Merges adjacent intervals with the same fade-only flag; an overlap with a content interval
/// keeps the content flag.
fn merge(mut intervals: Vec<Interval>) -> Vec<Interval> {
    intervals.sort_by_key(|interval| (interval.start, interval.end));
    let mut out: Vec<Interval> = Vec::new();
    for interval in intervals {
        match out.last_mut() {
            Some(last)
                if interval.start < last.end && interval.edge_fade_only != last.edge_fade_only =>
            {
                last.end = last.end.max(interval.end);
                last.edge_fade_only = false;
            }
            Some(last)
                if interval.edge_fade_only == last.edge_fade_only && interval.start <= last.end =>
            {
                last.end = last.end.max(interval.end);
            }
            _ => out.push(interval),
        }
    }
    out
}
