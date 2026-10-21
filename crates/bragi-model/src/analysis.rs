//! `analysis.apply`: recording an analysis stage and reconciling the document with it
//! (`specs/02-song-model.md` §6).
//!
//! The op is a **reconciler**, not a patch. It stores the stage's typed effects in
//! `AnalysisRef::effects` and then derives the analysis-owned part of the arrangement from the
//! *set* of recorded effects, so the document depends on which stages have finished and never on
//! the order they arrived in. When the arrangement still equals the previous baseline it is
//! replaced with the new one; when the user has edited it, only additive effects are applied and a
//! late `structure` becomes `meta.suggestedSections` instead of re-splitting.
//!
//! Everything the arrangement needs is a pure function of the source (`workingAsset`,
//! `durationSamples`) and the recorded effects, which is what makes the permutation property
//! provable rather than hopeful. See `crates/bragi-model/tests/analysis.rs`.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::INTERNAL_SAMPLE_RATE_HZ;
use crate::assets::AssetIndex;
use crate::canonical::derived_id;
use crate::error::{ApplyError, ValidationCode, ValidationError};
use crate::generated::{
    AnalysisApplyOp, AnalysisBlobMap, AnalysisEffect, AnalysisEffectList, AnalysisProfile,
    AnalysisRef, AnalysisRefMap, AnalysisStage, AnalysisStageStatus, AnalysisStatusMap, AssetHash,
    AutomationList, Clip, ClipId, DescriptionEffect, FadeCurve, FxChain, HexColor, IsoDate, Lane,
    LaneMap, Project, Provenance, ProvenanceKind, SectionId, SectionInstance, SectionKind,
    SectionSuggestion, SectionSuggestionList, SectionsEffect, SeparationEffect, Source, SourceId,
    StemAsset, StemAssetMap, StemRole, StructureSection, TagsEffect, TempoEffect, TimeSig,
    Timebase, Track, TrackId, TrackOrigin, Transition, TransitionKind, Warp, WarpAnchor,
    WarpBeatgrid, WarpBeatgridMode, WarpNone, WarpNoneMode,
};
use crate::time::{MAX_BPM, MIN_BPM, TempoCtx, bar_ticks};

/// The neutral colour the example document uses for a full-mix lane. The other role colours are the
/// dark-theme role palette in `packages/design/tokens.json`, the one the canvas uses; a document
/// stores one hex colour, so the theme choice has to be made here.
const NEUTRAL_ROLE_COLOR: &str = "#8A8F98";

/// Records `op` in the document and reconciles the analysis-owned arrangement with it.
pub(crate) fn apply_analysis_apply(
    doc: &mut Project,
    op: &AnalysisApplyOp,
    assets: &AssetIndex,
    op_index: usize,
) -> Result<(), ApplyError> {
    let Some(source) = doc
        .sources
        .iter()
        .find(|source| source.id == op.source_id)
        .cloned()
    else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!("source {} does not exist", op.source_id),
        ));
    };
    validate_effects(op, op_index)?;

    let prev_analyses = doc.analyses.0.clone();
    let mut next_analyses = prev_analyses.clone();
    record_stage(&mut next_analyses, &source.id, op);

    let prev_effects = recorded_effects(&prev_analyses, &source.id).to_vec();
    let next_effects = recorded_effects(&next_analyses, &source.id).to_vec();
    // `ingest` carries no effect, but it does start the source's block, so it changes the baseline.
    let ingest_changed =
        has_ingest(&prev_analyses, &source.id) != has_ingest(&next_analyses, &source.id);
    let changed = ingest_changed || !json_equal(&prev_effects, &next_effects);

    if changed {
        let generated_at = source.provenance.as_ref().map_or_else(
            || doc.meta.created_at.clone(),
            |provenance| provenance.created_at.clone(),
        );
        let prev_base = build_baseline(doc, &prev_analyses, assets, &generated_at);
        let next_base = build_baseline(doc, &next_analyses, assets, &generated_at);
        let pristine = json_equal(&doc.arrangement.sections, &prev_base.sections)
            && json_equal(&doc.arrangement.timebase, &prev_base.timebase);

        if pristine {
            doc.arrangement.timebase = next_base.timebase.clone();
            doc.arrangement.sections = next_base.sections.clone();
            reconcile_tracks(doc, &prev_base, &next_base);
            clear_suggestions(doc, &source.id);
        } else {
            merge_into_edited(
                doc,
                &source,
                &prev_base,
                &next_base,
                &prev_effects,
                &next_effects,
                assets,
                &generated_at,
            );
        }
        // Only this op's own metadata effects, so a re-delivery of an unchanged stage cannot
        // resurrect a tag the user removed.
        apply_meta_effects(doc, &op.effects.0);
    }

    // A placed source (a generated extend, fill or transition) is not part of the
    // analysis-owned baseline: its audio lives where its placement says, and its stems are mapped
    // into that span (02 §6.4).
    if source.placement.is_some() {
        reconcile_placed_source(doc, &source, &next_effects, assets, op_index)?;
    }

    doc.analyses = AnalysisRefMap(next_analyses);
    Ok(())
}

fn invalid(op_index: usize, code: ValidationCode, message: impl Into<String>) -> ApplyError {
    ApplyError::Op(ValidationError::new(op_index, code, message))
}

fn effect_error(op_index: usize, message: impl Into<String>) -> ApplyError {
    invalid(op_index, ValidationCode::AnalysisEffects, message)
}

