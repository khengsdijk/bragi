//! Applying op batches: the only way a song document changes
//! (`specs/02-song-model.md` §4, `specs/13-agent-guide.md` §1).
//!
//! [`apply`] clones the document, runs every op in order, enforces the AI-locked-section rule
//! (invariant 6), and re-validates the result (invariants 1–5 and 7). A batch is atomic: it either
//! applies fully or returns an [`ApplyError`] with the original document untouched.
//!
//! Everything a single op can get wrong — a missing target, an index past the end, an FX ID that
//! already exists — is reported per-op with that op's index. Everything the *batch* can get wrong
//! is reported as an invariant failure.

use std::collections::{BTreeSet, HashMap};

use crate::assets::AssetIndex;
use crate::canonical::derived_id;
use crate::clipmath::{clip_end_local, src_sample_at_local};
use crate::error::{ApplyError, ValidationCode, ValidationError};
use crate::generated::{
    All, Automation, AutomationClearOp, AutomationList, AutomationPoints, AutomationScope,
    AutomationSetOp, AutomationTarget, BatchAuthor, Clip, ClipAddOp, ClipId, ClipPatch,
    ClipRemoveOp, ClipReplaceOp, ClipSplitOp, ClipUpdateOp, FadeCurve, FxAddOp, FxChain, FxId,
    FxRemoveOp, FxReorderOp, FxScope, FxUpdateOp, KeyTransposeOp, Lane, LaneMap, Op, OpBatch,
    Project, ProjectSetMetaOp, RegionClearOp, SectionDuplicateOp, SectionId, SectionInsertOp,
    SectionInstance, SectionMergeOp, SectionMoveOp, SectionPatch, SectionRemoveOp,
    SectionResizeMode, SectionResizeOp, SectionSetTransitionOp, SectionSplitOp, SectionUpdateOp,
    TempoSetOp, Track, TrackAddOp, TrackId, TrackPatch, TrackRemoveOp, TrackUpdateOp, Transition,
    TransitionKind, TransposeScope, Warp, WarpStretch, WarpStretchMode,
};
use crate::region::resolve_region;
use crate::spans::{SectionSpan, section_spans};
use crate::time::{TempoCtx, bar_ticks, ticks_to_bar_beat};
use crate::validate::validate;

/// The short fade `region.clear` and `section.resize` add at a cut, in seconds (02 §5.4 uses 10 ms
/// at `region.adopt`'s boundaries).
pub const CUT_FADE_SECS: f64 = 0.01;

/// Applies `batch` to `doc`, returning a new document.
///
/// `assets` supplies the `AssetMeta` the invariants need. On any failure the document is unchanged
/// (the function works on a clone).
///
/// ```
/// # use bragi_model::{apply, AssetIndex};
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
/// let batch: OpBatch = serde_json::from_value(serde_json::json!({
///     "id": "bat_01", "label": "Rename", "createdAt": "2026-10-18T12:00:00Z",
///     "author": { "kind": "user" },
///     "ops": [{ "op": "project.set_meta", "title": "New title" }]
/// })).unwrap();
/// let next = apply(&doc, &batch, &AssetIndex::new()).unwrap();
/// assert_eq!(next.meta.title, "New title");
/// ```
pub fn apply(doc: &Project, batch: &OpBatch, assets: &AssetIndex) -> Result<Project, ApplyError> {
    let mut next = doc.clone();
    for (index, op) in batch.ops.iter().enumerate() {
        apply_op(&mut next, op, assets, index)?;
    }
    if matches!(batch.author, BatchAuthor::AiAuthor(_)) {
        check_locked_sections(doc, &next, batch.ops.len().saturating_sub(1))?;
    }
    if let Err(errors) = validate(&next, assets) {
        return Err(ApplyError::Invariants(errors));
    }
    Ok(next)
}

fn invalid(op_index: usize, code: ValidationCode, message: impl Into<String>) -> ApplyError {
    ApplyError::Op(ValidationError::new(op_index, code, message))
}

fn apply_op(
    doc: &mut Project,
    op: &Op,
    assets: &AssetIndex,
    op_index: usize,
) -> Result<(), ApplyError> {
    match op {
        Op::ProjectSetMetaOp(payload) => apply_set_meta(doc, payload),
        Op::TrackAddOp(payload) => apply_track_add(doc, payload, op_index),
        Op::TrackRemoveOp(payload) => apply_track_remove(doc, payload, op_index),
        Op::TrackUpdateOp(payload) => apply_track_update(doc, payload, op_index),
        Op::FxAddOp(payload) => apply_fx_add(doc, payload, op_index),
        Op::FxRemoveOp(payload) => apply_fx_remove(doc, payload, op_index),
        Op::FxReorderOp(payload) => apply_fx_reorder(doc, payload, op_index),
        Op::FxUpdateOp(payload) => apply_fx_update(doc, payload, op_index),
        Op::SectionInsertOp(payload) => apply_section_insert(doc, payload, op_index),
        Op::SectionRemoveOp(payload) => apply_section_remove(doc, payload, op_index),
        Op::SectionMoveOp(payload) => apply_section_move(doc, payload, op_index),
        Op::SectionDuplicateOp(payload) => apply_section_duplicate(doc, payload, op_index),
        Op::SectionResizeOp(payload) => apply_section_resize(doc, payload, assets, op_index),
        Op::SectionSplitOp(payload) => apply_section_split(doc, payload, assets, op_index),
        Op::SectionMergeOp(payload) => apply_section_merge(doc, payload, op_index),
        Op::SectionUpdateOp(payload) => apply_section_update(doc, payload, op_index),
        Op::SectionSetTransitionOp(payload) => apply_section_set_transition(doc, payload, op_index),
        Op::ClipAddOp(payload) => apply_clip_add(doc, payload, op_index),
        Op::ClipUpdateOp(payload) => apply_clip_update(doc, payload, op_index),
        Op::ClipRemoveOp(payload) => apply_clip_remove(doc, payload, op_index),
        Op::ClipReplaceOp(payload) => apply_clip_replace(doc, payload, op_index),
        Op::ClipSplitOp(payload) => apply_clip_split(doc, payload, assets, op_index),
        Op::AutomationSetOp(payload) => apply_automation_set(doc, payload, op_index),
        Op::AutomationClearOp(payload) => apply_automation_clear(doc, payload, op_index),
        Op::TempoSetOp(payload) => apply_tempo_set(doc, payload),
        Op::KeyTransposeOp(payload) => apply_key_transpose(doc, payload, assets),
        Op::RegionClearOp(payload) => apply_region_clear(doc, payload, assets),
        // Out of scope for WP-0.3 (specs/12-roadmap.md): the analysis/planner work packages own them.
        Op::AnalysisApplyOp(_) | Op::RegionAdoptOp(_) => Err(invalid(
            op_index,
            ValidationCode::UnsupportedOp,
            "analysis.apply and region.adopt are not implemented by WP-0.3",
        )),
    }
}

