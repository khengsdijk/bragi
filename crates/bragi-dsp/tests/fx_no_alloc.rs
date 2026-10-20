//! The audio-thread contract for the FX catalogue (13 §1, 03 §11): after `create`, nothing in
//! `set_param`, `process` or `reset` allocates — for every kind `create` can build. One test per
//! binary, so no other test allocates on another thread while the counter is live.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use bragi_dsp::fx::{FxContext, FxKind, create};

static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);

struct CountingAllocator;

// SAFETY: forwards to the system allocator after counting; never returns foreign memory.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        // SAFETY: `layout` comes from the caller of the global allocator.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: `ptr`/`layout` come from a matching `alloc` on this allocator.
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        // SAFETY: as `alloc`.
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        // SAFETY: `ptr`/`layout` come from a matching `alloc`.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

#[test]
fn no_allocation_after_create() {
    let block = 512usize;
    let mut effects: Vec<_> = FxKind::ALL
        .into_iter()
        .filter_map(|kind| create(kind, 48_000, block).ok())
        .collect();
    assert!(!effects.is_empty());
    let mut left = vec![0.0f32; block];
    let mut right = vec![0.0f32; block];
    let key_l = vec![0.3f32; block];
    let key_r = vec![-0.3f32; block];
    let ctx = FxContext {
        bpm: 128.0,
        sidechain: Some((&key_l, &key_r)),
    };

    ALLOCATIONS.store(0, Ordering::Relaxed);

    for fx in &mut effects {
        let kind = fx.kind();
        for round in 0..4 {
            for (index, spec) in kind.params().iter().enumerate() {
                let value = if round % 2 == 0 { spec.max } else { spec.min };
                fx.set_param(index, value);
            }
            for frames in [1usize, 64, 128, 512] {
                for (i, (l, r)) in left.iter_mut().zip(&mut right).enumerate() {
                    *l = 0.5 * ((i * 7 % 64) as f32 / 64.0 - 0.5);
                    *r = -*l;
                }
                fx.process(&mut left[..frames], &mut right[..frames], &ctx);
                fx.process(
                    &mut left[..frames],
                    &mut right[..frames],
                    &FxContext::default(),
                );
            }
            fx.reset();
            let _ = fx.latency();
            let _ = fx.tail();
        }
    }

    let allocations = ALLOCATIONS.load(Ordering::Relaxed);
    assert_eq!(
        allocations, 0,
        "fx allocated {allocations} times after create"
    );
}