/// Structural equality through JSON: the generated types do not implement `PartialEq`, and a
/// serialisation failure counts as "not equal" so the safe (edited) path wins.
fn json_equal<T: Serialize>(left: &T, right: &T) -> bool {
    match (serde_json::to_value(left), serde_json::to_value(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

// --- the effect list -------------------------------------------------------------------------

/// The kinds of effect, in the fixed order the recorded list is kept in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum EffectKind {
    Tempo,
    Sections,
    Separation,
    Tags,
    Description,
}

fn effect_kind(effect: &AnalysisEffect) -> EffectKind {
    match effect {
        AnalysisEffect::TempoEffect(_) => EffectKind::Tempo,
        AnalysisEffect::SectionsEffect(_) => EffectKind::Sections,
        AnalysisEffect::SeparationEffect(_) => EffectKind::Separation,
        AnalysisEffect::TagsEffect(_) => EffectKind::Tags,
        AnalysisEffect::DescriptionEffect(_) => EffectKind::Description,
    }
}

/// The one effect kind a stage may carry, if any (02 §6).
fn expected_kind(stage: AnalysisStage) -> Option<EffectKind> {
    match stage {
        AnalysisStage::Rhythm => Some(EffectKind::Tempo),
        AnalysisStage::Structure => Some(EffectKind::Sections),
        AnalysisStage::Separation => Some(EffectKind::Separation),
        AnalysisStage::Tag => Some(EffectKind::Tags),
        AnalysisStage::Describe => Some(EffectKind::Description),
        _ => None,
    }
}

/// Merges `incoming` into `recorded`, one effect per kind, then sorts by kind. The result is a set,
/// not a log: the order events arrived in cannot influence it.
fn merge_effects(recorded: &[AnalysisEffect], incoming: &[AnalysisEffect]) -> Vec<AnalysisEffect> {
    let mut merged: Vec<AnalysisEffect> = recorded
        .iter()
        .filter(|recorded| {
            !incoming
                .iter()
                .any(|new| effect_kind(new) == effect_kind(recorded))
        })
        .cloned()
        .collect();
    merged.extend(incoming.iter().cloned());
    merged.sort_by_key(effect_kind);
    merged
}

fn tempo_effect(effects: &[AnalysisEffect]) -> Option<&TempoEffect> {
    effects.iter().find_map(|effect| match effect {
        AnalysisEffect::TempoEffect(tempo) => Some(tempo),
        _ => None,
    })
}

fn sections_effect(effects: &[AnalysisEffect]) -> Option<&SectionsEffect> {
    effects.iter().find_map(|effect| match effect {
        AnalysisEffect::SectionsEffect(sections) => Some(sections),
        _ => None,
    })
}

fn separation_effect(effects: &[AnalysisEffect]) -> Option<&SeparationEffect> {
    effects.iter().find_map(|effect| match effect {
        AnalysisEffect::SeparationEffect(separation) => Some(separation),
        _ => None,
    })
}

fn recorded_effects<'a>(
    analyses: &'a HashMap<SourceId, AnalysisRef>,
    source_id: &SourceId,
) -> &'a [AnalysisEffect] {
    analyses
        .get(source_id)
        .and_then(|analysis| analysis.effects.as_ref())
        .map_or(&[], |list| list.0.as_slice())
}

fn has_ingest(analyses: &HashMap<SourceId, AnalysisRef>, source_id: &SourceId) -> bool {
    analyses
        .get(source_id)
        .and_then(|analysis| analysis.status.0.get(&AnalysisStage::Ingest))
        .is_some_and(|status| *status == AnalysisStageStatus::Done)
}

/// Records the stage's status, blob and effect, and copies a `separation` effect's stems.
fn record_stage(
    analyses: &mut HashMap<SourceId, AnalysisRef>,
    source_id: &SourceId,
    op: &AnalysisApplyOp,
) {
    let analysis = analyses
        .entry(source_id.clone())
        .or_insert_with(|| AnalysisRef {
            blobs: AnalysisBlobMap(HashMap::new()),
            effects: None,
            profile: AnalysisProfile::Standard,
            status: AnalysisStatusMap(HashMap::new()),
            stems: None,
            summary: None,
        });
    analysis
        .status
        .0
        .insert(op.stage, AnalysisStageStatus::Done);
    analysis.blobs.0.insert(op.stage, op.blob.clone());

    let recorded: Vec<AnalysisEffect> = analysis
        .effects
        .as_ref()
        .map_or_else(Vec::new, |list| list.0.clone());
    let merged = merge_effects(&recorded, &op.effects.0);
    analysis.effects = if merged.is_empty() {
        None
    } else {
        Some(AnalysisEffectList(merged))
    };

    if let Some(separation) = separation_effect(&op.effects.0) {
        let mut stems = HashMap::new();
        for stem in &separation.stems.0 {
            stems.insert(stem.role, stem.asset.clone());
        }
        analysis.stems = Some(StemAssetMap(stems));
    }
}

/// Checks that the effects are the ones the stage owns and that each payload is usable (02 §6), so
/// the producer learns which effect is wrong instead of getting a document-level invariant error.
fn validate_effects(op: &AnalysisApplyOp, op_index: usize) -> Result<(), ApplyError> {
    let expected = expected_kind(op.stage);
    let mut seen: Vec<EffectKind> = Vec::new();
    for effect in &op.effects.0 {
        let kind = effect_kind(effect);
        if Some(kind) != expected {
            return Err(effect_error(
                op_index,
                format!("stage {} cannot carry a {kind:?} effect", op.stage),
            ));
        }
        if seen.contains(&kind) {
            return Err(effect_error(
                op_index,
                format!("stage {} carries more than one {kind:?} effect", op.stage),
            ));
        }
        seen.push(kind);
    }
    if let Some(expected) = expected
        && !seen.contains(&expected)
    {
        return Err(effect_error(
            op_index,
            format!("stage {} must carry its {expected:?} effect", op.stage),
        ));
    }
    for effect in &op.effects.0 {
        validate_effect(effect, op_index)?;
    }
    Ok(())
}

fn validate_effect(effect: &AnalysisEffect, op_index: usize) -> Result<(), ApplyError> {
    match effect {
        AnalysisEffect::TempoEffect(tempo) => validate_tempo(tempo, op_index),
        AnalysisEffect::SectionsEffect(sections) => {
            validate_sections(&sections.sections.0, op_index)
        }
        AnalysisEffect::SeparationEffect(separation) => {
            validate_separation(&separation.stems.0, op_index)
        }
        AnalysisEffect::TagsEffect(_) | AnalysisEffect::DescriptionEffect(_) => Ok(()),
    }
}

