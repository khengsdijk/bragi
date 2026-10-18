//! `bragi-render`: render a fixture project offline, natively.
//!
//! Used by `scripts/conformance.mjs` to compare the native engine against the
//! WASM one and against golden WAVs. It is deliberately small and
//! dependency-free (stdlib argument parsing), so the conformance harness has no
//! build surprises.
//!
//! ```text
//! bragi-render --project fixtures/projects/engine-conformance.json \
//!              --asset sha256:…=fixtures/audio/drums_120.wav \
//!              --frames 96000 --out out.wav --raw out.f32 [--start 0] [--block 512]
//! ```
//!
//! It prints three lines to stdout: `sha256:<hex>` of the raw f32 output,
//! `frames:<n>`, and `peak:<dbFS>`.
#![allow(clippy::print_stderr, clippy::print_stdout)]

use std::process::ExitCode;

use bragi_engine::offline::{OfflineOptions, render};
use bragi_engine::pcm::{MemoryPcm, PcmBuffer};
use bragi_engine::plan::compile;
use bragi_engine_native::{asset_meta, write_f32_wav};
use bragi_model::AssetIndex;
use bragi_model::generated::AssetHash;

fn mime_for(path: &str) -> &'static str {
    if path.ends_with(".flac") {
        "audio/flac"
    } else if path.ends_with(".mp3") {
        "audio/mpeg"
    } else if path.ends_with(".ogg") || path.ends_with(".oga") {
        "audio/ogg"
    } else if path.ends_with(".m4a") || path.ends_with(".mp4") {
        "audio/mp4"
    } else if path.ends_with(".aac") {
        "audio/aac"
    } else {
        "audio/wav"
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("bragi-render: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut project: Option<String> = None;
    let mut out: Option<String> = None;
    let mut raw: Option<String> = None;
    let mut frames: Option<u64> = None;
    let mut start: u64 = 0;
    let mut block: usize = 512;
    let mut assets: Vec<(String, String)> = Vec::new();

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--project" => project = Some(value()?),
            "--out" => out = Some(value()?),
            "--raw" => raw = Some(value()?),
            "--frames" => frames = Some(value()?.parse().map_err(|_| "bad --frames")?),
            "--start" => start = value()?.parse().map_err(|_| "bad --start")?,
            "--block" => block = value()?.parse().map_err(|_| "bad --block")?,
            "--asset" => {
                let pair = value()?;
                let (hash, path) = pair
                    .split_once('=')
                    .ok_or_else(|| format!("--asset wants <hash>=<path>, got {pair}"))?;
                assets.push((hash.to_string(), path.to_string()));
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }

    let project_path = project.ok_or("--project is required")?;
    let out_path = out.ok_or("--out is required")?;
    let json = std::fs::read_to_string(&project_path)
        .map_err(|error| format!("reading {project_path}: {error}"))?;
    let doc: bragi_model::generated::Project =
        serde_json::from_str(&json).map_err(|error| format!("parsing {project_path}: {error}"))?;

    let mut index = AssetIndex::new();
    let mut pcm = MemoryPcm::new();
    for (hash_text, path) in &assets {
        let hash: AssetHash = hash_text
            .parse()
            .map_err(|_| format!("bad asset hash {hash_text}"))?;
        let bytes = std::fs::read(path).map_err(|error| format!("reading {path}: {error}"))?;
        let extension = path.rsplit('.').next();
        let decoded = bragi_engine::decode::decode_working_copy(&bytes, extension)
            .map_err(|error| format!("decoding {path}: {error}"))?;
        let meta = asset_meta(
            hash_text,
            mime_for(path),
            bytes.len() as u64,
            decoded.channels,
            decoded.sample_rate,
            decoded.frames(),
        )
        .map_err(|error| format!("asset metadata for {hash_text}: {error}"))?;
        index.insert(meta);
        pcm.insert(
            hash,
            PcmBuffer::new(
                decoded.samples.clone(),
                decoded.channels,
                decoded.sample_rate,
            ),
        );
    }

    let plan = compile(&doc, &index, 48_000, 1).map_err(|error| error.to_string())?;
    let options = OfflineOptions {
        start,
        frames,
        block,
        sample_rate: 48_000,
    };
    let output = render(&plan, &pcm, &options);

    if let Some(raw_path) = &raw {
        let mut bytes = Vec::with_capacity(output.samples.len() * 4);
        for sample in &output.samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        std::fs::write(raw_path, &bytes).map_err(|error| format!("writing {raw_path}: {error}"))?;
    }
    write_f32_wav(&out_path, &output.samples, 2, 48_000)
        .map_err(|error| format!("writing {out_path}: {error}"))?;

    let mut hasher_bytes = Vec::with_capacity(output.samples.len() * 4);
    for sample in &output.samples {
        hasher_bytes.extend_from_slice(&sample.to_le_bytes());
    }
    let digest = bragi_model::sha256(&hasher_bytes);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    println!("sha256:{hex}");
    println!("frames:{}", output.frames);
    println!("peak:{:.4}", output.peak_dbfs());
    Ok(())
}