// --- project -----------------------------------------------------------------------------------

fn apply_set_meta(doc: &mut Project, op: &ProjectSetMetaOp) -> Result<(), ApplyError> {
    if let Some(title) = &op.title {
        doc.meta.title = title.clone();
    }
    if let Some(tags) = &op.tags {
        doc.meta.tags = tags.clone();
    }
    if let Some(description) = &op.description {
        doc.meta.description = Some(description.clone());
    }
    if let Some(color) = &op.color {
        doc.meta.color = Some(color.clone());
    }
    Ok(())
}

// --- tracks ------------------------------------------------------------------------------------

fn apply_track_add(doc: &mut Project, op: &TrackAddOp, op_index: usize) -> Result<(), ApplyError> {
    if track_index(doc, &op.track.id).is_some() {
        return Err(invalid(
            op_index,
            ValidationCode::DuplicateId,
            format!("track {} already exists", op.track.id),
        ));
    }
    let index = op.index.map_or(doc.tracks.len(), |index| index as usize);
    if index > doc.tracks.len() {
        return Err(invalid(
            op_index,
            ValidationCode::IndexOutOfRange,
            format!("track index {index} is past the end"),
        ));
    }
    doc.tracks.insert(index, op.track.clone());
    Ok(())
}

fn apply_track_remove(
    doc: &mut Project,
    op: &TrackRemoveOp,
    op_index: usize,
) -> Result<(), ApplyError> {
    let Some(index) = track_index(doc, &op.track_id) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("track {} does not exist", op.track_id),
        ));
    };
    doc.tracks.remove(index);
    for section in &mut doc.arrangement.sections {
        section.lanes.0.remove(&op.track_id);
    }
    Ok(())
}

fn apply_track_update(
    doc: &mut Project,
    op: &TrackUpdateOp,
    op_index: usize,
) -> Result<(), ApplyError> {
    let Some(index) = track_index(doc, &op.track_id) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("track {} does not exist", op.track_id),
        ));
    };
    apply_track_patch(&mut doc.tracks[index], &op.patch);
    Ok(())
}

fn apply_track_patch(track: &mut Track, patch: &TrackPatch) {
    if let Some(name) = &patch.name {
        track.name = name.clone();
    }
    if let Some(color) = &patch.color {
        track.color = color.clone();
    }
    if let Some(gain_db) = patch.gain_db {
        track.gain_db = gain_db;
    }
    if let Some(pan) = patch.pan {
        track.pan = pan;
    }
    if let Some(mute) = patch.mute {
        track.mute = mute;
    }
    if let Some(solo) = patch.solo {
        track.solo = solo;
    }
    if let Some(hidden) = patch.hidden {
        track.hidden = hidden;
    }
}

// --- fx ----------------------------------------------------------------------------------------

/// Where an FX instance lives.
enum FxLoc {
    Track {
        track: usize,
        fx: usize,
    },
    Clip {
        section: usize,
        track: TrackId,
        clip: usize,
        fx: usize,
    },
    Master {
        fx: usize,
    },
}

impl FxLoc {
    fn index(&self) -> usize {
        match self {
            Self::Track { fx, .. } | Self::Clip { fx, .. } | Self::Master { fx } => *fx,
        }
    }
}

fn find_fx(doc: &Project, id: &FxId) -> Option<FxLoc> {
    for (track, instance) in doc.tracks.iter().enumerate() {
        if let Some(fx) = instance.fx.0.iter().position(|fx| fx.id == *id) {
            return Some(FxLoc::Track { track, fx });
        }
    }
    for (section, instance) in doc.arrangement.sections.iter().enumerate() {
        for (track_id, lane) in &instance.lanes.0 {
            for (clip, clip_instance) in lane.clips.iter().enumerate() {
                if let Some(fx) = clip_instance
                    .fx
                    .iter()
                    .flat_map(|chain| chain.0.iter())
                    .position(|fx| fx.id == *id)
                {
                    return Some(FxLoc::Clip {
                        section,
                        track: track_id.clone(),
                        clip,
                        fx,
                    });
                }
            }
        }
    }
    doc.arrangement
        .master
        .fx
        .0
        .iter()
        .position(|fx| fx.id == *id)
        .map(|fx| FxLoc::Master { fx })
}

/// Runs `f` with the chain an FX location names. Returns `None` if the location went stale.
fn with_fx_chain<R>(
    doc: &mut Project,
    loc: &FxLoc,
    f: impl FnOnce(&mut FxChain) -> R,
) -> Option<R> {
    match loc {
        FxLoc::Track { track, .. } => Some(f(&mut doc.tracks[*track].fx)),
        FxLoc::Clip {
            section,
            track,
            clip,
            ..
        } => {
            let lane = doc.arrangement.sections[*section].lanes.0.get_mut(track)?;
            let chain = lane.clips[*clip]
                .fx
                .get_or_insert_with(|| FxChain(Vec::new()));
            Some(f(chain))
        }
        FxLoc::Master { .. } => Some(f(&mut doc.arrangement.master.fx)),
    }
}

/// The chain an `fx.add` scope names, validating the scope first.
fn fx_chain_for_scope<'a>(
    doc: &'a mut Project,
    scope: &FxScope,
    op_index: usize,
) -> Result<&'a mut FxChain, ApplyError> {
    match scope {
        FxScope::TrackFxScope(scope) => {
            let Some(index) = track_index(doc, &scope.track_id) else {
                return Err(invalid(
                    op_index,
                    ValidationCode::MissingTarget,
                    format!("track {} does not exist", scope.track_id),
                ));
            };
            Ok(&mut doc.tracks[index].fx)
        }
        FxScope::ClipFxScope(scope) => {
            let Some(loc) = find_clip(doc, &scope.clip_id) else {
                return Err(invalid(
                    op_index,
                    ValidationCode::MissingTarget,
                    format!("clip {} does not exist", scope.clip_id),
                ));
            };
            let Some(lane) = doc.arrangement.sections[loc.section]
                .lanes
                .0
                .get_mut(&loc.track)
            else {
                return Err(invalid(
                    op_index,
                    ValidationCode::MissingTarget,
                    format!("clip {} does not exist", scope.clip_id),
                ));
            };
            Ok(lane.clips[loc.clip]
                .fx
                .get_or_insert_with(|| FxChain(Vec::new())))
        }
        FxScope::MasterFxScope(_) => Ok(&mut doc.arrangement.master.fx),
    }
}

