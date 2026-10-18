//! PCM sources: the only way the renderer reads audio.
//!
//! Every host implements [`PcmSource`] over its own storage — a `MemoryPcm` for
//! tests and the wasm worker hand-off, a [`ChunkPool`](crate::chunkpool) in the
//! browser, a memory map on desktop. The trait is deliberately small and
//! audio-thread safe:
//!
//! - [`PcmSource::read`] fills exactly `frames × 2` interleaved stereo samples,
//!   duplicating mono sources and truncating wider ones;
//! - a missing region is **silence** and returns `false`, which the renderer
//!   counts as an underrun (`specs/03-audio-engine.md` §3.1);
//! - implementations may not allocate, lock, log or panic.
//!
//! ```
//! use bragi_engine::pcm::{MemoryPcm, PcmBuffer, PcmSource};
//! # use bragi_model::generated::AssetHash;
//! # let hash = AssetHash::try_from(format!("sha256:{}", "0".repeat(64))).unwrap();
//! let mut pcm = MemoryPcm::new();
//! pcm.insert(hash.clone(), PcmBuffer::silent(2, 48_000, 480));
//! let mut out = [0.0f32; 256];
//! assert!(pcm.read(&hash, 0, 128, &mut out));
//! ```

use std::collections::HashMap;

use bragi_model::generated::AssetHash;

use crate::SAMPLE_RATE;

/// A stereo-interleaved window of PCM.
pub trait PcmSource {
    /// Reads `frames` frames starting at absolute sample `start` into `out`
    /// (interleaved stereo, length `frames * 2`).
    ///
    /// Always fills `out` (zeros where data is missing). Returns `false` when
    /// the requested region was not available, which the renderer treats as an
    /// underrun.
    fn read(&self, asset: &AssetHash, start: u64, frames: usize, out: &mut [f32]) -> bool;

    /// The asset's length in frames, if known.
    fn available_frames(&self, _asset: &AssetHash) -> Option<u64> {
        None
    }
}

impl<T: PcmSource + ?Sized> PcmSource for &T {
    fn read(&self, asset: &AssetHash, start: u64, frames: usize, out: &mut [f32]) -> bool {
        (**self).read(asset, start, frames, out)
    }

    fn available_frames(&self, asset: &AssetHash) -> Option<u64> {
        (**self).available_frames(asset)
    }
}

/// One asset's decoded PCM, interleaved at its own channel count.
#[derive(Clone, Debug)]
pub struct PcmBuffer {
    /// Interleaved samples.
    pub samples: Vec<f32>,
    /// Channel count (1 or 2; wider input is truncated on read).
    pub channels: u16,
    /// The asset's rate (the working copies are 48 kHz).
    pub sample_rate: u32,
}

impl PcmBuffer {
    /// Wraps decoded interleaved samples.
    #[must_use]
    pub fn new(samples: Vec<f32>, channels: u16, sample_rate: u32) -> Self {
        Self {
            samples,
            channels: channels.max(1),
            sample_rate,
        }
    }

    /// A silent buffer of `frames` frames.
    #[must_use]
    pub fn silent(channels: u16, sample_rate: u32, frames: usize) -> Self {
        let channels = channels.max(1);
        Self {
            samples: vec![0.0; frames.saturating_mul(channels as usize)],
            channels,
            sample_rate,
        }
    }

    /// Frames in the buffer.
    #[must_use]
    pub fn frames(&self) -> usize {
        self.samples.len() / self.channels as usize
    }

    /// Reads one frame as `(left, right)`; mono is duplicated and out-of-range
    /// is silence.
    #[must_use]
    pub fn frame(&self, index: usize) -> (f32, f32) {
        let channels = self.channels as usize;
        if index >= self.frames() {
            return (0.0, 0.0);
        }
        let base = index * channels;
        match channels {
            1 => {
                let sample = self.samples[base];
                (sample, sample)
            }
            _ => (self.samples[base], self.samples[base + 1]),
        }
    }
}

/// A map of assets to decoded PCM. Hosts and tests use it directly; the browser
/// uses [`ChunkPool`](crate::chunkpool) and desktop uses an mmap cache instead.
#[derive(Clone, Debug, Default)]
pub struct MemoryPcm {
    assets: HashMap<AssetHash, PcmBuffer>,
}

impl MemoryPcm {
    /// An empty source.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds or replaces one asset.
    pub fn insert(&mut self, asset: AssetHash, buffer: PcmBuffer) {
        self.assets.insert(asset, buffer);
    }

