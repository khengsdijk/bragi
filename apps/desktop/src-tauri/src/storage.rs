//! The process-wide state behind the commands: one SQLite connection and the
//! blob directory, both under the app's data directory.
//!
//! `BRAGI_DATA_DIR` overrides the location. It exists so the desktop end-to-end
//! harness (src/selftest.rs) can point two process launches at one throwaway
//! directory instead of the real user data; nothing else sets it.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

use crate::blobs::BlobCache;
use crate::error::CommandError;
use crate::migrations;

/// The database file's name inside the data directory. The browser's OPFS
/// database uses the same name.
pub const DB_FILE: &str = "bragi.sqlite3";

/// The blob directory's name, shared with `packages/platform`'s OPFS cache.
pub const BLOB_DIR: &str = "blobs";

/// Everything a command needs.
pub struct Storage {
    connection: Mutex<Connection>,
    blobs: BlobCache,
    data_directory: PathBuf,
}

impl Storage {
    /// Opens the data directory, creating it, and brings the schema up to date.
    pub fn open(data_directory: &Path) -> Result<Self, CommandError> {
        std::fs::create_dir_all(data_directory)?;
        let mut connection = Connection::open(data_directory.join(DB_FILE))?;
        connection.execute_batch("PRAGMA foreign_keys = ON")?;
        migrations::apply(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            blobs: BlobCache::open(data_directory.join(BLOB_DIR))?,
            data_directory: data_directory.to_path_buf(),
        })
    }

    /// The connection, or `invalid` when a previous command panicked while
    /// holding it.
    pub fn connection(&self) -> Result<MutexGuard<'_, Connection>, CommandError> {
        self.connection
            .lock()
            .map_err(|_| CommandError::invalid("the local database connection is poisoned"))
    }

    /// The blob cache.
    pub fn blobs(&self) -> &BlobCache {
        &self.blobs
    }

    /// Where the data directory is, for diagnostics.
    pub fn data_directory(&self) -> &Path {
        &self.data_directory
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        clippy::unwrap_used,
        reason = "tests: a failed expectation is the failure report (13 §3)"
    )]

    use super::*;

    #[test]
    fn opens_a_directory_and_brings_the_schema_up_to_date() {
        let directory = crate::test_support::temp_dir("storage").expect("a temporary directory");
        let storage = Storage::open(&directory).expect("opens");
        assert!(directory.join(DB_FILE).is_file());
        assert!(directory.join(BLOB_DIR).is_dir());
        let count: i64 = storage
            .connection()
            .expect("connection")
            .query_row("SELECT count(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .expect("count");
        assert_eq!(
            count,
            i64::try_from(migrations::MIGRATIONS.len()).expect("small")
        );
    }
}
