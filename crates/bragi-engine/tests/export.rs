//! WP-1.11 acceptance and export correctness.
//!
//! Every fixture is generated here (13 §6): a synthetic "working asset" is
//! encoded as 24-bit FLAC, decoded back (that is the working asset the engine
//! plays), exported through the engine, decoded again, and nulled against the
//! working asset. Decoding goes through symphonia, so the encoders are checked
//! by an independent implementation.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout)]

mod common;

use bragi_engine::decode::decode_bytes;
use bragi_engine::export::md5::Md5;
use bragi_engine::export::{
    AudioFormat, CONTEXT_FILE_NAME, ExportError, ExportMeta, ExportOptions, StemSelection,
    encode_flac, encode_wav, export_context, export_mixdown, export_stems, run_job,
};
use bragi_engine::offline::null_level_dbfs;
use bragi_engine::pcm::{MemoryPcm, PcmBuffer};
use bragi_engine::plan::{RenderPlan, compile, tick_to_sample};
use bragi_model::TempoCtx;
use bragi_model::generated::{TempoCurve, TempoPoint, TickRange};
use common::{
    assets, clip_none, fx_instance, hash, lane, pcm as memory_pcm, project, section, track_with,
};
use serde_json::json;

const FRAMES: usize = 144_000; // 3 s at 48 kHz = 6 beats at 120 bpm = 5760 ticks

/// Deterministic pseudo-noise in `-1..1`.
fn noise(state: &mut u64) -> f32 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    ((*state >> 40) as f32 / (1u64 << 23) as f32) - 1.0
}

/// A stereo mix of two tones plus noise, peaking well under the −0.3 dBFS
/// safety limiter, with different left and right content.
fn synthetic(frames: usize, seed: u64, amplitude: f32) -> Vec<f32> {
    let mut state = seed;
    let mut out = Vec::with_capacity(frames * 2);
    for frame in 0..frames {
        let t = frame as f32 / 48_000.0;
        let tone = (t * std::f32::consts::TAU * 220.0).sin() * 0.5
            + (t * std::f32::consts::TAU * 331.0).sin() * 0.3;
        out.push((tone + noise(&mut state) * 0.1) * amplitude);
        out.push((tone * 0.8 + noise(&mut state) * 0.1) * amplitude);
    }
    out
}

/// The working asset: a 24-bit FLAC round trip, as ingest would produce.
fn working_asset(frames: usize, seed: u64, amplitude: f32) -> PcmBuffer {
    let flac = encode_flac(
        &synthetic(frames, seed, amplitude),
        2,
        24,
        &ExportMeta::bare(),
        None,
    )
    .unwrap();
    let decoded = decode_bytes(&flac, Some("flac")).unwrap();
    assert_eq!((decoded.channels, decoded.sample_rate), (2, 48_000));
    decoded.into_pcm_buffer()
}

fn one_clip_project(buffer_frames: usize) -> RenderPlan {
    let h = hash('a');
    let doc = project(
        vec![track_with("trk_01", 0.0, 0.0, false, false)],
        vec![section(
            "sec_a",
            5760,
            json!({ "trk_01": lane(vec![clip_none("clp_a", &h, 0, buffer_frames as u64, 0)]) }),
        )],
    );
    compile(&doc, &assets(&h, buffer_frames as u64), 48_000, 1).unwrap()
}

fn decode(file: &bragi_engine::export::ExportFile, extension: &str) -> Vec<f32> {
    decode_bytes(&file.bytes, Some(extension)).unwrap().samples
}

