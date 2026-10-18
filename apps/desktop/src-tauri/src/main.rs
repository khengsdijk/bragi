//! The Tauri 2 desktop shell.
//!
//! Everything lives in the library crate, so `cargo test` covers it without a
//! display, and so the same crate can be built as a mobile entry point later
//! (01 §9).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    bragi_desktop::run();
}