fn validate_tempo(tempo: &TempoEffect, op_index: usize) -> Result<(), ApplyError> {
    let Some(first) = tempo.tempo_map.0.first() else {
        return Err(effect_error(op_index, "a tempo effect needs a tempo map"));
    };
    if first.tick != 0 {
        return Err(effect_error(
            op_index,
            format!("the tempo map starts at tick {} instead of 0", first.tick),
        ));
    }
    let mut previous: Option<u64> = None;
    for point in &tempo.tempo_map.0 {
        if !(MIN_BPM..=MAX_BPM).contains(&point.bpm) {
            return Err(effect_error(
                op_index,
                format!(
                    "tempo {} bpm at tick {} is outside {MIN_BPM}..{MAX_BPM}",
                    point.bpm, point.tick
                ),
            ));
        }
        if let Some(previous) = previous
            && point.tick <= previous
        {
            return Err(effect_error(
                op_index,
                format!(
                    "tempo points are not sorted: tick {} follows tick {previous}",
                    point.tick
                ),
            ));
        }
        previous = Some(point.tick);
    }
    if tempo.time_signatures.0.is_empty() {
        return Err(effect_error(
            op_index,
            "a tempo effect needs a time signature",
        ));
    }
    Ok(())
}

fn validate_sections(sections: &[StructureSection], op_index: usize) -> Result<(), ApplyError> {
    let Some(first) = sections.first() else {
        return Err(effect_error(op_index, "a sections effect needs a section"));
    };
    if first.start_sec > 0.0 {
        return Err(effect_error(
            op_index,
            format!(
                "the first analysed section starts at {} s instead of 0",
                first.start_sec
            ),
        ));
    }
    let mut previous: Option<&StructureSection> = None;
    for section in sections {
        if !(section.start_sec.is_finite() && section.end_sec.is_finite())
            || section.start_sec < 0.0
            || section.end_sec <= section.start_sec
        {
            return Err(effect_error(
                op_index,
                format!(
                    "analysed section {}..{} is not a positive range",
                    section.start_sec, section.end_sec
                ),
            ));
        }
        if let Some(previous) = previous
            && section.start_sec < previous.end_sec
        {
            return Err(effect_error(
                op_index,
                format!(
                    "analysed sections overlap: {} s starts before {} s",
                    section.start_sec, previous.end_sec
                ),
            ));
        }
        previous = Some(section);
    }
    Ok(())
}

fn validate_separation(stems: &[StemAsset], op_index: usize) -> Result<(), ApplyError> {
    if stems.is_empty() {
        return Err(effect_error(op_index, "a separation effect needs a stem"));
    }
    let mut roles: HashSet<&StemRole> = HashSet::new();
    for stem in stems {
        if matches!(
            stem.role,
            StemRole::FullMix | StemRole::Residual | StemRole::Fx
        ) {
            return Err(effect_error(
                op_index,
                format!("{} is not a separated stem role", stem.role),
            ));
        }
        if !roles.insert(&stem.role) {
            return Err(effect_error(
                op_index,
                format!("stem role {} appears twice", stem.role),
            ));
        }
    }
    Ok(())
}

// --- the baseline ----------------------------------------------------------------------------

/// The analysis-owned part of the document, derived from the sources and a set of effects.
struct Baseline {
    timebase: Timebase,
    tracks: Vec<Track>,
    sections: Vec<SectionInstance>,
    blocks: Vec<Block>,
}

/// One source's contribution to the baseline: where it sits, its tracks and the sections it wants.
struct Block {
    source_id: SourceId,
    offset: i64,
    total_ticks: i64,
    /// Tracks this block owns, with the asset each one's clips use.
    assets: Vec<(TrackId, AssetHash)>,
    /// Whether a tempo effect gave this block a grid.
    grid: bool,
    suggestions: Vec<SectionSuggestion>,
}

/// A growing list of bar starts for a time signature set. Bar `n` starts at the sum of the lengths
/// of bars `0..n`.
struct BarGrid<'a> {
    signatures: &'a [TimeSig],
    ppq: i64,
    starts: Vec<i64>,
}

impl<'a> BarGrid<'a> {
    fn new(signatures: &'a [TimeSig], ppq: i64) -> Self {
        Self {
            signatures,
            ppq,
            starts: vec![0],
        }
    }

    /// Appends bar starts until the last one is at or past `tick`.
    fn extend_past(&mut self, tick: i64) {
        // A bar is at least 120 ticks at PPQ 960, but a document is not bounded, so cap the list
        // rather than risk an unbounded allocation on a nonsensical duration.
        const MAX_BARS: usize = 4_000_000;
        while self.starts.last().copied().unwrap_or(0) < tick {
            if self.starts.len() >= MAX_BARS {
                break;
            }
            let bar = u64::try_from(self.starts.len() - 1).unwrap_or(u64::MAX);
            let length = bar_ticks(self.signatures, bar, self.ppq).max(1);
            let next = self
                .starts
                .last()
                .copied()
                .unwrap_or(0)
                .saturating_add(length);
            self.starts.push(next);
        }
    }

    /// The first bar start at or after `tick`.
    fn ceil(&mut self, tick: i64) -> i64 {
        self.extend_past(tick);
        let index = self.starts.partition_point(|start| *start < tick);
        self.starts
            .get(index)
            .copied()
            .unwrap_or_else(|| self.starts.last().copied().unwrap_or(0))
    }

    /// The bar start closest to `tick`; ties go to the earlier bar.
    fn nearest(&mut self, tick: i64) -> i64 {
        self.extend_past(tick);
        let index = self.starts.partition_point(|start| *start < tick);
        let lower = index
            .checked_sub(1)
            .and_then(|index| self.starts.get(index))
            .copied();
        let upper = self.starts.get(index).copied();
        match (lower, upper) {
            (Some(lower), Some(upper)) => {
                if tick - lower <= upper - tick {
                    lower
                } else {
                    upper
                }
            }
            (Some(lower), None) => lower,
            (None, Some(upper)) => upper,
            (None, None) => 0,
        }
    }
}

/// One section boundary: a bar-snapped local tick, the kind it starts, and which analysed section
/// it came from (`None` for the implicit start at 0 when there is no structure effect).
struct Boundary {
    tick: i64,
    kind: SectionKind,
    section: Option<usize>,
}

