//! The desktop PCM cache: decoded f32 written once and memory-mapped
//! (`specs/03-audio-engine.md` §3.2).
//!
//! Working assets are 48 kHz, so the cache is raw interleaved f32 with no
//! header — `<appCache>/pcm/<assetHash hex>.f32` — exactly what the spec
//! describes. The channel count comes from `AssetMeta`, which the host already
//! has (`crates/bragi-model`), so the file stays a pure sample dump.
//!
//! There is no chunk pool on desktop: pages are faulted in on demand and the OS
//! page cache does the eviction. Reads are audio-thread safe (no allocation, no
//! I/O beyond touching mapped pages).

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use bragi_engine::pcm::PcmSource;
use bragi_model::generated::AssetHash;
use memmap2::Mmap;
use std::sync::Arc;

/// One memory-mapped asset.
#[derive(Clone, Debug)]
pub struct MmapAsset {
    map: Arc<Mmap>,
    channels: u16,
    frames: u64,
}

impl MmapAsset {
    /// Frames in the asset.
    #[must_use]
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Channels in the file.
    #[must_use]
    pub fn channels(&self) -> u16 {
        self.channels
    }

    fn frame(&self, index: usize) -> (f32, f32) {
        let channels = self.channels.max(1) as usize;
        let base = index * channels * 4;
        let bytes = self.map.as_ref();
        let read = |offset: usize| -> f32 {
            match bytes.get(offset..offset + 4) {
                Some(slice) => f32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]),
                None => 0.0,
            }
        };
        let left = read(base);
        if channels == 1 {
            (left, left)
        } else {
            (left, read(base + 4))
        }
    }
}

/// The directory holding the raw f32 files.
#[derive(Clone, Debug)]
pub struct PcmCache {
    dir: PathBuf,
}

impl PcmCache {
    /// Opens (creating if needed) the cache directory.
    ///
    /// # Errors
    /// Propagates the directory creation error.
    pub fn new(dir: impl AsRef<Path>) -> io::Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    /// The cache directory.
    #[must_use]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The file name for an asset hash: the hex part plus `.f32`.
    #[must_use]
    pub fn file_name(hash: &AssetHash) -> String {
        let hex = hash
            .strip_prefix("sha256:")
            .unwrap_or_else(|| hash.as_str());
        format!("{hex}.f32")
    }

    /// The full path for an asset.
    #[must_use]
    pub fn path(&self, hash: &AssetHash) -> PathBuf {
        self.dir.join(Self::file_name(hash))
    }

    /// Whether the asset is already cached.
    #[must_use]
    pub fn has(&self, hash: &AssetHash) -> bool {
        self.path(hash).is_file()
    }

    /// Writes `samples` (interleaved, 48 kHz) atomically if the file is absent.
    ///
    /// # Errors
    /// Propagates write or rename errors.
    pub fn ensure(&self, hash: &AssetHash, samples: &[f32]) -> io::Result<PathBuf> {
        let path = self.path(hash);
        if path.is_file() {
            return Ok(path);
        }
        let temp = path.with_extension("f32.tmp");
        {
            let mut file = fs::File::create(&temp)?;
            let mut buffer = Vec::with_capacity(64 * 1024);
            for sample in samples {
                buffer.extend_from_slice(&sample.to_le_bytes());
                if buffer.len() >= 64 * 1024 {
                    file.write_all(&buffer)?;
                    buffer.clear();
                }
            }
            file.write_all(&buffer)?;
            file.sync_all()?;
        }
        fs::rename(&temp, &path)?;
        Ok(path)
    }

    /// Memory-maps a cached asset.
    ///
    /// # Errors
    /// Propagates open/map errors.
    pub fn open(&self, hash: &AssetHash, channels: u16) -> io::Result<MmapAsset> {
        let path = self.path(hash);
        let file = fs::File::open(&path)?;
        // SAFETY: the file is written atomically under a content-addressed name
        // and never mutated afterwards, so the mapping cannot change underneath
        // us.
        let map = unsafe { Mmap::map(&file)? };
        let frame_bytes = channels.max(1) as u64 * 4;
        let frames = map.len() as u64 / frame_bytes.max(1);
        Ok(MmapAsset {
            map: Arc::new(map),
            channels: channels.max(1),
            frames,
        })
    }
}

