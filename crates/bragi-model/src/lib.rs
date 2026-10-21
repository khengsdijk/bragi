//! The Bragi song model: document types, op application, validation, diff and
//! time mapping.
//!
//! This crate is the **only** thing that changes a song document
//! (`specs/02-song-model.md`, `specs/13-agent-guide.md` §1). TypeScript and
//! Python never mutate a document; they build op batches and hand them here,
//! through the `wasm-bindgen` wrapper in `packages/model-wasm`.
//!
//! The crate must compile for `wasm32-unknown-unknown`.
//!
//! # Layout
//!
//! - [`generated`] — the types WP-0.2 generated from the JSON Schemas. Never edited by hand.
//! - [`time`] — ticks ⇄ seconds ⇄ bar/beat.
//! - [`assets`] — the `AssetMeta` index the invariants need.
//! - [`clipmath`] — clip end ticks and the sample ⇄ tick mapping.
//! - [`spans`], [`region`] — derived arrangement geometry.
//! - [`commits`] — the commit documents an op may read (for `region.adopt`).
//! - [`validate`], [`apply`] — the invariants and the op interpreter.
//! - [`canonical`] — stable bytes and the commit hash.
//! - [`diff`] — the delta handed to the audio engine.
#![forbid(unsafe_code)]

mod analysis;
pub mod apply;
pub mod assets;
pub mod canonical;
pub mod clipmath;
pub mod commits;
pub mod diff;
pub mod error;
pub mod generated;
mod ids;
mod patch;
pub mod region;
pub mod spans;
pub mod time;
pub mod validate;

pub use apply::{apply, apply_with};
pub use assets::AssetIndex;
pub use canonical::{base32, canonical_json, canonical_value, commit_id, derived_id, sha256};
pub use clipmath::{clip_end_local, local_at_src_sample, src_sample_at_local};
pub use commits::{CommitDocs, NoCommits};
pub use diff::{EngineDelta, diff};
pub use error::{ApplyError, ValidationCode, ValidationError};
pub use region::{RegionSlice, ResolvedRegion, resolve_region};
pub use spans::{SectionSpan, section_spans};
pub use time::{
    ContextEdge, MAX_BPM, MIN_BPM, TempoCtx, bar_aligned_context_range, bar_beat_to_ticks,
    seconds_to_ticks, ticks_to_bar_beat, ticks_to_seconds,
};
pub use validate::validate;

/// Pulses per quarter note: the resolution of every musical position in a song
/// document. Fixed for all projects (`specs/02-song-model.md` §2.2).
///
/// ```
/// // One bar of 4/4 is four quarter notes.
/// assert_eq!(4 * bragi_model::PPQ, 3_840);
/// ```
pub const PPQ: i64 = 960;

/// The project's internal sample rate in hertz. Ingest produces a 48 kHz
/// 24-bit FLAC working copy of every source (`specs/02-song-model.md` §2.2,
/// `specs/04-analysis-pipeline.md` §3.1).
///
/// ```
/// assert_eq!(bragi_model::INTERNAL_SAMPLE_RATE_HZ, 48_000);
/// ```
pub const INTERNAL_SAMPLE_RATE_HZ: u32 = 48_000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ppq_is_divisible_by_the_common_note_subdivisions() {
        // Triplets and 64th notes must land on whole ticks, which is why PPQ is
        // 960 rather than a power of two.
        for subdivision in [2, 3, 4, 5, 6, 8, 12, 16, 24, 32, 48, 64, 96, 960] {
            assert_eq!(
                PPQ % subdivision,
                0,
                "PPQ must divide evenly by {subdivision}"
            );
        }
    }
}