/// Acceptance (12, WP-1.11): the mixdown of an unedited project nulls against
/// the working asset at or below −60 dBFS. The formats are held to their own,
/// much tighter, quantisation floors as well.
#[test]
fn unedited_mixdown_nulls_against_the_working_asset() {
    let asset = working_asset(FRAMES, 0x1234_5678_9abc_def1, 0.6);
    let reference = asset.samples.clone();
    let mut pcm = MemoryPcm::new();
    pcm.insert(hash('a'), asset);
    let plan = one_clip_project(FRAMES);

    let cases: [(AudioFormat, &str, f32); 4] = [
        (AudioFormat::Wav { bits: 24 }, "wav", -130.0),
        (AudioFormat::Flac { bits: 24 }, "flac", -130.0),
        (AudioFormat::Wav { bits: 16 }, "wav", -85.0),
        (AudioFormat::Flac { bits: 16 }, "flac", -85.0),
    ];
    for (format, extension, ceiling) in cases {
        let options = ExportOptions::new(format, ExportMeta::titled("Null test"));
        let file = export_mixdown(&plan, &pcm, &options).unwrap();
        assert_eq!(file.frames as usize, FRAMES);
        assert_eq!(file.name, format!("Null test.{extension}"));
        let decoded = decode(&file, extension);
        assert_eq!(decoded.len(), reference.len());
        let level = null_level_dbfs(&decoded, &reference);
        println!("null {format:?}: {level:.1} dBFS");
        assert!(level <= -60.0, "{format:?} nulls at {level} dBFS (> -60)");
        assert!(
            level <= ceiling,
            "{format:?} nulls at {level} dBFS (> {ceiling})"
        );
    }

    // 32-bit float carries the engine output unchanged.
    let float = export_mixdown(
        &plan,
        &pcm,
        &ExportOptions::new(AudioFormat::Wav { bits: 32 }, ExportMeta::bare()),
    )
    .unwrap();
    let level = null_level_dbfs(&decode(&float, "wav"), &reference);
    println!("null wav32: {level} dBFS");
    assert_eq!(level, f32::NEG_INFINITY);
}

#[test]
fn flac_round_trips_losslessly_at_awkward_lengths() {
    for &bits in &[16u8, 24] {
        let scale = (1u32 << (bits - 1)) as f32;
        for &frames in &[0usize, 1, 3, 5, 255, 256, 257, 4095, 4096, 4097, 9000] {
            let mut state = 0x9e37_79b9_7f4a_7c15u64 ^ frames as u64;
            let mut samples = Vec::with_capacity(frames * 2);
            for frame in 0..frames {
                let wave = (frame as f32 * 0.03).sin() * 0.7;
                // Exactly representable values, so the round trip is bit exact.
                let left = ((wave + noise(&mut state) * 0.05) * scale).round() / scale;
                let right = ((wave * -0.5) * scale).round() / scale;
                samples.push(left);
                samples.push(right);
            }
            let bytes = encode_flac(&samples, 2, bits, &ExportMeta::bare(), None).unwrap();
            if frames < 16 {
                // Valid FLAC, but symphonia (like some decoders) refuses a
                // stream whose only block is under the 16-sample minimum.
                assert_eq!(&bytes[0..4], b"fLaC");
                continue;
            }
            let decoded = decode_bytes(&bytes, Some("flac")).unwrap();
            assert_eq!(
                decoded.samples.len(),
                samples.len(),
                "{bits}-bit {frames} frames"
            );
            assert_eq!(decoded.samples, samples, "{bits}-bit {frames} frames");
        }
    }
}

#[test]
fn flac_handles_extremes_silence_and_mono() {
    // Full-scale square wave and silence in one stream.
    let mut samples = Vec::new();
    for frame in 0..6000 {
        let value = if frame < 2000 {
            if (frame / 7) % 2 == 0 {
                1.0 - 1.0 / 32768.0
            } else {
                -1.0
            }
        } else {
            0.0
        };
        samples.push(value);
        // +1.0 is not representable in 16 bit; use the largest positive value.
        samples.push(if value == -1.0 {
            1.0 - 1.0 / 32768.0
        } else {
            -value
        });
    }
    let bytes = encode_flac(&samples, 2, 16, &ExportMeta::bare(), None).unwrap();
    assert_eq!(decode_bytes(&bytes, Some("flac")).unwrap().samples, samples);

    let mono: Vec<f32> = (0..5000).map(|i| (i as f32 * 0.01).sin() * 0.5).collect();
    let mono: Vec<f32> = mono
        .iter()
        .map(|v| (v * 32768.0).round() / 32768.0)
        .collect();
    let bytes = encode_flac(&mono, 1, 16, &ExportMeta::bare(), None).unwrap();
    let decoded = decode_bytes(&bytes, Some("flac")).unwrap();
    assert_eq!(decoded.channels, 1);
    assert_eq!(decoded.samples, mono);
}