/// All memory-mapped assets the engine can read.
///
/// Cheap to clone: each asset holds an `Arc<Mmap>`, so the playback thread can
/// own a snapshot while the control side keeps adding assets.
#[derive(Clone, Debug, Default)]
pub struct MmapPcmCache {
    assets: HashMap<AssetHash, MmapAsset>,
}

impl MmapPcmCache {
    /// An empty cache.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds an asset from a decoded buffer, writing the file if needed, and
    /// memory-maps it.
    ///
    /// # Errors
    /// Propagates cache write/map errors.
    pub fn insert_decoded(
        &mut self,
        cache: &PcmCache,
        hash: &AssetHash,
        channels: u16,
        sample_rate: u32,
        samples: &[f32],
    ) -> io::Result<()> {
        let _ = sample_rate;
        cache.ensure(hash, samples)?;
        let asset = cache.open(hash, channels)?;
        self.assets.insert(hash.clone(), asset);
        Ok(())
    }

    /// Memory-maps an already-cached asset.
    ///
    /// # Errors
    /// Propagates map errors.
    pub fn load(&mut self, cache: &PcmCache, hash: &AssetHash, channels: u16) -> io::Result<()> {
        let asset = cache.open(hash, channels)?;
        self.assets.insert(hash.clone(), asset);
        Ok(())
    }

    /// How many assets are mapped.
    #[must_use]
    pub fn len(&self) -> usize {
        self.assets.len()
    }

    /// Whether no assets are mapped.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.assets.is_empty()
    }
}

impl PcmSource for MmapPcmCache {
    fn read(&self, asset: &AssetHash, start: u64, frames: usize, out: &mut [f32]) -> bool {
        let Some(mapped) = self.assets.get(asset) else {
            for sample in out.iter_mut() {
                *sample = 0.0;
            }
            return false;
        };
        let count = frames.min(out.len() / 2);
        for frame in 0..count {
            let (left, right) = mapped.frame(start as usize + frame);
            out[frame * 2] = left;
            out[frame * 2 + 1] = right;
        }
        for sample in out[count * 2..].iter_mut() {
            *sample = 0.0;
        }
        true
    }

    fn available_frames(&self, asset: &AssetHash) -> Option<u64> {
        self.assets.get(asset).map(MmapAsset::frames)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn hash(byte: char) -> AssetHash {
        AssetHash::try_from(format!("sha256:{}", byte.to_string().repeat(64))).unwrap()
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bragi-pcm-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn write_map_and_read_stereo() {
        let dir = temp_dir("stereo");
        let cache = PcmCache::new(&dir).unwrap();
        let mut mmap = MmapPcmCache::new();
        let samples: Vec<f32> = (0..16).map(|value| value as f32 * 0.1).collect();
        mmap.insert_decoded(&cache, &hash('0'), 2, 48_000, &samples)
            .unwrap();
        let mut out = [0.0f32; 8];
        assert!(PcmSource::read(&mmap, &hash('0'), 2, 4, &mut out));
        assert_eq!(out[0], 0.4);
        assert_eq!(out[1], 0.5);
        assert_eq!(out[6], 1.0);
        assert_eq!(out[7], 1.1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mono_is_duplicated_and_missing_is_false() {
        let dir = temp_dir("mono");
        let cache = PcmCache::new(&dir).unwrap();
        let mut mmap = MmapPcmCache::new();
        mmap.insert_decoded(&cache, &hash('1'), 1, 48_000, &[0.25, 0.5])
            .unwrap();
        let mut out = [0.0f32; 4];
        assert!(PcmSource::read(&mmap, &hash('1'), 0, 2, &mut out));
        assert_eq!(out, [0.25, 0.25, 0.5, 0.5]);
        assert!(!PcmSource::read(&mmap, &hash('2'), 0, 2, &mut out));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_name_strips_the_scheme() {
        assert_eq!(
            PcmCache::file_name(&hash('a')),
            format!("{}.f32", "a".repeat(64))
        );
    }
}
