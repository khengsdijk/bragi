//! Browser glue for `bragi_engine`: `wasm-bindgen` bindings for the AudioWorklet
//! and the decoder worker (`specs/03-audio-engine.md` §3.1).
//!
//! The same `bragi-engine` runs here, so a render made in Node from this module
//! nulls against the native binary at ≤ −90 dBFS (`pnpm test:conformance`).
//!
//! # Surface
//!
//! [`EngineWasm`] is a handle-based wrapper, the same shape as
//! `packages/model-wasm`:
//!
//! | Call | Who |
//! |---|---|
//! | `new(block)` | main thread / worker |
//! | `decode_asset(bytes, mime)` | decoder worker (symphonia, off the audio thread) |
//! | `add_asset(hash, bytes, mime)` | tests and the conformance harness (decode + register) |
//! | `add_asset_pcm(hash, samples, channels, rate)` | AudioWorklet: registers PCM decoded in the worker |
//! | `load_project(json)` / `apply_delta(json)` | main thread after a commit |
//! | `process(left, right)` | AudioWorklet, one quantum |
//! | `transport(cmd, value)` | main thread, drained in the worklet |
//! | `state_words()` | AudioWorklet, written into the SharedArrayBuffer |
//! | `render(start, frames, block)` | offline render in a worker |
//! | `export_frame(jobJson)` | WAV/FLAC mixdown or stems, one binary export frame |
//! | `peaks(hash)` | waveform pyramids for the canvas |
//!
//! `process` uses `wasm-bindgen`'s `&mut [f32]` conversion, which copies into and
//! out of linear memory. The worklet's production path will point the engine at
//! its own `SharedArrayBuffer` views instead; that is a host-integration detail
//! recorded in `docs/wp/1.1.md`.

use wasm_bindgen::prelude::*;

use bragi_engine::engine::Engine;
use bragi_engine::offline::{OfflineOptions, render};
use bragi_engine::pcm::{MemoryPcm, PcmBuffer};
use bragi_engine::peaks::PeakPyramid;
use bragi_engine::plan::compile;
use bragi_engine::rt::StateBlock;
use bragi_engine::transport::TransportState;
use bragi_engine::{ENGINE_VERSION, QUANTUM_FRAMES, SAMPLE_RATE};
use bragi_model::AssetIndex;
use bragi_model::generated::AssetHash;

/// Transport opcodes shared with the TypeScript host (`TransportCmd`).
pub const TRANSPORT_PLAY: u32 = 0;
/// Pause.
pub const TRANSPORT_PAUSE: u32 = 1;
/// Stop and rewind.
pub const TRANSPORT_STOP: u32 = 2;
/// Seek to a sample (the `value` argument).
pub const TRANSPORT_SEEK: u32 = 3;
/// Set the loop region: `value` is the start, `value2` the end.
pub const TRANSPORT_LOOP: u32 = 4;
/// Clear the loop region.
pub const TRANSPORT_LOOP_CLEAR: u32 = 5;
/// Enable or disable the audition overlay.
pub const TRANSPORT_AUDITION: u32 = 6;

/// The browser engine handle.
#[wasm_bindgen]
pub struct EngineWasm {
    engine: Engine,
    index: AssetIndex,
    pcm: MemoryPcm,
    state: StateBlock,
    meter_words: Vec<u32>,
    block: usize,
}

#[wasm_bindgen]
impl EngineWasm {
    /// Creates an engine with an empty plan, processing `block` frames at a
    /// time (the AudioWorklet uses 128).
    #[wasm_bindgen(constructor)]
    #[must_use]
    #[allow(clippy::expect_used)] // an empty project is a fixed literal; see `empty_project`
    pub fn new(block: usize) -> EngineWasm {
        let block = if block == 0 { QUANTUM_FRAMES } else { block };
        let empty = empty_project();
        let plan = compile(&empty, &AssetIndex::new(), SAMPLE_RATE, 1)
            .expect("an empty project always compiles");
        let state = StateBlock::new(0, 0);
        let meter_words = vec![0u32; state.word_count()];
        EngineWasm {
            engine: Engine::new(plan, block),
            index: AssetIndex::new(),
            pcm: MemoryPcm::new(),
            state,
            meter_words,
            block,
        }
    }