#[test]
fn flac_streaminfo_md5_matches_the_audio() {
    let samples: Vec<f32> = synthetic(10_000, 77, 0.5)
        .iter()
        .map(|v| (v * 8_388_608.0).round() / 8_388_608.0)
        .collect();
    let bytes = encode_flac(&samples, 2, 24, &ExportMeta::bare(), None).unwrap();
    let mut md5 = Md5::new();
    for sample in &samples {
        let value = (sample * 8_388_608.0) as i32;
        md5.update(&value.to_le_bytes()[..3]);
    }
    // "fLaC" + 4-byte block header + the 18 bytes before the signature.
    assert_eq!(&bytes[26..42], &md5.finalize());
}

#[test]
fn flac_is_smaller_than_wav_for_tonal_audio() {
    let samples = synthetic(48_000, 5, 0.1);
    let wav = encode_wav(&samples, 2, 24, &ExportMeta::bare(), None).unwrap();
    let flac = encode_flac(&samples, 2, 24, &ExportMeta::bare(), None).unwrap();
    println!("flac {} / wav {}", flac.len(), wav.len());
    assert!(flac.len() < wav.len());
}

#[test]
fn metadata_survives_in_both_containers() {
    let meta = ExportMeta {
        title: Some("Song".into()),
        bpm: Some(128.0),
        key: Some("A minor".into()),
        created: Some("2026-10-19".into()),
        ..ExportMeta::default()
    };
    let wav = encode_wav(&[0.0; 8], 2, 24, &meta, None).unwrap();
    let flac = encode_flac(&[0.0; 8], 2, 16, &meta, None).unwrap();
    for bytes in [wav, flac] {
        let text = String::from_utf8_lossy(&bytes).to_string();
        assert!(text.contains("Song"), "title");
        assert!(text.contains("BPM 128.00"), "bpm");
        assert!(text.contains("A minor"), "key");
        assert!(text.contains("2026-10-19"), "date");
        assert!(text.contains("Bragi"), "software");
    }
}

fn three_track_plan() -> (RenderPlan, MemoryPcm) {
    let (ha, hb, hc) = (hash('a'), hash('b'), hash('c'));
    let frames = 96_000usize;
    let doc = project(
        vec![
            track_with("trk_01", 0.0, -0.5, false, false),
            track_with("trk_02", -3.0, 0.5, true, false), // muted in the doc
            track_with("trk_03", -6.0, 0.0, false, false),
        ],
        vec![section(
            "sec_a",
            3840,
            json!({
                "trk_01": lane(vec![clip_none("clp_a", &ha, 0, frames as u64, 0)]),
                "trk_02": lane(vec![clip_none("clp_b", &hb, 0, frames as u64, 0)]),
                "trk_03": lane(vec![clip_none("clp_c", &hc, 0, frames as u64, 0)]),
            }),
        )],
    );
    let index = bragi_model::AssetIndex::from_metas([
        common::meta(&ha, frames as u64),
        common::meta(&hb, frames as u64),
        common::meta(&hc, frames as u64),
    ]);
    let plan = compile(&doc, &index, 48_000, 1).unwrap();
    let mut pcm = MemoryPcm::new();
    pcm.insert(ha, PcmBuffer::new(synthetic(frames, 1, 0.25), 2, 48_000));
    pcm.insert(hb, PcmBuffer::new(synthetic(frames, 2, 0.25), 2, 48_000));
    pcm.insert(hc, PcmBuffer::new(synthetic(frames, 3, 0.25), 2, 48_000));
    (plan, pcm)
}