/// Builds the baseline for every source that has finished `ingest`.
fn build_baseline(
    doc: &Project,
    analyses: &HashMap<SourceId, AnalysisRef>,
    assets: &AssetIndex,
    generated_at: &IsoDate,
) -> Baseline {
    let mut timebase = doc.arrangement.timebase.clone();
    for source in &doc.sources {
        // A placed source does not own the song's tempo; its audio is already in the song's grid.
        if source.placement.is_some() || !has_ingest(analyses, &source.id) {
            continue;
        }
        if let Some(tempo) = tempo_effect(recorded_effects(analyses, &source.id)) {
            timebase.tempo_map = tempo.tempo_map.clone();
            timebase.time_signatures = tempo.time_signatures.clone();
            break;
        }
    }

    let ppq = *timebase.ppq;
    let mut grid = BarGrid::new(&timebase.time_signatures, ppq);
    let tempo = TempoCtx::new(&timebase.tempo_map.0, ppq);
    let mut tracks: Vec<Track> = Vec::new();
    let mut sections: Vec<SectionInstance> = Vec::new();
    let mut blocks: Vec<Block> = Vec::new();
    let mut offset = 0_i64;

    for source in &doc.sources {
        if source.placement.is_some() || !has_ingest(analyses, &source.id) {
            continue;
        }
        let effects = recorded_effects(analyses, &source.id);
        let base_seconds = tempo.ticks_to_seconds(offset);
        let duration_secs = source.duration_samples as f64 / f64::from(INTERNAL_SAMPLE_RATE_HZ);
        if duration_secs <= 0.0 {
            continue;
        }
        let total = grid.ceil(tempo.seconds_to_ticks(base_seconds + duration_secs)) - offset;
        if total <= 0 {
            continue;
        }
        grid.extend_past(offset + total);
        let bar_starts = grid.starts.clone();

        let (block_tracks, block_assets) = source_tracks(source, effects);
        let section_list = sections_effect(effects).map(|effect| &effect.sections.0);
        let boundaries =
            section_boundaries(section_list, &mut grid, &tempo, base_seconds, offset, total);
        let labels = section_labels(&boundaries);
        let plan = ClipPlan {
            assets,
            bar_starts: &bar_starts,
            base_samples: 0,
            base_seconds,
            grid: tempo_effect(effects).is_some(),
            source_duration: source.duration_samples,
            tempo: &tempo,
        };
        let transform = provenance(ProvenanceKind::Transform, generated_at);
        let separation_provenance = provenance(ProvenanceKind::Separation, generated_at);
        let mix_track = block_assets.first().map(|(id, _)| id.clone());

        for (index, boundary) in boundaries.iter().enumerate() {
            let end = boundaries.get(index + 1).map_or(total, |next| next.tick);
            let length = end - boundary.tick;
            if length <= 0 {
                continue;
            }
            let Some(id) = section_id(derived_id(
                "sec_",
                source.id.as_str(),
                &format!("section:{index}"),
            )) else {
                continue;
            };
            let mut lanes = LaneMap(HashMap::new());
            for (track_id, asset) in &block_assets {
                let provenance = if mix_track.as_ref() == Some(track_id) {
                    &transform
                } else {
                    &separation_provenance
                };
                let section_abs_start = offset + boundary.tick;
                if let Some(clip) = plan.clip(
                    &id,
                    track_id,
                    asset,
                    0,
                    length,
                    section_abs_start,
                    provenance,
                ) {
                    lanes.0.insert(
                        track_id.clone(),
                        Lane {
                            clips: vec![clip],
                            automation: AutomationList(Vec::new()),
                        },
                    );
                }
            }
            sections.push(SectionInstance {
                derived_from: None,
                energy_target: None,
                id,
                kind: boundary.kind,
                label: labels.get(index).cloned().unwrap_or_default(),
                length_ticks: nonzero(length),
                lanes,
                locked: None,
                transition_in: Transition {
                    asset: None,
                    kind: TransitionKind::Cut,
                    length_ticks: 0,
                },
            });
        }

        let suggestions = block_suggestions(
            &source.id,
            section_list,
            &boundaries,
            &labels,
            offset,
            total,
        );

        tracks.extend(block_tracks);
        blocks.push(Block {
            source_id: source.id.clone(),
            offset,
            total_ticks: total,
            assets: block_assets,
            grid: plan.grid,
            suggestions,
        });
        offset += total;
    }

    Baseline {
        timebase,
        tracks,
        sections,
        blocks,
    }
}

/// The full-mix track, the stem tracks and the residual for one source.
fn source_tracks(
    source: &Source,
    effects: &[AnalysisEffect],
) -> (Vec<Track>, Vec<(TrackId, AssetHash)>) {
    let separation = separation_effect(effects);
    let mut tracks = Vec::new();
    let mut assets = Vec::new();

    if let Some(id) = track_id(derived_id("trk_", source.id.as_str(), "full_mix")) {
        tracks.push(Track {
            color: role_color(StemRole::FullMix),
            fx: FxChain(Vec::new()),
            gain_db: 0.0,
            hidden: separation.is_some(),
            id: id.clone(),
            mute: false,
            name: "Original mix".to_owned(),
            origin: Some(TrackOrigin {
                source_id: source.id.clone(),
                stem: Some(StemRole::FullMix),
            }),
            pan: 0.0,
            role: StemRole::FullMix,
            solo: false,
        });
        assets.push((id, source.working_asset.clone()));
    }

    if let Some(separation) = separation {
        for stem in &separation.stems.0 {
            let Some(id) = track_id(derived_id(
                "trk_",
                source.id.as_str(),
                &format!("stem:{}", stem.role),
            )) else {
                continue;
            };
            tracks.push(Track {
                color: role_color(stem.role),
                fx: FxChain(Vec::new()),
                gain_db: 0.0,
                hidden: false,
                id: id.clone(),
                mute: false,
                name: role_name(&stem.role).to_owned(),
                origin: Some(TrackOrigin {
                    source_id: source.id.clone(),
                    stem: Some(stem.role),
                }),
                pan: 0.0,
                role: stem.role,
                solo: false,
            });
            assets.push((id, stem.asset.clone()));
        }

        if let Some(id) = track_id(derived_id("trk_", source.id.as_str(), "residual")) {
            tracks.push(Track {
                color: role_color(StemRole::Residual),
                fx: FxChain(Vec::new()),
                gain_db: 0.0,
                hidden: true,
                id: id.clone(),
                mute: false,
                name: "Residual".to_owned(),
                origin: Some(TrackOrigin {
                    source_id: source.id.clone(),
                    stem: Some(StemRole::Residual),
                }),
                pan: 0.0,
                role: StemRole::Residual,
                solo: false,
            });
            assets.push((id, separation.residual.clone()));
        }
    }

    (tracks, assets)
}

