//! Hand-written serde helpers referenced by the generated types.
//!
//! Typify maps an optional property to `Option<T>`, which cannot tell an absent field from an
//! explicit JSON `null`. `fx.update` needs that distinction: absent leaves a duck's source alone,
//! `null` clears it (02 §4.2). The code generator emits
//! `Option<Option<SidechainSourcePatch>>` for that one field and points its `deserialize_with` at
//! [`deserialize_sidechain_source`], so the outer `Option` is presence and the inner one is null.

use serde::{Deserialize, Deserializer};

use crate::generated::SidechainSourcePatch;

/// Reads a present `sidechainSource`: `null` becomes `Some(None)`, a track becomes
/// `Some(Some(..))`. An absent field is not passed here; serde's `default` yields `None`.
pub(crate) fn deserialize_sidechain_source<'de, D>(
    deserializer: D,
) -> Result<Option<Option<SidechainSourcePatch>>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Some(Option::<SidechainSourcePatch>::deserialize(
        deserializer,
    )?))
}
