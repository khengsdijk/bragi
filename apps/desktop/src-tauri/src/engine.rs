//! The engine commands the desktop engine host calls
//! (`specs/03-audio-engine.md` §3.2, `packages/platform/src/tauri/engine.ts`).
//!
//! A thin shell: everything real lives in `bragi-engine-native::service`, which
//! `cargo test` covers without a webview or an audio device. Each command
//! crosses the IPC as JSON and rejects with [`CommandError`].
//!
//! The command names are declared in `build.rs`, so the ACL grants them
//! explicitly ([01 §10](../../../../specs/01-architecture.md)).

use std::sync::Mutex;

use tauri::State;

use crate::error::CommandError;

/// The managed engine service.
pub struct EngineState(pub Mutex<bragi_engine_native::EngineService>);

fn lock<'a>(
    state: &'a State<'_, EngineState>,
) -> Result<std::sync::MutexGuard<'a, bragi_engine_native::EngineService>, CommandError> {
    state
        .0
        .lock()
        .map_err(|error| CommandError::io(error.to_string()))
}

fn engine_error(error: bragi_engine_native::ServiceError) -> CommandError {
    CommandError::invalid(error.to_string())
}

/// Starts (or restarts) native playback. Returns `{ playback: bool }`, where
/// `false` means no output device was found but offline work still functions.
#[tauri::command]
pub fn engine_init(
    state: State<'_, EngineState>,
    buffer_frames: Option<usize>,
) -> Result<serde_json::Value, CommandError> {
    let mut service = lock(&state)?;
    let playback = service
        .start_playback(buffer_frames.unwrap_or(256))
        .unwrap_or(false);
    Ok(serde_json::json!({ "playback": playback }))
}

/// Compiles and loads a project document.
#[tauri::command]
pub fn engine_load_document(
    state: State<'_, EngineState>,
    doc: serde_json::Value,
) -> Result<serde_json::Value, CommandError> {
    let document: bragi_model::generated::Project = serde_json::from_value(doc)
        .map_err(|error| CommandError::invalid(format!("invalid document: {error}")))?;
    let mut service = lock(&state)?;
    let version = service.load_document(document).map_err(engine_error)?;
    Ok(serde_json::json!({ "planVersion": version }))
}

/// Applies a delta to the loaded document.
#[tauri::command]
pub fn engine_apply_delta(
    state: State<'_, EngineState>,
    delta: serde_json::Value,
) -> Result<serde_json::Value, CommandError> {
    let delta: bragi_model::EngineDelta = serde_json::from_value(delta)
        .map_err(|error| CommandError::invalid(format!("invalid delta: {error}")))?;
    let mut service = lock(&state)?;
    let version = service.apply_delta(&delta).map_err(engine_error)?;
    Ok(serde_json::json!({ "planVersion": version }))
}

/// Applies a transport command.
#[tauri::command]
pub fn engine_transport(
    state: State<'_, EngineState>,
    cmd: serde_json::Value,
) -> Result<(), CommandError> {
    let mut service = lock(&state)?;
    service.transport(&cmd).map_err(engine_error)
}

/// Warms a candidate document in slot 1–3 for A/B audition (03 §5.4).
#[tauri::command]
pub fn engine_warm(
    state: State<'_, EngineState>,
    slot: usize,
    doc: serde_json::Value,
) -> Result<(), CommandError> {
    let document: bragi_model::generated::Project = serde_json::from_value(doc)
        .map_err(|error| CommandError::invalid(format!("invalid document: {error}")))?;
    let mut service = lock(&state)?;
    service.warm(slot, &document).map_err(engine_error)
}

/// Drops the candidate in slot 1–3.
#[tauri::command]
pub fn engine_release(state: State<'_, EngineState>, slot: usize) -> Result<(), CommandError> {
    let mut service = lock(&state)?;
    service.release_slot(slot).map_err(engine_error)
}

/// Crossfades to a warm slot (0 = the main plan) over 30 ms.
#[tauri::command]
pub fn engine_audition(state: State<'_, EngineState>, slot: usize) -> Result<(), CommandError> {
    let mut service = lock(&state)?;
    service.audition(slot).map_err(engine_error)
}

/// Applies (or clears) a transient preview patch.
#[tauri::command]
pub fn engine_set_preview(
    state: State<'_, EngineState>,
    patch: Option<serde_json::Value>,
) -> Result<(), CommandError> {
    let mut service = lock(&state)?;
    service.set_preview(patch.as_ref()).map_err(engine_error)
}

/// The 60 Hz engine state.
#[tauri::command]
pub fn engine_state(
    state: State<'_, EngineState>,
) -> Result<bragi_engine_native::service::EngineStateJson, CommandError> {
    let service = lock(&state)?;
    Ok(service.state())
}

/// Offline export (03 §9): WAV/FLAC mixdown or per-track stems.
///
/// The reply is one binary export frame (`ExportResult::to_frame`) sent as a
/// raw IPC response, so megabytes of audio never become a JSON number array.
#[tauri::command]
pub fn engine_render(
    state: State<'_, EngineState>,
    job: serde_json::Value,
) -> Result<tauri::ipc::Response, CommandError> {
    let service = lock(&state)?;
    let exported = service.export(&job).map_err(engine_error)?;
    Ok(tauri::ipc::Response::new(exported.to_frame()))
}

/// The peak pyramid for an asset, as raw bytes (03 §10).
#[tauri::command]
pub fn engine_peaks(
    state: State<'_, EngineState>,
    asset: String,
    // The full pyramid is returned; the level is picked on the TS side
    // (`pyramidLevel`), so this is accepted and ignored.
    level: Option<u32>,
) -> Result<Vec<u8>, CommandError> {
    let _ = level;
    let service = lock(&state)?;
    service.peaks(&asset).map_err(engine_error)
}

/// Stops playback and releases the engine.
#[tauri::command]
pub fn engine_dispose(state: State<'_, EngineState>) -> Result<(), CommandError> {
    let mut service = lock(&state)?;
    service.dispose();
    Ok(())
}
