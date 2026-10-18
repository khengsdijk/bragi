//! Lock-free glue shared by both hosts: a single-producer/single-consumer ring,
//! the fixed-layout state block, and the real-time allocator guard.
//!
//! Nothing here depends on a platform. The ring carries `u64` words so it can
//! stay safe Rust (no `UnsafeCell`): hosts pack commands, chunk requests and
//! plan pointers into `u64`s. The state block is an array of `AtomicU32`; the
//! audio thread stores, the UI loads with `Relaxed`/`Acquire` as noted.
//!
//! ## Allocation guard
//!
//! `specs/03-audio-engine.md` §11 asks for a custom allocator in debug builds
//! that catches audio-thread allocation. [`alloc_guard::TrackingAllocator`]
//! wraps the system allocator; [`alloc_guard::guard`] raises a thread-local
//! flag, and every allocation while it is set is counted (and, with
//! [`alloc_guard::set_panic_on_violation`], aborts the process). The engine's
//! `process` paths raise the flag, and `crates/bragi-engine/tests/no_alloc.rs`
//! installs the allocator for the test binary. The release build pays one
//! thread-local read per allocation and no counter.
//!
//! ```
//! use bragi_engine::rt::SpscU64;
//! let ring = SpscU64::new(4);
//! assert!(ring.push(1));
//! assert!(ring.push(2));
//! assert_eq!(ring.pop(), Some(1));
//! assert_eq!(ring.pop(), Some(2));
//! assert_eq!(ring.pop(), None);
//! ```

pub mod alloc_guard;

use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};

/// A bounded single-producer/single-consumer ring of `u64` values.
///
/// `push` is called from one thread (the producer) and `pop` from another (the
/// consumer); each is lock-free and allocation-free. The capacity is rounded up
/// to a power of two. A full ring drops the new value (`push` returns `false`).
#[derive(Debug)]
pub struct SpscU64 {
    slots: Vec<AtomicU64>,
    mask: usize,
    head: AtomicUsize,
    tail: AtomicUsize,
}

impl SpscU64 {
    /// Creates a ring with at least `capacity` slots.
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(2).next_power_of_two();
        let slots = (0..capacity).map(|_| AtomicU64::new(0)).collect();
        Self {
            slots,
            mask: capacity - 1,
            head: AtomicUsize::new(0),
            tail: AtomicUsize::new(0),
        }
    }

    /// The usable capacity (power of two).
    #[must_use]
    pub fn capacity(&self) -> usize {
        self.mask + 1
    }

    /// Pushes one value. Returns `false` when the ring is full.
    pub fn push(&self, value: u64) -> bool {
        let head = self.head.load(Ordering::Relaxed);
        let tail = self.tail.load(Ordering::Acquire);
        if head.wrapping_sub(tail) >= self.capacity() {
            return false;
        }
        self.slots[head & self.mask].store(value, Ordering::Relaxed);
        self.head.store(head.wrapping_add(1), Ordering::Release);
        true
    }

    /// Pops one value, or `None` when empty.
    pub fn pop(&self) -> Option<u64> {
        let tail = self.tail.load(Ordering::Relaxed);
        let head = self.head.load(Ordering::Acquire);
        if tail == head {
            return None;
        }
        let value = self.slots[tail & self.mask].load(Ordering::Relaxed);
        self.tail.store(tail.wrapping_add(1), Ordering::Release);
        Some(value)
    }

    /// Whether the ring is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.head.load(Ordering::Acquire) == self.tail.load(Ordering::Acquire)
    }

    /// How many values are queued.
    #[must_use]
    pub fn len(&self) -> usize {
        self.head
            .load(Ordering::Acquire)
            .wrapping_sub(self.tail.load(Ordering::Acquire))
    }
}

/// Packs two `u32`s into one ring word.
#[must_use]
pub fn pack_u32_pair(a: u32, b: u32) -> u64 {
    (u64::from(a) << 32) | u64::from(b)
}

/// Unpacks a ring word written by [`pack_u32_pair`].
#[must_use]
pub fn unpack_u32_pair(word: u64) -> (u32, u32) {
    ((word >> 32) as u32, word as u32)
}

/// The fixed-layout state block the audio thread publishes
/// (`specs/03-audio-engine.md` §3.1).
///
/// Layout (word indices):
///
/// | Word | Value |
/// |---|---|
/// | 0 | transport state (`0` stopped, `1` playing, `2` paused, `3` looping, `4` scrubbing) |
/// | 1 | auditioning (`0`/`1`) |
/// | 2..4 | playhead (low, high) |
/// | 4..6 | underruns (low, high) |
/// | 6..8 | plan version (low, high) |
/// | 8.. | meters, `[peak, rms]` per track then master |
///
/// Stored with `Relaxed` ordering: the values are independent snapshots, not a
/// transactional record, which is what a 60 Hz meter read needs.
#[derive(Debug)]
pub struct StateBlock {
    words: Vec<AtomicU32>,
}

