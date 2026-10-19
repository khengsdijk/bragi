//! Offline render (`specs/03-audio-engine.md` §9).
//!
//! Deterministic mixdown: a fixed 512-frame block size regardless of host, the
//! `Render` stretch tier, no randomness and no wall clock. Two runs of the same
//! plan over the same PCM produce bit-identical output, which is what makes the
//! golden fixtures and the WASM-vs-native null test meaningful.
//!
//! ```
//! use bragi_engine::offline::{render, OfflineOptions};
//! # fn plan() -> bragi_engine::plan::RenderPlan {
//! #   let doc: bragi_model::generated::Project = serde_json::from_value(serde_json::json!({
//! #     "schemaVersion": 1, "id": "prj_01",
//! #     "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
//! #     "sources": [], "analyses": {}, "tracks": [],
//! #     "arrangement": { "timebase": { "ppq": 960,
//! #         "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }], "timeSignatures": [] },
//! #         "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } } })).unwrap();
//! #   bragi_engine::plan::compile(&doc, &bragi_model::AssetIndex::new(), 48_000, 1).unwrap()
//! # }
//! let pcm = bragi_engine::pcm::MemoryPcm::new();
//! let out = render(&plan(), &pcm, &OfflineOptions::default());
//! assert_eq!(out.channels, 2);
//! ```

use std::sync::Arc;

use crate::SAMPLE_RATE;
use crate::pcm::PcmSource;
use crate::plan::RenderPlan;
use crate::render::{RenderStats, Renderer};

/// The offline render block size. Fixed so output is host-independent.
pub const OFFLINE_BLOCK: usize = 512;

/// What to render.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OfflineOptions {
    /// First sample to render.
    pub start: u64,
    /// How many frames to render; `None` renders to the end of the arrangement.
    pub frames: Option<u64>,
    /// Block size (defaults to [`OFFLINE_BLOCK`]).
    pub block: usize,
    /// Output sample rate; must be the engine rate.
    pub sample_rate: u32,
}

impl Default for OfflineOptions {
    fn default() -> Self {
        Self {
            start: 0,
            frames: None,
            block: OFFLINE_BLOCK,
            sample_rate: SAMPLE_RATE,
        }
    }
}

impl OfflineOptions {
    /// Renders a whole range.
    #[must_use]
    pub fn range(start: u64, frames: u64) -> Self {
        Self {
            start,
            frames: Some(frames),
            ..Self::default()
        }
    }
}

/// An offline render's output.
#[derive(Clone, Debug, PartialEq)]
pub struct RenderOutput {
    /// Interleaved stereo samples.
    pub samples: Vec<f32>,
    /// Frames rendered.
    pub frames: usize,
    /// Channels (always 2).
    pub channels: usize,
    /// Peak absolute sample.
    pub peak: f32,
    /// RMS over the render.
    pub rms: f32,
    /// PCM reads that found no data.
    pub underruns: u64,
    /// Whether every sample is finite.
    pub finite: bool,
}

impl RenderOutput {
    /// Peak in dBFS (`-inf` for silence).
    #[must_use]
    pub fn peak_dbfs(&self) -> f32 {
        if self.peak <= 0.0 {
            f32::NEG_INFINITY
        } else {
            20.0 * self.peak.log10()
        }
    }
}

/// Renders `plan` against `pcm`.
///
/// # Panics
/// Panics when `options.sample_rate` is not the engine rate; a caller that wants
/// another rate resamples the result (Q27).
#[must_use]
pub fn render(plan: &RenderPlan, pcm: &dyn PcmSource, options: &OfflineOptions) -> RenderOutput {
    debug_assert_eq!(
        options.sample_rate, SAMPLE_RATE,
        "offline render runs at the engine rate"
    );
    let block = options.block.max(1);
    let mut renderer = Renderer::with_quality(
        Arc::new(plan.clone()),
        block,
        crate::plan::quality_for(true),
    );
    renderer.transport_mut().seek(options.start);
    renderer.transport_mut().play();

    // Past the last arrangement sample, keep processing so reverb/delay tails
    // ring out (03 §9), capped at 30 s. An explicit range adds no tail, and a
    // plan without fx has a zero tail — the unedited null tests are unchanged.
    let tail = if options.frames.is_none() {
        renderer
            .prepared()
            .max_tail_frames()
            .min(30 * SAMPLE_RATE as usize) as u64
    } else {
        0
    };
    let total = match options.frames {
        Some(frames) => frames.min(plan.length_samples.saturating_sub(options.start)),
        None => plan
            .length_samples
            .saturating_sub(options.start)
            .saturating_add(tail),
    };
    let mut samples = Vec::with_capacity(total as usize * 2);
    let mut left = vec![0.0f32; block];
    let mut right = vec![0.0f32; block];
    let mut underruns = 0u64;
    let mut rendered = 0u64;
    let mut finite = true;
    while rendered < total {
        let frames = ((total - rendered) as usize).min(block);
        let stats: RenderStats =
            renderer.process(pcm, &mut [&mut left[..frames], &mut right[..frames]]);
        underruns += stats.underruns;
        for index in 0..frames {
            finite &= left[index].is_finite() && right[index].is_finite();
            samples.push(left[index]);
            samples.push(right[index]);
        }
        rendered += frames as u64;
    }

    let mut peak = 0.0f32;
    let mut sum_sq = 0.0f64;
    for sample in &samples {
        peak = peak.max(sample.abs());
        sum_sq += f64::from(*sample) * f64::from(*sample);
    }
    let rms = if samples.is_empty() {
        0.0
    } else {
        (sum_sq / samples.len() as f64).sqrt() as f32
    };

    RenderOutput {
        frames: samples.len() / 2,
        channels: 2,
        samples,
        peak,
        rms,
        underruns,
        finite,
    }
}