#[test]
fn stems_are_named_ordered_and_sum_to_the_mixdown() {
    let (plan, pcm) = three_track_plan();
    let options = ExportOptions::new(AudioFormat::Wav { bits: 32 }, ExportMeta::titled("Song"));
    let stems = export_stems(&plan, &pcm, &StemSelection::All, &options).unwrap();
    let names: Vec<&str> = stems.iter().map(|file| file.name.as_str()).collect();
    assert_eq!(names, ["01-trk_01.wav", "02-trk_02.wav", "03-trk_03.wav"]);
    assert!(stems.iter().all(|file| file.frames == 96_000));

    // The muted track still has a stem: a stem is the track as written.
    let muted = decode(&stems[1], "wav");
    assert!(muted.iter().any(|sample| sample.abs() > 0.01));

    // Σ stems == mixdown of the audible tracks plus the muted stem, i.e. the
    // mixdown of a plan where nothing is muted.
    let mut unmuted = plan.clone();
    for track in &mut unmuted.tracks {
        track.mute = false;
    }
    let mixdown = export_mixdown(&unmuted, &pcm, &options).unwrap();
    let mix = decode(&mixdown, "wav");
    let mut sum = vec![0.0f32; mix.len()];
    for stem in &stems {
        for (acc, value) in sum.iter_mut().zip(decode(stem, "wav")) {
            *acc += value;
        }
    }
    let level = null_level_dbfs(&sum, &mix);
    println!("stems sum vs mixdown: {level} dBFS");
    assert!(level <= -120.0, "stems sum null {level}");

    // The song mixdown honours the mute.
    let audible = export_mixdown(&plan, &pcm, &options).unwrap();
    assert!(null_level_dbfs(&decode(&audible, "wav"), &mix) > -60.0);
}

#[test]
fn stem_selection_filters_and_rejects_unknown_tracks() {
    let (plan, pcm) = three_track_plan();
    let options = ExportOptions::new(AudioFormat::Flac { bits: 24 }, ExportMeta::bare());
    let picked = export_stems(
        &plan,
        &pcm,
        &StemSelection::Tracks(vec!["trk_03".into(), "trk_01".into()]),
        &options,
    )
    .unwrap();
    let names: Vec<&str> = picked.iter().map(|file| file.name.as_str()).collect();
    assert_eq!(names, ["01-trk_01.flac", "03-trk_03.flac"]);
    assert_eq!(
        export_stems(
            &plan,
            &pcm,
            &StemSelection::Tracks(vec!["trk_99".into()]),
            &options
        ),
        Err(ExportError::UnknownTrack("trk_99".into()))
    );
}

#[test]
fn export_is_deterministic_and_dither_needs_a_seed() {
    let (plan, pcm) = three_track_plan();
    let mut options = ExportOptions::new(AudioFormat::Wav { bits: 16 }, ExportMeta::bare());
    let a = export_mixdown(&plan, &pcm, &options).unwrap();
    let b = export_mixdown(&plan, &pcm, &options).unwrap();
    assert_eq!(a.bytes, b.bytes);
    options.dither_seed = Some(42);
    let c = export_mixdown(&plan, &pcm, &options).unwrap();
    let d = export_mixdown(&plan, &pcm, &options).unwrap();
    assert_eq!(c.bytes, d.bytes);
    assert_ne!(a.bytes, c.bytes);

    let stems_a = export_stems(&plan, &pcm, &StemSelection::All, &options).unwrap();
    let stems_b = export_stems(&plan, &pcm, &StemSelection::All, &options).unwrap();
    assert_eq!(stems_a, stems_b);
}

#[test]
fn a_range_exports_only_that_range() {
    let (plan, pcm) = three_track_plan();
    let mut options = ExportOptions::new(AudioFormat::Wav { bits: 24 }, ExportMeta::bare());
    options.start = 48_000;
    options.frames = Some(24_000);
    let part = export_mixdown(&plan, &pcm, &options).unwrap();
    assert_eq!(part.frames, 24_000);
    let full = export_mixdown(
        &plan,
        &pcm,
        &ExportOptions::new(AudioFormat::Wav { bits: 24 }, ExportMeta::bare()),
    )
    .unwrap();
    let whole = decode(&full, "wav");
    let slice = decode(&part, "wav");
    assert!(null_level_dbfs(&slice, &whole[96_000..96_000 + 48_000]) <= -130.0);
}

