//! Export: WAV and FLAC mixdowns and per-track stems (`specs/03-audio-engine.md` §9).
//!
//! Everything here is platform-free, so the **same bytes** come out of the
//! WASM engine in the browser and the native engine on the desktop; the null
//! and parity tests rely on that. The module sits on top of
//! [`crate::offline::render`]: a mixdown is one offline render, and a stem is an
//! offline render of a plan reduced to a single track.
//!
//! * Formats: WAV 16/24-bit integer and 32-bit float; FLAC 16/24-bit. MP3 and
//!   loudness normalisation are not part of v1 and are rejected with a typed
//!   error.
//! * `context` (WP-2.7) is a 48 kHz 32-bit float WAV of one tick range, for
//!   generation conditioning; [`export_context`] cuts it sample-exactly.
//! * Determinism: no dither unless a seed is supplied (`ditherSeed`), and the
//!   engine never reads the clock, so equal jobs give equal bytes.
//! * Stems keep the master gain but bypass the safety limiter, so they sum to
//!   the mixdown whenever the mixdown limiter does not engage.
//!
//! ```
//! use bragi_engine::export::{AudioFormat, ExportMeta, ExportOptions, export_mixdown};
//! # use bragi_engine::pcm::MemoryPcm;
//! # let doc: bragi_model::generated::Project = serde_json::from_value(serde_json::json!({
//! #   "schemaVersion": 1, "id": "prj_01",
//! #   "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
//! #   "sources": [], "analyses": {}, "tracks": [],
//! #   "arrangement": { "timebase": { "ppq": 960,
//! #       "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }], "timeSignatures": [] },
//! #       "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } } })).unwrap();
//! # let plan = bragi_engine::plan::compile(&doc, &bragi_model::AssetIndex::new(), 48_000, 1).unwrap();
//! let options = ExportOptions::new(AudioFormat::Wav { bits: 24 }, ExportMeta::titled("My song"));
//! let file = export_mixdown(&plan, &MemoryPcm::new(), &options).unwrap();
//! assert_eq!(file.name, "My song.wav");
//! assert_eq!(&file.bytes[0..4], b"RIFF");
//! ```

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::offline::{OfflineOptions, render};
use crate::pcm::PcmSource;
use crate::plan::{RenderPlan, TrackPlan};

pub mod flac;
pub mod md5;
pub mod quantize;
pub mod wav;

pub use flac::encode_flac;
pub use wav::encode_wav;

/// Something went wrong while exporting.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum ExportError {
    /// The container is not available in v1 (MP3).
    #[error("unsupported export format: {0}")]
    UnsupportedFormat(String),
    /// The bit depth is not valid for the container.
    #[error("unsupported bit depth: {0}")]
    UnsupportedBits(u8),
    /// The channel count cannot be encoded.
    #[error("unsupported channel count: {0}")]
    UnsupportedChannels(u16),
    /// The audio would not fit a RIFF container (4 GiB).
    #[error("the render is too large for a WAV file; use FLAC")]
    TooLarge,
    /// A stem or a context render was requested for a track that is not in the project.
    #[error("unknown track: {0}")]
    UnknownTrack(String),
    /// A context render was asked for no tracks at all.
    #[error("the track list is empty")]
    EmptyTrackList,
    /// A context range is empty or inverted (`end <= start`).
    #[error("empty or inverted tick range: start {start_tick}, end {end_tick}")]
    EmptyRange {
        /// Range start in ticks.
        start_tick: i64,
        /// Range end in ticks.
        end_tick: i64,
    },
    /// A context range does not lie inside the song.
    #[error("tick range {start_tick}..{end_tick} is outside the song")]
    RangeOutsideSong {
        /// Range start in ticks.
        start_tick: i64,
        /// Range end in ticks.
        end_tick: i64,
    },
    /// The job kind is not exportable here.
    #[error("unsupported render job: {0}")]
    UnsupportedJob(String),
    /// The job description could not be read.
    #[error("bad render job: {0}")]
    BadJob(String),
}

