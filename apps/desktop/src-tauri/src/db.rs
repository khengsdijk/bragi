//! The statement-level database work, kept free of Tauri types so it is unit
//! tested directly (see the tests at the end of this file). `commands.rs` is the
//! thin IPC shell around it.

use rusqlite::{Connection, params_from_iter};
use serde_json::{Map, Value as Json};

use crate::error::CommandError;
use crate::storage::Storage;
use crate::values::{row_to_json, to_sql};

/// Runs one statement and returns every row it yields.
pub fn query(
    connection: &Connection,
    sql: &str,
    params: &[Json],
) -> Result<Vec<Map<String, Json>>, CommandError> {
    let mut statement = connection.prepare(sql)?;
    let columns: Vec<String> = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    let mut rows = statement.query(params_from_iter(to_sql(params)?))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(row_to_json(&columns, row)?);
    }
    Ok(out)
}

/// Runs one write statement and reports how many rows it changed.
pub fn run(connection: &Connection, sql: &str, params: &[Json]) -> Result<u64, CommandError> {
    let mut statement = connection.prepare(sql)?;
    let changes = statement.execute(params_from_iter(to_sql(params)?))?;
    Ok(u64::try_from(changes).unwrap_or_default())
}

/// Runs every step in one transaction: all of them, or none.
pub fn transaction(connection: &mut Connection, steps: &[Step]) -> Result<(), CommandError> {
    let tx = connection.transaction()?;
    for step in steps {
        match &step.params {
            Some(params) => {
                tx.execute(&step.sql, params_from_iter(to_sql(params)?))?;
            }
            None => tx.execute_batch(&step.sql)?,
        }
    }
    tx.commit()?;
    Ok(())
}

/// One step of a transaction. Without `params` the step may hold several
/// `;`-separated statements (a migration script); with them it is one statement.
#[derive(Debug, Clone)]
pub struct Step {
    /// The SQL.
    pub sql: String,
    /// Positional parameters, or `None` for a script.
    pub params: Option<Vec<Json>>,
}

impl Storage {
    /// [`query`] against this storage's connection.
    pub fn query(
        &self,
        sql: &str,
        params: &[Json],
    ) -> Result<Vec<Map<String, Json>>, CommandError> {
        let connection = self.connection()?;
        query(&connection, sql, params)
    }

    /// [`run`] against this storage's connection.
    pub fn run(&self, sql: &str, params: &[Json]) -> Result<u64, CommandError> {
        let connection = self.connection()?;
        run(&connection, sql, params)
    }

    /// [`transaction`] against this storage's connection.
    pub fn transaction(&self, steps: &[Step]) -> Result<(), CommandError> {
        let mut connection = self.connection()?;
        transaction(&mut connection, steps)
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
    use serde_json::json;

    fn storage() -> Storage {
        let directory = crate::test_support::temp_dir("db").expect("a temporary directory");
        let storage = Storage::open(&directory).expect("opens");
        storage
            .run(
                "CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER, r REAL, s TEXT)",
                &[],
            )
            .expect("schema");
        storage
    }

    #[test]
    fn round_trips_text_integer_real_and_null() {
        let storage = storage();
        storage
            .run(
                "INSERT INTO t (id, n, r, s) VALUES (?1, ?2, ?3, ?4)",
                &[json!("a"), json!(42), json!(1.5), Json::Null],
            )
            .expect("insert");
        assert_eq!(
            storage
                .query("SELECT id, n, r, s FROM t", &[])
                .expect("query"),
            vec![
                serde_json::from_value::<Map<String, Json>>(json!({
                    "id": "a", "n": 42, "r": 1.5, "s": null
                }))
                .expect("an object")
            ]
        );
    }

    #[test]
    fn binds_positional_parameters_as_values_never_as_sql() {
        let storage = storage();
        let hostile = "x'); DROP TABLE t; --";
        storage
            .run("INSERT INTO t (id) VALUES (?1)", &[json!(hostile)])
            .expect("insert");
        assert_eq!(
            storage.query("SELECT id FROM t", &[]).expect("query"),
            vec![
                serde_json::from_value::<Map<String, Json>>(json!({ "id": hostile }))
                    .expect("an object")
            ]
        );
    }

    #[test]
    fn reports_how_many_rows_a_write_changed() {
        let storage = storage();
        storage
            .run(
                "INSERT INTO t (id, n) VALUES ('a', 1), ('b', 1), ('c', 2)",
                &[],
            )
            .expect("insert");
        assert_eq!(
            storage
                .run("UPDATE t SET s = 'x' WHERE n = ?1", &[json!(1)])
                .expect("update"),
            2
        );
        assert_eq!(
            storage
                .run("DELETE FROM t WHERE id = 'zzz'", &[])
                .expect("delete"),
            0
        );
    }

    #[test]
    fn runs_a_multi_statement_script_inside_a_transaction() {
        let storage = storage();
        storage
            .transaction(&[Step {
                sql: "CREATE TABLE u (k TEXT); INSERT INTO u VALUES ('1'); INSERT INTO u VALUES ('2');"
                    .to_owned(),
                params: None,
            }])
            .expect("transaction");
        assert_eq!(
            storage
                .query("SELECT count(*) AS c FROM u", &[])
                .expect("query"),
            vec![
                serde_json::from_value::<Map<String, Json>>(json!({ "c": 2 })).expect("an object")
            ]
        );
    }

    #[test]
    fn rolls_back_every_step_when_one_fails_and_stays_usable() {
        let storage = storage();
        let steps = [
            Step {
                sql: "INSERT INTO t (id) VALUES (?1)".to_owned(),
                params: Some(vec![json!("a")]),
            },
            Step {
                sql: "CREATE TABLE v (k TEXT)".to_owned(),
                params: None,
            },
            Step {
                // Duplicate primary key: the whole transaction must go.
                sql: "INSERT INTO t (id) VALUES (?1)".to_owned(),
                params: Some(vec![json!("a")]),
            },
        ];
        assert!(storage.transaction(&steps).is_err());
        assert!(
            storage
                .query("SELECT id FROM t", &[])
                .expect("query")
                .is_empty()
        );
        assert!(
            storage
                .query("SELECT name FROM sqlite_master WHERE name = 'v'", &[])
                .expect("query")
                .is_empty()
        );
        // Still usable after the failure.
        storage
            .transaction(&[Step {
                sql: "INSERT INTO t (id) VALUES ('ok')".to_owned(),
                params: None,
            }])
            .expect("transaction");
        assert_eq!(
            storage.query("SELECT id FROM t", &[]).expect("query"),
            vec![
                serde_json::from_value::<Map<String, Json>>(json!({ "id": "ok" }))
                    .expect("an object")
            ]
        );
    }

    #[test]
    fn rejects_invalid_sql_and_constraint_violations_as_sql_errors() {
        let storage = storage();
        let invalid = storage.query("SELEC nonsense", &[]).expect_err("must fail");
        assert_eq!(invalid.kind, crate::error::Kind::Sql);
        storage
            .run("INSERT INTO t (id) VALUES ('a')", &[])
            .expect("insert");
        let duplicate = storage
            .run("INSERT INTO t (id) VALUES ('a')", &[])
            .expect_err("must fail");
        assert_eq!(duplicate.kind, crate::error::Kind::Sql);
    }

    #[test]
    fn returns_an_empty_list_when_nothing_matches() {
        let storage = storage();
        assert!(
            storage
                .query("SELECT * FROM t WHERE id = ?1", &[json!("missing")])
                .expect("query")
                .is_empty()
        );
    }
}
