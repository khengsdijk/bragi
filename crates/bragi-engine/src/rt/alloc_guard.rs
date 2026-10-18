//! The real-time allocator guard (`specs/03-audio-engine.md` §11).
//!
//! The engine's `process` paths raise a thread-local flag. A binary that opts in
//! with
//!
//! ```ignore
//! #[global_allocator]
//! static ALLOC: bragi_engine::rt::alloc_guard::TrackingAllocator<
//!     std::alloc::System,
//! > = bragi_engine::rt::alloc_guard::TrackingAllocator::new(std::alloc::System);
//! ```
//!
//! counts every allocation made while the flag is set. The counter is an
//! `AtomicU64`, so recording a violation itself allocates nothing.
//!
//! The guard is intentionally *not* a panic by default: panicking inside the
//! allocator can abort the process (the panic machinery may allocate) and would
//! hide the stack that caused it. Instead a test or a debug host calls
//! [`assert_clean`] after the run, and a debug host can turn on
//! [`set_panic_on_violation`] once it is known to be allocation-free.
//!
//! ```
//! use bragi_engine::rt::alloc_guard;
//! {
//!     let _guard = alloc_guard::guard();
//!     // No allocations here.
//! }
//! ```

use std::alloc::{GlobalAlloc, Layout};
use std::cell::Cell;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

thread_local! {
    /// Whether the current thread is inside a guarded section.
    static IN_GUARD: Cell<bool> = const { Cell::new(false) };
}

static VIOLATIONS: AtomicU64 = AtomicU64::new(0);
static PANIC_ON_VIOLATION: AtomicBool = AtomicBool::new(false);

/// Raises the guard for the lifetime of the value (RAII).
///
/// Nested guards are fine: the flag is restored to its previous value.
#[derive(Debug)]
pub struct Guard {
    previous: bool,
}

impl Guard {
    /// The number of allocations recorded since the process started.
    #[must_use]
    pub fn violations() -> u64 {
        VIOLATIONS.load(Ordering::Relaxed)
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        IN_GUARD.with(|flag| flag.set(self.previous));
    }
}

/// Raises the allocator guard on the current thread.
#[must_use]
pub fn guard() -> Guard {
    let previous = IN_GUARD.with(|flag| {
        let previous = flag.get();
        flag.set(true);
        previous
    });
    Guard { previous }
}

/// Whether the current thread is inside a guarded section. Allocation-free and
/// safe to call from anywhere, including the allocator itself.
#[must_use]
pub fn is_guarded() -> bool {
    IN_GUARD.try_with(Cell::get).unwrap_or(false)
}

/// Zeroes the violation counter (tests call this before a measured run).
pub fn reset_violations() {
    VIOLATIONS.store(0, Ordering::Relaxed);
}

/// Turns an allocation inside a guarded section into an abort.
///
/// Off by default; see the module docs.
pub fn set_panic_on_violation(enabled: bool) {
    PANIC_ON_VIOLATION.store(enabled, Ordering::Relaxed);
}

/// Panics when any guarded allocation was recorded since the last
/// [`reset_violations`]. Intended for tests and debug hosts.
///
/// # Panics
/// Panics with the number of allocation sites recorded.
pub fn assert_clean() {
    let violations = Guard::violations();
    assert_eq!(
        violations, 0,
        "{violations} allocation(s) happened on a guarded (audio-thread) path"
    );
}

/// A `GlobalAlloc` wrapper that counts allocations inside a guard.
///
/// It forwards every operation unchanged, so installing it does not change
/// behaviour apart from the counter. `realloc` and `alloc_zeroed` are counted
/// like `alloc`.
#[derive(Debug)]
pub struct TrackingAllocator<A> {
    inner: A,
}

impl<A> TrackingAllocator<A> {
    /// Wraps `inner`.
    pub const fn new(inner: A) -> Self {
        Self { inner }
    }

    fn record() {
        VIOLATIONS.fetch_add(1, Ordering::Relaxed);
        if PANIC_ON_VIOLATION.load(Ordering::Relaxed) {
            // A static message keeps this path allocation-free. This is opt-in
            // (see `set_panic_on_violation`) so a plain run reports at the end
            // instead of aborting inside the allocator.
            #[allow(clippy::panic)]
            {
                panic!("allocation on the audio thread (bragi_engine allocator guard)");
            }
        }
    }
}

// SAFETY: every method forwards to the wrapped `GlobalAlloc` with the same
// arguments and upholds its contract; the only added work is an atomic
// increment, which cannot unwind into the allocator's caller.
unsafe impl<A: GlobalAlloc> GlobalAlloc for TrackingAllocator<A> {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if is_guarded() {
            Self::record();
        }
        // SAFETY: the caller upholds `GlobalAlloc::alloc`'s contract; we forward
        // it unchanged.
        unsafe { self.inner.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: `ptr` came from this allocator with the same layout.
        unsafe { self.inner.dealloc(ptr, layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if is_guarded() {
            Self::record();
        }
        // SAFETY: as `alloc`.
        unsafe { self.inner.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if is_guarded() {
            Self::record();
        }
        // SAFETY: as `alloc`.
        unsafe { self.inner.realloc(ptr, layout, new_size) }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn guard_is_nestable_and_restored() {
        assert!(!is_guarded());
        {
            let _outer = guard();
            assert!(is_guarded());
            {
                let _inner = guard();
                assert!(is_guarded());
            }
            assert!(is_guarded());
        }
        assert!(!is_guarded());
    }

    #[test]
    fn violations_are_counted_only_inside_the_guard() {
        use std::alloc::System;
        reset_violations();
        let allocator = TrackingAllocator::new(System);
        let layout = Layout::new::<u64>();
        // Outside the guard nothing is counted.
        // SAFETY: the pointer comes from this allocator with this layout.
        let ptr = unsafe { allocator.alloc(layout) };
        assert_eq!(Guard::violations(), 0);
        // SAFETY: as above.
        unsafe { allocator.dealloc(ptr, layout) };
        {
            let _guard = guard();
            // SAFETY: the pointer comes from this allocator with this layout.
            let ptr = unsafe { allocator.alloc(layout) };
            // SAFETY: as above.
            unsafe { allocator.dealloc(ptr, layout) };
        }
        assert_eq!(Guard::violations(), 1);
        reset_violations();
    }
}