fn apply_fx_add(doc: &mut Project, op: &FxAddOp, op_index: usize) -> Result<(), ApplyError> {
    if find_fx(doc, &op.fx.id).is_some() {
        return Err(invalid(
            op_index,
            ValidationCode::DuplicateId,
            format!("fx {} already exists", op.fx.id),
        ));
    }
    let chain = fx_chain_for_scope(doc, &op.scope, op_index)?;
    let index = op.index.map_or(chain.0.len(), |index| index as usize);
    if index > chain.0.len() {
        return Err(invalid(
            op_index,
            ValidationCode::IndexOutOfRange,
            format!("fx index {index} is past the end"),
        ));
    }
    chain.0.insert(index, op.fx.clone());
    Ok(())
}

fn apply_fx_remove(doc: &mut Project, op: &FxRemoveOp, op_index: usize) -> Result<(), ApplyError> {
    let Some(loc) = find_fx(doc, &op.fx_id) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("fx {} does not exist", op.fx_id),
        ));
    };
    let index = loc.index();
    if with_fx_chain(doc, &loc, |chain| chain.0.remove(index)).is_none() {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("fx {} does not exist", op.fx_id),
        ));
    }
    Ok(())
}

fn apply_fx_reorder(
    doc: &mut Project,
    op: &FxReorderOp,
    op_index: usize,
) -> Result<(), ApplyError> {
    let Some(loc) = find_fx(doc, &op.fx_id) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("fx {} does not exist", op.fx_id),
        ));
    };
    let from = loc.index();
    let to = op.new_index as usize;
    let moved = with_fx_chain(doc, &loc, |chain| {
        if to >= chain.0.len() {
            return false;
        }
        let instance = chain.0.remove(from);
        chain.0.insert(to, instance);
        true
    });
    match moved {
        Some(true) => Ok(()),
        Some(false) => Err(invalid(
            op_index,
            ValidationCode::IndexOutOfRange,
            format!("fx index {to} is past the end"),
        )),
        None => Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("fx {} does not exist", op.fx_id),
        )),
    }
}

fn apply_fx_update(doc: &mut Project, op: &FxUpdateOp, op_index: usize) -> Result<(), ApplyError> {
    let Some(loc) = find_fx(doc, &op.fx_id) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("fx {} does not exist", op.fx_id),
        ));
    };
    let index = loc.index();
    let updated = with_fx_chain(doc, &loc, |chain| {
        let Some(instance) = chain.0.get_mut(index) else {
            return false;
        };
        if let Some(bypass) = op.bypass {
            instance.bypass = bypass;
        }
        for (name, value) in &op.params_patch.0 {
            instance.params.0.insert(name.clone(), *value);
        }
        true
    });
    if updated != Some(true) {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("fx {} does not exist", op.fx_id),
        ));
    }
    Ok(())
}

// --- sections ----------------------------------------------------------------------------------

fn section_index(doc: &Project, id: &SectionId) -> Option<usize> {
    doc.arrangement.sections.iter().position(|s| s.id == *id)
}

fn apply_section_insert(
    doc: &mut Project,
    op: &SectionInsertOp,
    op_index: usize,
) -> Result<(), ApplyError> {
    if section_index(doc, &op.section.id).is_some() {
        return Err(invalid(
            op_index,
            ValidationCode::DuplicateId,
            format!("section {} already exists", op.section.id),
        ));
    }
    let index = op.index as usize;
    if index > doc.arrangement.sections.len() {
        return Err(invalid(
            op_index,
            ValidationCode::IndexOutOfRange,
            format!("section index {index} is past the end"),
        ));
    }
    doc.arrangement.sections.insert(index, op.section.clone());
    Ok(())
}

fn apply_section_remove(
    doc: &mut Project,
    op: &SectionRemoveOp,
    op_index: usize,
) -> Result<(), ApplyError> {
    if !op.close_gap.0 {
        return Err(invalid(
            op_index,
            ValidationCode::UnsupportedOp,
            "section.remove with closeGap false is not supported in v1",
        ));
    }
    let Some(index) = section_index(doc, &op.section_id) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("section {} does not exist", op.section_id),
        ));
    };
    doc.arrangement.sections.remove(index);
    Ok(())
}

fn apply_section_move(
    doc: &mut Project,
    op: &SectionMoveOp,
    op_index: usize,
) -> Result<(), ApplyError> {
    let Some(from) = section_index(doc, &op.section_id) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("section {} does not exist", op.section_id),
        ));
    };
    let to = op.to_index as usize;
    if to >= doc.arrangement.sections.len() {
        return Err(invalid(
            op_index,
            ValidationCode::IndexOutOfRange,
            format!("section index {to} is past the end"),
        ));
    }
    let before = section_spans(doc);
    let moved = doc.arrangement.sections.remove(from);
    doc.arrangement.sections.insert(to, moved);
    let after = section_spans(doc);
    reanchor_master_automation(doc, &before, &after);
    Ok(())
}

/// Re-anchors master automation after a `section.move` (`specs/02-song-model.md` §5.3): a point in a
/// section keeps its offset from that section's (new) start; a point past the arrangement scales
/// with the total length.
fn reanchor_master_automation(doc: &mut Project, before: &[SectionSpan], after: &[SectionSpan]) {
    let old_total = before.last().map_or(0, |span| span.end_tick);
    let new_total = after.last().map_or(0, |span| span.end_tick);
    for automation in &mut doc.arrangement.master.automation.0 {
        for point in &mut automation.points.0 {
            point.tick = remap_tick(point.tick, before, after, old_total, new_total);
        }
        automation.points.0.sort_by_key(|point| point.tick);
    }
}

fn remap_tick(
    tick: i64,
    before: &[SectionSpan],
    after: &[SectionSpan],
    old_total: i64,
    new_total: i64,
) -> i64 {
    if let Some(span) = before.iter().find(|span| span.contains(tick))
        && let Some(new_span) = after.iter().find(|candidate| candidate.id == span.id)
    {
        return new_span.start_tick + (tick - span.start_tick);
    }
    if old_total > 0 && new_total != old_total {
        return (tick as f64 * new_total as f64 / old_total as f64).round() as i64;
    }
    tick
}

fn apply_section_duplicate(
    doc: &mut Project,
    op: &SectionDuplicateOp,
    op_index: usize,
) -> Result<(), ApplyError> {
    let Some(from) = section_index(doc, &op.section_id) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("section {} does not exist", op.section_id),
        ));
    };
    if section_index(doc, &op.new_id).is_some() {
        return Err(invalid(
            op_index,
            ValidationCode::DuplicateId,
            format!("section {} already exists", op.new_id),
        ));
    }
    let to = op.to_index as usize;
    if to > doc.arrangement.sections.len() {
        return Err(invalid(
            op_index,
            ValidationCode::IndexOutOfRange,
            format!("section index {to} is past the end"),
        ));
    }
    let source = doc.arrangement.sections[from].clone();
    let mut copy = duplicate_section(&source, &op.new_id);
    copy.derived_from = Some(source.id.clone());
    doc.arrangement.sections.insert(to, copy);
    Ok(())
}

