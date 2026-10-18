//! The desktop end-to-end harness (WP-0.5).
//!
//! WKWebView has no WebDriver, so `tauri-driver` cannot drive the app on macOS.
//! Instead a `selftest` **cargo feature** compiles this module in, and
//! `apps/desktop/scripts/selftest.mjs` launches the app twice against one
//! throwaway data directory:
//!
//! 1. `BRAGI_SELFTEST_PHASE=create` — the app is built with
//!    `--features selftest`, a page load evaluates the driver bundle named by
//!    `BRAGI_SELFTEST_SCRIPT`, which clicks through the real UI, creates a
//!    project and reads it back after a reload.
//! 2. `BRAGI_SELFTEST_PHASE=read` — a **second process launch** against the same
//!    data directory. The driver asserts the project and its stored card are
//!    still there, which is the part a reload cannot prove: the database and the
//!    blob cache were reopened from disk by a new process.
//!
//! The driver reports through [`selftest_report`], which prints the transcript to
//! stdout and exits 0 (pass) or 1 (fail). The capability that grants that command
//! is scoped to a window label no normal build creates, so a normal build cannot
//! reach it at all. Without the feature the command only returns an error.

#![allow(
    clippy::print_stderr,
    clippy::print_stdout,
    reason = "the harness owns the process's console: its transcript is the test report"
)]

#[cfg(feature = "selftest")]
use std::io::Write;
#[cfg(feature = "selftest")]
use std::path::Path;

#[cfg(feature = "selftest")]
use tauri::webview::PageLoadEvent;
use tauri::webview::PageLoadPayload;
use tauri::{AppHandle, Webview};

use crate::error::CommandError;

/// Environment variable naming the phase; absent means "not a selftest run".
pub const PHASE: &str = "BRAGI_SELFTEST_PHASE";
/// Environment variable naming the compiled driver bundle.
pub const SCRIPT: &str = "BRAGI_SELFTEST_SCRIPT";

/// The window label the selftest harness uses. `capabilities/selftest.json`
/// grants the reporting command to this label only, and `tauri.conf.json`
/// defines no such window, so the grant is inert everywhere else.
pub const WINDOW: &str = "selftest";

/// Evaluates the driver bundle after every page load, when this process was
/// launched by the harness.
pub fn on_page_load(webview: &Webview, payload: &PageLoadPayload<'_>) {
    #[cfg(feature = "selftest")]
    {
        if payload.event() != PageLoadEvent::Finished {
            return;
        }
        if webview.label() != WINDOW {
            return;
        }
        let Ok(phase) = std::env::var(PHASE) else {
            return;
        };
        let Ok(script_path) = std::env::var(SCRIPT) else {
            eprintln!("[selftest] {PHASE} is set but {SCRIPT} is not");
            std::process::exit(1);
        };
        match driver_call(&script_path, &phase) {
            Ok(call) => {
                if let Err(error) = webview.eval(&call) {
                    eprintln!("[selftest] could not evaluate the driver: {error}");
                    std::process::exit(1);
                }
            }
            Err(message) => {
                eprintln!("[selftest] {message}");
                std::process::exit(1);
            }
        }
    }
    #[cfg(not(feature = "selftest"))]
    {
        let _ = (webview, payload);
    }
}

#[cfg(feature = "selftest")]
fn driver_call(script_path: &str, phase: &str) -> Result<String, String> {
    let script = std::fs::read_to_string(Path::new(script_path))
        .map_err(|error| format!("could not read {script_path}: {error}"))?;
    let phase = serde_json::to_string(phase).map_err(|error| error.to_string())?;
    // The bundle defines `BragiSelftest.main(phase)`, which builds the in-page
    // driver, runs the shared scenario and reports through `selftest_report`.
    Ok(format!("{script}\nvoid BragiSelftest.main({phase});"))
}

/// Prints the driver's transcript and ends the process with its verdict.
///
/// Only reachable from the `selftest` window label (see [`WINDOW`]).
#[tauri::command]
#[allow(clippy::print_stdout)]
pub fn selftest_report(app: AppHandle, ok: bool, lines: Vec<String>) -> Result<(), CommandError> {
    #[cfg(feature = "selftest")]
    {
        for line in &lines {
            println!("[selftest] {line}");
        }
        println!("[selftest] {}", if ok { "PASS" } else { "FAIL" });
        let _ = std::io::stdout().flush();
        app.exit(i32::from(!ok));
        Ok(())
    }
    #[cfg(not(feature = "selftest"))]
    {
        let _ = (app, ok, lines);
        Err(CommandError::invalid("this build has no selftest harness"))
    }
}

#[cfg(all(test, feature = "selftest"))]
mod tests {
    #![allow(
        clippy::expect_used,
        clippy::unwrap_used,
        reason = "tests: a failed expectation is the failure report (13 §3)"
    )]

    use super::*;

    #[test]
    fn builds_a_call_that_reads_the_script_and_passes_the_phase() {
        // The script path is the only input; the phase is JSON-encoded so a
        // hostile value cannot break out of the call.
        let directory =
            crate::test_support::temp_dir("selftest-script").expect("a temporary directory");
        let script = directory.join("driver.js");
        std::fs::write(&script, "var BragiSelftest = {};").expect("writes");
        let call = driver_call(&script.to_string_lossy(), "create").expect("a call");
        assert!(call.contains("var BragiSelftest"));
        assert!(call.contains("BragiSelftest.main(\"create\")"));
    }

    #[test]
    fn refuses_a_missing_script() {
        assert!(driver_call("/nonexistent/bragi-driver.js", "create").is_err());
    }
}