/// The bar-snapped section starts of a source block, with the kind each boundary introduces.
fn section_boundaries(
    sections: Option<&Vec<StructureSection>>,
    grid: &mut BarGrid<'_>,
    tempo: &TempoCtx<'_>,
    base_seconds: f64,
    offset: i64,
    total: i64,
) -> Vec<Boundary> {
    let first = sections
        .and_then(|sections| sections.first())
        .map_or(SectionKind::Custom, |section| section.kind);
    let mut boundaries = vec![Boundary {
        tick: 0,
        kind: first,
        section: sections.map(|_| 0),
    }];
    if let Some(sections) = sections {
        for (index, section) in sections.iter().enumerate().skip(1) {
            let tick = tempo.seconds_to_ticks(base_seconds + section.start_sec);
            let local = (grid.nearest(tick) - offset).clamp(0, total);
            let previous = boundaries.last().map_or(0, |boundary| boundary.tick);
            if local > previous && local < total {
                boundaries.push(Boundary {
                    tick: local,
                    kind: section.kind,
                    section: Some(index),
                });
            }
        }
    }
    boundaries
}

/// "Verse 1" when the kind recurs, "Intro" when it does not (02 §6.1).
fn section_labels(boundaries: &[Boundary]) -> Vec<String> {
    boundaries
        .iter()
        .enumerate()
        .map(|(index, boundary)| {
            let label = kind_label(boundary.kind);
            let total = boundaries
                .iter()
                .filter(|other| other.kind == boundary.kind)
                .count();
            if total > 1 {
                let position = boundaries[..=index]
                    .iter()
                    .filter(|other| other.kind == boundary.kind)
                    .count();
                format!("{label} {position}")
            } else {
                label.to_owned()
            }
        })
        .collect()
}

pub(crate) fn kind_label(kind: SectionKind) -> &'static str {
    match kind {
        SectionKind::Intro => "Intro",
        SectionKind::Verse => "Verse",
        SectionKind::PreChorus => "Pre-chorus",
        SectionKind::Chorus => "Chorus",
        SectionKind::PostChorus => "Post-chorus",
        SectionKind::Bridge => "Bridge",
        SectionKind::Breakdown => "Breakdown",
        SectionKind::Build => "Build",
        SectionKind::Drop => "Drop",
        SectionKind::Solo => "Solo",
        SectionKind::Interlude => "Interlude",
        SectionKind::Outro => "Outro",
        SectionKind::Custom => "Section",
    }
}

/// Reconciles the span of a placed source with its recorded separation effect (02 §6).
///
/// A placed source is not laid out by the baseline: its audio lives where the placement says.
/// When a `separation` effect has been recorded, every stem role and the residual are mapped onto
/// the first track with that role (or a new deterministic track), as one deterministic clip per
/// (section, track) inside the placement span. That span is the anchored section's whole length
/// for an extend, or the gap range for a fill — which may cross into the following sections, so
/// each slice gets its own clip. The generated mix-only lane is removed in the same step; when
/// separation has not reported (it failed), nothing is removed and the generated clip keeps the
/// song playable. A placement with no lane audio (a generated transition) maps nothing.
fn reconcile_placed_source(
    doc: &mut Project,
    source: &Source,
    effects: &[AnalysisEffect],
    assets: &AssetIndex,
    op_index: usize,
) -> Result<(), ApplyError> {
    let Some(placement) = &source.placement else {
        return Ok(());
    };
    let Some(separation) = separation_effect(effects) else {
        return Ok(());
    };
    // A placement can own no lane audio at all (a generated transition, which the engine plays
    // over the boundary instead). Its stems map nowhere; without this guard the mapping would
    // still create role tracks for audio that has no span.
    let has_lane_audio = doc.arrangement.sections.iter().any(|section| {
        section
            .lanes
            .0
            .values()
            .flat_map(|lane| lane.clips.iter())
            .any(|clip| clip.asset == source.working_asset || clip.asset == source.original_asset)
    });
    if !has_lane_audio {
        return Ok(());
    }
    let Some((_, section_start, section_length)) = placed_section(doc, &placement.section_id)
    else {
        return Err(invalid(
            op_index,
            ValidationCode::MissingTarget,
            format!(
                "source {} is placed in section {} which does not exist",
                source.id, placement.section_id
            ),
        ));
    };

    let spans = crate::spans::section_spans(doc);
    let total = crate::spans::total_ticks(doc);
    let (span_start, span_end, base_samples) = match &placement.range {
        Some(range) => {
            let start = section_start.saturating_add(range.start_tick);
            let end = section_start.saturating_add(range.end_tick).min(total);
            if range.end_tick <= range.start_tick || start < section_start || end <= start {
                return Err(invalid(
                    op_index,
                    ValidationCode::NumericRange,
                    format!(
                        "source {} has an empty or out-of-range placement range [{}, {})",
                        source.id, range.start_tick, range.end_tick
                    ),
                ));
            }
            (start, end, placement.src_start_samples.unwrap_or(0))
        }
        None => (section_start, section_start + section_length, 0),
    };

    let timebase = doc.arrangement.timebase.clone();
    let ppq = *timebase.ppq;
    let mut grid = BarGrid::new(&timebase.time_signatures, ppq);
    grid.extend_past(span_end);
    let bar_starts = grid.starts.clone();
    let tempo = TempoCtx::new(&timebase.tempo_map.0, ppq);
    let plan = ClipPlan {
        assets,
        bar_starts: &bar_starts,
        base_samples,
        base_seconds: tempo.ticks_to_seconds(span_start),
        grid: true,
        source_duration: source.duration_samples,
        tempo: &tempo,
    };
    let generated_at = source.provenance.as_ref().map_or_else(
        || doc.meta.created_at.clone(),
        |provenance| provenance.created_at.clone(),
    );
    let stem_provenance = provenance(ProvenanceKind::Separation, &generated_at);

    let mut assets_by_role: Vec<(StemRole, AssetHash)> = separation
        .stems
        .0
        .iter()
        .map(|stem| (stem.role, stem.asset.clone()))
        .collect();
    // The residual is what makes the extended part reconstruct its own mix; map it too.
    assets_by_role.push((StemRole::Residual, separation.residual.clone()));
    // The effect list is a set, so the role order must not depend on the worker's order.
    assets_by_role.sort_by_key(|(role, _)| role.to_string());

    for (role, asset) in &assets_by_role {
        let track_id = match doc.tracks.iter().find(|track| track.role == *role) {
            Some(track) => track.id.clone(),
            None => {
                // Derived from the role alone: the track is shared by every placed source that
                // maps onto it, so its ID (and therefore the document) must not depend on which
                // source's analysis arrived first (02 §6.4).
                let Some(id) = track_id(derived_id("trk_", "placed", &format!("stem:{role}")))
                else {
                    return Err(effect_error(op_index, "cannot derive a stem track id"));
                };
                doc.tracks.push(track_for_role(*role, id.clone()));
                id
            }
        };
        for span in spans
            .iter()
            .filter(|span| span.end_tick > span_start && span.start_tick < span_end)
        {
            let local_start = span_start.max(span.start_tick) - span.start_tick;
            let local_end = span_end.min(span.end_tick) - span.start_tick;
            let Some(mut clip) = plan.clip(
                &span.id,
                &track_id,
                asset,
                local_start,
                local_end,
                span.start_tick,
                &stem_provenance,
            ) else {
                continue;
            };
            // A fill's mapped clips are per source, so two fills inside one section keep both.
            if placement.range.is_some() {
                let child = format!("fill:{}:{}", span.id, track_id);
                let Some(id) = clip_id(derived_id("clp_", source.id.as_str(), &child)) else {
                    return Err(effect_error(op_index, "cannot derive a stem clip id"));
                };
                clip.id = id;
            }
            upsert_clip(doc, span.index, &track_id, clip);
        }
    }

    remove_generated_lane(doc, source);
    Ok(())
}