    /// Registers PCM that the decoder worker already decoded.
    ///
    /// The AudioWorklet receives PCM in a `load` message and copies it here; it
    /// never decodes. A hash that is already loaded is ignored, so the host can
    /// re-send a document without touching the audio thread's memory.
    ///
    /// # Errors
    /// A JavaScript `Error` when the hash cannot be parsed.
    pub fn add_asset_pcm(
        &mut self,
        hash: &str,
        samples: Vec<f32>,
        channels: u16,
        sample_rate: u32,
    ) -> Result<(), JsError> {
        let hash: AssetHash = hash
            .parse()
            .map_err(|error| JsError::new(&format!("bad asset hash: {error}")))?;
        if self.pcm.get(&hash).is_some() {
            return Ok(());
        }
        let channels = channels.max(1);
        let sample_rate = sample_rate.max(1);
        let frames = (samples.len() / usize::from(channels)) as u64;
        let meta = bragi_model::generated::AssetMeta {
            // The compressed size is not known here; PCM is four bytes per sample.
            bytes: (samples.len() as u64).saturating_mul(4),
            channels: std::num::NonZeroU64::new(u64::from(channels))
                .unwrap_or(std::num::NonZeroU64::MIN),
            derived_from: None,
            duration_samples: frames,
            hash: hash.clone(),
            mime: "audio/wav"
                .parse()
                .map_err(|error| JsError::new(&format!("bad mime: {error}")))?,
            sample_rate: std::num::NonZeroU64::new(u64::from(sample_rate))
                .unwrap_or(std::num::NonZeroU64::MIN),
        };
        self.index.insert(meta);
        self.pcm
            .insert(hash, PcmBuffer::new(samples, channels, sample_rate));
        Ok(())
    }

    /// Decodes an asset (FLAC/WAV/MP3/AAC/OGG/M4A) and registers it.
    ///
    /// Kept for tests and the conformance harness. The browser host decodes in
    /// its worker ([`decode_asset`]) and registers the PCM with
    /// [`EngineWasm::add_asset_pcm`], so the audio thread never decodes.
    ///
    /// # Errors
    /// A JavaScript `Error` when decoding or hash parsing fails.
    pub fn add_asset(&mut self, hash: &str, bytes: &[u8], mime: &str) -> Result<(), JsError> {
        let hash: AssetHash = hash
            .parse()
            .map_err(|error| JsError::new(&format!("bad asset hash: {error}")))?;
        let decoded = bragi_engine::decode::decode_working_copy(bytes, mime.rsplit('/').next())
            .map_err(|error| JsError::new(&format!("decoding failed: {error}")))?;
        let channels = u64::from(decoded.channels.max(1));
        let sample_rate = u64::from(decoded.sample_rate.max(1));
        let frames = decoded.frames();
        let meta = bragi_model::generated::AssetMeta {
            bytes: bytes.len() as u64,
            channels: std::num::NonZeroU64::new(channels).unwrap_or(std::num::NonZeroU64::MIN),
            derived_from: None,
            duration_samples: frames,
            hash: hash.clone(),
            mime: mime
                .parse()
                .map_err(|error| JsError::new(&format!("bad mime: {error}")))?,
            sample_rate: std::num::NonZeroU64::new(sample_rate)
                .unwrap_or(std::num::NonZeroU64::MIN),
        };
        self.index.insert(meta);
        self.pcm.insert(
            hash,
            PcmBuffer::new(decoded.samples, decoded.channels, decoded.sample_rate),
        );
        Ok(())
    }

    /// Compiles and loads a project document (the full-load path of
    /// `EngineHost.loadDocument`, `specs/03-audio-engine.md` §3.3).
    ///
    /// # Errors
    /// A JavaScript `Error` when the JSON is invalid or does not compile.
    pub fn load_project(&mut self, json: &str) -> Result<(), JsError> {
        let doc: bragi_model::generated::Project = serde_json::from_str(json)
            .map_err(|error| JsError::new(&format!("invalid project: {error}")))?;
        let version = self.engine.plan().plan_version + 1;
        let plan = compile(&doc, &self.index, SAMPLE_RATE, version)
            .map_err(|error| JsError::new(&format!("plan failed: {error}")))?;
        self.engine.install(plan);
        self.state = StateBlock::new(self.engine.plan().tracks.len(), 0);
        self.meter_words = vec![0u32; self.state.word_count()];
        Ok(())
    }

