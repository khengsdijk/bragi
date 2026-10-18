//! A tiny 32-bit-float WAV writer/reader for renders and fixtures.
//!
//! Deliberately hand-rolled: the offline renderer and the conformance harness
//! need float WAVs to compare and to ship as goldens, and the project's export
//! work package (WP-1.11) owns the real, format-aware writer. Format: RIFF/WAVE,
//! PCM `format 3` (IEEE float), `channels` × f32 frames.

use std::fs;
use std::io::{self, Write};
use std::path::Path;

/// Writes an interleaved f32 WAV.
///
/// # Errors
/// Propagates file creation and write errors.
pub fn write_f32_wav(
    path: impl AsRef<Path>,
    samples: &[f32],
    channels: u16,
    sample_rate: u32,
) -> io::Result<()> {
    let channels = channels.max(1);
    let data_bytes = (samples.len() * 4) as u32;
    let mut file = fs::File::create(path)?;
    file.write_all(b"RIFF")?;
    file.write_all(&(36 + data_bytes).to_le_bytes())?;
    file.write_all(b"WAVE")?;
    file.write_all(b"fmt ")?;
    file.write_all(&16u32.to_le_bytes())?;
    file.write_all(&3u16.to_le_bytes())?; // IEEE float
    file.write_all(&channels.to_le_bytes())?;
    file.write_all(&sample_rate.to_le_bytes())?;
    file.write_all(&(sample_rate * u32::from(channels) * 4).to_le_bytes())?;
    file.write_all(&(channels * 4).to_le_bytes())?;
    file.write_all(&32u16.to_le_bytes())?;
    file.write_all(b"data")?;
    file.write_all(&data_bytes.to_le_bytes())?;
    let mut buffer = Vec::with_capacity(64 * 1024);
    for sample in samples {
        buffer.extend_from_slice(&sample.to_le_bytes());
        if buffer.len() >= 64 * 1024 {
            file.write_all(&buffer)?;
            buffer.clear();
        }
    }
    file.write_all(&buffer)?;
    Ok(())
}

/// A parsed f32 WAV.
#[derive(Clone, Debug)]
pub struct WavData {
    /// Interleaved samples.
    pub samples: Vec<f32>,
    /// Channel count.
    pub channels: u16,
    /// Sample rate.
    pub sample_rate: u32,
}

/// Reads an uncompressed or IEEE-float WAV into f32.
///
/// Integer PCM is normalised to `-1..1`.
///
/// # Errors
/// Returns an error when the file is not a readable WAV.
pub fn read_wav(path: impl AsRef<Path>) -> io::Result<WavData> {
    let bytes = fs::read(path)?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "not a WAV file"));
    }
    let mut offset = 12usize;
    let mut format = 1u16;
    let mut channels = 1u16;
    let mut sample_rate = 48_000u32;
    let mut bits = 16u16;
    let mut data: Option<&[u8]> = None;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;
        let body = offset + 8;
        match id {
            b"fmt " if body + 16 <= bytes.len() => {
                format = u16::from_le_bytes([bytes[body], bytes[body + 1]]);
                channels = u16::from_le_bytes([bytes[body + 2], bytes[body + 3]]);
                sample_rate = u32::from_le_bytes([
                    bytes[body + 4],
                    bytes[body + 5],
                    bytes[body + 6],
                    bytes[body + 7],
                ]);
                bits = u16::from_le_bytes([bytes[body + 14], bytes[body + 15]]);
            }
            b"data" => {
                let end = (body + size).min(bytes.len());
                data = Some(&bytes[body..end]);
            }
            _ => {}
        }
        offset = body + size + (size & 1);
    }
    let data = data.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "no data chunk"))?;
    let channels = channels.max(1);
    let mut samples = Vec::new();
    match (format, bits) {
        (3, 32) => {
            for chunk in data.as_chunks::<4>().0 {
                samples.push(f32::from_le_bytes(*chunk));
            }
        }
        (1, 16) => {
            for chunk in data.as_chunks::<2>().0 {
                samples.push(i16::from_le_bytes(*chunk) as f32 / 32_768.0);
            }
        }
        (1, 24) => {
            for chunk in data.as_chunks::<3>().0 {
                let value = i32::from_le_bytes([chunk[0], chunk[1], chunk[2], 0]) << 8 >> 8;
                samples.push(value as f32 / 8_388_608.0);
            }
        }
        (1, 32) => {
            for chunk in data.as_chunks::<4>().0 {
                samples.push(i32::from_le_bytes(*chunk) as f32 / 2_147_483_648.0);
            }
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unsupported WAV encoding",
            ));
        }
    }
    Ok(WavData {
        samples,
        channels,
        sample_rate,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_float_wav() {
        let dir = std::env::temp_dir().join(format!("bragi-wav-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tone.wav");
        let samples: Vec<f32> = (0..64).map(|value| value as f32 / 64.0).collect();
        write_f32_wav(&path, &samples, 2, 48_000).unwrap();
        let read = read_wav(&path).unwrap();
        assert_eq!(read.channels, 2);
        assert_eq!(read.sample_rate, 48_000);
        assert_eq!(read.samples, samples);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_non_wav() {
        let dir = std::env::temp_dir().join(format!("bragi-wav-bad-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bad.bin");
        fs::write(&path, b"nope").unwrap();
        assert!(read_wav(&path).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
