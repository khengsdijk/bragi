//! The payload every command rejects with.
//!
//! It crosses the IPC as JSON, and `@bragi/platform`'s Tauri adapter narrows on
//! `kind` (see `packages/platform/src/tauri/adapters.ts`): `blob_get` turns
//! `NotFound` into `null` instead of an error, and everything else surfaces as
//! an `Error` whose message is `message`.

use serde::Serialize;

/// What went wrong, coarsely. The frontend never matches on the message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// SQLite rejected the statement or it violated a constraint.
    Sql,
    /// The requested blob is not in the cache.
    NotFound,
    /// The call itself was malformed (bad hash, unsupported parameter type).
    Invalid,
    /// The filesystem failed.
    Io,
}

/// One rejection from a command.
#[derive(Debug, Clone, Serialize)]
pub struct CommandError {
    /// The coarse category.
    pub kind: Kind,
    /// A human-readable reason. Logged, never shown raw to the user.
    pub message: String,
}

impl CommandError {
    /// A `kind = "invalid"` rejection.
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            kind: Kind::Invalid,
            message: message.into(),
        }
    }

    /// A `kind = "not_found"` rejection.
    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            kind: Kind::NotFound,
            message: message.into(),
        }
    }

    /// A `kind = "io"` rejection.
    pub fn io(message: impl Into<String>) -> Self {
        Self {
            kind: Kind::Io,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for CommandError {}

impl From<rusqlite::Error> for CommandError {
    fn from(error: rusqlite::Error) -> Self {
        Self {
            kind: Kind::Sql,
            message: error.to_string(),
        }
    }
}

impl From<std::io::Error> for CommandError {
    fn from(error: std::io::Error) -> Self {
        Self {
            kind: Kind::Io,
            message: error.to_string(),
        }
    }
}

impl From<std::str::Utf8Error> for CommandError {
    fn from(error: std::str::Utf8Error) -> Self {
        Self::invalid(format!("not valid UTF-8: {error}"))
    }
}