/// Deep-copies a section, giving every clip and clip-level FX instance a new deterministic ID (Q14).
fn duplicate_section(source: &SectionInstance, new_id: &SectionId) -> SectionInstance {
    let mut fx_map: HashMap<String, String> = HashMap::new();
    let mut lanes = LaneMap(HashMap::new());
    for (track_id, lane) in &source.lanes.0 {
        let mut clips = Vec::with_capacity(lane.clips.len());
        for clip in &lane.clips {
            let new_clip_id = make_clip_id(derived_id("clp_", new_id.as_str(), clip.id.as_str()));
            clips.push(copy_clip_with_new_fx_ids(
                clip,
                new_clip_id,
                new_id.as_str(),
                &mut fx_map,
            ));
        }
        let automation = AutomationList(
            lane.automation
                .0
                .iter()
                .map(|automation| Automation {
                    target: remap_target(&automation.target, &fx_map),
                    points: automation.points.clone(),
                })
                .collect(),
        );
        lanes.0.insert(track_id.clone(), Lane { clips, automation });
    }
    SectionInstance {
        id: new_id.clone(),
        kind: source.kind,
        label: source.label.clone(),
        length_ticks: source.length_ticks,
        lanes,
        transition_in: source.transition_in.clone(),
        derived_from: None,
        energy_target: source.energy_target.clone(),
        locked: source.locked,
    }
}

/// Clones a clip, sets `id`, and gives its FX instances deterministic new IDs (recording the
/// rename in `fx_map` so automation targets can be rewritten).
fn copy_clip_with_new_fx_ids(
    clip: &Clip,
    id: ClipId,
    parent: &str,
    fx_map: &mut HashMap<String, String>,
) -> Clip {
    let mut copy = clip.clone();
    copy.id = id.clone();
    if let Some(chain) = &clip.fx {
        let mut new_chain = Vec::with_capacity(chain.0.len());
        for fx in &chain.0 {
            let new_fx = derived_id("fx_", parent, fx.id.as_str());
            fx_map.insert(fx.id.to_string(), new_fx.clone());
            let mut instance = fx.clone();
            instance.id = make_fx_id(new_fx);
            new_chain.push(instance);
        }
        copy.fx = Some(FxChain(new_chain));
    }
    copy
}

fn remap_target(target: &AutomationTarget, fx_map: &HashMap<String, String>) -> AutomationTarget {
    let mut text = target.to_string();
    for (old, new) in fx_map {
        if text.contains(old.as_str()) {
            text = text.replace(old.as_str(), new);
        }
    }
    make_target(text)
}

fn apply_section_resize(
    doc: &mut Project,
    op: &SectionResizeOp,
    assets: &AssetIndex,
    op_index: usize,
) -> Result<(), ApplyError> {
    let Some(index) = section_index(doc, &op.section_id) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("section {} does not exist", op.section_id),
        ));
    };
    let new_length = op.length_ticks.get();
    let start = section_start(doc, index);
    let old_length = doc.arrangement.sections[index].length_ticks.get();
    let mut section = doc.arrangement.sections[index].clone();
    match op.mode {
        SectionResizeMode::Trim => {
            let tempo = TempoCtx::from_project(doc);
            trim_lane_clips(&mut section, &tempo, assets, start, new_length);
        }
        SectionResizeMode::Loop => {
            loop_section(doc, &mut section, assets, start, old_length, new_length)
        }
        SectionResizeMode::Stretch => stretch_section(&mut section, old_length, new_length),
    }
    if let Ok(nonzero) = std::num::NonZeroU64::try_from(new_length) {
        section.length_ticks = nonzero;
    }
    doc.arrangement.sections[index] = section;
    Ok(())
}

/// Trims every clip in a section to `[0, new_length)`, fading the cuts.
fn trim_lane_clips(
    section: &mut SectionInstance,
    tempo: &TempoCtx<'_>,
    assets: &AssetIndex,
    section_start: i64,
    new_length: u64,
) {
    for lane in section.lanes.0.values_mut() {
        let fade = fade_at(tempo, section_start, section_start + new_length as i64);
        let mut kept = Vec::with_capacity(lane.clips.len());
        for clip in &lane.clips {
            let end = clip_end_local(clip, tempo, assets, section_start);
            if clip.start >= new_length as i64 {
                continue;
            }
            match end {
                Some(end) if end > new_length as i64 => {
                    let mut trimmed = clip.clone();
                    if let Some(sample) =
                        src_sample_at_local(clip, tempo, assets, section_start, new_length as i64)
                    {
                        trimmed.src_end = sample;
                    }
                    trimmed.fade_out_ticks = fade;
                    if trimmed.fade_in_ticks == 0 && fade > 0 {
                        trimmed.fade_curve = FadeCurve::EqualPower;
                    }
                    kept.push(trimmed);
                }
                _ => kept.push(clip.clone()),
            }
        }
        lane.clips = kept;
    }
}

/// Repeats a section's content in whole-bar units until it is at least `new_length`, then trims.
fn loop_section(
    doc: &Project,
    section: &mut SectionInstance,
    assets: &AssetIndex,
    section_start: i64,
    old_length: u64,
    new_length: u64,
) {
    let tempo = TempoCtx::from_project(doc);
    if new_length <= old_length {
        trim_lane_clips(section, &tempo, assets, section_start, new_length);
        return;
    }
    let ppq = *doc.arrangement.timebase.ppq;
    let (bar, _) = ticks_to_bar_beat(doc, section_start);
    let bar = u64::try_from(bar_ticks(
        &doc.arrangement.timebase.time_signatures,
        bar,
        ppq,
    ))
    .unwrap_or(0)
    .max(1);
    let period = if old_length != 0 && old_length.is_multiple_of(bar) {
        old_length
    } else {
        (old_length / bar).max(1) * bar
    };
    let mut tile = 1_u64;
    while tile * period < new_length {
        let offset = i64::try_from(tile * period).unwrap_or(i64::MAX);
        let parent = format!("{}:loop{tile}", section.id);
        for (track_id, lane) in &mut section.lanes.0 {
            let source = lane.clips.clone();
            for clip in &source {
                let mut copy = clip.clone();
                copy.id = make_clip_id(derived_id("clp_", &parent, clip.id.as_str()));
                copy.start += offset;
                let mut fx_map = HashMap::new();
                let copy = copy_clip_with_new_fx_ids(&copy, copy.id.clone(), &parent, &mut fx_map);
                lane.clips.push(copy);
            }
            let _ = &track_id;
        }
        tile += 1;
    }
    trim_lane_clips(section, &tempo, assets, section_start, new_length);
}

