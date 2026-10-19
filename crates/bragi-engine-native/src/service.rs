//! The native engine service behind the Tauri commands
//! (`specs/03-audio-engine.md` §3.2).
//!
//! It wires the platform-free engine to the desktop host: symphonia decoding
//! into the mmap PCM cache, plan compilation, offline rendering, peak pyramids
//! and the 60 Hz state the webview polls. Live playback is a cpal stream started
//! by [`EngineService::start_playback`]; when the machine has no output device
//! the service keeps working for offline render and meters, and reports
//! `playback: false` so the UI can say so.
//!
//! The service is a plain Rust API, so `cargo test` covers it without a webview
//! or an audio device; `apps/desktop/src-tauri/src/engine.rs` is a thin
//! `invoke` shell over it.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use bragi_engine::SAMPLE_RATE;
use bragi_engine::engine::Engine;
use bragi_engine::offline::{OfflineOptions, render};
use bragi_engine::pcm::PcmSource;
use bragi_engine::peaks::PeakPyramid;
use bragi_engine::plan::{RenderPlan, compile, compile_delta, quality_for};
use bragi_engine::render::PreparedPlan;
use bragi_engine::rt::StateBlock;
use bragi_engine::transport::TransportState;
use bragi_model::AssetIndex;
use bragi_model::EngineDelta;
use bragi_model::generated::{AssetHash, Project};
use serde::Serialize;
use thiserror::Error;

use crate::output::{NativePlayer, OutputError};
use crate::pcm_cache::{MmapPcmCache, PcmCache};

