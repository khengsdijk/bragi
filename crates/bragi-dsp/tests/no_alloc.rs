//! Proves the audio-thread contract of [13 §1] / [03 §11]: after construction, nothing in the
//! `Stretcher` hot path allocates. A counting global allocator stands in for `assert_no_alloc`
//! (which would be a new dependency); the whole test binary has exactly one test so no other
//! test can allocate on another thread while the counter is live.
//!
//! [13 §1]: ../../../specs/13-agent-guide.md
//! [03 §11]: ../../../specs/03-audio-engine.md
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use bragi_dsp::stretch::{PhaseVocoder, Quality, Stretcher};

/// Bumped on every allocation the process makes.
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);

struct CountingAllocator;

// SAFETY: `CountingAllocator` only forwards to the system allocator after counting; it never
// returns memory it did not obtain from `System`.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        // SAFETY: `layout` comes from the caller of the global allocator, as required.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: `ptr`/`layout` come from a matching `alloc` on this allocator.
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        // SAFETY: as `alloc` above.
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        // SAFETY: `ptr`/`layout` come from a matching `alloc`; `new_size` is the caller's request.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

#[test]
fn no_allocation_after_construction() {
    let sr = 48_000u32;
    let mut st = PhaseVocoder::new(2, sr).unwrap();

    // Warm up: the first `configure`/`process` may touch lazily-initialised state, and the
    // caller's own buffers are allocated here, outside the measured region.
    st.configure(1.12, 0.0, Quality::Preview).unwrap();
    let mut input: Vec<Vec<f32>> = vec![vec![0.0f32; 4096]; 2];
    for (c, ch) in input.iter_mut().enumerate() {
        for (i, s) in ch.iter_mut().enumerate() {
            *s = 0.25 * (((i + c * 7) % 64) as f32 / 64.0 - 0.5);
        }
    }
    let mut out: Vec<Vec<f32>> = vec![vec![0.0f32; 512]; 2];
    let need = st.input_required(out[0].len());
    let ins: [&[f32]; 2] = [
        &input[0][..need.min(input[0].len())],
        &input[1][..need.min(input[1].len())],
    ];
    let (o0, o1) = out.split_at_mut(1);
    let mut outs: [&mut [f32]; 2] = [&mut o0[0], &mut o1[0]];
    st.process(&ins, &mut outs);

    ALLOCATIONS.store(0, Ordering::Relaxed);

    for quality in [Quality::Preview, Quality::Render] {
        for (ratio, semis) in [
            (1.12, 0.0),
            (0.88, 0.0),
            (1.0, 7.0),
            (0.75, -5.0),
            (1.5, 3.0),
        ] {
            st.reset();
            st.configure(ratio, semis, quality).unwrap();
            for block in [1usize, 128, 256, 1024, 4096] {
                let n = block.min(out[0].len());
                let need = st.input_required(n);
                let take = need.min(input[0].len());
                let ins: [&[f32]; 2] = [&input[0][..take], &input[1][..take]];
                let (o0, o1) = out.split_at_mut(1);
                let mut outs: [&mut [f32]; 2] = [&mut o0[0][..n], &mut o1[0][..n]];
                st.process(&ins, &mut outs);
                let _ = st.latency();
                let _ = st.look_ahead();
                let _ = st.ratio();
            }
        }
    }

    let allocations = ALLOCATIONS.load(Ordering::Relaxed);
    assert_eq!(
        allocations, 0,
        "the stretcher allocated {allocations} times off the constructor"
    );
}
