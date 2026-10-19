//! Section boundaries without clicks (`specs/03-audio-engine.md` §5.5,
//! `specs/07-song-canvas.md` §10 check 4).
//!
//! Every fixture is generated here (13 §6): a continuous 55 Hz sine whose
//! source windows are reordered, uncorrelated noise, and DC. No audio file is
//! committed.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

mod common;

use std::sync::Arc;

use bragi_engine::engine::Engine;
use bragi_engine::offline::null_level_dbfs;
use bragi_engine::pcm::{PcmBuffer, PcmSource};
use bragi_engine::plan::{PlanOptions, RenderPlan, compile, compile_with_options};
use bragi_engine::render::Renderer;
use bragi_model::diff;
use bragi_model::generated::Project;
use common::*;
use serde_json::{Value, json};

/// One beat at 120 bpm: a section length and the clip window used by the
/// reordered fixture.
const SECTION_TICKS: u64 = BEAT_TICKS;
const SECTION_SAMPLES: u64 = BEAT_SAMPLES;
/// The generated sine asset is long enough for every source window below.
const SINE_FRAMES: u64 = 100_000;

/// Source offsets for parts A, B, C, D. Each offset moves the 55 Hz phase by
/// about half a period (48000 / 55 / 2 ≈ 436 samples) from where the previous
/// part's window ends, and puts the boundary at a peak rather than a zero
/// crossing, so every boundary is maximally discontinuous.
const PART_OFFSETS: [u64; 4] = [654, 25_090, 49_526, 73_962];

/// A section with an explicit transition.
fn section_with(
    id: &str,
    length_ticks: u64,
    lanes: Value,
    kind: &str,
    transition_ticks: u64,
) -> Value {
    json!({
        "id": id, "kind": "custom", "label": id, "lengthTicks": length_ticks,
        "lanes": lanes,
        "transitionIn": { "kind": kind, "lengthTicks": transition_ticks }
    })
}

/// A stereo buffer of deterministic uniform noise in `-amplitude..=amplitude`.
fn noise(frames: usize, seed: u64, amplitude: f32) -> PcmBuffer {
    let mut state = seed;
    let mut samples = Vec::with_capacity(frames * 2);
    for _ in 0..frames {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let value = ((state >> 40) as f32 / (1u64 << 23) as f32 - 1.0) * amplitude;
        samples.push(value);
        samples.push(value);
    }
    PcmBuffer::new(samples, 2, 48_000)
}

/// The reordered sine document: one continuous 55 Hz asset, four one-beat
/// sections whose source windows jump at every boundary by about half a period.
///
/// `order` indexes [`PART_OFFSETS`]; the default order `A, C, B, D` is not the
/// source order, which is the point.
fn reordered_sine(order: [usize; 4]) -> Project {
    let h = hash('b');
    let sections = order
        .iter()
        .enumerate()
        .map(|(index, &part)| {
            let offset = PART_OFFSETS[part];
            let clip = clip_none(
                &format!("clp_{index}"),
                &h,
                offset,
                offset + SECTION_SAMPLES,
                0,
            );
            section(
                &format!("sec_part{part}"),
                SECTION_TICKS,
                json!({ "trk_01": lane(vec![clip]) }),
            )
        })
        .collect();
    project(vec![track("trk_01")], sections)
}

fn reordered_plan(doc: &Project) -> RenderPlan {
    compile(doc, &assets(&hash('b'), SINE_FRAMES), 48_000, 1).unwrap()
}

/// Every planned boundary, as `(absolute sample, crossfade length)`.
fn planned_boundaries(plan: &RenderPlan) -> Vec<(u64, u64)> {
    let mut boundaries = Vec::new();
    for section in plan.sections.iter().skip(1) {
        let boundary = section.start;
        let fade = plan
            .tracks
            .iter()
            .flat_map(|track| &track.segments)
            .find(|segment| segment.dst_end == boundary)
            .and_then(|segment| segment.boundary_out)
            .map(|fade| fade.len_samples);
        if let Some(len_samples) = fade {
            boundaries.push((boundary, len_samples));
        }
    }
    boundaries
}

fn left_step(samples: &[f32], frame: usize) -> f32 {
    if frame == 0 {
        return 0.0;
    }
    (samples[frame * 2] - samples[(frame - 1) * 2]).abs()
}

fn max_step(samples: &[f32], frames: impl Iterator<Item = usize>) -> f32 {
    frames.fold(0.0, |max, frame| max.max(left_step(samples, frame)))
}

