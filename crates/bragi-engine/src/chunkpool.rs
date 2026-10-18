//! The browser's bounded PCM chunk pool (`specs/03-audio-engine.md` §3.1).
//!
//! Working assets are decoded in **2-second chunks** (96 000 frames at 48 kHz)
//! into a shared pool of pre-allocated slots (256 MB by default, LRU). The audio
//! thread only reads; the decoder worker inserts chunks and evicts the least
//! recently used one. A chunk that is not resident is silence, an underrun, and
//! a request pushed onto a lock-free ring that the worker drains.
//!
//! Every allocation happens in [`ChunkPool::new`] or in control-side
//! [`ChunkPool::insert_chunk`]; [`PcmSource::read`] allocates nothing.
//!
//! ```
//! use bragi_engine::chunkpool::ChunkPool;
//! # use bragi_model::generated::AssetHash;
//! # let hash = AssetHash::try_from(format!("sha256:{}", "0".repeat(64))).unwrap();
//! let mut pool = ChunkPool::new(4, 2);
//! pool.insert_chunk(&hash, 0, 2, 4, &[1.0; 8]);
//! let mut out = [0.0f32; 8];
//! assert!(bragi_engine::pcm::PcmSource::read(&pool, &hash, 0, 4, &mut out));
//! assert_eq!(out[0], 1.0);
//! ```

use std::collections::{HashMap, HashSet};
use std::mem::size_of;
use std::sync::atomic::{AtomicU64, Ordering};

use bragi_model::generated::AssetHash;

use crate::SAMPLE_RATE;
use crate::pcm::PcmSource;
use crate::rt::{SpscU64, pack_u32_pair, unpack_u32_pair};

/// Default chunk length in seconds (`specs/03-audio-engine.md` §3.1).
pub const DEFAULT_CHUNK_SECONDS: f32 = 2.0;
/// Default pool size in bytes.
pub const DEFAULT_CAPACITY_BYTES: usize = 256 * 1024 * 1024;

/// A request for one chunk, as packed into a ring word.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkRequest {
    /// The pool's internal asset number.
    pub asset: u32,
    /// The chunk index.
    pub chunk: u32,
}

/// One resident chunk.
#[derive(Debug)]
struct Slot {
    asset: Option<u32>,
    chunk: u32,
    data: Vec<f32>,
    last_used: AtomicU64,
}

impl Slot {
    fn is_free(&self) -> bool {
        self.asset.is_none()
    }
}

/// Per-asset bookkeeping.
#[derive(Debug)]
struct AssetEntry {
    id: u32,
    chunks: HashSet<u32>,
}

/// The bounded chunk pool.
#[derive(Debug)]
pub struct ChunkPool {
    chunk_frames: usize,
    slots: Vec<Slot>,
    assets: HashMap<AssetHash, AssetEntry>,
    /// `(asset id, chunk index) -> slot`, so a read is two hash lookups with no
    /// allocation and no scan.
    index: HashMap<(u32, u32), usize>,
    by_id: Vec<AssetHash>,
    clock: AtomicU64,
    requests: SpscU64,
    dropped_requests: AtomicU64,
}

impl ChunkPool {
    /// Creates a pool with `chunk_frames` frames per chunk and `capacity`
    /// resident chunks.
    #[must_use]
    pub fn new(chunk_frames: usize, capacity: usize) -> Self {
        let chunk_frames = chunk_frames.max(1);
        let capacity = capacity.max(1);
        let slots = (0..capacity)
            .map(|_| Slot {
                asset: None,
                chunk: 0,
                data: vec![0.0; chunk_frames * 2],
                last_used: AtomicU64::new(0),
            })
            .collect();
        Self {
            chunk_frames,
            slots,
            assets: HashMap::new(),
            index: HashMap::new(),
            by_id: Vec::new(),
            clock: AtomicU64::new(1),
            requests: SpscU64::new(1024),
            dropped_requests: AtomicU64::new(0),
        }
    }

    /// Creates a pool with the spec's defaults: 2 s chunks, 256 MB.
    #[must_use]
    pub fn with_defaults() -> Self {
        let chunk_frames = (DEFAULT_CHUNK_SECONDS * SAMPLE_RATE as f32) as usize;
        let chunk_bytes = chunk_frames * 2 * size_of::<f32>();
        Self::new(chunk_frames, (DEFAULT_CAPACITY_BYTES / chunk_bytes).max(1))
    }

    /// Frames per chunk.
    #[must_use]
    pub fn chunk_frames(&self) -> usize {
        self.chunk_frames
    }

    /// How many chunks fit in the pool.
    #[must_use]
    pub fn capacity_chunks(&self) -> usize {
        self.slots.len()
    }

    /// How many chunks are resident.
    #[must_use]
    pub fn resident_chunks(&self) -> usize {
        self.slots.iter().filter(|slot| !slot.is_free()).count()
    }