/// The placement section's index, absolute start and length.
fn placed_section(doc: &Project, id: &SectionId) -> Option<(usize, i64, i64)> {
    let index = doc.arrangement.sections.iter().position(|s| s.id == *id)?;
    let start = crate::spans::section_spans(doc)
        .get(index)
        .map(|span| span.start_tick)?;
    let length = i64::try_from(doc.arrangement.sections[index].length_ticks.get()).ok()?;
    Some((index, start, length))
}

fn upsert_clip(doc: &mut Project, section_index: usize, track_id: &TrackId, clip: Clip) {
    let section = &mut doc.arrangement.sections[section_index];
    let lane = section
        .lanes
        .0
        .entry(track_id.clone())
        .or_insert_with(|| Lane {
            clips: Vec::new(),
            automation: AutomationList(Vec::new()),
        });
    lane.clips.retain(|current| current.id != clip.id);
    lane.clips.push(clip);
    // One clip per mapped track, but keep the order stable if that ever changes.
    lane.clips
        .sort_by(|left, right| (left.start, &left.id).cmp(&(right.start, &right.id)));
}

fn track_for_role(role: StemRole, id: TrackId) -> Track {
    Track {
        color: role_color(role),
        fx: FxChain(Vec::new()),
        gain_db: 0.0,
        hidden: role == StemRole::Residual,
        id,
        mute: false,
        name: role_name(&role).to_owned(),
        // No `origin`: several placed sources may map their stems onto this one track, so naming
        // any of them would make the document depend on the analysis arrival order (02 §6.4).
        origin: None,
        pan: 0.0,
        role,
        solo: false,
    }
}

/// Removes this source's generated mix clip and its now-empty lane; the track goes too when this
/// source owns it and nothing is left in it (09 §9 check 2).
fn remove_generated_lane(doc: &mut Project, source: &Source) {
    let generated: Vec<TrackId> = doc
        .tracks
        .iter()
        .filter(|track| track.role == StemRole::Generated)
        .map(|track| track.id.clone())
        .collect();
    for track_id in &generated {
        for section in &mut doc.arrangement.sections {
            if let Some(lane) = section.lanes.0.get_mut(track_id) {
                lane.clips.retain(|clip| {
                    clip.asset != source.working_asset && clip.asset != source.original_asset
                });
                if lane.clips.is_empty() && lane.automation.0.is_empty() {
                    section.lanes.0.remove(track_id);
                }
            }
        }
    }
    let empty: Vec<TrackId> =
        doc.tracks
            .iter()
            .filter(|track| {
                track.role == StemRole::Generated
                    && track.origin.as_ref().is_some_and(|origin| {
                        // A track a placement created, not the user's: whichever placed source
                        // maps last removes it once nothing is left anywhere, so a shared
                        // `generated` track does not depend on the analysis arrival order.
                        doc.sources.iter().any(|source| {
                            source.id == origin.source_id && source.placement.is_some()
                        })
                    })
                    && doc.arrangement.sections.iter().all(|section| {
                        section.lanes.0.get(&track.id).is_none_or(|lane| {
                            lane.clips.is_empty() && lane.automation.0.is_empty()
                        })
                    })
            })
            .map(|track| track.id.clone())
            .collect();
    doc.tracks.retain(|track| !empty.contains(&track.id));
}

pub(crate) fn role_name(role: &StemRole) -> &'static str {
    match role {
        StemRole::Vocals => "Vocals",
        StemRole::Drums => "Drums",
        StemRole::Bass => "Bass",
        StemRole::Guitar => "Guitar",
        StemRole::Piano => "Piano",
        StemRole::Synth => "Synths",
        StemRole::Strings => "Strings",
        StemRole::Other => "Other",
        StemRole::Residual => "Residual",
        StemRole::FullMix => "Original mix",
        StemRole::Generated => "Generated",
        StemRole::Fx => "FX",
        StemRole::Recorded => "Recorded",
    }
}

fn block_suggestions(
    source_id: &SourceId,
    sections: Option<&Vec<StructureSection>>,
    boundaries: &[Boundary],
    labels: &[String],
    offset: i64,
    total: i64,
) -> Vec<SectionSuggestion> {
    let Some(sections) = sections else {
        return Vec::new();
    };
    let mut suggestions = Vec::new();
    for (index, boundary) in boundaries.iter().enumerate() {
        let Some(section) = boundary.section.and_then(|index| sections.get(index)) else {
            continue;
        };
        let end = boundaries.get(index + 1).map_or(total, |next| next.tick);
        suggestions.push(SectionSuggestion {
            confidence: Some(section.confidence.0),
            end_sec: section.end_sec,
            end_tick: u64::try_from(offset + end).unwrap_or(0),
            kind: boundary.kind,
            label: labels.get(index).cloned().unwrap_or_default(),
            repeat_group: section.repeat_group.clone(),
            source_id: source_id.clone(),
            start_sec: section.start_sec,
            start_tick: u64::try_from(offset + boundary.tick).unwrap_or(0),
        });
    }
    suggestions
}

