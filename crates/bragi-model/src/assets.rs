//! The asset metadata index `validate` needs.
//!
//! Clip ranges are stored in samples, so checking that they lie inside their asset
//! (`specs/02-song-model.md` §4.3, invariant 2) needs `AssetMeta`, which is *not* in the document
//! — it lives in the DB and the local cache (02 §3.2). Callers hand it to the model as an
//! [`AssetIndex`].

use std::collections::HashMap;

use crate::generated::{AssetHash, AssetMeta};

/// A lookup from [`AssetHash`] to [`AssetMeta`].
///
/// ```
/// use bragi_model::{AssetIndex, generated::AssetMeta};
/// # fn meta() -> AssetMeta { serde_json::from_value(serde_json::json!({
/// #   "hash": format!("sha256:{}", "0".repeat(64)), "mime": "audio/flac", "bytes": 10,
/// #   "sampleRate": 48000, "channels": 2, "durationSamples": 288000 })).unwrap() }
/// let mut assets = AssetIndex::new();
/// assets.insert(meta());
/// assert_eq!(assets.len(), 1);
/// ```
#[derive(Clone, Debug, Default)]
pub struct AssetIndex {
    by_hash: HashMap<AssetHash, AssetMeta>,
}

impl AssetIndex {
    /// An empty index.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// An index built from `metas`; a later meta with the same hash replaces an earlier one.
    #[must_use]
    pub fn from_metas(metas: impl IntoIterator<Item = AssetMeta>) -> Self {
        let mut index = Self::new();
        for meta in metas {
            index.insert(meta);
        }
        index
    }

    /// Adds one asset's metadata.
    pub fn insert(&mut self, meta: AssetMeta) {
        self.by_hash.insert(meta.hash.clone(), meta);
    }

    /// The metadata for `hash`, if the index knows it.
    #[must_use]
    pub fn get(&self, hash: &AssetHash) -> Option<&AssetMeta> {
        self.by_hash.get(hash)
    }

    /// The asset's length in samples, if the index knows it.
    #[must_use]
    pub fn duration_samples(&self, hash: &AssetHash) -> Option<u64> {
        self.by_hash.get(hash).map(|meta| meta.duration_samples)
    }

    /// The asset's sample rate, if the index knows it.
    #[must_use]
    pub fn sample_rate(&self, hash: &AssetHash) -> Option<u64> {
        self.by_hash.get(hash).map(|meta| meta.sample_rate.get())
    }

    /// How many assets the index holds.
    #[must_use]
    pub fn len(&self) -> usize {
        self.by_hash.len()
    }

    /// Whether the index is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.by_hash.is_empty()
    }

    /// The assets, in an unspecified order.
    pub fn iter(&self) -> impl Iterator<Item = (&AssetHash, &AssetMeta)> {
        self.by_hash.iter()
    }
}

impl FromIterator<AssetMeta> for AssetIndex {
    fn from_iter<T: IntoIterator<Item = AssetMeta>>(iter: T) -> Self {
        Self::from_metas(iter)
    }
}