    /// How many manifest requests could not be queued because the ring was
    /// full.
    #[must_use]
    pub fn dropped_requests(&self) -> u64 {
        self.dropped_requests.load(Ordering::Relaxed)
    }

    /// The next chunk request for the decoder worker.
    pub fn next_request(&self) -> Option<ChunkRequest> {
        let word = self.requests.pop()?;
        let (asset, chunk) = unpack_u32_pair(word);
        Some(ChunkRequest { asset, chunk })
    }

    /// The asset hash for a request's internal id.
    #[must_use]
    pub fn asset_for_id(&self, id: u32) -> Option<&AssetHash> {
        self.by_id.get(id as usize)
    }

    /// Queues manifest requests for every chunk overlapping `[start, start +
    /// frames)`. Called by the host on the control thread (or, for the one
    /// chunk the playhead needs, by the audio thread).
    pub fn request_range(&self, asset: &AssetHash, start: u64, frames: u64) {
        let Some(entry) = self.assets.get(asset) else {
            return;
        };
        if frames == 0 {
            return;
        }
        let first = (start / self.chunk_frames as u64) as u32;
        let last = ((start + frames - 1) / self.chunk_frames as u64) as u32;
        for chunk in first..=last {
            if !entry.chunks.contains(&chunk) && !self.requests.push(pack_u32_pair(entry.id, chunk))
            {
                self.dropped_requests.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// Inserts one decoded chunk. `samples` is interleaved at `channels`; it is
    /// converted to stereo here. Extra frames are zeroed, so a short final chunk
    /// reads as silence past its end. Control-side only.
    pub fn insert_chunk(
        &mut self,
        asset: &AssetHash,
        chunk: u32,
        channels: u16,
        frames: usize,
        samples: &[f32],
    ) {
        let chunk_frames = self.chunk_frames;
        let entry_id = if let Some(entry) = self.assets.get(asset) {
            entry.id
        } else {
            let id = u32::try_from(self.by_id.len()).unwrap_or(u32::MAX);
            self.by_id.push(asset.clone());
            self.assets.insert(
                asset.clone(),
                AssetEntry {
                    id,
                    chunks: HashSet::new(),
                },
            );
            id
        };

        let existing = self.index.get(&(entry_id, chunk)).copied();
        let slot_index = match existing {
            Some(index) => index,
            None => {
                let index = self.find_free_or_lru();
                // Evict the previous tenant.
                if let Some(old_asset) = self.slots[index].asset {
                    let old_chunk = self.slots[index].chunk;
                    self.index.remove(&(old_asset, old_chunk));
                    if let Some(old_hash) = self.by_id.get(old_asset as usize)
                        && let Some(entry) = self.assets.get_mut(old_hash)
                    {
                        entry.chunks.remove(&old_chunk);
                    }
                }
                self.slots[index].asset = Some(entry_id);
                self.slots[index].chunk = chunk;
                if let Some(entry) = self.assets.get_mut(asset) {
                    entry.chunks.insert(chunk);
                }
                self.index.insert((entry_id, chunk), index);
                index
            }
        };

        let slot = &mut self.slots[slot_index];
        let channels = channels.max(1) as usize;
        let count = frames.min(chunk_frames).min(samples.len() / channels);
        for frame in 0..count {
            let base = frame * channels;
            let (left, right) = if channels == 1 {
                (samples[base], samples[base])
            } else {
                (samples[base], samples[base + 1])
            };
            slot.data[frame * 2] = left;
            slot.data[frame * 2 + 1] = right;
        }
        for frame in count..chunk_frames {
            slot.data[frame * 2] = 0.0;
            slot.data[frame * 2 + 1] = 0.0;
        }
        slot.last_used.store(
            self.clock.fetch_add(1, Ordering::Relaxed),
            Ordering::Relaxed,
        );
    }

    /// Drops every chunk of an asset (the asset was removed from the project).
    pub fn remove_asset(&mut self, asset: &AssetHash) {
        if let Some(entry) = self.assets.remove(asset) {
            for chunk in &entry.chunks {
                if let Some(index) = self.index.remove(&(entry.id, *chunk)) {
                    self.slots[index].asset = None;
                }
            }
        }
    }

    /// Drops everything.
    pub fn clear(&mut self) {
        for slot in &mut self.slots {
            slot.asset = None;
        }
        self.assets.clear();
        self.index.clear();
        self.by_id.clear();
    }

    fn find_free_or_lru(&self) -> usize {
        if let Some(index) = self.slots.iter().position(Slot::is_free) {
            return index;
        }
        let mut oldest = 0usize;
        let mut oldest_time = u64::MAX;
        for (index, slot) in self.slots.iter().enumerate() {
            let time = slot.last_used.load(Ordering::Relaxed);
            if time < oldest_time {
                oldest_time = time;
                oldest = index;
            }
        }
        oldest
    }

    fn touch(&self, slot: usize) {
        let now = self.clock.fetch_add(1, Ordering::Relaxed);
        self.slots[slot].last_used.store(now, Ordering::Relaxed);
    }

    fn read_chunk(
        &self,
        entry_id: u32,
        chunk: u32,
        offset: usize,
        frames: usize,
        out: &mut [f32],
    ) -> bool {
        let Some(index) = self.index.get(&(entry_id, chunk)).copied() else {
            return false;
        };
        let slot = &self.slots[index];
        self.touch(index);
        let end = (offset + frames).min(self.chunk_frames);
        let count = end.saturating_sub(offset);
        out[..count * 2].copy_from_slice(&slot.data[offset * 2..end * 2]);
        for sample in out[count * 2..].iter_mut() {
            *sample = 0.0;
        }
        true
    }
}

impl PcmSource for ChunkPool {
    fn read(&self, asset: &AssetHash, start: u64, frames: usize, out: &mut [f32]) -> bool {
        let Some(entry) = self.assets.get(asset) else {
            for sample in out[..frames * 2].iter_mut() {
                *sample = 0.0;
            }
            return false;
        };
        let entry_id = entry.id;
        let mut ok = true;
        let mut done = 0usize;
        while done < frames {
            let position = start + done as u64;
            let chunk = (position / self.chunk_frames as u64) as u32;
            let offset = (position % self.chunk_frames as u64) as usize;
            let take = (frames - done).min(self.chunk_frames - offset);
            if !self.read_chunk(entry_id, chunk, offset, take, &mut out[done * 2..]) {
                for sample in out[done * 2..(done + take) * 2].iter_mut() {
                    *sample = 0.0;
                }
                ok = false;
                if !self.requests.push(pack_u32_pair(entry_id, chunk)) {
                    self.dropped_requests.fetch_add(1, Ordering::Relaxed);
                }
            }
            done += take;
        }
        ok
    }

    fn available_frames(&self, _asset: &AssetHash) -> Option<u64> {
        None
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn hash(byte: char) -> AssetHash {
        AssetHash::try_from(format!("sha256:{}", byte.to_string().repeat(64))).unwrap()
    }

    #[test]
    fn chunks_read_across_boundaries() {
        let mut pool = ChunkPool::new(4, 4);
        pool.insert_chunk(
            &hash('0'),
            0,
            2,
            4,
            &[1.0, -1.0, 2.0, -2.0, 3.0, -3.0, 4.0, -4.0],
        );
        pool.insert_chunk(
            &hash('0'),
            1,
            2,
            4,
            &[5.0, -5.0, 6.0, -6.0, 7.0, -7.0, 8.0, -8.0],
        );
        let mut out = [0.0f32; 8];
        assert!(pool.read(&hash('0'), 2, 4, &mut out));
        assert_eq!(out, [3.0, -3.0, 4.0, -4.0, 5.0, -5.0, 6.0, -6.0]);
    }

    #[test]
    fn missing_chunk_is_silence_and_queues_a_request() {
        let mut pool = ChunkPool::new(4, 4);
        pool.insert_chunk(&hash('1'), 0, 1, 4, &[1.0; 4]);
        let mut out = [9.0f32; 8];
        assert!(!pool.read(&hash('1'), 4, 4, &mut out));
        assert_eq!(out, [0.0; 8]);
        let request = pool.next_request().unwrap();
        assert_eq!(request.chunk, 1);
    }

    #[test]
    fn lru_evicts_the_oldest_chunk() {
        let mut pool = ChunkPool::new(4, 2);
        pool.insert_chunk(&hash('2'), 0, 1, 4, &[1.0; 4]);
        pool.insert_chunk(&hash('2'), 1, 1, 4, &[2.0; 4]);
        // Touch chunk 0 so chunk 1 becomes the oldest.
        let mut out = [0.0f32; 8];
        assert!(pool.read(&hash('2'), 0, 4, &mut out));
        pool.insert_chunk(&hash('2'), 2, 1, 4, &[3.0; 4]);
        assert_eq!(pool.resident_chunks(), 2);
        assert!(pool.read(&hash('2'), 0, 4, &mut out));
        assert!(!pool.read(&hash('2'), 4, 4, &mut out));
        assert!(pool.read(&hash('2'), 8, 4, &mut out));
    }

    #[test]
    fn mono_chunks_are_duplicated() {
        let mut pool = ChunkPool::new(4, 1);
        pool.insert_chunk(&hash('3'), 0, 1, 2, &[0.5, 0.25]);
        let mut out = [0.0f32; 4];
        assert!(pool.read(&hash('3'), 0, 2, &mut out));
        assert_eq!(out, [0.5, 0.5, 0.25, 0.25]);
    }

    #[test]
    fn prefetch_queues_only_missing_chunks() {
        let mut pool = ChunkPool::new(4, 8);
        pool.insert_chunk(&hash('4'), 0, 1, 4, &[0.0; 4]);
        pool.request_range(&hash('4'), 0, 12);
        assert_eq!(pool.next_request().unwrap().chunk, 1);
        assert_eq!(pool.next_request().unwrap().chunk, 2);
        assert_eq!(pool.next_request(), None);
    }
}