    /// Renders one live block into `left`/`right` (one `Float32Array` each).
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        self.engine.process(&self.pcm, &mut [left, right]);
    }

    /// Applies a transport command.
    pub fn transport(&mut self, cmd: u32, value: f64, value2: f64) {
        let transport = self.engine.transport_mut();
        match cmd {
            TRANSPORT_PLAY => transport.play(),
            TRANSPORT_PAUSE => transport.pause(),
            TRANSPORT_STOP => transport.stop(),
            TRANSPORT_SEEK => transport.seek(value.max(0.0) as u64),
            TRANSPORT_LOOP => {
                transport.set_loop(Some((value.max(0.0) as u64, value2.max(0.0) as u64)))
            }
            TRANSPORT_LOOP_CLEAR => transport.set_loop(None),
            TRANSPORT_AUDITION => transport.set_auditioning(value != 0.0),
            _ => {}
        }
    }

    /// Offline mixdown of `frames` frames from `start`, interleaved stereo.
    ///
    /// Deterministic and host-independent: the same plan and PCM always produce
    /// the same bytes, which is what the WASM-vs-native null test measures.
    #[must_use]
    pub fn render(&self, start: u64, frames: u64, block: usize) -> Vec<f32> {
        let options = OfflineOptions {
            start,
            frames: Some(frames),
            block: if block == 0 { self.block } else { block },
            sample_rate: SAMPLE_RATE,
        };
        render(self.engine.plan(), &self.pcm, &options).samples
    }

    /// Runs a `mixdown` or `stems` render job (03 §9) and returns one export
    /// frame (`ExportResult::to_frame`) holding the encoded WAV/FLAC files.
    /// `job_json` is the host's `RenderJob`.
    ///
    /// The same encoders run on the desktop, so a WASM export is byte-identical
    /// to a native one (the conformance harness asserts it).
    ///
    /// # Errors
    /// A JavaScript `Error` for a bad job, an unsupported format or a missing document.
    pub fn export_frame(&self, job_json: &str) -> Result<Vec<u8>, JsError> {
        let job: serde_json::Value = serde_json::from_str(job_json)
            .map_err(|error| JsError::new(&format!("bad render job: {error}")))?;
        let result = bragi_engine::export::run_job(self.engine.plan(), &self.pcm, &job)
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(result.to_frame())
    }

    /// The waveform peak pyramid for an asset, in the cache byte format.
    ///
    /// # Errors
    /// A JavaScript `Error` when the asset is unknown.
    pub fn peaks(&self, hash: &str) -> Result<Vec<u8>, JsError> {
        let hash: AssetHash = hash
            .parse()
            .map_err(|error| JsError::new(&format!("bad asset hash: {error}")))?;
        let buffer = self
            .pcm
            .get(&hash)
            .ok_or_else(|| JsError::new("unknown asset"))?;
        Ok(PeakPyramid::compute(&buffer.samples, buffer.channels).to_bytes())
    }

    /// Publishes the transport, counters and meters into the state words.
    pub fn publish_state(&mut self) -> Vec<u32> {
        self.engine.publish(&self.state, &mut self.meter_words);
        let mut words = vec![0u32; self.state.word_count()];
        let written = self.state.snapshot(&mut words);
        words.truncate(written);
        words
    }

    /// The plan version.
    #[must_use]
    pub fn plan_version(&self) -> u64 {
        self.engine.plan_version()
    }

    /// Total PCM underruns.
    #[must_use]
    pub fn underruns(&self) -> u64 {
        self.engine.underruns()
    }

    /// The arrangement length in samples.
    #[must_use]
    pub fn length_samples(&self) -> u64 {
        self.engine.plan().length_samples
    }

    /// The transport state as a number (`0` stopped … `4` scrubbing).
    #[must_use]
    pub fn transport_state(&self) -> u32 {
        transport_code(self.engine.transport().state())
    }
}