/// The fixed words before the meters start.
pub const STATE_HEADER_WORDS: usize = 8;

impl StateBlock {
    /// Creates a block for `tracks` tracks plus `extra` reserved words.
    #[must_use]
    pub fn new(tracks: usize, extra: usize) -> Self {
        let words = STATE_HEADER_WORDS + tracks * 2 + 2 + extra;
        Self {
            words: (0..words).map(|_| AtomicU32::new(0)).collect(),
        }
    }

    /// The number of words.
    #[must_use]
    pub fn word_count(&self) -> usize {
        self.words.len()
    }

    /// Stores the transport state.
    pub fn set_transport(&self, state: u32, auditioning: bool, playhead: u64) {
        self.words[0].store(state, Ordering::Relaxed);
        self.words[1].store(u32::from(auditioning), Ordering::Relaxed);
        self.words[2].store(playhead as u32, Ordering::Relaxed);
        self.words[3].store((playhead >> 32) as u32, Ordering::Relaxed);
    }

    /// Stores the underrun counter and plan version.
    pub fn set_counters(&self, underruns: u64, plan_version: u64) {
        self.words[4].store(underruns as u32, Ordering::Relaxed);
        self.words[5].store((underruns >> 32) as u32, Ordering::Relaxed);
        self.words[6].store(plan_version as u32, Ordering::Relaxed);
        self.words[7].store((plan_version >> 32) as u32, Ordering::Relaxed);
    }

    /// Copies the meter words (the layout of
    /// [`Meters::write_words`](crate::meters::Meters::write_words)).
    pub fn set_meters(&self, words: &[u32]) -> usize {
        let space = self.words.len().saturating_sub(STATE_HEADER_WORDS);
        let count = words.len().min(space);
        for (index, value) in words.iter().take(count).enumerate() {
            self.words[STATE_HEADER_WORDS + index].store(*value, Ordering::Relaxed);
        }
        count
    }

    /// Copies the whole block into `out` (no allocation); returns the word
    /// count, or `0` when `out` is too small.
    pub fn snapshot(&self, out: &mut [u32]) -> usize {
        if out.len() < self.words.len() {
            return 0;
        }
        for (index, word) in self.words.iter().enumerate() {
            out[index] = word.load(Ordering::Relaxed);
        }
        self.words.len()
    }

    /// Reads the transport state back as `(state, auditioning, playhead)`.
    #[must_use]
    pub fn transport(&self) -> (u32, bool, u64) {
        let state = self.words[0].load(Ordering::Relaxed);
        let auditioning = self.words[1].load(Ordering::Relaxed) != 0;
        let playhead = u64::from(self.words[2].load(Ordering::Relaxed))
            | (u64::from(self.words[3].load(Ordering::Relaxed)) << 32);
        (state, auditioning, playhead)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn ring_round_trips_in_order_and_reports_full() {
        let ring = SpscU64::new(3);
        assert!(ring.capacity() >= 3);
        assert!(ring.push(7));
        assert!(ring.push(8));
        assert_eq!(ring.pop(), Some(7));
        assert!(ring.push(9));
        assert_eq!(ring.len(), 2);
        assert_eq!(ring.pop(), Some(8));
        assert_eq!(ring.pop(), Some(9));
        assert!(ring.is_empty());
    }

    #[test]
    fn full_ring_drops_the_new_value() {
        let ring = SpscU64::new(2);
        let capacity = ring.capacity();
        for value in 0..capacity {
            assert!(ring.push(value as u64));
        }
        assert!(!ring.push(999));
        assert_eq!(ring.len(), capacity);
    }

    #[test]
    fn ring_is_usable_across_threads() {
        let ring = std::sync::Arc::new(SpscU64::new(64));
        let producer = {
            let ring = ring.clone();
            std::thread::spawn(move || {
                for value in 0..1_000u64 {
                    while !ring.push(value) {
                        std::hint::spin_loop();
                    }
                }
            })
        };
        let mut seen = 0;
        while seen < 1_000 {
            if let Some(value) = ring.pop() {
                assert_eq!(value, seen);
                seen += 1;
            }
        }
        producer.join().unwrap();
    }

    #[test]
    fn pair_packing_round_trips() {
        assert_eq!(unpack_u32_pair(pack_u32_pair(7, 9)), (7, 9));
    }

    #[test]
    fn state_block_round_trips() {
        let block = StateBlock::new(2, 0);
        block.set_transport(3, true, 0x1_0000_0002);
        block.set_counters(5, 9);
        block.set_meters(&[1, 2, 3, 4, 5, 6]);
        assert_eq!(block.transport(), (3, true, 0x1_0000_0002));
        let mut words = vec![0u32; block.word_count()];
        assert_eq!(block.snapshot(&mut words), block.word_count());
        assert_eq!(words[STATE_HEADER_WORDS], 1);
        assert_eq!(words[STATE_HEADER_WORDS + 5], 6);
    }
}
