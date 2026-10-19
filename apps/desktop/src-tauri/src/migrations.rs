//! The shared migration set, applied with the same bookkeeping as the browser
//! (`packages/platform/src/migrations.ts`) so a database written by one host is
//! readable by the other's rules.
//!
//! The SQL lives in `packages/schemas/sqlite/migrations/NNN_name.sql` and is
//! **owned by both** hosts. `include_str!` embeds each file, and
//! [`tests::every_shared_file_is_registered`] fails when the directory and
//! [`MIGRATIONS`] disagree, so adding a file without registering it here is
//! caught by `cargo test`.

use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::error::CommandError;

/// One migration, in `NNN_name.sql` order (05 §7).
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    /// The `NNN` prefix; versions start at 1 and have no gaps.
    pub version: u32,
    /// The `name` part of the file name.
    pub name: &'static str,
    /// The file's exact contents.
    pub sql: &'static str,
}

/// Every migration this app knows, oldest first.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "projects",
        sql: include_str!("../../../../packages/schemas/sqlite/migrations/001_projects.sql"),
    },
    Migration {
        version: 2,
        name: "library",
        sql: include_str!("../../../../packages/schemas/sqlite/migrations/002_library.sql"),
    },
];

/// The bookkeeping table, byte-for-byte the browser's.
const BOOKKEEPING: &str = "CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
)";