/// An export container and sample format (`03 §9` `AudioFormat`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "container", rename_all = "lowercase")]
pub enum AudioFormat {
    /// RIFF/WAVE: 16 or 24-bit integer PCM, or 32-bit IEEE float.
    Wav {
        /// 16, 24 or 32.
        bits: u8,
    },
    /// FLAC: 16 or 24 bit.
    Flac {
        /// 16 or 24.
        bits: u8,
    },
    /// MP3 (not in v1).
    Mp3 {
        /// Bitrate in kbit/s.
        kbps: u16,
    },
}

impl AudioFormat {
    /// The file extension, without the dot.
    #[must_use]
    pub fn extension(&self) -> &'static str {
        match self {
            Self::Wav { .. } => "wav",
            Self::Flac { .. } => "flac",
            Self::Mp3 { .. } => "mp3",
        }
    }

    /// Checks the format can be produced.
    ///
    /// # Errors
    /// [`ExportError::UnsupportedFormat`] / [`ExportError::UnsupportedBits`].
    pub fn validate(&self) -> Result<(), ExportError> {
        match *self {
            Self::Wav { bits: 16 | 24 | 32 } | Self::Flac { bits: 16 | 24 } => Ok(()),
            Self::Wav { bits } | Self::Flac { bits } => Err(ExportError::UnsupportedBits(bits)),
            Self::Mp3 { .. } => Err(ExportError::UnsupportedFormat("mp3".into())),
        }
    }
}

/// Descriptive metadata written into the file (WAV `LIST/INFO`, FLAC Vorbis comments).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportMeta {
    /// The song title.
    pub title: Option<String>,
    /// The stem's track name (set by [`export_stems`]).
    pub track: Option<String>,
    /// Tempo, for the comment.
    pub bpm: Option<f64>,
    /// Musical key, for the comment.
    pub key: Option<String>,
    /// Creation date (ISO 8601). The engine never reads the clock, so the
    /// caller supplies it.
    pub created: Option<String>,
}

/// One metadata field in both container vocabularies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tag {
    /// The WAV `INFO` chunk id, when WAV has one.
    pub wav_id: Option<&'static str>,
    /// The Vorbis comment field name.
    pub vorbis_name: &'static str,
    /// The value.
    pub value: String,
}

impl ExportMeta {
    /// Metadata with just a title.
    #[must_use]
    pub fn titled(title: impl Into<String>) -> Self {
        Self {
            title: Some(title.into()),
            ..Self::default()
        }
    }

    /// No descriptive fields (the software tag is still written).
    #[must_use]
    pub fn bare() -> Self {
        Self::default()
    }

    /// The fields to write, in a stable order.
    #[must_use]
    pub fn tags(&self) -> Vec<Tag> {
        let mut tags = Vec::new();
        let title = match (&self.title, &self.track) {
            (Some(title), Some(track)) => Some(format!("{title} - {track}")),
            (Some(title), None) => Some(title.clone()),
            (None, Some(track)) => Some(track.clone()),
            (None, None) => None,
        };
        if let Some(value) = title {
            tags.push(Tag {
                wav_id: Some("INAM"),
                vorbis_name: "TITLE",
                value,
            });
        }
        let mut comment = Vec::new();
        if let Some(bpm) = self.bpm {
            comment.push(format!("BPM {bpm:.2}"));
        }
        if let Some(key) = &self.key {
            comment.push(format!("Key {key}"));
        }
        if let Some(track) = &self.track {
            comment.push(format!("Stem {track}"));
        }
        if !comment.is_empty() {
            tags.push(Tag {
                wav_id: Some("ICMT"),
                vorbis_name: "COMMENT",
                value: comment.join(", "),
            });
        }
        if let Some(created) = &self.created {
            tags.push(Tag {
                wav_id: Some("ICRD"),
                vorbis_name: "DATE",
                value: created.clone(),
            });
        }
        tags.push(Tag {
            wav_id: Some("ISFT"),
            vorbis_name: "ENCODER",
            value: format!("Bragi {}", crate::ENGINE_VERSION),
        });
        tags
    }
}

/// An encoded file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportFile {
    /// The suggested file name.
    pub name: String,
    /// The encoded bytes.
    pub bytes: Vec<u8>,
    /// Frames of audio in the file.
    pub frames: u64,
}

