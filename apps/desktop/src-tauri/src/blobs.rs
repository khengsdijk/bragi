//! The desktop blob cache: one file per blob under `<data dir>/blobs`, named by
//! the SHA-256 of its bytes (01 §3). Content-addressed, so writing the same
//! bytes twice is a no-op and the web's OPFS cache can hold the same names.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::CommandError;
use crate::migrations::is_blob_hash;

/// A directory of content-addressed files.
#[derive(Debug, Clone)]
pub struct BlobCache {
    directory: PathBuf,
}

impl BlobCache {
    /// Opens (creating if needed) the blob directory.
    pub fn open(directory: impl AsRef<Path>) -> Result<Self, CommandError> {
        let directory = directory.as_ref().to_path_buf();
        std::fs::create_dir_all(&directory)?;
        Ok(Self { directory })
    }

    /// The directory the cache lives in, for diagnostics and tests.
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// The path of a blob, refusing anything that is not a well-formed hash so a
    /// hash can never name a file outside the cache.
    fn path_of(&self, hash: &str) -> Result<PathBuf, CommandError> {
        if !is_blob_hash(hash) {
            return Err(CommandError::invalid(format!(
                "not a blob hash (expected sha256:<64 hex>): {hash:?}"
            )));
        }
        let name = hash.trim_start_matches("sha256:");
        Ok(self.directory.join(name))
    }

    /// Stores the bytes and returns their hash.
    ///
    /// Written to a temporary name and renamed, so a reader never sees a partial
    /// file. Identical content under an identical name makes the race harmless.
    pub fn put(&self, bytes: &[u8]) -> Result<String, CommandError> {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let hash = format!("sha256:{}", hex(&hasher.finalize()));
        let path = self.path_of(&hash)?;
        if path.exists() {
            return Ok(hash);
        }
        let temporary = path.with_extension("tmp");
        std::fs::write(&temporary, bytes)?;
        std::fs::rename(&temporary, &path)?;
        Ok(hash)
    }

    /// The stored bytes, or [`CommandError::not_found`].
    pub fn get(&self, hash: &str) -> Result<Vec<u8>, CommandError> {
        let path = self.path_of(hash)?;
        match std::fs::read(&path) {
            Ok(bytes) => Ok(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Err(CommandError::not_found(hash))
            }
            Err(error) => Err(error.into()),
        }
    }

    /// Whether the blob is present.
    pub fn has(&self, hash: &str) -> Result<bool, CommandError> {
        Ok(self.path_of(hash)?.is_file())
    }

    /// Removes the blob. Removing an absent blob is a no-op.
    pub fn delete(&self, hash: &str) -> Result<(), CommandError> {
        let path = self.path_of(hash)?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        clippy::unwrap_used,
        reason = "tests: a failed expectation is the failure report (13 §3)"
    )]

    use super::*;

    fn directory() -> PathBuf {
        crate::test_support::temp_dir("blobs").expect("a temporary directory")
    }

    #[test]
    fn names_a_blob_by_the_sha256_of_its_bytes() {
        let cache = BlobCache::open(directory()).expect("opens");
        // FIPS 180-2 "abc" vector, the same literal the TS contract suite uses.
        assert_eq!(
            cache.put(b"abc").expect("puts"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            cache.get(&cache.put(b"abc").expect("puts")).expect("gets"),
            b"abc"
        );
    }

    #[test]
    fn stores_empty_blobs_and_the_same_bytes_twice() {
        let cache = BlobCache::open(directory()).expect("opens");
        let first = cache.put(&[]).expect("puts");
        assert_eq!(cache.put(&[]).expect("puts"), first);
        assert_eq!(cache.get(&first).expect("gets"), Vec::<u8>::new());
    }

    #[test]
    fn reports_an_absent_blob_as_not_found() {
        let cache = BlobCache::open(directory()).expect("opens");
        let absent = format!("sha256:{}", "0".repeat(64));
        assert!(!cache.has(&absent).expect("has"));
        let error = cache.get(&absent).expect_err("must be missing");
        assert_eq!(error.kind, crate::error::Kind::NotFound);
        cache
            .delete(&absent)
            .expect("deleting an absent blob is a no-op");
    }

    #[test]
    fn deletes_blobs() {
        let cache = BlobCache::open(directory()).expect("opens");
        let hash = cache.put(b"abc").expect("puts");
        cache.delete(&hash).expect("deletes");
        assert!(!cache.has(&hash).expect("has"));
    }

    #[test]
    fn refuses_a_hash_that_could_name_a_path_outside_the_cache() {
        let cache = BlobCache::open(directory()).expect("opens");
        for bad in ["sha256:../../etc/passwd", "sha256:ABC", "md5:00", ""] {
            assert!(cache.get(bad).is_err(), "{bad}");
            assert!(cache.has(bad).is_err(), "{bad}");
            assert!(cache.delete(bad).is_err(), "{bad}");
        }
    }
}
