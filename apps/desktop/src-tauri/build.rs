//! Tauri's build step: reads `tauri.conf.json`, checks the capabilities and
//! emits the code `tauri::generate_context!` expands.
//!
//! `AppManifest::commands` is what puts the app's own commands into the ACL
//! (01 §10): with it, every command below needs an explicit `allow-…` grant in
//! a capability, and a command added without one is denied at runtime instead of
//! quietly reachable. The capability files name the window labels they apply to;
//! `selftest_report` is granted to the harness window only.

fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=capabilities");
    println!("cargo:rerun-if-changed=icons");

    run();
}

#[allow(
    clippy::expect_used,
    reason = "a build script has no other way to report a Tauri misconfiguration; the panic message is the build error"
)]
fn run() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "db_query",
            "db_run",
            "db_transaction",
            "blob_put",
            "blob_get",
            "blob_has",
            "blob_delete",
            "engine_init",
            "engine_load_document",
            "engine_apply_delta",
            "engine_transport",
            "engine_set_preview",
            "engine_state",
            "engine_render",
            "engine_peaks",
            "engine_dispose",
            "selftest_report",
        ]),
    ))
    .expect("failed to run tauri-build");
}