    /// Removes one asset.
    pub fn remove(&mut self, asset: &AssetHash) -> Option<PcmBuffer> {
        self.assets.remove(asset)
    }

    /// The buffer for an asset.
    #[must_use]
    pub fn get(&self, asset: &AssetHash) -> Option<&PcmBuffer> {
        self.assets.get(asset)
    }

    /// How many assets are loaded.
    #[must_use]
    pub fn len(&self) -> usize {
        self.assets.len()
    }

    /// Whether no assets are loaded.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.assets.is_empty()
    }

    /// The sample rate of an asset, if known.
    #[must_use]
    pub fn sample_rate(&self, asset: &AssetHash) -> Option<u32> {
        self.assets.get(asset).map(|buffer| buffer.sample_rate)
    }
}

impl PcmSource for MemoryPcm {
    fn read(&self, asset: &AssetHash, start: u64, frames: usize, out: &mut [f32]) -> bool {
        let Some(buffer) = self.assets.get(asset) else {
            for sample in out.iter_mut() {
                *sample = 0.0;
            }
            return false;
        };
        let count = frames.min(out.len() / 2);
        let total = buffer.frames();
        for frame in 0..count {
            let source_index = start as usize + frame;
            let (left, right) = if source_index < total {
                buffer.frame(source_index)
            } else {
                (0.0, 0.0)
            };
            out[frame * 2] = left;
            out[frame * 2 + 1] = right;
        }
        for sample in out[count * 2..].iter_mut() {
            *sample = 0.0;
        }
        true
    }

    fn available_frames(&self, asset: &AssetHash) -> Option<u64> {
        self.assets.get(asset).map(|buffer| buffer.frames() as u64)
    }
}

/// An always-silent source, for hosts before the first asset arrives.
#[derive(Clone, Copy, Debug, Default)]
pub struct SilentPcm;

impl PcmSource for SilentPcm {
    fn read(&self, _asset: &AssetHash, _start: u64, frames: usize, out: &mut [f32]) -> bool {
        for sample in out[..frames * 2].iter_mut() {
            *sample = 0.0;
        }
        false
    }
}

/// Converts an interleaved buffer at `channels` to stereo in place helpers.
///
/// Returns the number of stereo frames written.
#[must_use]
pub fn to_stereo(samples: &[f32], channels: u16, out: &mut [f32]) -> usize {
    let channels = channels.max(1) as usize;
    let frames = (samples.len() / channels).min(out.len() / 2);
    for frame in 0..frames {
        let base = frame * channels;
        match channels {
            1 => {
                let sample = samples[base];
                out[frame * 2] = sample;
                out[frame * 2 + 1] = sample;
            }
            _ => {
                out[frame * 2] = samples[base];
                out[frame * 2 + 1] = samples[base + 1];
            }
        }
    }
    frames
}

/// The engine's nominal output rate, for hosts that need to declare it.
#[must_use]
pub const fn engine_sample_rate() -> u32 {
    SAMPLE_RATE
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn hash(byte: char) -> AssetHash {
        AssetHash::try_from(format!("sha256:{}", byte.to_string().repeat(64))).unwrap()
    }

    #[test]
    fn mono_is_duplicated_and_past_the_end_is_silence() {
        let mut pcm = MemoryPcm::new();
        pcm.insert(hash('0'), PcmBuffer::new(vec![0.5, 0.25], 1, 48_000));
        let mut out = [1.0f32; 8];
        assert!(pcm.read(&hash('0'), 0, 4, &mut out));
        assert_eq!(out, [0.5, 0.5, 0.25, 0.25, 0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn missing_asset_is_silence_and_false() {
        let pcm = MemoryPcm::new();
        let mut out = [1.0f32; 4];
        assert!(!pcm.read(&hash('1'), 0, 2, &mut out));
        assert_eq!(out, [0.0; 4]);
    }

    #[test]
    fn stereo_passthrough() {
        let mut pcm = MemoryPcm::new();
        pcm.insert(
            hash('2'),
            PcmBuffer::new(vec![0.1, -0.1, 0.2, -0.2], 2, 48_000),
        );
        let mut out = [0.0f32; 4];
        assert!(pcm.read(&hash('2'), 0, 2, &mut out));
        assert_eq!(out, [0.1, -0.1, 0.2, -0.2]);
    }

    #[test]
    fn to_stereo_duplicates_mono() {
        let mut out = [0.0f32; 4];
        assert_eq!(to_stereo(&[0.5, 0.25], 1, &mut out), 2);
        assert_eq!(out, [0.5, 0.5, 0.25, 0.25]);
    }
}
