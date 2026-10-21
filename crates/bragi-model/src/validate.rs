//! Document validation: the invariants in `specs/02-song-model.md` §4.3.
//!
//! The JSON Schema checks what a single object can express (types, enums, ID and hash shapes,
//! integer bounds). The invariants here span several objects at once — a lane's `TrackId` must
//! exist, a clip must fit its asset, the tempo map must be sorted, clips may only overlap under
//! fades — so this module is where they live (02 §4.3).
//!
//! Validation is *total*: it collects every error rather than stopping at the first.

use std::collections::{BTreeSet, HashMap};
use std::sync::LazyLock;

use serde::Deserialize;

use crate::assets::AssetIndex;
use crate::clipmath::clip_end_local;
use crate::error::{ValidationCode, ValidationError};
use crate::generated::{FxInstance, FxType, Project, TempoPoint};
use crate::time::{MAX_BPM, MIN_BPM, TempoCtx};

/// The lowest pan the specification allows (`specs/02-song-model.md` §3.4).
pub const MIN_PAN: f64 = -1.0;
/// The highest pan the specification allows.
pub const MAX_PAN: f64 = 1.0;

/// Validates a whole document against 02 §4.3.
///
/// Returns every error found, with `opIndex` `0` (the document was not produced by a specific op).
///
/// ```
/// # use bragi_model::{AssetIndex, validate};
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
/// #         "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } }
/// # })).unwrap();
/// assert!(validate(&doc, &AssetIndex::new()).is_ok());
/// ```
pub fn validate(doc: &Project, assets: &AssetIndex) -> Result<(), Vec<ValidationError>> {
    let mut errors = Vec::new();
    let tracks = check_ids(doc, &mut errors);
    check_sources(doc, &mut errors);
    check_lanes(doc, &tracks, &mut errors);
    check_tempo_map(&doc.arrangement.timebase.tempo_map.0, &mut errors);
    check_numeric_bounds(doc, &mut errors);
    check_clips(doc, assets, &mut errors);
    check_fx(doc, &tracks, &mut errors);
    errors.sort_by(|a, b| (a.op_index, a.code, &a.message).cmp(&(b.op_index, b.code, &b.message)));
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

fn push(errors: &mut Vec<ValidationError>, code: ValidationCode, message: impl Into<String>) {
    errors.push(ValidationError::new(0, code, message));
}

/// Checks invariant 7 and returns the set of track IDs.
fn check_ids(doc: &Project, errors: &mut Vec<ValidationError>) -> BTreeSet<String> {
    let mut tracks = BTreeSet::new();
    let mut sections = BTreeSet::new();
    let mut clips = BTreeSet::new();
    let mut fx_ids = BTreeSet::new();

    for track in &doc.tracks {
        let id = track.id.to_string();
        if !tracks.insert(id.clone()) {
            push(
                errors,
                ValidationCode::DuplicateId,
                format!("duplicate track {id}"),
            );
        }
        for fx in &track.fx.0 {
            check_unique_fx(fx, &mut fx_ids, errors);
        }
    }
    for section in &doc.arrangement.sections {
        let id = section.id.to_string();
        if !sections.insert(id.clone()) {
            push(
                errors,
                ValidationCode::DuplicateId,
                format!("duplicate section {id}"),
            );
        }
        for lane in section.lanes.values() {
            for clip in &lane.clips {
                let clip_id = clip.id.to_string();
                if !clips.insert(clip_id.clone()) {
                    push(
                        errors,
                        ValidationCode::DuplicateId,
                        format!("duplicate clip {clip_id}"),
                    );
                }
                for fx in clip.fx.iter().flat_map(|chain| chain.0.iter()) {
                    check_unique_fx(fx, &mut fx_ids, errors);
                }
            }
        }
    }
    for fx in &doc.arrangement.master.fx.0 {
        check_unique_fx(fx, &mut fx_ids, errors);
    }
    tracks
}

fn check_unique_fx(
    fx: &FxInstance,
    fx_ids: &mut BTreeSet<String>,
    errors: &mut Vec<ValidationError>,
) {
    let id = fx.id.to_string();
    if !fx_ids.insert(id.clone()) {
        push(
            errors,
            ValidationCode::DuplicateId,
            format!("duplicate fx {id}"),
        );
    }
}

/// Checks invariant 7 for sources and that a `Source.placement` names an existing section (02 §3.2,
/// §6).
fn check_sources(doc: &Project, errors: &mut Vec<ValidationError>) {
    let mut ids = BTreeSet::new();
    for source in &doc.sources {
        let id = source.id.to_string();
        if !ids.insert(id.clone()) {
            push(
                errors,
                ValidationCode::DuplicateId,
                format!("duplicate source {id}"),
            );
        }
        if let Some(placement) = &source.placement
            && !doc
                .arrangement
                .sections
                .iter()
                .any(|section| section.id == placement.section_id)
        {
            push(
                errors,
                ValidationCode::MissingTarget,
                format!(
                    "source {} is placed in section {} which does not exist",
                    source.id, placement.section_id
                ),
            );
        }
    }
}

/// Checks invariant 1: every lane's track exists.
fn check_lanes(doc: &Project, tracks: &BTreeSet<String>, errors: &mut Vec<ValidationError>) {
    for section in &doc.arrangement.sections {
        for track_id in section.lanes.keys() {
            if !tracks.contains(&track_id.to_string()) {
                push(
                    errors,
                    ValidationCode::UnknownTrack,
                    format!(
                        "section {} has a lane for unknown track {track_id}",
                        section.id
                    ),
                );
            }
        }
    }
}

/// Checks invariant 4.
fn check_tempo_map(points: &[TempoPoint], errors: &mut Vec<ValidationError>) {
    let Some(first) = points.first() else {
        push(errors, ValidationCode::TempoMap, "the tempo map is empty");
        return;
    };
    if first.tick != 0 {
        push(
            errors,
            ValidationCode::TempoMap,
            format!("the tempo map starts at tick {} instead of 0", first.tick),
        );
    }
    let mut previous: Option<&TempoPoint> = None;
    for point in points {
        if !(MIN_BPM..=MAX_BPM).contains(&point.bpm) {
            push(
                errors,
                ValidationCode::TempoMap,
                format!(
                    "tempo {} bpm at tick {} is outside {MIN_BPM}..{MAX_BPM}",
                    point.bpm, point.tick
                ),
            );
        }
        if let Some(prev) = previous
            && point.tick <= prev.tick
        {
            push(
                errors,
                ValidationCode::TempoMap,
                format!(
                    "tempo points are not sorted: tick {} follows tick {}",
                    point.tick, prev.tick
                ),
            );
        }
        previous = Some(point);
    }
}

/// Checks the single-field float bounds the schema cannot express.
fn check_numeric_bounds(doc: &Project, errors: &mut Vec<ValidationError>) {
    for track in &doc.tracks {
        if !(MIN_PAN..=MAX_PAN).contains(&track.pan) {
            push(
                errors,
                ValidationCode::NumericRange,
                format!(
                    "track {} pan {} is outside {MIN_PAN}..{MAX_PAN}",
                    track.id, track.pan
                ),
            );
        }
    }
    for section in &doc.arrangement.sections {
        if let Some(target) = &section.energy_target {
            for point in &target.0 {
                if !(0.0..=1.0).contains(&point.value) {
                    push(
                        errors,
                        ValidationCode::NumericRange,
                        format!(
                            "section {} energyTarget value {} is outside 0..1",
                            section.id, point.value
                        ),
                    );
                }
            }
        }
    }
}

/// Checks invariant 2 (clip ranges fit their asset) and invariant 3 (overlaps need fades).
fn check_clips(doc: &Project, assets: &AssetIndex, errors: &mut Vec<ValidationError>) {
    let tempo = TempoCtx::from_project(doc);
    let mut section_start = 0_i64;
    for section in &doc.arrangement.sections {
        for lane in section.lanes.values() {
            let mut spans = Vec::new();
            for clip in &lane.clips {
                if clip.src_start >= clip.src_end {
                    push(
                        errors,
                        ValidationCode::ClipRange,
                        format!(
                            "clip {} has srcStart {} >= srcEnd {}",
                            clip.id, clip.src_start, clip.src_end
                        ),
                    );
                }
                match assets.get(&clip.asset) {
                    None => push(
                        errors,
                        ValidationCode::UnknownAsset,
                        format!(
                            "clip {} references asset {} which is not in the index",
                            clip.id, clip.asset
                        ),
                    ),
                    Some(meta) if clip.src_end > meta.duration_samples => push(
                        errors,
                        ValidationCode::ClipRange,
                        format!(
                            "clip {} srcEnd {} exceeds asset duration {}",
                            clip.id, clip.src_end, meta.duration_samples
                        ),
                    ),
                    Some(_) => {}
                }
                if let Some(end) = clip_end_local(clip, &tempo, assets, section_start) {
                    spans.push(ClipSpan {
                        start: clip.start,
                        end,
                        fade_in: clip.fade_in_ticks,
                        fade_out: clip.fade_out_ticks,
                        id: clip.id.to_string(),
                    });
                }
            }
            check_overlaps(&spans, &section.id.to_string(), errors);
        }
        section_start = section_start
            .saturating_add(i64::try_from(section.length_ticks.get()).unwrap_or(i64::MAX));
    }
}

/// A clip's tick extent and fades, for the overlap check.
struct ClipSpan {
    start: i64,
    end: i64,
    fade_in: u64,
    fade_out: u64,
    id: String,
}

/// Invariant 3: a clip pair that overlaps must be covered by matching fades.
fn check_overlaps(spans: &[ClipSpan], section: &str, errors: &mut Vec<ValidationError>) {
    for (index, left) in spans.iter().enumerate() {
        for right in &spans[index + 1..] {
            if left.start >= right.end || right.start >= left.end {
                continue; // disjoint (half-open)
            }
            // `first` starts no later than `second`.
            let (first, second) = if left.start <= right.start {
                (left, right)
            } else {
                (right, left)
            };
            let overlap_start = second.start;
            let overlap_end = first.end.min(second.end);
            let first_out = i64::try_from(first.fade_out).unwrap_or(i64::MAX);
            let second_in = i64::try_from(second.fade_in).unwrap_or(i64::MAX);
            let first_covers = first_out >= first.end - overlap_start;
            let second_covers = second_in >= overlap_end - overlap_start;
            if !first_covers || !second_covers {
                push(
                    errors,
                    ValidationCode::OverlapWithoutFade,
                    format!(
                        "clips {} and {} overlap in section {section} without matching fades at tick {overlap_start}",
                        first.id, second.id
                    ),
                );
            }
        }
    }
}

/// Checks invariant 5 against the shared catalogue (03 §6), plus the routing field of
/// `sidechain_duck` (02 §3.7, §5).
fn check_fx(doc: &Project, tracks: &BTreeSet<String>, errors: &mut Vec<ValidationError>) {
    for track in &doc.tracks {
        for fx in &track.fx.0 {
            check_fx_params(fx, errors);
            check_sidechain_source(fx, Some(&track.id), tracks, errors);
        }
    }
    for section in &doc.arrangement.sections {
        for (track_id, lane) in &section.lanes.0 {
            for clip in &lane.clips {
                for fx in clip.fx.iter().flat_map(|chain| chain.0.iter()) {
                    check_fx_params(fx, errors);
                    check_sidechain_source(fx, Some(track_id), tracks, errors);
                }
            }
        }
    }
    for fx in &doc.arrangement.master.fx.0 {
        check_fx_params(fx, errors);
        check_sidechain_source(fx, None, tracks, errors);
    }
}

/// A `sidechainSource` must name an existing track other than the duck's own track, and only
/// `sidechain_duck` may carry one (02 §3.7).
fn check_sidechain_source(
    fx: &FxInstance,
    owner: Option<&crate::generated::TrackId>,
    tracks: &BTreeSet<String>,
    errors: &mut Vec<ValidationError>,
) {
    let Some(source) = &fx.sidechain_source else {
        return;
    };
    if fx.type_ != FxType::SidechainDuck {
        push(
            errors,
            ValidationCode::FxParam,
            format!(
                "fx {} has a sidechainSource but is {}, not sidechain_duck",
                fx.id, fx.type_
            ),
        );
        return;
    }
    if !tracks.contains(source.as_str()) {
        push(
            errors,
            ValidationCode::UnknownTrack,
            format!(
                "fx {} (sidechain_duck) references unknown track {source}",
                fx.id
            ),
        );
    }
    if owner.is_some_and(|owner| owner == source) {
        push(
            errors,
            ValidationCode::FxParam,
            format!(
                "fx {} cannot use its own track {source} as sidechainSource",
                fx.id
            ),
        );
    }
}

fn check_fx_params(fx: &FxInstance, errors: &mut Vec<ValidationError>) {
    let catalogue = fx_catalog();
    let type_name = fx.type_.to_string();
    let Some(entry) = catalogue.fx.get(type_name.as_str()) else {
        push(
            errors,
            ValidationCode::FxParam,
            format!("fx {} has unknown type {type_name}", fx.id),
        );
        return;
    };
    for (name, value) in &fx.params.0 {
        let Some(spec) = entry.params.get(name.as_str()) else {
            push(
                errors,
                ValidationCode::FxParam,
                format!("fx {} ({type_name}) has unknown parameter {name}", fx.id),
            );
            continue;
        };
        if !value.is_finite() {
            push(
                errors,
                ValidationCode::FxParam,
                format!("fx {} parameter {name} is not finite", fx.id),
            );
            continue;
        }
        if let Some(min) = spec.min
            && *value < min
        {
            push(
                errors,
                ValidationCode::FxParam,
                format!("fx {} parameter {name} = {value} is below {min}", fx.id),
            );
        }
        if let Some(max) = spec.max
            && *value > max
        {
            push(
                errors,
                ValidationCode::FxParam,
                format!("fx {} parameter {name} = {value} is above {max}", fx.id),
            );
        }
    }
}

/// The parsed `crates/bragi-dsp/fx_catalog.json` (`specs/03-audio-engine.md` §6).
#[derive(Debug, Deserialize)]
struct FxCatalog {
    fx: HashMap<String, FxEntry>,
}

#[derive(Debug, Deserialize)]
struct FxEntry {
    #[serde(default)]
    params: HashMap<String, ParamSpec>,
}

#[derive(Debug, Deserialize)]
struct ParamSpec {
    #[serde(default)]
    min: Option<f64>,
    #[serde(default)]
    max: Option<f64>,
}

/// The FX catalogue, parsed once.
fn fx_catalog() -> &'static FxCatalog {
    static CATALOG: LazyLock<FxCatalog> = LazyLock::new(|| {
        // The catalogue is a compile-time-embedded, hand-checked asset; a parse failure is a bug
        // caught by `fx_catalog_parses_and_covers_every_fx_type`, not by runtime input.
        #[allow(clippy::expect_used)]
        serde_json::from_str(include_str!("../../bragi-dsp/fx_catalog.json"))
            .expect("crates/bragi-dsp/fx_catalog.json is valid")
    });
    &CATALOG
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::generated::FxType;

    #[test]
    fn fx_catalog_parses_and_covers_every_fx_type() {
        let catalogue = fx_catalog();
        for fx_type in [
            FxType::Eq3,
            FxType::Filter,
            FxType::Compressor,
            FxType::Saturation,
            FxType::Reverb,
            FxType::Delay,
            FxType::Width,
            FxType::Gain,
            FxType::Transient,
            FxType::Lofi,
            FxType::Chorus,
            FxType::SidechainDuck,
            FxType::MatchEq,
            FxType::Limiter,
        ] {
            assert!(
                catalogue.fx.contains_key(&fx_type.to_string()),
                "the catalogue is missing {fx_type}"
            );
        }
        assert_eq!(catalogue.fx.len(), 14);
    }
}
