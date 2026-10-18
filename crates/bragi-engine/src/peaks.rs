//! Waveform peak pyramids (`specs/03-audio-engine.md` §10).
//!
//! Min/max pairs at 256, 1024, 4096 and 16384 samples per bin, computed from
//! decoded PCM on first load. The serialised form is versioned little-endian so
//! the web cache (OPFS) and the desktop cache store the same bytes:
//!
//! ```text
//! "BRGP" | u32 version | u32 channels | u64 frames | u32 levels
//! per level: u32 bin_size | u64 bins | bins × (f32 min, f32 max)
//! ```
//!
//! ```
//! use bragi_engine::peaks::PeakPyramid;
//! let samples: Vec<f32> = (0..2048).map(|i| (i as f32 * 0.01).sin()).collect();
//! let peaks = PeakPyramid::compute(&samples, 1);
//! assert_eq!(peaks.levels()[0].bin_size, 256);
//! assert_eq!(peaks.levels()[0].bins.len(), 8);
//! let bytes = peaks.to_bytes();
//! assert_eq!(PeakPyramid::from_bytes(&bytes).unwrap(), peaks);
//! ```

use thiserror::Error;

/// The bin sizes the UI asks for (`specs/03-audio-engine.md` §10).
pub const PEAK_LEVELS: [usize; 4] = [256, 1024, 4096, 16384];

const MAGIC: [u8; 4] = *b"BRGP";
const VERSION: u32 = 1;

/// A peak pyramid could not be decoded.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum PeakError {
    /// The byte string is not a peak pyramid.
    #[error("not a peak pyramid (bad magic)")]
    BadMagic,
    /// The format version is not supported.
    #[error("unsupported peak pyramid version {0}")]
    UnsupportedVersion(u32),
    /// The byte string ended before the header or a level did.
    #[error("truncated peak pyramid")]
    Truncated,
    /// The channel count is zero.
    #[error("invalid channel count")]
    BadChannels,
    /// The level count is implausible.
    #[error("invalid level count {0}")]
    BadLevelCount(u32),
}

/// One level of the pyramid.
#[derive(Clone, Debug, PartialEq)]
pub struct PeakLevel {
    /// Samples per bin.
    pub bin_size: usize,
    /// Min/max pairs, one per bin.
    pub bins: Vec<[f32; 2]>,
}

/// A whole pyramid.
#[derive(Clone, Debug, PartialEq)]
pub struct PeakPyramid {
    /// The source's frame count.
    pub frames: u64,
    /// The source's channel count.
    pub channels: u32,
    levels: Vec<PeakLevel>,
}

impl PeakPyramid {
    /// Computes all four levels from interleaved PCM.
    ///
    /// A bin's minimum and maximum are taken over every channel and every frame
    /// in the bin. A short final bin covers the remaining frames.
    #[must_use]
    pub fn compute(samples: &[f32], channels: u16) -> Self {
        let channels = channels.max(1) as usize;
        let frames = samples.len() / channels;
        let mut levels = Vec::with_capacity(PEAK_LEVELS.len());
        for bin_size in PEAK_LEVELS {
            let bin_count = frames.div_ceil(bin_size);
            let mut bins = Vec::with_capacity(bin_count);
            for bin in 0..bin_count {
                let start = bin * bin_size;
                let end = (start + bin_size).min(frames);
                let mut min = f32::INFINITY;
                let mut max = f32::NEG_INFINITY;
                for frame in start..end {
                    for channel in 0..channels {
                        let value = samples[frame * channels + channel];
                        min = min.min(value);
                        max = max.max(value);
                    }
                }
                if !min.is_finite() {
                    min = 0.0;
                }
                if !max.is_finite() {
                    max = 0.0;
                }
                bins.push([min, max]);
            }
            levels.push(PeakLevel { bin_size, bins });
        }
        Self {
            frames: frames as u64,
            channels: channels as u32,
            levels,
        }
    }

    /// The levels, in ascending bin size.
    #[must_use]
    pub fn levels(&self) -> &[PeakLevel] {
        &self.levels
    }

    /// One level by bin size.
    #[must_use]
    pub fn level(&self, bin_size: usize) -> Option<&PeakLevel> {
        self.levels.iter().find(|level| level.bin_size == bin_size)
    }