fn dbfs(value: f32) -> f32 {
    if value <= 0.0 {
        f32::NEG_INFINITY
    } else {
        20.0 * value.log10()
    }
}

#[test]
fn an_unedited_song_plans_no_boundary_fade_and_renders_bit_identically() {
    let h = hash('a');
    // Two tracks: `none` and `beatgrid`. Both are split into consecutive
    // sections whose clips continue the same asset at the same source sample.
    let mut lane_none = Vec::new();
    let mut lane_grid = Vec::new();
    for index in 0..4u64 {
        let start = index * SECTION_SAMPLES;
        let end = start + SECTION_SAMPLES;
        lane_none.push(clip_none(&format!("clp_n{index}"), &h, start, end, 0));
        lane_grid.push(clip(
            &format!("clp_g{index}"),
            &h,
            start,
            end,
            0,
            beatgrid(&[(start, 0), (end, SECTION_TICKS as i64)]),
            0,
            0,
            0.0,
        ));
    }
    let sections = (0..4)
        .map(|index| {
            section(
                &format!("sec_{index}"),
                SECTION_TICKS,
                json!({ "trk_none": lane(vec![lane_none[index].clone()]), "trk_grid": lane(vec![lane_grid[index].clone()]), }),
            )
        })
        .collect();
    let doc = project(vec![track("trk_none"), track("trk_grid")], sections);
    let asset_index = assets(&h, 4 * SECTION_SAMPLES);
    let with_fades = compile(&doc, &asset_index, 48_000, 1).unwrap();
    let without = compile_with_options(
        &doc,
        &asset_index,
        48_000,
        2,
        PlanOptions {
            section_fades: false,
        },
    )
    .unwrap();

    let mut fades = 0;
    for track in &with_fades.tracks {
        for segment in &track.segments {
            fades += usize::from(segment.boundary_in.is_some());
            fades += usize::from(segment.boundary_out.is_some());
        }
    }
    assert_eq!(fades, 0, "a contiguous song must plan no boundary fade");
    assert!(planned_boundaries(&with_fades).is_empty());

    let source = pcm(&h, tone(4 * SECTION_SAMPLES as usize, 220.0, 0.5));
    let with_fades_out = render_plan(&with_fades, &source, 4 * SECTION_SAMPLES as usize, 512);
    let without_out = render_plan(&without, &source, 4 * SECTION_SAMPLES as usize, 512);
    assert_eq!(with_fades_out, without_out);
    assert_eq!(
        null_level_dbfs(&with_fades_out, &without_out),
        f32::NEG_INFINITY
    );
}

#[test]
fn a_reordered_song_has_no_sample_step_at_any_boundary() {
    let doc = reordered_sine([0, 2, 1, 3]);
    let plan = reordered_plan(&doc);
    let boundaries = planned_boundaries(&plan);
    assert_eq!(
        boundaries.len(),
        plan.sections.len() - 1,
        "every boundary is discontinuous"
    );
    for segment in &plan.tracks[0].segments {
        if let Some(fade) = segment.boundary_out {
            assert!(fade.has_handle, "the sine fixture has outgoing handles");
            assert_eq!(segment.post_roll, fade.len_samples / 2);
        }
        if let Some(fade) = segment.boundary_in {
            assert!(fade.has_handle, "the sine fixture has incoming handles");
            assert_eq!(segment.pre_roll, fade.len_samples / 2);
        }
    }

    let source = pcm(&hash('b'), tone(SINE_FRAMES as usize, 55.0, 0.5));
    let frames = plan.length_samples as usize;
    let faded = render_plan(&plan, &source, frames, 512);
    let hard = render_plan(
        &compile_with_options(
            &doc,
            &assets(&hash('b'), SINE_FRAMES),
            48_000,
            2,
            PlanOptions {
                section_fades: false,
            },
        )
        .unwrap(),
        &source,
        frames,
        512,
    );

    let inside = |frame: usize| {
        boundaries.iter().any(|(boundary, len)| {
            let boundary = *boundary as usize;
            let len = *len as usize;
            frame >= boundary.saturating_sub(len) && frame <= boundary + len
        })
    };
    let at_boundaries = |samples: &[f32]| {
        max_step(
            samples,
            boundaries.iter().flat_map(|(boundary, len)| {
                let boundary = *boundary as usize;
                let len = *len as usize;
                boundary.saturating_sub(len)..=(boundary + len).min(frames - 1)
            }),
        )
    };
    let elsewhere =
        |samples: &[f32]| max_step(samples, (1..frames).filter(|frame| !inside(*frame)));

    let faded_at = at_boundaries(&faded);
    let faded_elsewhere = elsewhere(&faded);
    let hard_at = at_boundaries(&hard);
    let hard_elsewhere = elsewhere(&hard);
    println!(
        "boundary step: faded {:.2} dBFS (elsewhere {:.2}), hard cut {:.2} dBFS (elsewhere {:.2})",
        dbfs(faded_at),
        dbfs(faded_elsewhere),
        dbfs(hard_at),
        dbfs(hard_elsewhere)
    );
    // 07 §10 check 4: a step may not exceed the signal's own maximum step by
    // more than −40 dBFS (0.01 in linear amplitude).
    assert!(
        faded_at <= faded_elsewhere + 0.01,
        "faded boundary step {} > {} + 0.01",
        dbfs(faded_at),
        dbfs(faded_elsewhere)
    );
    // The same metric fails when the crossfades are disabled, so the check has
    // teeth.
    assert!(
        hard_at > hard_elsewhere + 0.01,
        "hard-cut boundary step {} is not distinguishable from {}",
        dbfs(hard_at),
        dbfs(hard_elsewhere)
    );
}