/// What to export.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportOptions {
    /// Container and bit depth.
    pub format: AudioFormat,
    /// Metadata.
    pub meta: ExportMeta,
    /// First sample to render.
    pub start: u64,
    /// Frames to render; `None` renders to the end of the arrangement.
    pub frames: Option<u64>,
    /// TPDF dither seed for 16/24-bit output; `None` means no dither.
    pub dither_seed: Option<u64>,
}

impl ExportOptions {
    /// A whole-song export with no dither.
    #[must_use]
    pub fn new(format: AudioFormat, meta: ExportMeta) -> Self {
        Self {
            format,
            meta,
            start: 0,
            frames: None,
            dither_seed: None,
        }
    }

    fn offline(&self, _plan: &RenderPlan) -> OfflineOptions {
        match self.frames {
            Some(frames) => OfflineOptions::range(self.start, frames),
            // No explicit range: render the arrangement and any fx tail
            // (`offline::render` adds `max(effect.tail())` past the end).
            None => OfflineOptions {
                start: self.start,
                frames: None,
                ..OfflineOptions::default()
            },
        }
    }
}

/// Which tracks a stems export covers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StemSelection {
    /// Every track, in document order.
    All,
    /// These track IDs, in document order.
    Tracks(Vec<String>),
}

/// Encodes interleaved stereo samples in `format`.
///
/// # Errors
/// Any [`ExportError`] from validation or the encoders.
pub fn encode(
    samples: &[f32],
    format: AudioFormat,
    meta: &ExportMeta,
    dither_seed: Option<u64>,
) -> Result<Vec<u8>, ExportError> {
    format.validate()?;
    match format {
        AudioFormat::Wav { bits } => encode_wav(samples, 2, bits, meta, dither_seed),
        AudioFormat::Flac { bits } => encode_flac(samples, 2, bits, meta, dither_seed),
        AudioFormat::Mp3 { .. } => Err(ExportError::UnsupportedFormat("mp3".into())),
    }
}

/// Renders the arrangement offline and encodes it.
///
/// The file is named `<title>.<ext>` (`song.<ext>` without a title).
///
/// # Errors
/// Any [`ExportError`].
pub fn export_mixdown<P: PcmSource + ?Sized>(
    plan: &RenderPlan,
    pcm: &P,
    options: &ExportOptions,
) -> Result<ExportFile, ExportError> {
    options.format.validate()?;
    let rendered = render(plan, &PcmRef(pcm), &options.offline(plan));
    let bytes = encode(
        &rendered.samples,
        options.format,
        &options.meta,
        options.dither_seed,
    )?;
    let stem = options.meta.title.as_deref().unwrap_or("song");
    Ok(ExportFile {
        name: format!(
            "{}.{}",
            sanitize_file_name(stem, "song"),
            options.format.extension()
        ),
        bytes,
        frames: rendered.frames as u64,
    })
}

/// A plan that renders only `track`: its mute and solo are cleared (a stem is
/// the track as written, not as auditioned), the master gain is kept, the safety
/// limiter is bypassed so stems stay linear, and a generated transition overlay
/// is left out (it bridges the master bus, not a track; 03 §5.5, §9).
#[must_use]
pub fn stem_plan(plan: &RenderPlan, track: &TrackPlan) -> RenderPlan {
    let mut stem = plan.clone();
    let mut only = track.clone();
    only.mute = false;
    only.solo = false;
    stem.tracks = vec![only];
    stem.master.ceiling = 1.0e6;
    stem.overlays.clear();
    stem
}