    /// Serialises to the cache format.
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(
            24 + self
                .levels
                .iter()
                .map(|level| 12 + level.bins.len() * 8)
                .sum::<usize>(),
        );
        out.extend_from_slice(&MAGIC);
        out.extend_from_slice(&VERSION.to_le_bytes());
        out.extend_from_slice(&self.channels.to_le_bytes());
        out.extend_from_slice(&self.frames.to_le_bytes());
        out.extend_from_slice(&(self.levels.len() as u32).to_le_bytes());
        for level in &self.levels {
            out.extend_from_slice(&(level.bin_size as u32).to_le_bytes());
            out.extend_from_slice(&(level.bins.len() as u64).to_le_bytes());
            for [min, max] in &level.bins {
                out.extend_from_slice(&min.to_le_bytes());
                out.extend_from_slice(&max.to_le_bytes());
            }
        }
        out
    }

    /// Parses the cache format.
    ///
    /// # Errors
    /// [`PeakError`] when the bytes are not a well-formed pyramid.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, PeakError> {
        let mut reader = Reader::new(bytes);
        if reader.take(4)? != MAGIC {
            return Err(PeakError::BadMagic);
        }
        let version = reader.u32()?;
        if version != VERSION {
            return Err(PeakError::UnsupportedVersion(version));
        }
        let channels = reader.u32()?;
        if channels == 0 {
            return Err(PeakError::BadChannels);
        }
        let frames = reader.u64()?;
        let level_count = reader.u32()?;
        if level_count as usize > 32 {
            return Err(PeakError::BadLevelCount(level_count));
        }
        let mut levels = Vec::with_capacity(level_count as usize);
        for _ in 0..level_count {
            let bin_size = reader.u32()? as usize;
            let bins = reader.u64()? as usize;
            let mut pairs = Vec::with_capacity(bins);
            for _ in 0..bins {
                let min = f32::from_le_bytes(reader.array()?);
                let max = f32::from_le_bytes(reader.array()?);
                pairs.push([min, max]);
            }
            levels.push(PeakLevel {
                bin_size,
                bins: pairs,
            });
        }
        Ok(Self {
            frames,
            channels,
            levels,
        })
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], PeakError> {
        let end = self.offset.checked_add(len).ok_or(PeakError::Truncated)?;
        let slice = self
            .bytes
            .get(self.offset..end)
            .ok_or(PeakError::Truncated)?;
        self.offset = end;
        Ok(slice)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], PeakError> {
        let slice = self.take(N)?;
        let mut array = [0u8; N];
        array.copy_from_slice(slice);
        Ok(array)
    }

    fn u32(&mut self) -> Result<u32, PeakError> {
        Ok(u32::from_le_bytes(self.array()?))
    }

    fn u64(&mut self) -> Result<u64, PeakError> {
        Ok(u64::from_le_bytes(self.array()?))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn bins_are_min_max_over_all_channels() {
        let samples = [1.0, -1.0, 0.5, -0.5, 0.25, -0.25];
        let peaks = PeakPyramid::compute(&samples, 2);
        let level = peaks.level(256).unwrap();
        assert_eq!(level.bins.len(), 1);
        assert_eq!(level.bins[0], [-1.0, 1.0]);
    }

    #[test]
    fn short_final_bin_covers_the_tail() {
        let samples: Vec<f32> = (0..300).map(|i| i as f32).collect();
        let peaks = PeakPyramid::compute(&samples, 1);
        let level = peaks.level(256).unwrap();
        assert_eq!(level.bins.len(), 2);
        assert_eq!(level.bins[1], [256.0, 299.0]);
    }

    #[test]
    fn malformed_bytes_are_rejected() {
        assert_eq!(
            PeakPyramid::from_bytes(b"nope").unwrap_err(),
            PeakError::BadMagic
        );
        assert_eq!(
            PeakPyramid::from_bytes(b"BRGP\x02\x00\x00\x00").unwrap_err(),
            PeakError::UnsupportedVersion(2)
        );
        assert_eq!(
            PeakPyramid::from_bytes(b"BRGP\x01\x00\x00\x00").unwrap_err(),
            PeakError::Truncated
        );
    }

    #[test]
    fn empty_pcm_has_empty_levels() {
        let peaks = PeakPyramid::compute(&[], 2);
        assert_eq!(peaks.frames, 0);
        assert!(peaks.levels().iter().all(|level| level.bins.is_empty()));
    }
}