/// Interleaved PCM at 48 kHz, on its way from the decoder worker to the host.
#[wasm_bindgen]
pub struct DecodedPcmWasm {
    samples: Vec<f32>,
    channels: u16,
    sample_rate: u32,
}

#[wasm_bindgen]
impl DecodedPcmWasm {
    /// Channel count (mono or stereo after the working-copy resample).
    #[must_use]
    pub fn channels(&self) -> u16 {
        self.channels
    }

    /// Sample rate in hertz (the working copies are 48 kHz).
    #[must_use]
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Takes the interleaved samples. Consuming the handle avoids a copy inside wasm.
    #[must_use]
    pub fn into_samples(self) -> Vec<f32> {
        self.samples
    }
}

/// Decodes one asset to interleaved f32 at 48 kHz.
///
/// This is the worker-side half of the browser host: the result is transferred
/// to the AudioWorklet as PCM and registered with [`EngineWasm::add_asset_pcm`],
/// so no decode ever runs on the audio thread (`specs/03-audio-engine.md` §3.1).
///
/// # Errors
/// A JavaScript `Error` when the container is unsupported or decoding fails.
#[wasm_bindgen]
pub fn decode_asset(bytes: &[u8], mime: &str) -> Result<DecodedPcmWasm, JsError> {
    let decoded = bragi_engine::decode::decode_working_copy(bytes, mime.rsplit('/').next())
        .map_err(|error| JsError::new(&format!("decoding failed: {error}")))?;
    Ok(DecodedPcmWasm {
        samples: decoded.samples,
        channels: decoded.channels.max(1),
        sample_rate: decoded.sample_rate.max(1),
    })
}

/// The engine crate version string, for cache invalidation and diagnostics.
#[wasm_bindgen]
#[must_use]
pub fn engine_version() -> String {
    ENGINE_VERSION.to_string()
}

/// The engine's sample rate (48 000).
#[wasm_bindgen]
#[must_use]
pub fn sample_rate() -> u32 {
    SAMPLE_RATE
}

fn transport_code(state: TransportState) -> u32 {
    match state {
        TransportState::Stopped => 0,
        TransportState::Playing => 1,
        TransportState::Paused => 2,
        TransportState::Looping => 3,
        TransportState::Scrubbing => 4,
    }
}

#[allow(clippy::expect_used)] // a fixed literal that is known to be valid
fn empty_project() -> bragi_model::generated::Project {
    serde_json::from_value(serde_json::json!({
        "schemaVersion": 1,
        "id": "prj_empty",
        "meta": { "title": "empty", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
        "sources": [],
        "analyses": {},
        "tracks": [],
        "arrangement": {
            "timebase": {
                "ppq": 960,
                "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }],
                "timeSignatures": []
            },
            "sections": [],
            "master": { "fx": [], "automation": [], "gainDb": 0 }
        }
    }))
    .expect("the empty project is valid")
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn hash(byte: char) -> AssetHash {
        AssetHash::try_from(format!("sha256:{}", byte.to_string().repeat(64))).unwrap()
    }

    #[test]
    fn add_asset_pcm_round_trips_and_ignores_a_duplicate() {
        let mut engine = EngineWasm::new(128);
        let asset = hash('a');
        engine
            .add_asset_pcm(&asset.to_string(), vec![0.5, -0.5, 0.25, -0.25], 2, 48_000)
            .unwrap();

        let stored = engine.pcm.get(&asset).unwrap();
        assert_eq!(stored.channels, 2);
        assert_eq!(stored.sample_rate, 48_000);
        assert_eq!(stored.frames(), 2);
        assert_eq!(stored.samples, vec![0.5, -0.5, 0.25, -0.25]);
        assert_eq!(engine.index.duration_samples(&asset), Some(2));

        // The host may re-send a document; an already-loaded hash is left alone.
        engine
            .add_asset_pcm(&asset.to_string(), vec![0.0; 8], 2, 48_000)
            .unwrap();
        assert_eq!(
            engine.pcm.get(&asset).unwrap().samples,
            vec![0.5, -0.5, 0.25, -0.25]
        );
    }
}
