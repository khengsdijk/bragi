//! Errors from the engine.

use thiserror::Error;

/// A render plan could not be compiled.
///
/// Plan compilation happens off the audio thread, so a missing asset is a
/// normal, recoverable error here; the renderer would otherwise have to guess a
/// channel count.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum PlanError {
    /// The requested output sample rate is not the project's 48 kHz.
    ///
    /// The engine works at the project rate (`specs/02-song-model.md` §2.2); a
    /// different device rate is the host's resampling problem (Q27).
    #[error("unsupported sample rate {0}; the engine runs at 48000 Hz")]
    UnsupportedSampleRate(u32),
    /// A clip referenced an asset that is not in the index, so its sample rate
    /// and channel count are unknown.
    #[error("asset {0} is missing from the asset index")]
    MissingAsset(String),
}

/// Anything that went wrong at the `Engine` boundary.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum EngineError {
    /// Plan compilation failed.
    #[error(transparent)]
    Plan(#[from] PlanError),
    /// A delta could not be applied to the current plan.
    #[error("delta does not belong to this project: {0}")]
    WrongProject(String),
    /// A transport command was outside the arrangement.
    #[error("sample {sample} is outside the arrangement (length {length})")]
    OutOfRange {
        /// The offending sample position.
        sample: u64,
        /// The arrangement length.
        length: u64,
    },
}