/// Renders each selected track on its own and encodes it.
///
/// Files are named `<NN>-<track name>.<ext>` with `NN` the track's 1-based
/// position in the document, and come back in document order. With the
/// `parallel` feature the tracks render on the rayon pool; the result is the
/// same bytes either way.
///
/// # Errors
/// [`ExportError::UnknownTrack`] for an ID that is not in the plan, plus any
/// encoder error.
pub fn export_stems<P: PcmSource + Sync + ?Sized>(
    plan: &RenderPlan,
    pcm: &P,
    selection: &StemSelection,
    options: &ExportOptions,
) -> Result<Vec<ExportFile>, ExportError> {
    options.format.validate()?;
    if let StemSelection::Tracks(ids) = selection {
        for id in ids {
            if !plan.tracks.iter().any(|track| track.id.as_str() == id) {
                return Err(ExportError::UnknownTrack(id.clone()));
            }
        }
    }
    let wanted: Vec<usize> = plan
        .tracks
        .iter()
        .enumerate()
        .filter(|(_, track)| match selection {
            StemSelection::All => true,
            StemSelection::Tracks(ids) => ids.iter().any(|id| id == track.id.as_str()),
        })
        .map(|(index, _)| index)
        .collect();
    let offline = options.offline(plan);

    let one = |index: usize| -> Result<ExportFile, ExportError> {
        let track = &plan.tracks[index];
        let rendered = render(&stem_plan(plan, track), &PcmRef(pcm), &offline);
        let mut meta = options.meta.clone();
        meta.track = Some(track.name.clone());
        let bytes = encode(
            &rendered.samples,
            options.format,
            &meta,
            options.dither_seed,
        )?;
        Ok(ExportFile {
            name: format!(
                "{:02}-{}.{}",
                index + 1,
                sanitize_file_name(&track.name, "track"),
                options.format.extension()
            ),
            bytes,
            frames: rendered.frames as u64,
        })
    };

    #[cfg(feature = "parallel")]
    let results: Vec<Result<ExportFile, ExportError>> = {
        use rayon::prelude::*;
        wanted.par_iter().map(|index| one(*index)).collect()
    };
    #[cfg(not(feature = "parallel"))]
    let results: Vec<Result<ExportFile, ExportError>> =
        wanted.iter().map(|index| one(*index)).collect();
    results.into_iter().collect()
}

/// The file name of a context render (`specs/03-audio-engine.md` §9).
pub const CONTEXT_FILE_NAME: &str = "context.wav";

/// The context format: 48 kHz, 32-bit float stereo WAV, one file.
pub const CONTEXT_FORMAT: AudioFormat = AudioFormat::Wav { bits: 32 };