/// Anything the service can fail with.
#[derive(Debug, Error)]
pub enum ServiceError {
    /// The PCM cache could not be read or written.
    #[error("pcm cache: {0}")]
    Cache(#[from] std::io::Error),
    /// Decoding an asset failed.
    #[error("decode: {0}")]
    Decode(String),
    /// A hash or mime string was malformed.
    #[error("invalid argument: {0}")]
    Argument(String),
    /// The render plan did not compile.
    #[error("plan: {0}")]
    Plan(#[from] bragi_engine::PlanError),
    /// The engine rejected a delta.
    #[error("engine: {0}")]
    Engine(#[from] bragi_engine::EngineError),
    /// No plan is loaded.
    #[error("no document is loaded")]
    NoDocument,
    /// The requested render kind is not implemented in v1.
    #[error("unsupported render job: {0}")]
    UnsupportedJob(String),
    /// Playback could not start.
    #[error("output: {0}")]
    Output(#[from] OutputError),
    /// An export job was rejected or could not be encoded.
    #[error("export: {0}")]
    Export(#[from] bragi_engine::export::ExportError),
}

/// One meter value as the UI reads it.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct MeterJson {
    /// Peak absolute amplitude.
    pub peak: f32,
    /// RMS amplitude.
    pub rms: f32,
}

/// The engine state the webview polls at 60 Hz (`EngineHost.onState`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStateJson {
    /// `stopped` | `playing` | `paused` | `looping` | `scrubbing`.
    pub transport: &'static str,
    /// Playhead in output samples.
    pub playhead: u64,
    /// Whether the audition overlay is active.
    pub auditioning: bool,
    /// The plan version.
    pub plan_version: u64,
    /// Total PCM underruns.
    pub underruns: u64,
    /// Per-track meters, in document order.
    pub tracks: Vec<MeterJson>,
    /// The master bus meters.
    pub master: MeterJson,
}

/// An offline render result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderJson {
    /// Always 2.
    pub channels: u8,
    /// Always 48 000.
    pub sample_rate: u32,
    /// Frames rendered.
    pub frames: u64,
    /// Interleaved samples.
    pub samples: Vec<f32>,
}

/// A playback thread that owns the (not-`Send`) cpal stream and takes transport
/// commands over a channel.
struct Playback {
    commands: Sender<serde_json::Value>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Playback {
    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // Dropping the sender also ends an idle `recv_timeout`.
        let _ = self.commands.send(serde_json::json!({ "kind": "noop" }));
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// The desktop engine host.
pub struct EngineService {
    plan: Option<RenderPlan>,
    document: Option<Project>,
    index: AssetIndex,
    cache: PcmCache,
    pcm: MmapPcmCache,
    engine: Engine,
    playback: Option<Playback>,
    state: Arc<StateBlock>,
    block: usize,
    playback_available: bool,
}

impl std::fmt::Debug for EngineService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EngineService")
            .field(
                "plan_version",
                &self.plan.as_ref().map(|plan| plan.plan_version),
            )
            .field("assets", &self.pcm.len())
            .field("playback", &self.playback.is_some())
            .finish()
    }
}

impl EngineService {
    /// Opens the service, creating `<data>/pcm` under `cache_dir`.
    ///
    /// # Errors
    /// [`ServiceError::Cache`] when the directory cannot be created.
    pub fn new(cache_dir: impl Into<PathBuf>, block: usize) -> Result<Self, ServiceError> {
        let cache = PcmCache::new(cache_dir.into().join("pcm"))?;
        let state = Arc::new(StateBlock::new(0, 0));
        let engine = Engine::new(empty_plan(block)?, block);
        Ok(Self {
            plan: None,
            document: None,
            index: AssetIndex::new(),
            cache,
            pcm: MmapPcmCache::new(),
            engine,
            playback: None,
            state,
            block,
            playback_available: false,
        })
    }

    /// Starts cpal playback for the loaded plan.
    ///
    /// Returns `false` (and stays usable for offline work) when the machine has
    /// no 48 kHz output device.
    ///
    /// # Errors
    /// [`ServiceError::NoDocument`] when nothing is loaded.
    pub fn start_playback(&mut self, buffer_frames: usize) -> Result<bool, ServiceError> {
        if self.plan.is_none() {
            return Err(ServiceError::NoDocument);
        }
        if self.playback.is_some() {
            self.playback_available = true;
            return Ok(true);
        }
        let plan = self.plan.clone().ok_or(ServiceError::NoDocument)?;
        let engine = Engine::new(plan, self.block);
        let pcm = self.pcm.clone();
        let state = Arc::clone(&self.state);
        let stop = Arc::new(AtomicBool::new(false));
        let (commands, receiver) = mpsc::channel::<serde_json::Value>();
        let (ready_tx, ready_rx) = mpsc::channel::<bool>();
        let thread_stop = Arc::clone(&stop);

        let handle = thread::Builder::new()
            .name("bragi-engine-audio".into())
            .spawn(move || {
                let source: Box<dyn PcmSource + Send> = Box::new(pcm);
                match NativePlayer::start(engine, source, state, buffer_frames) {
                    Ok(player) => {
                        let _ = ready_tx.send(true);
                        run_playback(player, &receiver, &thread_stop);
                    }
                    Err(error) => {
                        let _ = error;
                        let _ = ready_tx.send(false);
                    }
                }
            })
            .map_err(|error| ServiceError::Output(OutputError::Stream(error.to_string())))?;

        let ready = ready_rx.recv().unwrap_or(false);
        if !ready {
            stop.store(true, Ordering::Relaxed);
            let _ = handle.join();
            self.playback_available = false;
            return Ok(false);
        }
        self.playback = Some(Playback {
            commands,
            stop,
            handle: Some(handle),
        });
        self.playback_available = true;
        Ok(true)
    }

    /// Whether an output device was found.
    #[must_use]
    pub fn playback_available(&self) -> bool {
        self.playback_available
    }

    /// Decodes an asset, writes it to the mmap cache and registers its metadata.
    ///
    /// # Errors
    /// [`ServiceError::Decode`] / [`ServiceError::Argument`] / [`ServiceError::Cache`].
    pub fn register_asset(
        &mut self,
        hash: &str,
        bytes: &[u8],
        mime: &str,
    ) -> Result<(), ServiceError> {
        let hash: AssetHash =
            hash.parse()
                .map_err(|error: bragi_model::generated::error::ConversionError| {
                    ServiceError::Argument(error.to_string())
                })?;
        let extension = mime.rsplit('/').next();
        let decoded = bragi_engine::decode::decode_working_copy(bytes, extension)
            .map_err(|error| ServiceError::Decode(error.to_string()))?;
        self.pcm.insert_decoded(
            &self.cache,
            &hash,
            decoded.channels,
            decoded.sample_rate,
            &decoded.samples,
        )?;
        let meta = crate::asset_meta(
            hash.as_str(),
            mime,
            bytes.len() as u64,
            decoded.channels,
            decoded.sample_rate,
            decoded.frames(),
        )
        .map_err(|error| ServiceError::Argument(error.to_string()))?;
        self.index.insert(meta);
        Ok(())
    }

    /// Compiles and loads a document.
    ///
    /// # Errors
    /// [`ServiceError::Plan`].
    pub fn load_document(&mut self, doc: Project) -> Result<u64, ServiceError> {
        let version = self.plan.as_ref().map_or(1, |plan| plan.plan_version + 1);
        let plan = compile(&doc, &self.index, SAMPLE_RATE, version)?;
        self.install(plan, doc)
    }

    /// Applies a delta against the loaded document, recompiling only the
    /// affected tracks.
    ///
    /// The UI sends the delta from `bragi-model::diff`, which carries whole
    /// added/updated entities; the service merges them onto the stored document
    /// (so the caller does not have to ship the document again) and then uses
    /// the engine's delta compiler.
    ///
    /// # Errors
    /// [`ServiceError::NoDocument`] / [`ServiceError::Plan`].
    pub fn apply_delta(&mut self, delta: &EngineDelta) -> Result<u64, ServiceError> {
        let previous = self.plan.as_ref().ok_or(ServiceError::NoDocument)?;
        let document = merge_delta(
            self.document.as_ref().ok_or(ServiceError::NoDocument)?,
            delta,
        );
        let plan = compile_delta(previous, &document, &self.index, delta)?;
        self.install(plan, document)
    }

    fn install(&mut self, plan: RenderPlan, doc: Project) -> Result<u64, ServiceError> {
        let version = plan.plan_version;
        self.state = Arc::new(StateBlock::new(plan.tracks.len(), 0));
        self.plan = Some(plan.clone());
        self.document = Some(doc);
        self.engine.install(plan);
        // A plan reload stops playback; the UI restarts it.
        if let Some(mut playback) = self.playback.take() {
            playback.shutdown();
        }
        self.playback_available = false;
        Ok(version)
    }

    /// Applies a transport command, parsed from the UI's JSON.
    ///
    /// # Errors
    /// [`ServiceError::Argument`] when the command shape is unknown.
    pub fn transport(&mut self, cmd: &serde_json::Value) -> Result<(), ServiceError> {
        let kind = cmd
            .get("kind")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if !matches!(
            kind,
            "play"
                | "pause"
                | "stop"
                | "seek"
                | "scrubBegin"
                | "scrubTo"
                | "scrubEnd"
                | "audition"
                | "loop"
        ) {
            return Err(ServiceError::Argument(format!("unknown transport {kind}")));
        }
        if let Some(playback) = &self.playback {
            let _ = playback.commands.send(cmd.clone());
            return Ok(());
        }
        apply_transport(self.engine.transport_mut(), cmd);
        Ok(())
    }

    /// Applies (or clears) a transient preview patch, parsed from the UI's JSON
    /// (`specs/03-audio-engine.md` §5.3).
    ///
    /// A patch the engine does not implement (`fxParam`, `macro`) is ignored;
    /// those arrive with the FX work package.
    ///
    /// # Errors
    /// [`ServiceError::Argument`] when the shape is unknown.
    pub fn set_preview(&mut self, patch: Option<&serde_json::Value>) -> Result<(), ServiceError> {
        use bragi_engine::preview::PreviewPatch;
        let Some(patch) = patch else {
            self.engine.set_preview(None);
            return Ok(());
        };
        let kind = patch
            .get("kind")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let string = |key: &str| -> Result<String, ServiceError> {
            patch
                .get(key)
                .and_then(|value| value.as_str())
                .map(str::to_string)
                .ok_or_else(|| ServiceError::Argument(format!("{kind}: missing {key}")))
        };
        let preview = match kind {
            "trackGain" => PreviewPatch::TrackGain {
                track_id: string("trackId")?
                    .parse()
                    .map_err(|_| ServiceError::Argument("trackGain: bad trackId".into()))?,
                db: patch
                    .get("db")
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0),
            },
            "trackPan" => PreviewPatch::TrackPan {
                track_id: string("trackId")?
                    .parse()
                    .map_err(|_| ServiceError::Argument("trackPan: bad trackId".into()))?,
                pan: patch
                    .get("pan")
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0),
            },
            "trackMute" => PreviewPatch::TrackMute {
                track_id: string("trackId")?
                    .parse()
                    .map_err(|_| ServiceError::Argument("trackMute: bad trackId".into()))?,
                mute: patch
                    .get("mute")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
            },
            "clipOffset" => PreviewPatch::ClipOffset {
                clip_id: string("clipId")?
                    .parse()
                    .map_err(|_| ServiceError::Argument("clipOffset: bad clipId".into()))?,
                delta_samples: patch
                    .get("deltaSamples")
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or(0),
            },
            "moveSection" => PreviewPatch::MoveSection {
                section_id: string("sectionId")?
                    .parse()
                    .map_err(|_| ServiceError::Argument("moveSection: bad sectionId".into()))?,
                to_index: patch
                    .get("toIndex")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0) as usize,
            },
            "fxParam" | "macro" => {
                // Not implemented until the FX catalogue lands (WP-2.3).
                return Ok(());
            }
            other => return Err(ServiceError::Argument(format!("unknown preview {other}"))),
        };
        self.engine.set_preview(Some(preview));
        Ok(())
    }

    /// The 60 Hz state.
    #[must_use]
    pub fn state(&self) -> EngineStateJson {
        if self.playback.is_some() {
            return self.playback_state();
        }
        let transport = self.engine.transport();
        let meters = self.engine.meters();
        let tracks = (0..meters.len())
            .map(|index| {
                let meter = meters.track(index).copied().unwrap_or_default();
                MeterJson {
                    peak: meter.peak,
                    rms: meter.rms,
                }
            })
            .collect();
        EngineStateJson {
            transport: transport_name(transport.state()),
            playhead: transport.playhead(),
            auditioning: transport.is_auditioning(),
            plan_version: self.engine.plan_version(),
            underruns: self.engine.underruns(),
            tracks,
            master: MeterJson {
                peak: meters.master_peak(),
                rms: meters.master_rms(),
            },
        }
    }

    /// The state block the playback thread publishes (shared with the UI).
    #[must_use]
    pub fn state_block(&self) -> &Arc<StateBlock> {
        &self.state
    }

    /// Raw offline mixdown as interleaved `f32` (03 §9), for tests and the
    /// conformance harness. Hosts export files through [`EngineService::export`].
    ///
    /// # Errors
    /// [`ServiceError::NoDocument`], [`ServiceError::UnsupportedJob`].
    pub fn render(&mut self, job: &serde_json::Value) -> Result<RenderJson, ServiceError> {
        let plan = self.plan.as_ref().ok_or(ServiceError::NoDocument)?;
        let kind = job
            .get("kind")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if kind != "mixdown" {
            return Err(ServiceError::UnsupportedJob(kind.to_string()));
        }
        let start = job
            .get("startSample")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let frames = job
            .get("frames")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_else(|| plan.length_samples.saturating_sub(start));
        let options = OfflineOptions {
            start,
            frames: Some(frames),
            block: offline_block(),
            sample_rate: SAMPLE_RATE,
        };
        let output = render(plan, &self.pcm, &options);
        Ok(RenderJson {
            channels: 2,
            sample_rate: SAMPLE_RATE,
            frames: output.frames as u64,
            samples: output.samples,
        })
    }

    /// Encodes a `mixdown` or `stems` job (03 §9) to WAV or FLAC files.
    ///
    /// Stems render per track on the rayon pool. The job is the host's
    /// `RenderJob` JSON; see [`bragi_engine::export::run_job`].
    ///
    /// # Errors
    /// [`ServiceError::NoDocument`] and [`ServiceError::Export`].
    pub fn export(
        &self,
        job: &serde_json::Value,
    ) -> Result<bragi_engine::export::ExportResult, ServiceError> {
        let plan = self.plan.as_ref().ok_or(ServiceError::NoDocument)?;
        Ok(bragi_engine::export::run_job(plan, &self.pcm, job)?)
    }

    /// The peak pyramid for an asset, in the cache byte format (03 §10).
    ///
    /// # Errors
    /// [`ServiceError::Argument`] for a bad hash.
    pub fn peaks(&self, asset: &str) -> Result<Vec<u8>, ServiceError> {
        let hash: AssetHash =
            asset
                .parse()
                .map_err(|error: bragi_model::generated::error::ConversionError| {
                    ServiceError::Argument(error.to_string())
                })?;
        let path = self.cache.path(&hash);
        let bytes = std::fs::read(path)?;
        let samples: Vec<f32> = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|chunk| f32::from_le_bytes(*chunk))
            .collect();
        let channels = self
            .index
            .get(&hash)
            .map_or(2, |meta| u16::try_from(meta.channels.get()).unwrap_or(2));
        Ok(PeakPyramid::compute(&samples, channels).to_bytes())
    }

    /// The state published by the playback thread's shared block.
    fn playback_state(&self) -> EngineStateJson {
        let (code, auditioning, playhead) = self.state.transport();
        let mut words = vec![0u32; self.state.word_count()];
        let written = self.state.snapshot(&mut words);
        let meter_words = &words[..written];
        let header = bragi_engine::rt::STATE_HEADER_WORDS;
        let track_words = written.saturating_sub(header + 2);
        let track_count = track_words / 2;
        let read = |offset: usize| {
            bragi_engine::meters::Meters::word_to_f32(meter_words.get(offset).copied().unwrap_or(0))
        };
        let tracks = (0..track_count)
            .map(|index| MeterJson {
                peak: read(header + index * 2),
                rms: read(header + index * 2 + 1),
            })
            .collect();
        let master_index = header + track_count * 2;
        EngineStateJson {
            transport: transport_name_from_code(code),
            playhead,
            auditioning,
            plan_version: self.plan.as_ref().map_or(0, |plan| plan.plan_version),
            underruns: self.engine.underruns(),
            tracks,
            master: MeterJson {
                peak: read(master_index),
                rms: read(master_index + 1),
            },
        }
    }

    /// Stops playback and releases the engine. The cache stays on disk.
    pub fn dispose(&mut self) {
        if let Some(mut playback) = self.playback.take() {
            playback.shutdown();
        }
        self.playback_available = false;
    }

    /// A prepared plan for hosts that want to inspect it (tests, diagnostics).
    #[must_use]
    pub fn prepared(&self) -> Option<PreparedPlan> {
        self.plan
            .as_ref()
            .map(|plan| PreparedPlan::new(Arc::new(plan.clone()), quality_for(false)))
    }

    /// The loaded document, if any.
    #[must_use]
    pub fn document(&self) -> Option<&Project> {
        self.document.as_ref()
    }

    /// The mmap PCM source (tests read through it).
    #[must_use]
    pub fn pcm(&self) -> &MmapPcmCache {
        &self.pcm
    }
}

