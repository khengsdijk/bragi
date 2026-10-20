//! Shared helpers for the `bragi-dsp` integration tests. The stretch lab
//! (`crates/bragi-dsp/stretch-lab`) includes the same files by path, so the lab's numbers and
//! the tests' assertions come from one implementation of each measure.
#![allow(dead_code, unreachable_pub)]

pub mod fx;
pub mod metrics;
pub mod signals;
pub mod wav;

use std::path::PathBuf;

/// `fixtures/audio/<name>` in the repository.
pub fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/audio")
        .join(name)
}