/// Renders exactly one tick range of the mix, for generation conditioning.
///
/// The range is converted through the plan's tempo map and rendered at the
/// engine rate (48 kHz); the file is always 32-bit float WAV named `context.wav`
/// (`specs/03-audio-engine.md` §9, WP-2.7). The master chain (gain, fx and the
/// safety limiter) applies in every case. [`StemSelection::All`] is every
/// track, an explicit list only those tracks; mute applies in both, and solo is
/// ignored in both: it is a listening state, and a soloed part must not shrink
/// the context the model is conditioned on.
///
/// The render starts at the range's first sample and stops after its last, so
/// an fx tail is only included where the effect was excited inside the range;
/// nothing before or after the range is rendered.
///
/// # Errors
/// [`ExportError::EmptyRange`] (`end <= start`),
/// [`ExportError::RangeOutsideSong`] (negative start or an end past the song),
/// [`ExportError::EmptyTrackList`], [`ExportError::UnknownTrack`], plus any
/// encoder error.
pub fn export_context<P: PcmSource + ?Sized>(
    plan: &RenderPlan,
    pcm: &P,
    range: &bragi_model::generated::TickRange,
    selection: &StemSelection,
) -> Result<ExportFile, ExportError> {
    if range.end_tick <= range.start_tick {
        return Err(ExportError::EmptyRange {
            start_tick: range.start_tick,
            end_tick: range.end_tick,
        });
    }

    let wanted: Vec<usize> = match selection {
        StemSelection::All => (0..plan.tracks.len()).collect(),
        StemSelection::Tracks(ids) => {
            if ids.is_empty() {
                return Err(ExportError::EmptyTrackList);
            }
            for id in ids {
                if !plan.tracks.iter().any(|track| track.id.as_str() == id) {
                    return Err(ExportError::UnknownTrack(id.clone()));
                }
            }
            plan.tracks
                .iter()
                .enumerate()
                .filter(|(_, track)| ids.iter().any(|id| id == track.id.as_str()))
                .map(|(index, _)| index)
                .collect()
        }
    };

    // Tick -> sample is the tempo map's job; the plan carries it so the same
    // conversion runs on both hosts (03 §9).
    let tempo = bragi_model::TempoCtx::new(&plan.tempo_points, plan.ppq);
    let start = crate::plan::tick_to_sample(&tempo, plan.sample_rate, range.start_tick);
    let end = crate::plan::tick_to_sample(&tempo, plan.sample_rate, range.end_tick);
    if start < 0 || end > plan.length_samples as i64 {
        return Err(ExportError::RangeOutsideSong {
            start_tick: range.start_tick,
            end_tick: range.end_tick,
        });
    }
    let frames = (end - start) as u64;
    if frames == 0 {
        return Err(ExportError::EmptyRange {
            start_tick: range.start_tick,
            end_tick: range.end_tick,
        });
    }

    let mut context = plan.clone();
    context.tracks = wanted
        .into_iter()
        .map(|index| {
            let mut track = plan.tracks[index].clone();
            // Mute is part of the track as written; solo is a listening state,
            // so the context ignores it (03 §9).
            track.solo = false;
            track
        })
        .collect();

    // Effects are stateful: a reverb or delay excited before the range rings
    // into it. Render that much extra, then drop it, so the result equals the
    // same slice of a full mixdown and still ends exactly on the range's last
    // sample (no tail is appended past it).
    let pre_roll = {
        let prepared = crate::render::PreparedPlan::new(
            std::sync::Arc::new(context.clone()),
            crate::plan::quality_for(true),
            crate::offline::OFFLINE_BLOCK,
        );
        (prepared.max_tail_frames() as u64).min(start as u64)
    };
    let rendered = render(
        &context,
        &PcmRef(pcm),
        &OfflineOptions::range(start as u64 - pre_roll, frames + pre_roll),
    );
    let skip = (pre_roll as usize * 2).min(rendered.samples.len());
    let samples = &rendered.samples[skip..];
    let bytes = encode(samples, CONTEXT_FORMAT, &ExportMeta::bare(), None)?;
    Ok(ExportFile {
        name: CONTEXT_FILE_NAME.to_string(),
        bytes,
        frames: (samples.len() / 2) as u64,
    })
}

/// Adapts `&P` (possibly unsized) to the sized `&dyn PcmSource` the renderer takes.
struct PcmRef<'a, P: ?Sized>(&'a P);

impl<P: PcmSource + ?Sized> PcmSource for PcmRef<'_, P> {
    fn read(
        &self,
        asset: &bragi_model::generated::AssetHash,
        start: u64,
        frames: usize,
        out: &mut [f32],
    ) -> bool {
        self.0.read(asset, start, frames, out)
    }

    fn available_frames(&self, asset: &bragi_model::generated::AssetHash) -> Option<u64> {
        self.0.available_frames(asset)
    }
}

/// Reduces a title or track name to a portable file name stem.
///
/// Letters, digits, spaces, `_` and `-` survive; everything else becomes `_`.
/// Runs of whitespace collapse, edges are trimmed, and the result is capped at
/// 80 characters. `fallback` is used when nothing is left.
#[must_use]
pub fn sanitize_file_name(name: &str, fallback: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || matches!(ch, '_' | '-') {
                ch
            } else if ch.is_whitespace() {
                ' '
            } else {
                '_'
            }
        })
        .collect();
    let collapsed = mapped.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed: String = collapsed.chars().take(80).collect();
    let trimmed = trimmed.trim_matches(|ch| ch == ' ' || ch == '.' || ch == '_');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// The result of running a render job described as JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportResult {
    /// The files, in order (one for a mixdown).
    pub files: Vec<ExportFile>,
}

/// The magic bytes that open an export frame.
pub const FRAME_MAGIC: &[u8; 4] = b"BXPT";

