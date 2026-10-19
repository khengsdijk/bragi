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
    /// A stem was requested for a track that is not in the project.
    #[error("unknown track: {0}")]
    UnknownTrack(String),
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

    fn offline(&self, plan: &RenderPlan) -> OfflineOptions {
        match self.frames {
            Some(frames) => OfflineOptions::range(self.start, frames),
            None => OfflineOptions {
                start: self.start,
                frames: Some(plan.length_samples.saturating_sub(self.start)),
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
/// the track as written, not as auditioned), the master gain is kept, and the
/// safety limiter is bypassed so stems stay linear.
#[must_use]
pub fn stem_plan(plan: &RenderPlan, track: &TrackPlan) -> RenderPlan {
    let mut stem = plan.clone();
    let mut only = track.clone();
    only.mute = false;
    only.solo = false;
    stem.tracks = vec![only];
    stem.master.ceiling = 1.0e6;
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

/// Runs a `mixdown` or `stems` render job given as the host JSON
/// (`packages/platform` `RenderJob`), so both hosts share one parser.
///
/// Recognised fields: `kind`, `format`, `startSample`, `frames`, `tracks`
/// (`"all"` or an array of track IDs), `meta` ([`ExportMeta`]) and
/// `ditherSeed`.
///
/// # Errors
/// [`ExportError::UnsupportedJob`] for `context`/`cache`/unknown kinds,
/// [`ExportError::BadJob`] for unreadable fields, plus encoder errors.
pub fn run_job<P: PcmSource + Sync + ?Sized>(
    plan: &RenderPlan,
    pcm: &P,
    job: &serde_json::Value,
) -> Result<ExportResult, ExportError> {
    let kind = job
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
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
        let selection = match job.get("tracks") {
            None | Some(serde_json::Value::Null) => StemSelection::All,
            Some(serde_json::Value::String(all)) if all == "all" => StemSelection::All,
            Some(serde_json::Value::Array(ids)) => StemSelection::Tracks(
                ids.iter()
                    .map(|id| {
                        id.as_str()
                            .map(str::to_string)
                            .ok_or_else(|| ExportError::BadJob("tracks must be strings".into()))
                    })
                    .collect::<Result<_, _>>()?,
            ),
            Some(other) => {
                return Err(ExportError::BadJob(format!("tracks: {other}")));
            }
        };
        export_stems(plan, pcm, &selection, &options)?
    };
    Ok(ExportResult { files })
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