/// Merges the whole entities an [`EngineDelta`] carries onto `doc`.
fn merge_delta(doc: &Project, delta: &EngineDelta) -> Project {
    let mut next = doc.clone();
    next.id = delta.project_id.clone();
    next.tracks
        .retain(|track| !delta.tracks_removed.contains(&track.id));
    for track in &delta.tracks_added {
        next.tracks.push(track.clone());
    }
    for track in &delta.tracks_updated {
        if let Some(slot) = next.tracks.iter_mut().find(|slot| slot.id == track.id) {
            *slot = track.clone();
        }
    }
    next.arrangement
        .sections
        .retain(|section| !delta.sections_removed.contains(&section.id));
    for section in &delta.sections_added {
        next.arrangement.sections.push(section.clone());
    }
    for section in &delta.sections_updated {
        if let Some(slot) = next
            .arrangement
            .sections
            .iter_mut()
            .find(|slot| slot.id == section.id)
        {
            *slot = section.clone();
        }
    }
    next.sources
        .retain(|source| !delta.sources_removed.contains(&source.id));
    for source in &delta.sources_added {
        next.sources.push(source.clone());
    }
    next
}

fn transport_name(state: TransportState) -> &'static str {
    match state {
        TransportState::Stopped => "stopped",
        TransportState::Playing => "playing",
        TransportState::Paused => "paused",
        TransportState::Looping => "looping",
        TransportState::Scrubbing => "scrubbing",
    }
}

