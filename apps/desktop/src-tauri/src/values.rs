//! Translation between the JSON that crosses the IPC and rusqlite's own types.
//!
//! `@bragi/platform`'s `LocalDB` is deliberately narrow: text, numbers and
//! `null` in, plain objects out (`packages/platform/src/types.ts`). Anything
//! else — blobs, integers past `i64` — is refused here rather than silently
//! coerced.

use rusqlite::types::{Value, ValueRef};
use serde_json::{Map, Value as Json, json};

use crate::error::CommandError;

/// One bound parameter, in `LocalDB` order.
pub fn to_sql(params: &[Json]) -> Result<Vec<Value>, CommandError> {
    params
        .iter()
        .map(|param| match param {
            Json::Null => Ok(Value::Null),
            Json::Bool(value) => Ok(Value::Integer(i64::from(*value))),
            Json::Number(number) => {
                if let Some(integer) = number.as_i64() {
                    Ok(Value::Integer(integer))
                } else if let Some(real) = number.as_f64() {
                    Ok(Value::Real(real))
                } else {
                    Err(CommandError::invalid(format!(
                        "number {number} does not fit a SQLite value"
                    )))
                }
            }
            Json::String(text) => Ok(Value::Text(text.clone())),
            Json::Array(_) | Json::Object(_) => Err(CommandError::invalid(
                "parameters are text, numbers or null; blobs belong in the BlobCache",
            )),
        })
        .collect()
}

/// One result cell, as the frontend sees it.
pub fn to_json(value: ValueRef<'_>) -> Result<Json, CommandError> {
    Ok(match value {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(integer) => json!(integer),
        ValueRef::Real(real) => json!(real),
        ValueRef::Text(bytes) => Json::String(std::str::from_utf8(bytes)?.to_owned()),
        ValueRef::Blob(_) => {
            return Err(CommandError::invalid(
                "blob columns belong in the BlobCache, not in the local database",
            ));
        }
    })
}

/// The same, for a `LocalDB`-shaped row: plain object, keyed by column name.
pub fn row_to_json(
    columns: &[String],
    row: &rusqlite::Row<'_>,
) -> Result<Map<String, Json>, CommandError> {
    let mut object = Map::with_capacity(columns.len());
    for (index, name) in columns.iter().enumerate() {
        object.insert(name.clone(), to_json(row.get_ref(index)?)?);
    }
    Ok(object)
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
    fn binds_every_supported_parameter() {
        let bound = to_sql(&[json!("a"), json!(42), json!(1.5), json!(null), json!(true)])
            .expect("all of these are supported");
        assert_eq!(
            bound,
            vec![
                Value::Text("a".to_owned()),
                Value::Integer(42),
                Value::Real(1.5),
                Value::Null,
                Value::Integer(1),
            ]
        );
    }

    #[test]
    fn refuses_parameters_it_cannot_represent() {
        assert!(to_sql(&[json!([1, 2])]).is_err());
        assert!(to_sql(&[json!({ "a": 1 })]).is_err());
    }

    #[test]
    fn binds_an_out_of_range_integer_as_a_real() {
        // JavaScript cannot represent this exactly either, so the value has
        // already been rounded before it reached the IPC; a REAL is honest.
        let bound = to_sql(&[json!(18_446_744_073_709_551_615u64)]).expect("a REAL");
        assert!(matches!(bound.as_slice(), [Value::Real(_)]));
    }

    #[test]
    fn refuses_blob_cells() {
        assert!(to_json(ValueRef::Blob(&[1, 2, 3])).is_err());
    }
}
