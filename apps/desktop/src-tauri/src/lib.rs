//! `bragi-desktop`: the Tauri 2 process behind the desktop app
//! ([01 §3](../../../../specs/01-architecture.md)).
//!
//! It hosts the local database (`rusqlite`) and the filesystem blob cache behind
//! the commands in [`commands`], which is the *only* platform difference the
//! React app can see: the same bundle [`apps/web`](../../web/dist) serves in the
//! browser runs in the webview here, and `@bragi/platform`'s runtime check picks
//! these adapters.
//!
//! Permissions are allow-listed per command ([01 §10](../../../../specs/01-architecture.md)):
//! every capability file in `capabilities/` names the window label it applies to.

pub mod blobs;
pub mod commands;
pub mod db;
pub mod error;
pub mod migrations;
pub mod selftest;
pub mod storage;
pub mod values;

use std::path::PathBuf;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::CommandError;
use crate::storage::Storage;

/// Where the local database and blob cache live.
///
/// `BRAGI_DATA_DIR` overrides the app data directory. It exists for the desktop
/// end-to-end harness (`scripts/selftest.mjs`), which points two launches at one
/// throwaway directory; nothing else sets it.
pub fn data_directory(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    if let Some(directory) = std::env::var_os("BRAGI_DATA_DIR") {
        return Ok(PathBuf::from(directory));
    }
    app.path()
        .app_data_dir()
        .map_err(|error| CommandError::io(error.to_string()))
}

/// The label of the window this process opens.
///
/// A harness launch opens the window the `selftest` capability is scoped to, so
/// the shipped `main` grant is never in play during a test run. Everything else
/// opens `main`, whose capability is the shipped one.
fn window_label() -> &'static str {
    #[cfg(feature = "selftest")]
    if std::env::var_os(selftest::PHASE).is_some() {
        return selftest::WINDOW;
    }
    "main"
}

/// Builds and runs the app.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[allow(
    clippy::print_stderr,
    reason = "the entry point: a failure here has no UI to report it in"
)]
pub fn run() {
    let result = tauri::Builder::default()
        .setup(|app| {
            let directory = data_directory(app.handle())?;
            app.manage(Storage::open(&directory)?);
            WebviewWindowBuilder::new(app, window_label(), WebviewUrl::App("index.html".into()))
                .title("Bragi")
                .inner_size(1280.0, 800.0)
                .build()?;
            Ok(())
        })
        .on_page_load(selftest::on_page_load)
        .invoke_handler(tauri::generate_handler![
            commands::db_query,
            commands::db_run,
            commands::db_transaction,
            commands::blob_put,
            commands::blob_get,
            commands::blob_has,
            commands::blob_delete,
            selftest::selftest_report,
        ])
        .run(tauri::generate_context!());

    if let Err(error) = result {
        eprintln!("bragi-desktop: the app could not start: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A fresh, empty directory under the system temp directory, unique per call.
    pub(crate) fn temp_dir(name: &str) -> std::io::Result<PathBuf> {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let directory =
            std::env::temp_dir().join(format!("bragi-{name}-{}-{unique}", std::process::id()));
        std::fs::remove_dir_all(&directory).ok();
        std::fs::create_dir_all(&directory)?;
        Ok(directory)
    }
}