/// Time-stretches a section's clips so they fill `new_length` (`specs/02-song-model.md` §5.2).
fn stretch_section(section: &mut SectionInstance, old_length: u64, new_length: u64) {
    if old_length == 0 || new_length == 0 || old_length == new_length {
        return;
    }
    let scale = new_length as f64 / old_length as f64;
    for lane in section.lanes.0.values_mut() {
        for clip in &mut lane.clips {
            clip.start = (clip.start as f64 * scale).round() as i64;
            clip.fade_in_ticks = (clip.fade_in_ticks as f64 * scale).round() as u64;
            clip.fade_out_ticks = (clip.fade_out_ticks as f64 * scale).round() as u64;
            clip.warp = match &clip.warp {
                Warp::None(_) => Warp::Stretch(WarpStretch {
                    mode: WarpStretchMode::Stretch,
                    ratio: 1.0 / scale,
                }),
                Warp::Stretch(stretch) => Warp::Stretch(WarpStretch {
                    mode: WarpStretchMode::Stretch,
                    ratio: stretch.ratio / scale,
                }),
                Warp::Beatgrid(beatgrid) => {
                    let mut scaled = beatgrid.clone();
                    for anchor in &mut scaled.anchors {
                        anchor.tick = (anchor.tick as f64 * scale).round() as i64;
                    }
                    Warp::Beatgrid(scaled)
                }
            };
        }
    }
}

fn apply_section_split(
    doc: &mut Project,
    op: &SectionSplitOp,
    assets: &AssetIndex,
    op_index: usize,
) -> Result<(), ApplyError> {
    let Some(index) = section_index(doc, &op.section_id) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("section {} does not exist", op.section_id),
        ));
    };
    if section_index(doc, &op.new_id).is_some() {
        return Err(invalid(
            op_index,
            ValidationCode::DuplicateId,
            format!("section {} already exists", op.new_id),
        ));
    }
    let at_tick = op.at_tick.get();
    let old_length = doc.arrangement.sections[index].length_ticks.get();
    if at_tick == 0 || at_tick >= old_length {
        return Err(invalid(
            op_index,
            ValidationCode::IndexOutOfRange,
            format!("section.split atTick {at_tick} is outside 1..{old_length}"),
        ));
    }
    let start = section_start(doc, index);
    let tempo = TempoCtx::from_project(doc);
    let source = doc.arrangement.sections[index].clone();
    let (mut left, mut right) = split_section(&source, &tempo, assets, start, at_tick, &op.new_id);
    left.length_ticks = nonzero(at_tick);
    right.length_ticks = nonzero(old_length - at_tick);
    doc.arrangement.sections[index] = left;
    doc.arrangement.sections.insert(index + 1, right);
    Ok(())
}

fn split_section(
    source: &SectionInstance,
    tempo: &TempoCtx<'_>,
    assets: &AssetIndex,
    section_start: i64,
    at_tick: u64,
    new_id: &SectionId,
) -> (SectionInstance, SectionInstance) {
    let at = at_tick as i64;
    let fade = fade_at(tempo, section_start, section_start + at);
    let mut left_lanes = LaneMap(HashMap::new());
    let mut right_lanes = LaneMap(HashMap::new());
    for (track_id, lane) in &source.lanes.0 {
        let mut left_clips = Vec::new();
        let mut right_clips = Vec::new();
        for clip in &lane.clips {
            let end = clip_end_local(clip, tempo, assets, section_start);
            match end {
                Some(end) if end <= at => left_clips.push(clip.clone()),
                Some(_) if clip.start >= at => {
                    let mut moved = clip.clone();
                    moved.start -= at;
                    right_clips.push(moved);
                }
                Some(_) => {
                    // The clip straddles the boundary: keep the head, derive the tail.
                    let mut head = clip.clone();
                    if let Some(sample) =
                        src_sample_at_local(clip, tempo, assets, section_start, at)
                    {
                        head.src_end = sample;
                    }
                    head.fade_out_ticks = fade;
                    head.fade_curve = FadeCurve::EqualPower;
                    let mut tail = clip.clone();
                    tail.id = make_clip_id(derived_id("clp_", new_id.as_str(), clip.id.as_str()));
                    tail.start = 0;
                    if let Some(sample) =
                        src_sample_at_local(clip, tempo, assets, section_start, at)
                    {
                        tail.src_start = sample;
                    }
                    tail.fade_in_ticks = fade;
                    tail.fade_curve = FadeCurve::EqualPower;
                    left_clips.push(head);
                    right_clips.push(tail);
                }
                None => left_clips.push(clip.clone()),
            }
        }
        let left_automation = AutomationList(
            lane.automation
                .0
                .iter()
                .map(|automation| Automation {
                    target: automation.target.clone(),
                    points: AutomationPoints(
                        automation
                            .points
                            .0
                            .iter()
                            .filter(|point| point.tick < at)
                            .cloned()
                            .collect(),
                    ),
                })
                .filter(|automation| !automation.points.0.is_empty())
                .collect(),
        );
        let right_automation = AutomationList(
            lane.automation
                .0
                .iter()
                .map(|automation| Automation {
                    target: automation.target.clone(),
                    points: AutomationPoints(
                        automation
                            .points
                            .0
                            .iter()
                            .filter(|point| point.tick >= at)
                            .map(|point| {
                                let mut moved = point.clone();
                                moved.tick -= at;
                                moved
                            })
                            .collect(),
                    ),
                })
                .filter(|automation| !automation.points.0.is_empty())
                .collect(),
        );
        left_lanes.0.insert(
            track_id.clone(),
            Lane {
                clips: left_clips,
                automation: left_automation,
            },
        );
        right_lanes.0.insert(
            track_id.clone(),
            Lane {
                clips: right_clips,
                automation: right_automation,
            },
        );
    }
    let left = SectionInstance {
        id: source.id.clone(),
        kind: source.kind,
        label: source.label.clone(),
        length_ticks: source.length_ticks,
        lanes: left_lanes,
        transition_in: source.transition_in.clone(),
        derived_from: source.derived_from.clone(),
        energy_target: source.energy_target.clone(),
        locked: source.locked,
    };
    let right = SectionInstance {
        id: new_id.clone(),
        kind: source.kind,
        label: source.label.clone(),
        length_ticks: source.length_ticks,
        lanes: right_lanes,
        transition_in: Transition {
            kind: TransitionKind::Cut,
            length_ticks: 0,
            asset: None,
        },
        derived_from: Some(source.id.clone()),
        energy_target: source.energy_target.clone(),
        locked: source.locked,
    };
    (left, right)
}