#[test]
fn run_job_reads_the_host_json() {
    let (plan, pcm) = three_track_plan();
    let mixdown = run_job(
        &plan,
        &pcm,
        &json!({ "kind": "mixdown", "format": { "container": "flac", "bits": 16 },
                 "meta": { "title": "Hello / World" } }),
    )
    .unwrap();
    assert_eq!(mixdown.files.len(), 1);
    assert_eq!(mixdown.files[0].name, "Hello _ World.flac");

    let stems = run_job(
        &plan,
        &pcm,
        &json!({ "kind": "stems", "tracks": "all", "format": { "container": "wav", "bits": 24 } }),
    )
    .unwrap();
    assert_eq!(stems.files.len(), 3);

    for bad in [
        json!({ "kind": "context", "range": {}, "tracks": "all" }),
        json!({ "kind": "cache", "sectionId": "sec_a" }),
        json!({ "kind": "mixdown", "format": { "container": "mp3", "kbps": 192 } }),
        json!({ "kind": "mixdown", "format": { "container": "wav", "bits": 24 },
                "normalize": { "lufs": -14, "truePeakDb": -1 } }),
        json!({ "kind": "mixdown", "format": { "container": "flac", "bits": 32 } }),
    ] {
        assert!(run_job(&plan, &pcm, &bad).is_err(), "{bad}");
    }
}

fn context_plan(
    tempo: Vec<TempoPoint>,
    length_ticks: u64,
    frames: usize,
) -> (RenderPlan, MemoryPcm) {
    let h = hash('a');
    let mut doc = project(
        vec![track_with("trk_01", 0.0, 0.0, false, false)],
        vec![section(
            "sec_a",
            length_ticks,
            json!({ "trk_01": lane(vec![clip_none("clp_a", &h, 0, frames as u64, 0)]) }),
        )],
    );
    doc.arrangement.timebase.tempo_map.0 = tempo;
    let plan = compile(&doc, &assets(&h, frames as u64), 48_000, 1).unwrap();
    let mut pcm = MemoryPcm::new();
    pcm.insert(h, PcmBuffer::new(synthetic(frames, 7, 0.3), 2, 48_000));
    (plan, pcm)
}

/// WP-2.7: a context render is the exact tick range, converted through the
/// tempo map and cut to the sample.
#[test]
fn context_cuts_the_range_exactly_through_the_tempo_map() {
    let cases = [
        // 120 bpm throughout: 3 s, 144 000 frames, range 0.75..2.25 s.
        (
            vec![TempoPoint {
                tick: 0,
                bpm: 120.0,
                curve: TempoCurve::Step,
            }],
            5760u64,
            144_000usize,
        ),
        // 120 bpm for 2880 ticks, then 60 bpm: 1.5 s + 1.5 s = 3 s.
        (
            vec![
                TempoPoint {
                    tick: 0,
                    bpm: 120.0,
                    curve: TempoCurve::Step,
                },
                TempoPoint {
                    tick: 2880,
                    bpm: 60.0,
                    curve: TempoCurve::Step,
                },
            ],
            4320u64,
            144_000usize,
        ),
    ];
    for (tempo, length_ticks, frames) in cases {
        let (plan, pcm) = context_plan(tempo, length_ticks, frames);
        let range = TickRange {
            start_tick: 1440,
            end_tick: 4320.min(length_ticks as i64),
        };
        let file = export_context(&plan, &pcm, &range, &StemSelection::All).unwrap();
        assert_eq!(file.name, CONTEXT_FILE_NAME);

        let tempo = TempoCtx::new(&plan.tempo_points, plan.ppq);
        let start = tick_to_sample(&tempo, 48_000, range.start_tick);
        let end = tick_to_sample(&tempo, 48_000, range.end_tick);
        assert_eq!(file.frames as i64, end - start);

        let whole = decode(
            &export_mixdown(
                &plan,
                &pcm,
                &ExportOptions::new(AudioFormat::Wav { bits: 32 }, ExportMeta::bare()),
            )
            .unwrap(),
            "wav",
        );
        let cut = decode(&file, "wav");
        let level = null_level_dbfs(&cut, &whole[start as usize * 2..end as usize * 2]);
        println!("context cut at {start}..{end}: {level} dBFS");
        assert!(level <= -130.0, "context cut nulls at {level} dBFS");
    }
}