/// Everything a clip needs to map a section's tick span onto a source asset.
struct ClipPlan<'a> {
    assets: &'a AssetIndex,
    bar_starts: &'a [i64],
    /// The source sample that plays at [`ClipPlan::base_seconds`]: 0 for a block laid from the
    /// section start, the left-overlap skip for a ranged placement (02 §6.4).
    base_samples: u64,
    base_seconds: f64,
    grid: bool,
    source_duration: u64,
    tempo: &'a TempoCtx<'a>,
}

impl ClipPlan<'_> {
    /// Samples from the start of the source at absolute tick `tick`, clamped to the asset.
    fn sample_at(&self, tick: i64, asset: &AssetHash) -> u64 {
        let seconds = self.tempo.ticks_to_seconds(tick) - self.base_seconds;
        let raw = (seconds * f64::from(INTERNAL_SAMPLE_RATE_HZ)).round();
        let relative = if raw.is_finite() && raw > 0.0 {
            raw as u64
        } else {
            0
        };
        let asset_duration = self.assets.duration_samples(asset).unwrap_or(u64::MAX);
        self.base_samples
            .saturating_add(relative)
            .min(self.source_duration)
            .min(asset_duration)
    }

    /// One clip covering the section-relative span `[local_start, local_end)`, where
    /// `section_abs_start` is the absolute tick of that section's local 0.
    #[allow(clippy::too_many_arguments)] // one geometry call: two spans in two time domains
    fn clip(
        &self,
        section_id: &SectionId,
        track_id: &TrackId,
        asset: &AssetHash,
        local_start: i64,
        local_end: i64,
        section_abs_start: i64,
        provenance: &Provenance,
    ) -> Option<Clip> {
        if local_end <= local_start {
            return None;
        }
        let abs_start = section_abs_start.checked_add(local_start)?;
        let abs_end = section_abs_start.checked_add(local_end)?;
        let src_start = self.sample_at(abs_start, asset);
        let src_end = self.sample_at(abs_end, asset);
        if src_end <= src_start {
            return None;
        }
        Some(Clip {
            asset: asset.clone(),
            fade_curve: FadeCurve::EqualPower,
            fade_in_ticks: 0,
            fade_out_ticks: 0,
            fx: None,
            gain_db: 0.0,
            id: clip_id(derived_id("clp_", section_id.as_str(), track_id.as_str()))?,
            pitch_semitones: 0.0,
            provenance: provenance.clone(),
            reverse: None,
            src_end,
            src_start,
            start: local_start,
            warp: self.warp(
                asset,
                src_start,
                src_end,
                local_start,
                local_end,
                section_abs_start,
                abs_start,
                abs_end,
            ),
        })
    }

    /// A beat grid through the clip's own start, every bar start inside it, and its end; `none`
    /// when no tempo effect has been recorded yet.
    #[allow(clippy::too_many_arguments)] // one geometry call, all of it in ticks and samples
    fn warp(
        &self,
        asset: &AssetHash,
        src_start: u64,
        src_end: u64,
        local_start: i64,
        local_end: i64,
        section_abs_start: i64,
        abs_start: i64,
        abs_end: i64,
    ) -> Warp {
        if !self.grid {
            return Warp::None(WarpNone {
                mode: WarpNoneMode::None,
            });
        }
        let mut anchors = vec![WarpAnchor {
            src_sample: src_start,
            tick: local_start,
        }];
        let mut last_sample = src_start;
        let mut last_tick = local_start;
        for bar in self.bar_starts {
            if *bar <= abs_start || *bar >= abs_end {
                continue;
            }
            let sample = self.sample_at(*bar, asset);
            let tick = bar - section_abs_start;
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
}

// --- reconciliation --------------------------------------------------------------------------

/// The arrangement is pristine: adopt the new baseline's tracks, keeping any user track in place.
fn reconcile_tracks(doc: &mut Project, previous: &Baseline, next: &Baseline) {
    for track in &next.tracks {
        match doc.tracks.iter().position(|current| current.id == track.id) {
            Some(position) => {
                let untouched = previous
                    .tracks
                    .iter()
                    .find(|before| before.id == track.id)
                    .is_some_and(|before| json_equal(before, &doc.tracks[position]));
                if untouched {
                    doc.tracks[position] = track.clone();
                }
            }
            None => doc.tracks.push(track.clone()),
        }
    }
}

/// The user has edited the arrangement: only add what is missing, never overwrite (02 §6.3).
#[allow(clippy::too_many_arguments)]
fn merge_into_edited(
    doc: &mut Project,
    source: &Source,
    previous: &Baseline,
    next: &Baseline,
    prev_effects: &[AnalysisEffect],
    next_effects: &[AnalysisEffect],
    assets: &AssetIndex,
    generated_at: &IsoDate,
) {
    let existing: HashSet<String> = previous
        .tracks
        .iter()
        .map(|track| track.id.to_string())
        .collect();
    let mut added: Vec<TrackId> = Vec::new();
    for track in &next.tracks {
        if existing.contains(track.id.as_str()) {
            continue;
        }
        if doc.tracks.iter().any(|current| current.id == track.id) {
            continue;
        }
        doc.tracks.push(track.clone());
        added.push(track.id.clone());
    }
    if !added.is_empty() {
        fill_empty_lanes(doc, source, next, &added, assets, generated_at);
    }

    let sections_changed = !json_equal(
        &sections_summary(next_effects),
        &sections_summary(prev_effects),
    );
    if sections_changed
        && let Some(block) = next
            .blocks
            .iter()
            .find(|block| block.source_id == source.id)
        && !block.suggestions.is_empty()
    {
        write_suggestions(doc, &source.id, block.suggestions.clone());
    }
}

/// The `sections` effect's content as JSON, for change detection.
fn sections_summary(effects: &[AnalysisEffect]) -> serde_json::Value {
    sections_effect(effects)
        .and_then(|effect| serde_json::to_value(effect).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// Adds one clip per existing section whose span meets the block, for tracks that just appeared.
/// Existing clips are never touched.
fn fill_empty_lanes(
    doc: &mut Project,
    source: &Source,
    baseline: &Baseline,
    added: &[TrackId],
    assets: &AssetIndex,
    generated_at: &IsoDate,
) {
    let Some(block) = baseline
        .blocks
        .iter()
        .find(|block| block.source_id == source.id)
    else {
        return;
    };
    let timebase = doc.arrangement.timebase.clone();
    let ppq = *timebase.ppq;
    let mut grid = BarGrid::new(&timebase.time_signatures, ppq);
    let total = crate::spans::total_ticks(doc);
    grid.extend_past(total);
    let bar_starts = grid.starts.clone();
    let tempo = TempoCtx::new(&timebase.tempo_map.0, ppq);
    let plan = ClipPlan {
        assets,
        bar_starts: &bar_starts,
        base_samples: 0,
        base_seconds: tempo.ticks_to_seconds(block.offset),
        grid: block.grid,
        source_duration: source.duration_samples,
        tempo: &tempo,
    };
    let provenance = provenance(ProvenanceKind::Separation, generated_at);
    // A placed source owns its section: a late stage of another source must not fill it.
    let placed: HashSet<String> = doc
        .sources
        .iter()
        .filter_map(|source| {
            source
                .placement
                .as_ref()
                .map(|placement| placement.section_id.to_string())
        })
        .collect();

    for track_id in added {
        let Some((_, asset)) = block.assets.iter().find(|(id, _)| id == track_id) else {
            continue;
        };
        let block_start = block.offset;
        let block_end = block.offset.saturating_add(block.total_ticks);
        let mut section_start = 0_i64;
        for section in &mut doc.arrangement.sections {
            let section_length = i64::try_from(section.length_ticks.get()).unwrap_or(i64::MAX);
            let section_end = section_start.saturating_add(section_length);
            let span_start = section_start.max(block_start);
            let span_end = section_end.min(block_end);
            if span_end > span_start && !placed.contains(section.id.as_str()) {
                let occupied = section
                    .lanes
                    .0
                    .get(track_id)
                    .is_some_and(|lane| !lane.clips.is_empty());
                if !occupied
                    && let Some(clip) = plan.clip(
                        &section.id,
                        track_id,
                        asset,
                        span_start - section_start,
                        span_end - section_start,
                        section_start,
                        &provenance,
                    )
                {
                    section
                        .lanes
                        .0
                        .entry(track_id.clone())
                        .or_insert_with(|| Lane {
                            clips: Vec::new(),
                            automation: AutomationList(Vec::new()),
                        })
                        .clips
                        .push(clip);
                }
            }
            section_start = section_end;
        }
    }
}

fn write_suggestions(doc: &mut Project, source_id: &SourceId, suggestions: Vec<SectionSuggestion>) {
    let mut all: Vec<SectionSuggestion> =
        doc.meta
            .suggested_sections
            .take()
            .map_or_else(Vec::new, |list| {
                list.0
                    .into_iter()
                    .filter(|suggestion| suggestion.source_id != *source_id)
                    .collect()
            });
    all.extend(suggestions);
    doc.meta.suggested_sections = if all.is_empty() {
        None
    } else {
        Some(SectionSuggestionList(all))
    };
}

fn clear_suggestions(doc: &mut Project, source_id: &SourceId) {
    let Some(list) = doc.meta.suggested_sections.take() else {
        return;
    };
    let kept: Vec<SectionSuggestion> = list
        .0
        .into_iter()
        .filter(|suggestion| suggestion.source_id != *source_id)
        .collect();
    doc.meta.suggested_sections = if kept.is_empty() {
        None
    } else {
        Some(SectionSuggestionList(kept))
    };
}

/// `tag` merges into the tags (union, existing order first) and `describe` fills an absent
/// description. Both are idempotent, so a re-delivery cannot change anything.
fn apply_meta_effects(doc: &mut Project, effects: &[AnalysisEffect]) {
    for effect in effects {
        match effect {
            AnalysisEffect::TagsEffect(TagsEffect { genres, moods, .. }) => {
                for tag in genres.0.iter().chain(moods.0.iter()) {
                    if !doc.meta.tags.0.iter().any(|current| current == tag) {
                        doc.meta.tags.0.push(tag.clone());
                    }
                }
            }
            AnalysisEffect::DescriptionEffect(DescriptionEffect { description, .. })
                if doc.meta.description.is_none() =>
            {
                doc.meta.description = Some(description.as_str().to_owned());
            }
            _ => {}
        }
    }
}

// --- small constructors ----------------------------------------------------------------------

fn provenance(kind: ProvenanceKind, created_at: &IsoDate) -> Provenance {
    Provenance {
        created_at: created_at.clone(),
        job_id: None,
        kind,
        model: None,
        model_version: None,
        prompt: None,
    }
}

fn nonzero(value: i64) -> std::num::NonZeroU64 {
    std::num::NonZeroU64::new(u64::try_from(value).unwrap_or(1))
        .unwrap_or(std::num::NonZeroU64::MIN)
}

/// Role colours from `packages/design/tokens.json` (dark theme).
pub(crate) fn role_color(role: StemRole) -> HexColor {
    let hex = match role {
        StemRole::Vocals => "#FB766A",
        StemRole::Drums => "#FFAB46",
        StemRole::Bass => "#9778F5",
        StemRole::Guitar => "#6AD987",
        StemRole::Piano => "#8FE1FF",
        StemRole::Synth => "#DB5FD3",
        StemRole::Strings => "#29B5A8",
        StemRole::Generated => "#F3DF83",
        StemRole::Residual => "#808693",
        _ => NEUTRAL_ROLE_COLOR,
    };
    hex_color(hex)
}

#[allow(clippy::expect_used)] // `NEUTRAL_ROLE_COLOR` and the table are `#RRGGBB` constants
fn hex_color(text: &str) -> HexColor {
    text.parse().expect("role colours are #RRGGBB constants")
}

/// A derived ID is its prefix plus base32, which the schema's pattern always accepts.
fn track_id(text: String) -> Option<TrackId> {
    text.parse().ok()
}

fn section_id(text: String) -> Option<SectionId> {
    text.parse().ok()
}

fn clip_id(text: String) -> Option<ClipId> {
    text.parse().ok()
}