fn apply_section_merge(
    doc: &mut Project,
    op: &SectionMergeOp,
    op_index: usize,
) -> Result<(), ApplyError> {
    let Some(a) = section_index(doc, &op.section_id_a) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("section {} does not exist", op.section_id_a),
        ));
    };
    let Some(b) = section_index(doc, &op.section_id_b) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("section {} does not exist", op.section_id_b),
        ));
    };
    if b != a + 1 {
        return Err(invalid(
            op_index,
            ValidationCode::IndexOutOfRange,
            "section.merge requires two adjacent sections, in order",
        ));
    }
    let b_section = doc.arrangement.sections.remove(b);
    let offset = i64::try_from(doc.arrangement.sections[a].length_ticks.get()).unwrap_or(i64::MAX);
    let merged_length = doc.arrangement.sections[a]
        .length_ticks
        .get()
        .saturating_add(b_section.length_ticks.get());
    let section_a = &mut doc.arrangement.sections[a];
    for (track_id, lane) in b_section.lanes.0 {
        let target = section_a.lanes.0.entry(track_id).or_insert_with(|| Lane {
            clips: Vec::new(),
            automation: AutomationList(Vec::new()),
        });
        for mut clip in lane.clips {
            clip.start += offset;
            target.clips.push(clip);
        }
        for mut automation in lane.automation.0 {
            for point in &mut automation.points.0 {
                point.tick += offset;
            }
            target.automation.0.push(automation);
        }
    }
    if let Ok(length) = std::num::NonZeroU64::try_from(merged_length) {
        section_a.length_ticks = length;
    }
    Ok(())
}

fn apply_section_update(
    doc: &mut Project,
    op: &SectionUpdateOp,
    op_index: usize,
) -> Result<(), ApplyError> {
    let Some(index) = section_index(doc, &op.section_id) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("section {} does not exist", op.section_id),
        ));
    };
    apply_section_patch(&mut doc.arrangement.sections[index], &op.patch);
    Ok(())
}

fn apply_section_patch(section: &mut SectionInstance, patch: &SectionPatch) {
    if let Some(kind) = patch.kind {
        section.kind = kind;
    }
    if let Some(label) = &patch.label {
        section.label = label.clone();
    }
    if let Some(energy_target) = &patch.energy_target {
        section.energy_target = Some(energy_target.clone());
    }
    if let Some(locked) = patch.locked {
        section.locked = Some(locked);
    }
}

fn apply_section_set_transition(
    doc: &mut Project,
    op: &SectionSetTransitionOp,
    op_index: usize,
) -> Result<(), ApplyError> {
    let Some(index) = section_index(doc, &op.section_id) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("section {} does not exist", op.section_id),
        ));
    };
    doc.arrangement.sections[index].transition_in = op.transition.clone();
    Ok(())
}

// --- clips -------------------------------------------------------------------------------------

/// Where a clip lives.
struct ClipLoc {
    section: usize,
    track: TrackId,
    clip: usize,
}

fn find_clip(doc: &Project, id: &ClipId) -> Option<ClipLoc> {
    for (section, instance) in doc.arrangement.sections.iter().enumerate() {
        for (track, lane) in &instance.lanes.0 {
            if let Some(clip) = lane.clips.iter().position(|clip| clip.id == *id) {
                return Some(ClipLoc {
                    section,
                    track: track.clone(),
                    clip,
                });
            }
        }
    }
    None
}

fn apply_clip_add(doc: &mut Project, op: &ClipAddOp, op_index: usize) -> Result<(), ApplyError> {
    let Some(section) = section_index(doc, &op.section_id) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("section {} does not exist", op.section_id),
        ));
    };
    if track_index(doc, &op.track_id).is_none() {
        return Err(invalid(
            op_index,
            ValidationCode::UnknownTrack,
            format!("track {} does not exist", op.track_id),
        ));
    }
    if find_clip(doc, &op.clip.id).is_some() {
        return Err(invalid(
            op_index,
            ValidationCode::DuplicateId,
            format!("clip {} already exists", op.clip.id),
        ));
    }
    lane_mut(&mut doc.arrangement.sections[section], &op.track_id)
        .clips
        .push(op.clip.clone());
    Ok(())
}

fn apply_clip_update(
    doc: &mut Project,
    op: &ClipUpdateOp,
    op_index: usize,
) -> Result<(), ApplyError> {
    let Some(loc) = find_clip(doc, &op.clip_id) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("clip {} does not exist", op.clip_id),
        ));
    };
    let Some(clip) = clip_mut(doc, &loc) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("clip {} does not exist", op.clip_id),
        ));
    };
    apply_clip_patch(clip, &op.patch);
    Ok(())
}

fn apply_clip_patch(clip: &mut Clip, patch: &ClipPatch) {
    if let Some(start) = patch.start {
        clip.start = start;
    }
    if let Some(src_start) = patch.src_start {
        clip.src_start = src_start;
    }
    if let Some(src_end) = patch.src_end {
        clip.src_end = src_end;
    }
    if let Some(gain_db) = patch.gain_db {
        clip.gain_db = gain_db;
    }
    if let Some(pitch) = patch.pitch_semitones {
        clip.pitch_semitones = pitch;
    }
    if let Some(fade_in) = patch.fade_in_ticks {
        clip.fade_in_ticks = fade_in;
    }
    if let Some(fade_out) = patch.fade_out_ticks {
        clip.fade_out_ticks = fade_out;
    }
    if let Some(fade_curve) = patch.fade_curve {
        clip.fade_curve = fade_curve;
    }
    if let Some(reverse) = patch.reverse {
        clip.reverse = Some(reverse);
    }
    if let Some(warp) = &patch.warp {
        clip.warp = warp.clone();
    }
}

fn apply_clip_remove(
    doc: &mut Project,
    op: &ClipRemoveOp,
    op_index: usize,
) -> Result<(), ApplyError> {
    let Some(loc) = find_clip(doc, &op.clip_id) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("clip {} does not exist", op.clip_id),
        ));
    };
    if let Some(lane) = lane_at(doc, loc.section, &loc.track) {
        lane.clips.remove(loc.clip);
    }
    Ok(())
}

fn apply_clip_replace(
    doc: &mut Project,
    op: &ClipReplaceOp,
    op_index: usize,
) -> Result<(), ApplyError> {
    let Some(loc) = find_clip(doc, &op.clip_id) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("clip {} does not exist", op.clip_id),
        ));
    };
    let mut seen = BTreeSet::new();
    for clip in &op.clips {
        if !seen.insert(clip.id.to_string()) {
            return Err(invalid(
                op_index,
                ValidationCode::DuplicateId,
                format!("clip {} appears twice in the replacement", clip.id),
            ));
        }
        if clip.id != op.clip_id && find_clip(doc, &clip.id).is_some() {
            return Err(invalid(
                op_index,
                ValidationCode::DuplicateId,
                format!("clip {} already exists", clip.id),
            ));
        }
    }
    let Some(lane) = lane_at(doc, loc.section, &loc.track) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("clip {} does not exist", op.clip_id),
        ));
    };
    lane.clips
        .splice(loc.clip..=loc.clip, op.clips.iter().cloned());
    Ok(())
}