/// `sha256:<hex of the file's bytes>` — the same identifier the web runner
/// stores, so both hosts detect an edited migration the same way.
pub fn checksum(sql: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(sql.as_bytes());
    format!("sha256:{}", hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

/// True when `value` is `sha256:<64 lowercase hex>`; the same shape the frontend
/// enforces before a hash is used as a file name.
pub fn is_blob_hash(value: &str) -> bool {
    let Some(hex_part) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex_part.len() == 64
        && hex_part
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Applies every migration newer than the database, each in one transaction
/// together with its bookkeeping row. Returns the versions applied.
///
/// Refuses a database written by a newer app, and refuses a migration whose SQL
/// changed after it was applied: history is append-only.
pub fn apply(connection: &mut Connection) -> Result<Vec<u32>, CommandError> {
    connection.execute(BOOKKEEPING, [])?;
    let applied = {
        let mut statement = connection
            .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, u32>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    for (version, recorded) in &applied {
        let Some(migration) = MIGRATIONS.iter().find(|it| it.version == *version) else {
            return Err(CommandError::invalid(format!(
                "the local database is at migration {version}, newer than this app knows"
            )));
        };
        if checksum(migration.sql) != *recorded {
            return Err(CommandError::invalid(format!(
                "migration {} was changed after it was applied",
                label(migration)
            )));
        }
    }

    let mut newly_applied = Vec::new();
    for migration in MIGRATIONS {
        if applied
            .iter()
            .any(|(version, _)| *version == migration.version)
        {
            continue;
        }
        let transaction = connection.transaction()?;
        transaction.execute_batch(migration.sql)?;
        transaction.execute(
            "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                migration.version,
                migration.name,
                checksum(migration.sql),
                now_iso8601(),
            ],
        )?;
        transaction.commit()?;
        newly_applied.push(migration.version);
    }
    Ok(newly_applied)
}

fn label(migration: &Migration) -> String {
    format!("{:03}_{}", migration.version, migration.name)
}

/// `YYYY-MM-DDTHH:MM:SS.sssZ`, the shape the web runner writes.
fn now_iso8601() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = now.as_secs();
    let millis = now.subsec_millis();
    let days = seconds / 86_400;
    let time_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(i64::try_from(days).unwrap_or_default());
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60,
    )
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 → (y, m, d).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = u32::try_from(day_of_year - (153 * month_prime + 2) / 5 + 1).unwrap_or(1);
    let month = u32::try_from(if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    })
    .unwrap_or(1);
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        clippy::unwrap_used,
        reason = "tests: a failed expectation is the failure report (13 §3)"
    )]

    use super::*;

    fn in_memory() -> Connection {
        Connection::open_in_memory().expect("in-memory database")
    }

    fn shared_directory() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/schemas/sqlite/migrations")
    }

    #[test]
    fn every_shared_file_is_registered() {
        let directory = shared_directory();
        let mut on_disk: Vec<String> = std::fs::read_dir(&directory)
            .expect("the shared migration directory")
            .map(|entry| {
                entry
                    .expect("a directory entry")
                    .file_name()
                    .to_string_lossy()
                    .to_string()
            })
            .filter(|name: &String| name.ends_with(".sql"))
            .collect();
        on_disk.sort();
        let mut registered: Vec<String> = MIGRATIONS
            .iter()
            .map(|migration| format!("{:03}_{}.sql", migration.version, migration.name))
            .collect();
        registered.sort();
        assert_eq!(
            on_disk, registered,
            "packages/schemas/sqlite/migrations and MIGRATIONS must list the same files"
        );
    }

    #[test]
    fn checksums_agree_with_the_web_runner() {
        // The same literal is asserted in packages/platform's migration test.
        assert_eq!(
            checksum(MIGRATIONS[0].sql),
            "sha256:c695ba1237f2ee96252b4263553eccc301c911eac84a8940fe68f1846b66a7ab"
        );
    }

    #[test]
    fn creates_the_local_schema_and_records_it() {
        let mut connection = in_memory();
        assert_eq!(apply(&mut connection).expect("applies"), vec![1, 2]);
        let columns: Vec<String> = {
            let mut statement = connection
                .prepare("SELECT name FROM pragma_table_info('projects') ORDER BY cid")
                .expect("pragma");
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .expect("query");
            rows.collect::<Result<Vec<_>, _>>().expect("rows")
        };
        assert_eq!(
            columns,
            vec![
                "id",
                "title",
                "created_at",
                "updated_at",
                "deleted_at",
                "snapshot_hash",
                "asset_hash"
            ]
        );
        let recorded: Vec<(u32, String)> = {
            let mut statement = connection
                .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
                .expect("prepare");
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .expect("query");
            rows.collect::<Result<Vec<_>, _>>().expect("rows")
        };
        assert_eq!(
            recorded,
            vec![(1, "projects".to_owned()), (2, "library".to_owned())]
        );
    }

    #[test]
    fn is_idempotent() {
        let mut connection = in_memory();
        apply(&mut connection).expect("applies");
        assert_eq!(apply(&mut connection).expect("applies"), Vec::<u32>::new());
    }

    #[test]
    fn refuses_an_edited_migration() {
        let mut connection = in_memory();
        apply(&mut connection).expect("applies");
        connection
            .execute("UPDATE schema_migrations SET checksum = 'sha256:00'", [])
            .expect("tamper");
        let error = apply(&mut connection).expect_err("must refuse");
        assert!(error.message.contains("changed"), "{error}");
    }

    #[test]
    fn refuses_a_newer_database() {
        let mut connection = in_memory();
        apply(&mut connection).expect("applies");
        connection
            .execute(
                "INSERT INTO schema_migrations (version, name, checksum, applied_at) \
                 VALUES (99, 'future', 'sha256:00', '2030-01-01T00:00:00.000Z')",
                [],
            )
            .expect("a newer row");
        let error = apply(&mut connection).expect_err("must refuse");
        assert!(error.message.contains("newer"), "{error}");
    }

    #[test]
    fn a_failing_migration_rolls_back_completely() {
        let mut connection = in_memory();
        connection
            .execute_batch(BOOKKEEPING)
            .expect("the bookkeeping table");

        // Shaped exactly like `apply` runs a migration: the script and its
        // bookkeeping row in one transaction, where the script's third
        // statement violates a constraint.
        let transaction = connection.transaction().expect("transaction");
        let failed = transaction.execute_batch(
            "CREATE TABLE ok (id TEXT PRIMARY KEY); \
             INSERT INTO ok VALUES ('1'); \
             INSERT INTO ok VALUES ('1');",
        );
        assert!(failed.is_err(), "the duplicate key must fail the migration");
        drop(transaction);

        let created: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'ok'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(created, 0, "the failed batch left its table behind");
        // And the database is still usable: `apply` relies on that.
        assert_eq!(apply(&mut connection).expect("applies"), vec![1]);
    }

    #[test]
    fn recognises_blob_hashes() {
        assert!(is_blob_hash(&format!("sha256:{}", "a".repeat(64))));
        assert!(!is_blob_hash(&format!("sha256:{}", "A".repeat(64))));
        assert!(!is_blob_hash("sha256:abc"));
        assert!(!is_blob_hash("md5:00"));
        assert!(!is_blob_hash("sha256:../../etc/passwd"));
    }

    #[test]
    fn writes_iso_8601_utc() {
        let now = now_iso8601();
        assert_eq!(now.len(), 24, "{now}");
        assert!(now.ends_with('Z'), "{now}");
        assert_eq!(&now[4..5], "-");
        // 1970-01-01 and a leap day, through the same conversion.
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
    }
}
