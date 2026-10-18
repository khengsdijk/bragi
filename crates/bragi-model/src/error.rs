//! Errors returned by [`crate::validate`] and [`crate::apply`].
//!
//! A rejected batch produces structured errors of the shape `{ opIndex, code, message }`
//! (`specs/02-song-model.md` §4.3). `bragi-model` never panics on validated input and never
//! `unwrap()`s outside tests, so every failure path is one of these types.

use std::fmt;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// A machine-readable reason a document or op was rejected.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationCode {
    /// A lane names a track that is not in `tracks` (02 §4.3, invariant 1).
    UnknownTrack,
    /// Two entities share an ID (02 §4.3, invariant 7).
    DuplicateId,
    /// A clip's source range is empty or escapes its asset (invariant 2).
    ClipRange,
    /// A referenced asset is not in the [`crate::AssetIndex`].
    UnknownAsset,
    /// Overlapping clips in a lane are not covered by matching fades (invariant 3).
    OverlapWithoutFade,
    /// The tempo map is empty, unsorted, does not start at 0, or has an out-of-range bpm
    /// (invariant 4).
    TempoMap,
    /// An FX parameter is unknown or outside its catalogue range (invariant 5).
    FxParam,
    /// An AI batch modified a locked section (invariant 6).
    LockedSection,
    /// A single-field numeric bound the schema cannot express (e.g. `pan`, `energyTarget`).
    NumericRange,
    /// An op names an ID that does not exist.
    MissingTarget,
    /// An op gives an index beyond the end of its list.
    IndexOutOfRange,
    /// The op is valid but not implemented by this work package (`analysis.apply`, `region.adopt`).
    UnsupportedOp,
}

impl ValidationCode {
    /// The stable string form, the same one that appears in JSON.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnknownTrack => "unknown_track",
            Self::DuplicateId => "duplicate_id",
            Self::ClipRange => "clip_range",
            Self::UnknownAsset => "unknown_asset",
            Self::OverlapWithoutFade => "overlap_without_fade",
            Self::TempoMap => "tempo_map",
            Self::FxParam => "fx_param",
            Self::LockedSection => "locked_section",
            Self::NumericRange => "numeric_range",
            Self::MissingTarget => "missing_target",
            Self::IndexOutOfRange => "index_out_of_range",
            Self::UnsupportedOp => "unsupported_op",
        }
    }
}

impl fmt::Display for ValidationCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One structured failure: `{ opIndex, code, message }` (02 §4.3).
///
/// `op_index` is the index of the op in the batch that caused it, or `0` for document-level
/// validation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationError {
    /// Index of the offending op in the batch (`0` when the whole document was validated).
    pub op_index: usize,
    /// The machine-readable reason.
    pub code: ValidationCode,
    /// A human-readable explanation.
    pub message: String,
}

impl ValidationError {
    /// Builds an error.
    #[must_use]
    pub fn new(op_index: usize, code: ValidationCode, message: impl Into<String>) -> Self {
        Self {
            op_index,
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "op[{}] {}: {}", self.op_index, self.code, self.message)
    }
}

/// Why [`crate::apply`] rejected a batch.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum ApplyError {
    /// The op itself was invalid, attributed to its index in the batch.
    #[error("{0}")]
    Op(ValidationError),
    /// The batch applied but left the document violating an invariant.
    #[error("the batch left the document invalid ({} error(s))", .0.len())]
    Invariants(Vec<ValidationError>),
}

impl ApplyError {
    /// The structured errors, flattened, for reporting as `[{ opIndex, code, message }]`.
    #[must_use]
    pub fn errors(&self) -> Vec<ValidationError> {
        match self {
            Self::Op(error) => vec![error.clone()],
            Self::Invariants(errors) => errors.clone(),
        }
    }

    /// The first error's code — convenient for matching in tests and callers.
    #[must_use]
    pub fn code(&self) -> ValidationCode {
        match self {
            Self::Op(error) => error.code,
            Self::Invariants(errors) => errors
                .first()
                .map_or(ValidationCode::UnsupportedOp, |error| error.code),
        }
    }
}

impl From<ValidationError> for ApplyError {
    fn from(error: ValidationError) -> Self {
        Self::Op(error)
    }
}