fn apply_clip_split(
    doc: &mut Project,
    op: &ClipSplitOp,
    assets: &AssetIndex,
    op_index: usize,
) -> Result<(), ApplyError> {
    let Some(loc) = find_clip(doc, &op.clip_id) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("clip {} does not exist", op.clip_id),
        ));
    };
    if find_clip(doc, &op.new_id).is_some() {
        return Err(invalid(
            op_index,
            ValidationCode::DuplicateId,
            format!("clip {} already exists", op.new_id),
        ));
    }
    let start = section_start(doc, loc.section);
    let tempo = TempoCtx::from_project(doc);
    let clip = &doc.arrangement.sections[loc.section].lanes.0[&loc.track].clips[loc.clip];
    let Some(end) = clip_end_local(clip, &tempo, assets, start) else {
        return Err(invalid(
            op_index,
            ValidationCode::UnknownAsset,
            format!("clip {} has no derivable end (unknown asset)", op.clip_id),
        ));
    };
    if op.at_tick <= clip.start || op.at_tick >= end {
        return Err(invalid(
            op_index,
            ValidationCode::IndexOutOfRange,
            format!("clip.split atTick {} is outside the clip", op.at_tick),
        ));
    }
    let Some(sample) = src_sample_at_local(clip, &tempo, assets, start, op.at_tick) else {
        return Err(invalid(
            op_index,
            ValidationCode::UnknownAsset,
            format!(
                "clip {} cannot map a tick to a sample (unknown asset)",
                op.clip_id
            ),
        ));
    };
    let mut first = clip.clone();
    first.src_end = sample;
    first.fade_out_ticks = 0;
    let mut fx_map = HashMap::new();
    let mut second =
        copy_clip_with_new_fx_ids(clip, op.new_id.clone(), op.new_id.as_str(), &mut fx_map);
    second.start = op.at_tick;
    second.src_start = sample;
    second.fade_in_ticks = 0;
    let Some(lane) = lane_at(doc, loc.section, &loc.track) else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("clip {} does not exist", op.clip_id),
        ));
    };
    lane.clips[loc.clip] = first;
    lane.clips.insert(loc.clip + 1, second);
    Ok(())
}

// --- automation --------------------------------------------------------------------------------

fn apply_automation_set(
    doc: &mut Project,
    op: &AutomationSetOp,
    op_index: usize,
) -> Result<(), ApplyError> {
    let Some((min, max)) = tick_range_of(&op.points) else {
        return Err(invalid(
            op_index,
            ValidationCode::IndexOutOfRange,
            "automation.set needs at least one point",
        ));
    };
    let target = op.target.to_string();
    let entry = automation_entry_mut(doc, &op.scope, &target, op_index)?;
    entry
        .points
        .0
        .retain(|point| point.tick < min || point.tick > max);
    entry.points.0.extend(op.points.0.iter().cloned());
    entry.points.0.sort_by_key(|point| point.tick);
    Ok(())
}

fn apply_automation_clear(
    doc: &mut Project,
    op: &AutomationClearOp,
    op_index: usize,
) -> Result<(), ApplyError> {
    let target = op.target.to_string();
    let list = automation_list_mut(doc, &op.scope, op_index)?;
    let Some(entry) = list
        .0
        .iter_mut()
        .find(|entry| entry.target.to_string() == target)
    else {
        return Ok(());
    };
    match &op.range {
        None => entry.points.0.clear(),
        Some(range) => entry
            .points
            .0
            .retain(|point| point.tick < range.start_tick || point.tick >= range.end_tick),
    }
    list.0.retain(|entry| !entry.points.0.is_empty());
    Ok(())
}

fn tick_range_of(points: &AutomationPoints) -> Option<(i64, i64)> {
    let mut iter = points.0.iter().map(|point| point.tick);
    let first = iter.next()?;
    let mut min = first;
    let mut max = first;
    for tick in iter {
        min = min.min(tick);
        max = max.max(tick);
    }
    Some((min, max))
}

/// The automation list a scope points at.
fn automation_list_mut<'a>(
    doc: &'a mut Project,
    scope: &AutomationScope,
    op_index: usize,
) -> Result<&'a mut AutomationList, ApplyError> {
    match scope {
        AutomationScope::LaneAutomationScope(lane_scope) => {
            let Some(index) = section_index(doc, &lane_scope.section_id) else {
                return Err(invalid(
                    op_index,
                    ValidationCode::MissingTarget,
                    format!("section {} does not exist", lane_scope.section_id),
                ));
            };
            if track_index(doc, &lane_scope.track_id).is_none() {
                return Err(invalid(
                    op_index,
                    ValidationCode::UnknownTrack,
                    format!("track {} does not exist", lane_scope.track_id),
                ));
            }
            Ok(
                &mut lane_mut(&mut doc.arrangement.sections[index], &lane_scope.track_id)
                    .automation,
            )
        }
        AutomationScope::MasterAutomationScope(_) => Ok(&mut doc.arrangement.master.automation),
    }
}

/// The automation entry for `target`, creating it when absent.
fn automation_entry_mut<'a>(
    doc: &'a mut Project,
    scope: &AutomationScope,
    target: &str,
    op_index: usize,
) -> Result<&'a mut Automation, ApplyError> {
    let list = automation_list_mut(doc, scope, op_index)?;
    if let Some(position) = list
        .0
        .iter()
        .position(|entry| entry.target.to_string() == target)
    {
        return Ok(&mut list.0[position]);
    }
    list.0.push(Automation {
        target: make_target(target.to_string()),
        points: AutomationPoints(Vec::new()),
    });
    let last = list.0.len() - 1;
    Ok(&mut list.0[last])
}

// --- tempo & key -------------------------------------------------------------------------------

fn apply_tempo_set(doc: &mut Project, op: &TempoSetOp) -> Result<(), ApplyError> {
    doc.arrangement.timebase.tempo_map = op.tempo_map.clone();
    Ok(())
}

/// Adds `semitones` to every clip's `pitchSemitones` in scope (`specs/02-song-model.md` §4.2).
///
/// 02 §4.2 says "sets", which would clobber an existing shift; a *transpose* is additive, and the
/// spec is clarified to say so by this work package.
fn apply_key_transpose(
    doc: &mut Project,
    op: &KeyTransposeOp,
    assets: &AssetIndex,
) -> Result<(), ApplyError> {
    match &op.scope {
        TransposeScope::All(All::All) => {
            for section in &mut doc.arrangement.sections {
                for lane in section.lanes.0.values_mut() {
                    for clip in &mut lane.clips {
                        clip.pitch_semitones += op.semitones;
                    }
                }
            }
        }
        TransposeScope::Region(region) => {
            let ids = resolve_region(doc, region, assets).clip_ids();
            for clip_id in ids {
                if let Some(loc) = find_clip(doc, &clip_id)
                    && let Some(clip) = clip_mut(doc, &loc)
                {
                    clip.pitch_semitones += op.semitones;
                }
            }
        }
    }
    Ok(())
}