/// The null-test level between two interleaved stereo buffers, in dBFS
/// (`specs/03-audio-engine.md` §11).
///
/// `-inf` means bit-identical. Both buffers must have the same length; the
/// shorter one is used otherwise.
#[must_use]
pub fn null_level_dbfs(a: &[f32], b: &[f32]) -> f32 {
    let len = a.len().min(b.len());
    if len == 0 {
        return f32::NEG_INFINITY;
    }
    let mut sum_sq = 0.0f64;
    for index in 0..len {
        let diff = f64::from(a[index]) - f64::from(b[index]);
        sum_sq += diff * diff;
    }
    let rms = (sum_sq / len as f64).sqrt() as f32;
    if rms <= 0.0 {
        f32::NEG_INFINITY
    } else {
        20.0 * rms.log10()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::pcm::{MemoryPcm, PcmBuffer};
    use bragi_model::generated::{AssetHash, AssetMeta};

    fn hash() -> AssetHash {
        AssetHash::try_from(format!("sha256:{}", "0".repeat(64))).unwrap()
    }

    fn document() -> bragi_model::generated::Project {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "id": "prj_01",
            "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
            "sources": [], "analyses": {},
            "tracks": [{ "id": "trk_01", "name": "T", "role": "full_mix", "color": "#8A8F98",
                         "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": [] }],
            "arrangement": { "timebase": { "ppq": 960,
                "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }], "timeSignatures": [] },
                "sections": [{ "id": "sec_a", "kind": "intro", "label": "A", "lengthTicks": 1920,
                    "lanes": { "trk_01": { "clips": [{ "id": "clp_a",
                        "asset": format!("sha256:{}", "0".repeat(64)),
                        "srcStart": 0, "srcEnd": 48000, "start": 0, "warp": { "mode": "none" },
                        "gainDb": 0, "pitchSemitones": 0, "fadeInTicks": 0, "fadeOutTicks": 0,
                        "fadeCurve": "equal_power",
                        "provenance": { "kind": "user", "createdAt": "2026-10-18T12:00:00Z" } }],
                        "automation": [] } }, "transitionIn": { "kind": "cut", "lengthTicks": 0 } }],
                "master": { "fx": [], "automation": [], "gainDb": 0 } }
        }))
        .unwrap()
    }

    fn plan() -> RenderPlan {
        let meta: AssetMeta = serde_json::from_value(serde_json::json!({
            "hash": hash(), "mime": "audio/wav", "bytes": 1, "sampleRate": 48000,
            "channels": 2, "durationSamples": 48000
        }))
        .unwrap();
        crate::plan::compile(
            &document(),
            &bragi_model::AssetIndex::from_metas([meta]),
            48_000,
            1,
        )
        .unwrap()
    }

    #[test]
    fn render_is_deterministic_and_copies_the_source() {
        let mut pcm = MemoryPcm::new();
        let samples: Vec<f32> = (0..48_000)
            .map(|i| (i as f32 * 0.01).sin() * 0.5)
            .flat_map(|value| [value, value])
            .collect();
        pcm.insert(hash(), PcmBuffer::new(samples, 2, 48_000));
        let first = render(&plan(), &pcm, &OfflineOptions::default());
        let second = render(&plan(), &pcm, &OfflineOptions::default());
        assert_eq!(first.frames, 48_000);
        assert!(first.finite);
        assert_eq!(first.samples, second.samples);
        assert_eq!(
            null_level_dbfs(&first.samples, &second.samples),
            f32::NEG_INFINITY
        );
        assert!((first.peak - 0.5).abs() < 0.01);
    }

    #[test]
    fn missing_pcm_counts_underruns_and_renders_silence() {
        let pcm = MemoryPcm::new();
        let out = render(&plan(), &pcm, &OfflineOptions::default());
        assert!(out.underruns > 0);
        assert_eq!(out.peak, 0.0);
    }

    #[test]
    fn null_level_reports_differences() {
        assert_eq!(null_level_dbfs(&[0.0; 4], &[0.0; 4]), f32::NEG_INFINITY);
        let level = null_level_dbfs(&[1.0, 1.0], &[0.0, 0.0]);
        assert!((level - 0.0).abs() < 1e-6);
    }
}