impl ExportResult {
    /// Packs the result into one binary frame, so a host can hand every file
    /// across a process or worker boundary in a single buffer (no JSON number
    /// arrays for megabytes of audio).
    ///
    /// Layout: `"BXPT" | u32 LE jsonLen | json | file 0 bytes | file 1 bytes | …`
    /// where `json` is `{"version":1,"channels":2,"sampleRate":48000,
    /// "frames":N,"files":[{"name":…,"length":…,"frames":…},…]}`. The TypeScript
    /// reader is `decodeExportFrame` in `packages/platform/src/engine/codec.ts`.
    #[must_use]
    pub fn to_frame(&self) -> Vec<u8> {
        let files: Vec<serde_json::Value> = self
            .files
            .iter()
            .map(|file| {
                serde_json::json!({
                    "name": file.name,
                    "length": file.bytes.len(),
                    "frames": file.frames,
                })
            })
            .collect();
        let header = serde_json::json!({
            "version": 1,
            "channels": 2,
            "sampleRate": crate::SAMPLE_RATE,
            "frames": self.files.iter().map(|file| file.frames).max().unwrap_or(0),
            "files": files,
        })
        .to_string();
        let total: usize = self.files.iter().map(|file| file.bytes.len()).sum();
        let mut out = Vec::with_capacity(8 + header.len() + total);
        out.extend_from_slice(FRAME_MAGIC);
        out.extend_from_slice(&(header.len() as u32).to_le_bytes());
        out.extend_from_slice(header.as_bytes());
        for file in &self.files {
            out.extend_from_slice(&file.bytes);
        }
        out
    }
}

/// Runs a `mixdown`, `stems` or `context` render job given as the host JSON
/// (`packages/platform` `RenderJob`), so both hosts share one parser.
///
/// Recognised fields: `kind`, `format`, `startSample`, `frames`, `range`
/// (`{ startTick, endTick }`, `context` only), `tracks` (`"all"` or an array
/// of track IDs), `meta` ([`ExportMeta`]) and `ditherSeed`. A `context` job
/// takes its format from [`CONTEXT_FORMAT`].
///
/// # Errors
/// [`ExportError::UnsupportedJob`] for `cache`/unknown kinds,
/// [`ExportError::BadJob`] for unreadable fields, plus the errors of
/// [`export_context`] and the encoders.
pub fn run_job<P: PcmSource + Sync + ?Sized>(
    plan: &RenderPlan,
    pcm: &P,
    job: &serde_json::Value,
) -> Result<ExportResult, ExportError> {
    let kind = job
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if kind == "context" {
        let range: bragi_model::generated::TickRange = match job.get("range") {
            Some(value) if !value.is_null() => serde_json::from_value(value.clone())
                .map_err(|error| ExportError::BadJob(format!("range: {error}")))?,
            _ => return Err(ExportError::BadJob("context needs a tick range".into())),
        };
        let selection = parse_track_selection(job)?;
        return Ok(ExportResult {
            files: vec![export_context(plan, pcm, &range, &selection)?],
        });
    }
    if job.get("range").is_some_and(|range| !range.is_null()) && job.get("startSample").is_none() {
        return Err(ExportError::BadJob(
            "a tick range must be converted to startSample/frames by the caller; the tempo map lives in bragi-model"
                .into(),
        ));
    }
    if kind != "mixdown" && kind != "stems" {
        return Err(ExportError::UnsupportedJob(kind.to_string()));
    }
    if job.get("normalize").is_some_and(|value| !value.is_null()) {
        return Err(ExportError::UnsupportedJob(
            "normalize (needs loudness metering, not in v1)".into(),
        ));
    }
    let format: AudioFormat = match job.get("format") {
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|error| ExportError::BadJob(format!("format: {error}")))?,
        None => AudioFormat::Wav { bits: 24 },
    };
    let meta: ExportMeta = match job.get("meta") {
        Some(value) if !value.is_null() => serde_json::from_value(value.clone())
            .map_err(|error| ExportError::BadJob(format!("meta: {error}")))?,
        _ => ExportMeta::default(),
    };
    let mut options = ExportOptions::new(format, meta);
    options.start = job
        .get("startSample")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    options.frames = job.get("frames").and_then(serde_json::Value::as_u64);
    options.dither_seed = job.get("ditherSeed").and_then(serde_json::Value::as_u64);

    let files = if kind == "mixdown" {
        vec![export_mixdown(plan, pcm, &options)?]
    } else {
        let selection = parse_track_selection(job)?;
        export_stems(plan, pcm, &selection, &options)?
    };
    Ok(ExportResult { files })
}

