//! Read-only access to the documents of commits, for ops that reach outside the current document.
//!
//! `region.adopt` copies content from another commit (`specs/02-song-model.md` §5.4), and
//! `bragi-model` has no I/O, so the caller loads the snapshot and passes it in here. [`crate::apply`]
//! supplies [`NoCommits`]; the WASM wrapper builds a map from its handles.

use std::collections::{BTreeMap, HashMap};

use crate::generated::{CommitId, Project};

/// The documents of the commits an [`crate::apply_with`] batch may read from.
///
/// ```
/// use std::collections::HashMap;
/// use bragi_model::generated::{CommitId, Project};
/// use bragi_model::{CommitDocs, NoCommits};
///
/// let commit: CommitId = "cmt_01JAB3QK7M9P2V6XWN0T4Y8ZB5".parse().unwrap();
/// let mut docs: HashMap<CommitId, Project> = HashMap::new();
/// assert!(docs.get(&commit).is_none());
/// assert!(NoCommits.get(&commit).is_none());
/// ```
pub trait CommitDocs {
    /// The document after `id`, or `None` when the caller did not supply it.
    fn get(&self, id: &CommitId) -> Option<&Project>;
}

/// No commit documents at all: every lookup returns `None`.
///
/// This is what [`crate::apply`] passes, so an op that needs another commit fails with
/// [`crate::ValidationCode::UnknownCommit`] instead of silently doing nothing.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoCommits;

impl CommitDocs for NoCommits {
    fn get(&self, _id: &CommitId) -> Option<&Project> {
        None
    }
}

impl CommitDocs for HashMap<CommitId, Project> {
    fn get(&self, id: &CommitId) -> Option<&Project> {
        HashMap::get(self, id)
    }
}

impl CommitDocs for BTreeMap<CommitId, Project> {
    fn get(&self, id: &CommitId) -> Option<&Project> {
        BTreeMap::get(self, id)
    }
}