/// An explicit track list renders those tracks only: it equals the sum of the
/// tracks rendered one by one, keeps mute, and ignores solo (as does "all").
#[test]
fn context_track_subset_sums_and_respects_mute() {
    let (plan, pcm) = three_track_plan();
    let range = TickRange {
        start_tick: 0,
        end_tick: 3840,
    };
    let render = |plan: &RenderPlan, tracks: &[&str]| {
        let selection = StemSelection::Tracks(tracks.iter().map(|id| (*id).to_string()).collect());
        decode(
            &export_context(plan, &pcm, &range, &selection).unwrap(),
            "wav",
        )
    };

    // trk_02 is muted in the document, so "all" and the two audible tracks agree.
    let all = decode(
        &export_context(&plan, &pcm, &range, &StemSelection::All).unwrap(),
        "wav",
    );
    let audible = render(&plan, &["trk_01", "trk_03"]);
    assert!(null_level_dbfs(&all, &audible) <= -130.0);

    let first = render(&plan, &["trk_01"]);
    let second = render(&plan, &["trk_03"]);
    let sum: Vec<f32> = first.iter().zip(&second).map(|(a, b)| a + b).collect();
    let level = null_level_dbfs(&sum, &audible);
    println!("context subset sum: {level} dBFS");
    assert!(level <= -120.0, "subset sum nulls at {level} dBFS");

    // A muted track stays silent even when it is named explicitly.
    let muted = render(&plan, &["trk_02"]);
    assert!(muted.iter().all(|sample| *sample == 0.0));

    // Solo is an audition state: naming trk_01 renders it even when trk_02 is soloed.
    let mut soloed = plan.clone();
    for track in &mut soloed.tracks {
        if track.id.as_str() == "trk_02" {
            track.solo = true;
            track.mute = false;
        }
    }
    let named = render(&soloed, &["trk_01"]);
    assert!(
        named.iter().any(|sample| sample.abs() > 0.01),
        "solo must not silence an explicit track list"
    );
    assert!(null_level_dbfs(&named, &first) <= -130.0);

    // "all" ignores solo too: the soloed trk_02 does not silence the others.
    let all_soloed = decode(
        &export_context(&soloed, &pcm, &range, &StemSelection::All).unwrap(),
        "wav",
    );
    let every = render(&soloed, &["trk_01", "trk_02", "trk_03"]);
    assert!(null_level_dbfs(&all_soloed, &every) <= -130.0);
}

/// The fx tail is included where the effect rings inside the range, and the
/// range is cut at its last sample: nothing outside it is rendered.
#[test]
fn context_includes_the_fx_tail_inside_the_range_only() {
    let h = hash('a');
    let mut track = track_with("trk_01", 0.0, 0.0, false, false);
    track["fx"] = json!([fx_instance(
        "fx_delay",
        "delay",
        &[
            ("timeBeats", 0.25),
            ("feedback", 0.5),
            ("tone", 0.5),
            ("pingPong", 0.0),
            ("mix", 0.5),
        ],
        false,
    )]);
    let frames = 38_400usize;
    let mut impulse = vec![0.0f32; frames * 2];
    impulse[0] = 0.5;
    impulse[1] = 0.5;
    let doc = project(
        vec![track],
        vec![section(
            "sec_a",
            3840,
            json!({ "trk_01": lane(vec![clip_none("clp_a", &h, 0, frames as u64, 0)]) }),
        )],
    );
    let plan = compile(&doc, &assets(&h, frames as u64), 48_000, 1).unwrap();
    let pcm = memory_pcm(&h, PcmBuffer::new(impulse, 2, 48_000));

    let first = decode(
        &export_context(
            &plan,
            &pcm,
            &TickRange {
                start_tick: 0,
                end_tick: 1920,
            },
            &StemSelection::All,
        )
        .unwrap(),
        "wav",
    );
    // Exactly one second, and the delay's first echo (0.125 s) is present.
    assert_eq!(first.len(), 48_000 * 2);
    assert!(
        first
            .iter()
            .skip(4_800 * 2)
            .any(|sample| sample.abs() > 1e-3)
    );

    // The next second starts after the dry hit but still carries echoes.
    let second = decode(
        &export_context(
            &plan,
            &pcm,
            &TickRange {
                start_tick: 1920,
                end_tick: 3840,
            },
            &StemSelection::All,
        )
        .unwrap(),
        "wav",
    );
    assert_eq!(second.len(), 48_000 * 2);
    assert!(second.iter().any(|sample| *sample != 0.0));
}