/// Reads the `tracks` field: `"all"`, an array of track IDs, or absent (all).
fn parse_track_selection(job: &serde_json::Value) -> Result<StemSelection, ExportError> {
    match job.get("tracks") {
        None | Some(serde_json::Value::Null) => Ok(StemSelection::All),
        Some(serde_json::Value::String(all)) if all == "all" => Ok(StemSelection::All),
        Some(serde_json::Value::Array(ids)) => Ok(StemSelection::Tracks(
            ids.iter()
                .map(|id| {
                    id.as_str()
                        .map(str::to_string)
                        .ok_or_else(|| ExportError::BadJob("tracks must be strings".into()))
                })
                .collect::<Result<_, _>>()?,
        )),
        Some(other) => Err(ExportError::BadJob(format!("tracks: {other}"))),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_portable() {
        assert_eq!(sanitize_file_name("Lead / Vox: 1", "x"), "Lead _ Vox_ 1");
        assert_eq!(sanitize_file_name("  ..  ", "track"), "track");
        assert_eq!(sanitize_file_name("../../etc/passwd", "x"), "etc_passwd");
        assert_eq!(sanitize_file_name("Dr\u{fc}ms", "x"), "Dr\u{fc}ms");
        assert_eq!(sanitize_file_name(&"a".repeat(200), "x").len(), 80);
    }

    #[test]
    fn frames_pack_files_back_to_back() {
        let result = ExportResult {
            files: vec![
                ExportFile {
                    name: "a.wav".into(),
                    bytes: vec![1, 2, 3],
                    frames: 5,
                },
                ExportFile {
                    name: "b.wav".into(),
                    bytes: vec![9],
                    frames: 5,
                },
            ],
        };
        let frame = result.to_frame();
        assert_eq!(&frame[0..4], FRAME_MAGIC);
        let json_len = u32::from_le_bytes(frame[4..8].try_into().unwrap()) as usize;
        let header: serde_json::Value = serde_json::from_slice(&frame[8..8 + json_len]).unwrap();
        assert_eq!(header["files"][0]["length"], 3);
        assert_eq!(header["files"][1]["name"], "b.wav");
        assert_eq!(header["frames"], 5);
        assert_eq!(&frame[8 + json_len..], [1, 2, 3, 9]);
    }

    #[test]
    fn formats_validate() {
        assert!(AudioFormat::Wav { bits: 24 }.validate().is_ok());
        assert!(AudioFormat::Flac { bits: 16 }.validate().is_ok());
        assert_eq!(
            AudioFormat::Flac { bits: 32 }.validate(),
            Err(ExportError::UnsupportedBits(32))
        );
        assert!(matches!(
            AudioFormat::Mp3 { kbps: 320 }.validate(),
            Err(ExportError::UnsupportedFormat(_))
        ));
    }

    #[test]
    fn formats_parse_the_host_json() {
        let wav: AudioFormat =
            serde_json::from_value(serde_json::json!({ "container": "wav", "bits": 16 })).unwrap();
        assert_eq!(wav, AudioFormat::Wav { bits: 16 });
        let flac: AudioFormat =
            serde_json::from_value(serde_json::json!({ "container": "flac", "bits": 24 })).unwrap();
        assert_eq!(flac.extension(), "flac");
    }

    #[test]
    fn tags_carry_title_track_and_software() {
        let meta = ExportMeta {
            title: Some("Song".into()),
            track: Some("Drums".into()),
            bpm: Some(120.0),
            key: Some("C minor".into()),
            created: Some("2026-10-19".into()),
        };
        let tags = meta.tags();
        assert_eq!(tags[0].value, "Song - Drums");
        assert!(tags[1].value.contains("BPM 120.00"));
        assert!(tags[1].value.contains("Key C minor"));
        assert!(tags.iter().any(|tag| tag.vorbis_name == "ENCODER"));
    }
}