// --- region.clear ------------------------------------------------------------------------------

/// Removes or trims clip content inside `region`, adding 10 ms equal-power fades at the cuts
/// (`specs/02-song-model.md` §4.2, §5.4).
fn apply_region_clear(
    doc: &mut Project,
    op: &RegionClearOp,
    assets: &AssetIndex,
) -> Result<(), ApplyError> {
    let resolved = resolve_region(doc, &op.region, assets);
    let spans = section_spans(doc);
    let tempo = TempoCtx::from_project(doc);
    let fades = fade_at(&tempo, resolved.start_tick, resolved.end_tick);
    let mut edits: Vec<(usize, TrackId, Vec<Clip>)> = Vec::new();
    for slice in &resolved.slices {
        let Some(lane) = doc.arrangement.sections[slice.section_index]
            .lanes
            .0
            .get(&slice.track_id)
        else {
            continue;
        };
        let section_start = spans[slice.section_index].start_tick;
        let (rs, re) = (slice.local_start_tick, slice.local_end_tick);
        let mut rebuilt = Vec::with_capacity(lane.clips.len());
        for clip in &lane.clips {
            let Some(end) = clip_end_local(clip, &tempo, assets, section_start) else {
                rebuilt.push(clip.clone());
                continue;
            };
            if re <= clip.start || rs >= end {
                rebuilt.push(clip.clone());
            } else if rs <= clip.start && end <= re {
                // Fully covered: drop it.
            } else if rs <= clip.start {
                let mut trimmed = clip.clone();
                if let Some(sample) = src_sample_at_local(clip, &tempo, assets, section_start, re) {
                    trimmed.src_end = sample;
                }
                trimmed.fade_out_ticks = fades;
                trimmed.fade_curve = FadeCurve::EqualPower;
                rebuilt.push(trimmed);
            } else if re >= end {
                let mut trimmed = clip.clone();
                if let Some(sample) = src_sample_at_local(clip, &tempo, assets, section_start, rs) {
                    trimmed.src_start = sample;
                }
                trimmed.start = rs;
                trimmed.fade_in_ticks = fades;
                trimmed.fade_curve = FadeCurve::EqualPower;
                rebuilt.push(trimmed);
            } else {
                let mut left = clip.clone();
                if let Some(sample) = src_sample_at_local(clip, &tempo, assets, section_start, rs) {
                    left.src_end = sample;
                }
                left.fade_out_ticks = fades;
                left.fade_curve = FadeCurve::EqualPower;
                let new_id = make_clip_id(derived_id(
                    "clp_",
                    &format!("{}:region{rs}", slice.section_id),
                    clip.id.as_str(),
                ));
                let mut fx_map = HashMap::new();
                let mut right = copy_clip_with_new_fx_ids(
                    clip,
                    new_id,
                    &format!("{}:region{rs}", slice.section_id),
                    &mut fx_map,
                );
                right.start = re;
                if let Some(sample) = src_sample_at_local(clip, &tempo, assets, section_start, re) {
                    right.src_start = sample;
                }
                right.fade_in_ticks = fades;
                right.fade_curve = FadeCurve::EqualPower;
                rebuilt.push(left);
                rebuilt.push(right);
            }
        }
        edits.push((slice.section_index, slice.track_id.clone(), rebuilt));
    }
    for (section, track, clips) in edits {
        if let Some(lane) = doc.arrangement.sections[section].lanes.0.get_mut(&track) {
            lane.clips = clips;
        }
    }
    Ok(())
}

// --- helpers -----------------------------------------------------------------------------------

fn track_index(doc: &Project, id: &TrackId) -> Option<usize> {
    doc.tracks.iter().position(|track| track.id == *id)
}

fn lane_mut<'a>(section: &'a mut SectionInstance, track: &TrackId) -> &'a mut Lane {
    section
        .lanes
        .0
        .entry(track.clone())
        .or_insert_with(|| Lane {
            clips: Vec::new(),
            automation: AutomationList(Vec::new()),
        })
}

/// A mutable lane at a known (section, track), if both still exist.
fn lane_at<'a>(doc: &'a mut Project, section: usize, track: &TrackId) -> Option<&'a mut Lane> {
    doc.arrangement
        .sections
        .get_mut(section)?
        .lanes
        .0
        .get_mut(track)
}

/// A mutable clip at a known location.
fn clip_mut<'a>(doc: &'a mut Project, loc: &ClipLoc) -> Option<&'a mut Clip> {
    lane_at(doc, loc.section, &loc.track)?
        .clips
        .get_mut(loc.clip)
}

fn section_start(doc: &Project, index: usize) -> i64 {
    section_spans(doc)
        .get(index)
        .map_or(0, |span| span.start_tick)
}

fn nonzero(value: u64) -> std::num::NonZeroU64 {
    std::num::NonZeroU64::new(value).unwrap_or(std::num::NonZeroU64::MIN)
}

/// A short fade in ticks for a cut, using the tempo near the cut.
fn fade_at(tempo: &TempoCtx<'_>, start: i64, end: i64) -> u64 {
    let middle = start.saturating_add(end).saturating_div(2);
    let one_tick = tempo.ticks_to_seconds(middle + 1) - tempo.ticks_to_seconds(middle);
    if one_tick <= 0.0 {
        return 0;
    }
    (CUT_FADE_SECS / one_tick).round() as u64
}

/// Invariant 6: an AI batch may not change a locked section.
fn check_locked_sections(
    before: &Project,
    after: &Project,
    op_index: usize,
) -> Result<(), ApplyError> {
    for section in &before.arrangement.sections {
        if section.locked != Some(true) {
            continue;
        }
        let unchanged = after
            .arrangement
            .sections
            .iter()
            .find(|candidate| candidate.id == section.id)
            .is_some_and(|candidate| value_of(candidate) == value_of(section));
        if !unchanged {
            return Err(invalid(
                op_index,
                ValidationCode::LockedSection,
                format!(
                    "section {} is locked and an AI batch may not modify it",
                    section.id
                ),
            ));
        }
    }
    Ok(())
}

fn value_of<T: serde::Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or(serde_json::Value::Null)
}

#[allow(clippy::expect_used)]
fn make_clip_id(id: String) -> ClipId {
    id.parse().expect("a derived clp_ id is valid")
}

#[allow(clippy::expect_used)]
fn make_fx_id(id: String) -> FxId {
    id.parse().expect("a derived fx_ id is valid")
}

#[allow(clippy::expect_used)]
fn make_target(target: String) -> AutomationTarget {
    target.parse().expect("an automation target is non-empty")
}