#[test]
fn an_equal_power_crossfade_keeps_the_short_term_rms_within_1_5_db() {
    let h = hash('c');
    let doc = project(
        vec![track("trk_01")],
        vec![
            section(
                "sec_a",
                2 * BEAT_TICKS,
                json!({
                    "trk_01": lane(vec![clip_none("clp_a", &h, 12_000, 60_000, 0)])
                }),
            ),
            section_with(
                "sec_b",
                2 * BEAT_TICKS,
                json!({ "trk_01": lane(vec![clip_none("clp_b", &h, 70_000, 118_000, 0)]) }),
                "crossfade",
                BEAT_TICKS,
            ),
        ],
    );
    let plan = compile(&doc, &assets(&h, 130_000), 48_000, 1).unwrap();
    let boundary = plan.sections[1].start as usize;
    let segment_out = plan.tracks[0]
        .segments
        .iter()
        .find(|segment| segment.dst_end == plan.sections[1].start)
        .unwrap();
    let segment_in = plan.tracks[0]
        .segments
        .iter()
        .find(|segment| segment.dst_start == plan.sections[1].start)
        .unwrap();
    let fade = segment_out.boundary_out.unwrap();
    assert_eq!(fade.len_samples, BEAT_SAMPLES, "one beat");
    assert_eq!(segment_out.post_roll, fade.len_samples / 2);
    assert_eq!(segment_in.pre_roll, fade.len_samples / 2);
    assert!(fade.has_handle && segment_in.boundary_in.unwrap().has_handle);

    let source = pcm(&h, noise(130_000, 0x1234_5678_9abc_def1, 0.3));
    let frames = plan.length_samples as usize;
    let out = render_plan(&plan, &source, frames, 512);
    let half = fade.len_samples as usize / 2;

    let rms = |from: usize, to: usize| {
        let mut sum = 0.0f64;
        for frame in from..to {
            sum += f64::from(out[frame * 2]) * f64::from(out[frame * 2]);
        }
        (sum / (to - from) as f64).sqrt() as f32
    };
    let steady = 0.5 * (rms(0, boundary - half) + rms(boundary + half, frames));
    let window = 2_048;
    let mut minimum = f32::MAX;
    for start in (boundary - half..=(boundary + half - window)).step_by(256) {
        minimum = minimum.min(rms(start, start + window));
    }
    let dip_db = 20.0 * (minimum / steady).log10();
    println!(
        "crossfade short-term RMS: steady {:.2} dBFS, min {:.2} dBFS, dip {dip_db:.2} dB",
        dbfs(steady),
        dbfs(minimum)
    );
    assert!(
        dip_db > -1.5,
        "short-term RMS dips {dip_db:.2} dB through the crossfade"
    );
}