fn transport_name_from_code(code: u32) -> &'static str {
    match code {
        1 => "playing",
        2 => "paused",
        3 => "looping",
        4 => "scrubbing",
        _ => "stopped",
    }
}

/// Applies a transport command to a live transport.
fn apply_transport(transport: &mut bragi_engine::transport::Transport, cmd: &serde_json::Value) {
    let kind = cmd
        .get("kind")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let sample = |key: &str| -> u64 {
        cmd.get(key)
            .and_then(serde_json::Value::as_u64)
            .or_else(|| {
                cmd.get(key)
                    .and_then(serde_json::Value::as_f64)
                    .map(|value| value.max(0.0) as u64)
            })
            .unwrap_or(0)
    };
    match kind {
        "play" => transport.play(),
        "pause" => transport.pause(),
        "stop" => transport.stop(),
        "seek" => transport.seek(sample("sample")),
        "scrubBegin" => transport.scrub_begin(),
        "scrubTo" => transport.scrub_to(sample("sample")),
        "scrubEnd" => transport.scrub_end(),
        "audition" => transport.set_auditioning(
            cmd.get("on")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        ),
        "loop" => {
            if cmd.get("end").is_none_or(serde_json::Value::is_null) {
                transport.set_loop(None);
            } else {
                transport.set_loop(Some((sample("start"), sample("end"))));
            }
        }
        _ => {}
    }
}

