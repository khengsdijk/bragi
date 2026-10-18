//! Minimal WAV I/O for tests and the stretch lab: 16-bit PCM and 32-bit float, any channel
//! count, planar `Vec<Vec<f32>>` in memory. Deliberately tiny so no WAV crate is needed.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::Path;

/// Planar audio: `channels[c][frame]`.
pub struct Audio {
    pub sample_rate: u32,
    pub channels: Vec<Vec<f32>>,
}

impl Audio {
    pub fn frames(&self) -> usize {
        self.channels.first().map_or(0, Vec::len)
    }
}

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}
fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

/// Reads a RIFF/WAVE file with a PCM16 or float32 `data` chunk.
pub fn read(path: &Path) -> Audio {
    let b = fs::read(path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
    assert!(&b[0..4] == b"RIFF" && &b[8..12] == b"WAVE", "not a WAV file");
    let (mut fmt, mut channels, mut rate, mut bits) = (0u16, 0usize, 0u32, 0u16);
    let mut i = 12;
    while i + 8 <= b.len() {
        let id = &b[i..i + 4];
        let len = u32_at(&b, i + 4) as usize;
        let body = i + 8;
        if id == b"fmt " {
            fmt = u16_at(&b, body);
            channels = u16_at(&b, body + 2) as usize;
            rate = u32_at(&b, body + 4);
            bits = u16_at(&b, body + 14);
        } else if id == b"data" {
            let data = &b[body..body + len];
            let mut out = vec![Vec::new(); channels];
            match (fmt, bits) {
                (1, 16) => {
                    for (k, s) in data.chunks_exact(2).enumerate() {
                        let v = i16::from_le_bytes([s[0], s[1]]);
                        out[k % channels].push(f32::from(v) / 32768.0);
                    }
                }
                (3, 32) => {
                    for (k, s) in data.chunks_exact(4).enumerate() {
                        out[k % channels].push(f32::from_le_bytes([s[0], s[1], s[2], s[3]]));
                    }
                }
                _ => panic!("unsupported WAV format {fmt}/{bits}"),
            }
            return Audio { sample_rate: rate, channels: out };
        }
        i = body + len + (len & 1);
    }
    panic!("no data chunk in {}", path.display());
}

/// Writes 16-bit PCM (TPDF-free, plain rounding: fixtures must be reproducible).
pub fn write_pcm16(path: &Path, audio: &Audio) {
    write(path, audio, false);
}

/// Writes 32-bit float, for listening renders (no requantisation of the stretcher output).
pub fn write_f32(path: &Path, audio: &Audio) {
    write(path, audio, true);
}

fn write(path: &Path, audio: &Audio, float: bool) {
    let ch = audio.channels.len();
    let frames = audio.frames();
    let bytes_per = if float { 4 } else { 2 };
    let data_len = frames * ch * bytes_per;
    let mut b = Vec::with_capacity(44 + data_len);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&(if float { 3u16 } else { 1u16 }).to_le_bytes());
    b.extend_from_slice(&(ch as u16).to_le_bytes());
    b.extend_from_slice(&audio.sample_rate.to_le_bytes());
    b.extend_from_slice(&(audio.sample_rate * (ch * bytes_per) as u32).to_le_bytes());
    b.extend_from_slice(&((ch * bytes_per) as u16).to_le_bytes());
    b.extend_from_slice(&((bytes_per * 8) as u16).to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&(data_len as u32).to_le_bytes());
    for f in 0..frames {
        for c in &audio.channels {
            let v = c[f];
            if float {
                b.extend_from_slice(&v.to_le_bytes());
            } else {
                let q = (v.clamp(-1.0, 1.0) * 32767.0).round() as i16;
                b.extend_from_slice(&q.to_le_bytes());
            }
        }
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).unwrap();
    }
    fs::write(path, b).unwrap();
}