#[test]
fn context_rejects_bad_ranges_and_tracks() {
    let (plan, pcm) = three_track_plan();
    let render = |range: TickRange, selection: StemSelection| {
        export_context(&plan, &pcm, &range, &selection)
    };
    for range in [
        TickRange {
            start_tick: 960,
            end_tick: 960,
        },
        TickRange {
            start_tick: 1920,
            end_tick: 960,
        },
    ] {
        assert!(
            matches!(
                render(range, StemSelection::All),
                Err(ExportError::EmptyRange { .. })
            ),
            "empty or inverted range"
        );
    }
    for range in [
        TickRange {
            start_tick: -1,
            end_tick: 960,
        },
        TickRange {
            start_tick: 0,
            end_tick: 3841,
        },
    ] {
        assert!(matches!(
            render(range, StemSelection::All),
            Err(ExportError::RangeOutsideSong { .. })
        ));
    }
    assert!(matches!(
        render(
            TickRange {
                start_tick: 0,
                end_tick: 960
            },
            StemSelection::Tracks(vec![])
        ),
        Err(ExportError::EmptyTrackList)
    ));
    assert!(matches!(
        render(
            TickRange {
                start_tick: 0,
                end_tick: 960
            },
            StemSelection::Tracks(vec!["trk_99".into()])
        ),
        Err(ExportError::UnknownTrack(_))
    ));
}

#[test]
fn run_job_runs_a_context_render() {
    let (plan, pcm) = three_track_plan();
    let context = run_job(
        &plan,
        &pcm,
        &json!({ "kind": "context",
                 "range": { "startTick": 0, "endTick": 960 },
                 "tracks": ["trk_01"] }),
    )
    .unwrap();
    assert_eq!(context.files.len(), 1);
    assert_eq!(context.files[0].name, "context.wav");
    assert_eq!(context.files[0].frames, 24_000);

    for bad in [
        json!({ "kind": "context", "tracks": "all" }),
        json!({ "kind": "context", "range": {} }),
        json!({ "kind": "context", "range": { "startTick": 960, "endTick": 960 } }),
        json!({ "kind": "context", "range": { "startTick": 0, "endTick": 960 },
                "tracks": [] }),
    ] {
        assert!(run_job(&plan, &pcm, &bad).is_err(), "{bad}");
    }
}

/// With the `parallel` feature the stems render on the rayon pool; the bytes
/// must equal a sequential render of the same stem plans.
#[cfg(feature = "parallel")]
#[test]
fn parallel_stems_equal_sequential_stems() {
    use bragi_engine::export::{encode, stem_plan};
    use bragi_engine::offline::{OfflineOptions, render};

    let (plan, pcm) = three_track_plan();
    let options = ExportOptions::new(AudioFormat::Flac { bits: 24 }, ExportMeta::titled("Song"));
    let parallel = export_stems(&plan, &pcm, &StemSelection::All, &options).unwrap();
    for (index, file) in parallel.iter().enumerate() {
        let rendered = render(
            &stem_plan(&plan, &plan.tracks[index]),
            &pcm,
            &OfflineOptions::range(0, plan.length_samples),
        );
        let mut meta = options.meta.clone();
        meta.track = Some(plan.tracks[index].name.clone());
        let expected = encode(&rendered.samples, options.format, &meta, None).unwrap();
        assert_eq!(file.bytes, expected, "stem {index}");
    }
}