#[test]
fn an_incoming_clip_without_a_handle_fades_in_after_the_boundary() {
    let h = hash('d');
    let silent = hash('0');
    // The outgoing clip ends at the boundary (a different asset, so the pair is
    // discontinuous); the incoming clip starts at source 0, so it has no
    // pre-roll even though the outgoing side exists.
    let doc = project(
        vec![track("trk_01")],
        vec![
            section(
                "sec_a",
                SECTION_TICKS,
                json!({ "trk_01": lane(vec![clip_none("clp_a", &silent, 0, SECTION_SAMPLES, 0)]) }),
            ),
            section(
                "sec_b",
                SECTION_TICKS,
                json!({ "trk_01": lane(vec![clip_none("clp_b", &h, 0, SECTION_SAMPLES, 0)]) }),
            ),
        ],
    );
    let asset_index =
        bragi_model::AssetIndex::from_metas([meta(&h, 48_000), meta(&silent, 48_000)]);
    let plan = compile(&doc, &asset_index, 48_000, 1).unwrap();
    let boundary = plan.sections[1].start;
    let outgoing = plan.tracks[0]
        .segments
        .iter()
        .find(|segment| segment.dst_end == boundary)
        .unwrap();
    assert!(outgoing.boundary_out.unwrap().has_handle);
    let segment = plan.tracks[0]
        .segments
        .iter()
        .find(|segment| segment.dst_start == boundary)
        .unwrap();
    let fade = segment.boundary_in.unwrap();
    assert!(!fade.has_handle);
    assert_eq!(segment.pre_roll, 0);
    let boundary = boundary as usize;
    let half = fade.len_samples as usize / 2;
    assert_eq!(half, 120, "5 ms at 48 kHz");

    let mut source = pcm(&h, dc(48_000, 0.5));
    source.insert(silent, dc(48_000, 0.0));
    let out = render_plan(&plan, &source, boundary + half + 1, 512);
    assert_eq!(out[(boundary - 1) * 2], 0.0, "nothing before the boundary");
    assert!(out[boundary * 2].abs() < 1e-6, "fade-in starts at zero");
    let midpoint = 0.5 * std::f32::consts::FRAC_1_SQRT_2;
    assert!(
        (out[(boundary + half / 2) * 2] - midpoint).abs() < 1e-5,
        "equal-power midpoint: {}",
        out[(boundary + half / 2) * 2]
    );
    assert!((out[(boundary + half) * 2] - 0.5).abs() < 1e-6);
}

#[test]
fn an_outgoing_clip_that_ends_at_the_asset_end_fades_out_before_the_boundary() {
    let h = hash('e');
    let silent = hash('1');
    let doc = project(
        vec![track("trk_01")],
        vec![
            section(
                "sec_a",
                SECTION_TICKS,
                json!({ "trk_01": lane(vec![clip_none("clp_a", &h, 0, SECTION_SAMPLES, 0)]) }),
            ),
            section(
                "sec_b",
                SECTION_TICKS,
                json!({ "trk_01": lane(vec![clip_none("clp_b", &silent, 0, SECTION_SAMPLES, 0)]) }),
            ),
        ],
    );
    // The asset ends exactly where the clip does, so there is no handle; the
    // incoming side exists (and is silent), so the pair is a crossfade.
    let asset_index =
        bragi_model::AssetIndex::from_metas([meta(&h, SECTION_SAMPLES), meta(&silent, 48_000)]);
    let plan = compile(&doc, &asset_index, 48_000, 1).unwrap();
    let boundary = plan.sections[1].start;
    let segment = plan.tracks[0]
        .segments
        .iter()
        .find(|segment| segment.dst_end == boundary)
        .unwrap();
    let fade = segment.boundary_out.unwrap();
    assert!(!fade.has_handle);
    assert_eq!(segment.post_roll, 0);
    let boundary = boundary as usize;
    let half = fade.len_samples as usize / 2;

    let mut source = pcm(&h, dc(SECTION_SAMPLES as usize, 0.5));
    source.insert(silent, dc(48_000, 0.0));
    let out = render_plan(&plan, &source, boundary, 512);
    assert!((out[(boundary - half) * 2] - 0.5).abs() < 1e-6);
    let midpoint = 0.5 * std::f32::consts::FRAC_1_SQRT_2;
    assert!(
        (out[(boundary - half / 2) * 2] - midpoint).abs() < 1e-5,
        "equal-power midpoint: {}",
        out[(boundary - half / 2) * 2]
    );
    assert!(
        out[(boundary - 1) * 2].abs() < 0.01,
        "the fade completes at the boundary: {}",
        out[(boundary - 1) * 2]
    );
}

