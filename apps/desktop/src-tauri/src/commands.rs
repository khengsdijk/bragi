//! The commands `@bragi/platform`'s Tauri adapter calls. Command names, argument
//! names and payload shapes are a contract with
//! `packages/platform/src/tauri/adapters.ts`: the TypeScript half runs the same
//! contract suite against an IPC double, and `crate::db`'s tests are the Rust
//! half.
//!
//! All SQL runs here, in the app process, one statement at a time;
//! `db_transaction` is the only atomic unit and it never spans IPC round-trips.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};
use tauri::State;
use tauri::ipc::{InvokeBody, Request, Response};

use crate::error::CommandError;
use crate::storage::Storage;

/// What a write statement did (`sqlite3_changes`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct RunResult {
    /// Rows inserted, updated or deleted.
    pub changes: u64,
}

/// One step of `db_transaction`.
#[derive(Debug, Deserialize)]
pub struct TransactionStep {
    /// The SQL.
    pub sql: String,
    /// Positional parameters, or `None` for a `;`-separated script.
    #[serde(default)]
    pub params: Option<Vec<Json>>,
}

/// Runs one statement and returns every row it yields.
#[tauri::command]
pub fn db_query(
    storage: State<'_, Storage>,
    sql: String,
    params: Vec<Json>,
) -> Result<Vec<Map<String, Json>>, CommandError> {
    storage.query(&sql, &params)
}

/// Runs one write statement.
#[tauri::command]
pub fn db_run(
    storage: State<'_, Storage>,
    sql: String,
    params: Vec<Json>,
) -> Result<RunResult, CommandError> {
    Ok(RunResult {
        changes: storage.run(&sql, &params)?,
    })
}

/// Runs the steps atomically: all of them, or none.
#[tauri::command]
pub fn db_transaction(
    storage: State<'_, Storage>,
    steps: Vec<TransactionStep>,
) -> Result<(), CommandError> {
    let steps: Vec<crate::db::Step> = steps
        .into_iter()
        .map(|step| crate::db::Step {
            sql: step.sql,
            params: step.params,
        })
        .collect();
    storage.transaction(&steps)
}

/// Stores bytes and returns their `sha256:<hex>` hash.
///
/// The bytes are the request body, not a JSON field: binary data never becomes a
/// JSON number array. `@tauri-apps/api`'s `invoke` sends a `Uint8Array` argument
/// as the raw body, which is what [`InvokeBody::Raw`] is.
#[tauri::command]
pub fn blob_put(storage: State<'_, Storage>, request: Request<'_>) -> Result<String, CommandError> {
    storage.blobs().put(raw_body(request.body())?)
}

/// Returns the stored bytes as the response body (`ArrayBuffer` in the page).
#[tauri::command]
pub fn blob_get(storage: State<'_, Storage>, hash: String) -> Result<Response, CommandError> {
    Ok(Response::new(storage.blobs().get(&hash)?))
}

/// Whether the blob is present.
#[tauri::command]
pub fn blob_has(storage: State<'_, Storage>, hash: String) -> Result<bool, CommandError> {
    storage.blobs().has(&hash)
}

/// Removes the blob. Removing an absent blob is a no-op.
#[tauri::command]
pub fn blob_delete(storage: State<'_, Storage>, hash: String) -> Result<(), CommandError> {
    storage.blobs().delete(&hash)
}

/// The raw request body, or an `invalid` rejection for a JSON body.
fn raw_body(body: &InvokeBody) -> Result<&[u8], CommandError> {
    match body {
        InvokeBody::Raw(bytes) => Ok(bytes),
        InvokeBody::Json(_) => Err(CommandError::invalid(
            "blob_put expects the bytes as the request body",
        )),
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
    fn takes_the_bytes_from_a_raw_body() {
        assert_eq!(
            raw_body(&InvokeBody::Raw(b"abc".to_vec())).expect("raw"),
            b"abc"
        );
    }

    #[test]
    fn refuses_a_json_body_for_blob_put() {
        let body = InvokeBody::Json(serde_json::json!({ "bytes": [1, 2] }));
        assert_eq!(
            raw_body(&body).expect_err("must refuse").kind,
            crate::error::Kind::Invalid
        );
    }
}
