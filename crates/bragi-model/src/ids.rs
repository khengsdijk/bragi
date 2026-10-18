//! `Display` for the generated identifier and hash newtypes.
//!
//! `typify` generates the constrained ID/hash types (`SectionId`, `ClipId`, `AssetHash`, …) as
//! `#[serde(transparent)]` newtypes over `String`, with a `Deref<Target = String>` but **no**
//! `Display`. They are local types, so this crate may implement `Display` for them; doing it once
//! here keeps every error message and log line free of `.to_string()` noise.
//!
//! This is hand-written code around generated types, not an edit to generated code
//! (`specs/13-agent-guide.md` §1): the generated file is untouched.

use std::fmt;

use crate::generated::{
    AssetHash, AutomationTarget, BatchId, ClipId, CommitDeviceId, CommitId, FxId, IsoDate, JobId,
    MacroId, PlanId, ProjectId, SectionId, SourceId, TrackId, UserId,
};

macro_rules! impl_display {
    ($($type:ty),* $(,)?) => {
        $(
            impl fmt::Display for $type {
                fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                    f.write_str(self.as_str())
                }
            }
        )*
    };
}

impl_display!(
    AssetHash,
    AutomationTarget,
    BatchId,
    ClipId,
    CommitDeviceId,
    CommitId,
    FxId,
    IsoDate,
    JobId,
    MacroId,
    PlanId,
    ProjectId,
    SectionId,
    SourceId,
    TrackId,
    UserId,
);