#[test]
fn a_generated_transition_behaves_like_a_crossfade_and_warns() {
    let h = hash('9');
    let offsets = [654u64, 25_090];
    let mut sections = Vec::new();
    for (index, offset) in offsets.into_iter().enumerate() {
        let clip = clip_none(
            &format!("clp_{index}"),
            &h,
            offset,
            offset + SECTION_SAMPLES,
            0,
        );
        let lanes = json!({ "trk_01": lane(vec![clip]) });
        sections.push(if index == 1 {
            section_with("sec_b", SECTION_TICKS, lanes, "generated", BEAT_TICKS / 4)
        } else {
            section("sec_a", SECTION_TICKS, lanes)
        });
    }
    let doc = project(vec![track("trk_01")], sections);
    let plan = compile(&doc, &assets(&h, 50_000), 48_000, 1).unwrap();
    assert!(
        plan.warnings
            .iter()
            .any(|warning| warning.contains("generated")),
        "the planner warns that the asset is not rendered yet: {:?}",
        plan.warnings
    );
    let segment = plan.tracks[0]
        .segments
        .iter()
        .find(|segment| segment.dst_start == plan.sections[1].start)
        .unwrap();
    let fade = segment.boundary_in.unwrap();
    assert_eq!(fade.len_samples, BEAT_SAMPLES / 4);
    assert!(fade.has_handle);
}

#[test]
fn a_seek_into_a_crossfade_renders_the_same_samples() {
    let h = hash('f');
    let doc = project(
        vec![track("trk_01")],
        vec![
            section(
                "sec_a",
                2 * BEAT_TICKS,
                json!({
                    "trk_01": lane(vec![clip_none("clp_a", &h, 12_000, 60_000, 0)])
                }),
            ),
            section_with(
                "sec_b",
                2 * BEAT_TICKS,
                json!({ "trk_01": lane(vec![clip_none("clp_b", &h, 70_000, 118_000, 0)]) }),
                "crossfade",
                BEAT_TICKS,
            ),
        ],
    );
    let plan = compile(&doc, &assets(&h, 130_000), 48_000, 1).unwrap();
    let source = pcm(&h, noise(130_000, 77, 0.3));
    let frames = plan.length_samples as usize;
    let continuous = render_plan(&plan, &source, frames, 512);
    let boundary = plan.sections[1].start as usize;
    let start = boundary - 3_000;
    let count = 6_000;
    let seeked = render_from(&plan, &source, start as u64, count, 512);
    for index in 0..count {
        assert_eq!(
            seeked[index * 2],
            continuous[(start + index) * 2],
            "left frame {}",
            start + index
        );
        assert_eq!(
            seeked[index * 2 + 1],
            continuous[(start + index) * 2 + 1],
            "right frame {}",
            start + index
        );
    }
}

#[test]
fn a_section_move_during_playback_renders_from_the_playhead() {
    let before = reordered_sine([0, 2, 1, 3]);
    let after = reordered_sine([2, 0, 1, 3]);
    let source = pcm(&hash('b'), tone(SINE_FRAMES as usize, 55.0, 0.5));
    let asset_index = assets(&hash('b'), SINE_FRAMES);
    let plan = compile(&before, &asset_index, 48_000, 1).unwrap();
    let mut engine = Engine::new(plan, 128);
    engine.transport_mut().play();
    // Play through the first boundary, then move a section while the transport
    // runs: the structural delta rebuilds the plan and keeps the playhead.
    render_engine(&mut engine, &source, 30_000, 128);
    let delta = diff(&before, &after);
    assert!(delta.requires_full_resync, "a reorder is structural");
    engine.apply_delta(&after, &asset_index, &delta).unwrap();
    let moved = render_engine(&mut engine, &source, 30_000, 128);

    let mut fresh = Engine::new(compile(&after, &asset_index, 48_000, 3).unwrap(), 128);
    fresh.transport_mut().seek(30_000);
    fresh.transport_mut().play();
    let expected = render_engine(&mut fresh, &source, 30_000, 128);
    assert_eq!(moved, expected, "the moved plan renders from the playhead");
}

/// Renders `frames` from an absolute start sample through a fresh renderer.
fn render_from(
    plan: &RenderPlan,
    pcm: &dyn PcmSource,
    start: u64,
    frames: usize,
    block: usize,
) -> Vec<f32> {
    let mut renderer = Renderer::new(Arc::new(plan.clone()), block);
    renderer.transport_mut().seek(start);
    renderer.transport_mut().play();
    let mut left = vec![0.0f32; block];
    let mut right = vec![0.0f32; block];
    let mut out = Vec::with_capacity(frames * 2);
    let mut rendered = 0;
    while rendered < frames {
        let count = (frames - rendered).min(block);
        renderer.process(pcm, &mut [&mut left[..count], &mut right[..count]]);
        for index in 0..count {
            out.push(left[index]);
            out.push(right[index]);
        }
        rendered += count;
    }
    out
}