/// The playback thread's loop: translate JSON commands into `NativePlayer`
/// calls until the service shuts it down.
fn run_playback(player: NativePlayer, receiver: &Receiver<serde_json::Value>, stop: &AtomicBool) {
    while !stop.load(Ordering::Relaxed) {
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(cmd) => apply_player_command(&player, &cmd),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn apply_player_command(player: &NativePlayer, cmd: &serde_json::Value) {
    let kind = cmd
        .get("kind")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let sample = |key: &str| -> u64 {
        cmd.get(key)
            .and_then(serde_json::Value::as_u64)
            .or_else(|| {
                cmd.get(key)
                    .and_then(serde_json::Value::as_f64)
                    .map(|value| value.max(0.0) as u64)
            })
            .unwrap_or(0)
    };
    match kind {
        "play" => {
            player.play();
        }
        "pause" => {
            player.pause();
        }
        "stop" => {
            player.stop();
        }
        "seek" => {
            player.seek(sample("sample"));
        }
        "loop" => {
            if cmd.get("end").is_none_or(serde_json::Value::is_null) {
                player.clear_loop();
            } else {
                player.set_loop(sample("start"), sample("end"));
            }
        }
        "audition" => {
            player.set_auditioning(
                cmd.get("on")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
            );
        }
        _ => {}
    }
}

/// The offline render block size (`bragi-engine`'s default).
#[must_use]
pub fn offline_block() -> usize {
    bragi_engine::offline::OFFLINE_BLOCK
}

fn empty_plan(block: usize) -> Result<RenderPlan, bragi_engine::PlanError> {
    let _ = block;
    let doc: Project = serde_json::from_value(serde_json::json!({
        "schemaVersion": 1,
        "id": "prj_empty",
        "meta": { "title": "empty", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
        "sources": [], "analyses": {}, "tracks": [],
        "arrangement": {
            "timebase": { "ppq": 960,
                "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }],
                "timeSignatures": [] },
            "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 }
        }
    }))
    .unwrap_or_else(|_| unreachable!("the empty project literal is valid"));
    compile(&doc, &AssetIndex::new(), SAMPLE_RATE, 1)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn wav(samples: &[i16], channels: u16) -> Vec<u8> {
        let data_len = (samples.len() * 2) as u32;
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&channels.to_le_bytes());
        out.extend_from_slice(&48_000u32.to_le_bytes());
        out.extend_from_slice(&(48_000u32 * u32::from(channels) * 2).to_le_bytes());
        out.extend_from_slice(&(channels * 2).to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        for sample in samples {
            out.extend_from_slice(&sample.to_le_bytes());
        }
        out
    }

    fn hash(byte: char) -> String {
        format!("sha256:{}", byte.to_string().repeat(64))
    }

    fn document(hash: &str) -> Project {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "id": "prj_01",
            "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
            "sources": [], "analyses": {},
            "tracks": [{ "id": "trk_01", "name": "T", "role": "full_mix", "color": "#8A8F98",
                         "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": [] }],
            "arrangement": { "timebase": { "ppq": 960,
                "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }], "timeSignatures": [] },
                "sections": [{ "id": "sec_a", "kind": "intro", "label": "A", "lengthTicks": 1920,
                    "lanes": { "trk_01": { "clips": [{ "id": "clp_01",
                        "asset": hash, "srcStart": 0, "srcEnd": 24000, "start": 0,
                        "warp": { "mode": "none" }, "gainDb": 0, "pitchSemitones": 0,
                        "fadeInTicks": 0, "fadeOutTicks": 0, "fadeCurve": "equal_power",
                        "provenance": { "kind": "user", "createdAt": "2026-10-18T12:00:00Z" } }],
                        "automation": [] } }, "transitionIn": { "kind": "cut", "lengthTicks": 0 } }],
                "master": { "fx": [], "automation": [], "gainDb": 0 } }
        }))
        .unwrap()
    }

    fn service() -> (EngineService, String, tempdir::TempDir) {
        let dir = tempdir::TempDir::new();
        let service = EngineService::new(dir.path(), 512).unwrap();
        (service, hash('0'), dir)
    }

    #[test]
    fn registers_decodes_renders_and_reports_state() {
        let (mut service, hash, _dir) = service();
        let samples = vec![1000i16; 48_000 * 2];
        service
            .register_asset(&hash, &wav(&samples, 2), "audio/wav")
            .unwrap();
        let version = service.load_document(document(&hash)).unwrap();
        assert_eq!(version, 1);
        let state = service.state();
        assert_eq!(state.transport, "stopped");
        assert_eq!(state.plan_version, 1);
        assert_eq!(state.tracks.len(), 1);

        let rendered = service
            .render(&serde_json::json!({ "kind": "mixdown", "format": { "container": "wav", "bits": 32 } }))
            .unwrap();
        assert_eq!(rendered.frames, 48_000);
        assert!(rendered.samples.iter().all(|sample| sample.is_finite()));
        assert!(rendered.samples[0] > 0.0);

        service
            .transport(&serde_json::json!({ "kind": "play" }))
            .unwrap();
        assert_eq!(service.state().transport, "playing");
        service
            .transport(&serde_json::json!({ "kind": "seek", "sample": 1000 }))
            .unwrap();
        assert_eq!(service.state().playhead, 1000);

        let peaks = service.peaks(&hash).unwrap();
        assert!(peaks.starts_with(b"BRGP"));
    }

    #[test]
    fn missing_pcm_renders_silence_instead_of_failing() {
        let (mut service, _hash, _dir) = service();
        let hash = hash('1');
        // Register metadata without writing any PCM by decoding a silent file
        // and then rendering a clip beyond it: the cache has the file, so the
        // clip just runs past its end.
        service
            .register_asset(&hash, &wav(&[0i16; 4], 1), "audio/wav")
            .unwrap();
        service.load_document(document(hash.as_str())).unwrap();
        let rendered = service
            .render(&serde_json::json!({ "kind": "mixdown" }))
            .unwrap();
        assert!(rendered.samples.iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn unknown_render_kinds_are_rejected() {
        let (mut service, hash, _dir) = service();
        service
            .register_asset(&hash, &wav(&[0i16; 8], 2), "audio/wav")
            .unwrap();
        service.load_document(document(&hash)).unwrap();
        assert!(matches!(
            service.render(&serde_json::json!({ "kind": "stems" })),
            Err(ServiceError::UnsupportedJob(_))
        ));
    }

    #[test]
    fn exports_flac_mixdowns_and_wav_stems_through_the_mmap_cache() {
        let (mut service, hash, _dir) = service();
        let samples = vec![1000i16; 48_000 * 2];
        service
            .register_asset(&hash, &wav(&samples, 2), "audio/wav")
            .unwrap();
        service.load_document(document(&hash)).unwrap();

        let raw = service
            .render(&serde_json::json!({ "kind": "mixdown" }))
            .unwrap();
        let mix = service
            .export(&serde_json::json!({
                "kind": "mixdown",
                "format": { "container": "flac", "bits": 24 },
                "meta": { "title": "Native" }
            }))
            .unwrap();
        assert_eq!(mix.files.len(), 1);
        assert_eq!(mix.files[0].name, "Native.flac");
        let decoded =
            bragi_engine::decode::decode_bytes(&mix.files[0].bytes, Some("flac")).unwrap();
        assert_eq!(decoded.samples.len(), raw.samples.len());
        let level = bragi_engine::offline::null_level_dbfs(&decoded.samples, &raw.samples);
        assert!(level <= -130.0, "flac vs raw render: {level} dBFS");

        let stems = service
            .export(&serde_json::json!({
                "kind": "stems", "tracks": "all",
                "format": { "container": "wav", "bits": 16 }
            }))
            .unwrap();
        assert_eq!(stems.files.len(), 1);
        assert_eq!(stems.files[0].name, "01-T.wav");

        let frame = stems.to_frame();
        assert_eq!(&frame[0..4], b"BXPT");

        assert!(matches!(
            service.export(&serde_json::json!({ "kind": "context" })),
            Err(ServiceError::Export(_))
        ));
    }

    /// A tiny temporary directory helper (no new dependency).
    #[allow(unreachable_pub)]
    mod tempdir {
        use std::path::{Path, PathBuf};

        pub struct TempDir(PathBuf);

        impl TempDir {
            pub fn new() -> Self {
                let path = std::env::temp_dir()
                    .join(format!("bragi-service-{}", std::process::id()))
                    .join(format!("{}", crate::service::tests::unique()));
                std::fs::create_dir_all(&path).unwrap();
                Self(path)
            }

            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    fn unique() -> u128 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        u128::from(NEXT.fetch_add(1, Ordering::Relaxed))
    }
}
