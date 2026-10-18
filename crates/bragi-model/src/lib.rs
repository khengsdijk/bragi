//! The Bragi song model: document types, op application, validation, diff and
//! time mapping.
//!
//! This crate is the **only** thing that changes a song document
//! ([`specs/02-song-model.md`], [`specs/13-agent-guide.md`] §1). TypeScript and
//! Python never mutate a document; they build op batches and hand them here,
//! through the `wasm-bindgen` wrapper in `packages/model-wasm`.
//!
//! The crate must compile for `wasm32-unknown-unknown`.
//!
//! # Status
//!
//! Scaffold (WP-0.1). The normative time constants below are in place; the
//! document types, `apply`, `validate`, `section_spans`, `resolve_region`,
//! `canonical_json`, the commit hash and `diff` arrive with **WP-0.3**.
#![forbid(unsafe_code)]

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
