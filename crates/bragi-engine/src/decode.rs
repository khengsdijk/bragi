//! Symphonia decoding (`specs/03-audio-engine.md` §1, `specs/01-architecture.md` §1).
//!
//! One decoder for native and wasm32, behind the `decode` feature so the core
//! engine stays dependency-free for hosts that are handed PCM. It turns any of
//! the spec's containers (FLAC/WAV/MP3/AAC/OGG/M4A) into interleaved `f32` at the
//! asset's own rate; the hosts resample to 48 kHz if an asset is not already
//! there.
//!
//! Decoding runs off the audio thread (the decoder worker on web, the import
//! path on desktop), so it may allocate freely.
//!
//! ```
//! # #[cfg(feature = "decode")] {
//! // A 1-frame, 16-bit mono WAV header plus one sample.
//! let wav = b"RIFF\x28\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\
//! \x80\xbb\x00\x00\x00\x77\x01\x00\x02\x00\x10\x00data\x02\x00\x00\x00\x00\x40";
//! let decoded = bragi_engine::decode::decode_bytes(wav, None).unwrap();
//! assert_eq!(decoded.channels, 1);
//! assert_eq!(decoded.sample_rate, 48_000);
//! assert!((decoded.samples[0] - 0.5).abs() < 1e-3);
//! # }
//! ```

use std::io::Cursor;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use thiserror::Error;

use crate::SAMPLE_RATE;

/// Decoded PCM at the asset's own rate.
#[derive(Clone, Debug)]
pub struct DecodedPcm {
    /// Interleaved samples.
    pub samples: Vec<f32>,
    /// Channel count.
    pub channels: u16,
    /// Sample rate in hertz.
    pub sample_rate: u32,
}

impl DecodedPcm {
    /// Frames in the buffer.
    #[must_use]
    pub fn frames(&self) -> u64 {
        if self.channels == 0 {
            0
        } else {
            (self.samples.len() / self.channels as usize) as u64
        }
    }

    /// Converts to the engine's [`PcmBuffer`](crate::pcm::PcmBuffer).
    #[must_use]
    pub fn into_pcm_buffer(self) -> crate::pcm::PcmBuffer {
        crate::pcm::PcmBuffer::new(self.samples, self.channels, self.sample_rate)
    }

    /// Resamples to `target_rate` with linear interpolation (a working asset is
    /// already 48 kHz; this is for previews of non-conforming files).
    #[must_use]
    pub fn resampled_to(self, target_rate: u32) -> Self {
        if target_rate == 0 || target_rate == self.sample_rate || self.sample_rate == 0 {
            return self;
        }
        let channels = self.channels.max(1) as usize;
        let frames = self.samples.len() / channels;
        let ratio = target_rate as f64 / self.sample_rate as f64;
        let out_frames = ((frames as f64) * ratio).round() as usize;
        let mut samples = Vec::with_capacity(out_frames * channels);
        for frame in 0..out_frames {
            let position = frame as f64 / ratio;
            let base = position.floor() as usize;
            let frac = (position - base as f64) as f32;
            let next = (base + 1).min(frames.saturating_sub(1));
            for channel in 0..channels {
                let a = self.samples[base * channels + channel];
                let b = self.samples[next * channels + channel];
                samples.push(a + (b - a) * frac);
            }
        }
        Self {
            samples,
            channels: self.channels,
            sample_rate: target_rate,
        }
    }
}

/// A decode failure.
#[derive(Debug, Error)]
pub enum DecodeError {
    /// The probe could not identify a container.
    #[error("unsupported audio format: {0}")]
    Unsupported(String),
    /// The container has no decodable audio track.
    #[error("no audio track in the container")]
    NoTrack,
    /// The decoder rejected a packet.
    #[error("decode error: {0}")]
    Decode(String),
    /// Reading the stream failed.
    #[error("io error: {0}")]
    Io(String),
}

/// Decodes an in-memory asset to interleaved f32.
///
/// `extension_hint` (for example `"flac"`) helps the probe; it is optional
/// because the container usually identifies itself.
///
/// # Errors
/// [`DecodeError`] when the container or codec is unsupported, when there is no
/// audio track, or when a packet fails to decode.
pub fn decode_bytes(bytes: &[u8], extension_hint: Option<&str>) -> Result<DecodedPcm, DecodeError> {
    let source = Cursor::new(bytes.to_vec());
    let stream = MediaSourceStream::new(Box::new(source), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = extension_hint {
        hint.with_extension(extension);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|error| DecodeError::Unsupported(error.to_string()))?;
    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|track| track.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or(DecodeError::NoTrack)?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|error| DecodeError::Unsupported(error.to_string()))?;

    let mut samples: Vec<f32> = Vec::new();
    let mut channels = 2u16;
    let mut sample_rate = SAMPLE_RATE;
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(error) => return Err(DecodeError::Decode(error.to_string())),
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                channels = spec.channels.count() as u16;
                sample_rate = spec.rate;
                let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
                buffer.copy_interleaved_ref(decoded);
                samples.extend_from_slice(buffer.samples());
            }
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(error) => return Err(DecodeError::Decode(error.to_string())),
        }
    }

    if samples.is_empty() {
        return Err(DecodeError::Decode("no audio samples decoded".into()));
    }
    Ok(DecodedPcm {
        samples,
        channels: channels.max(1),
        sample_rate,
    })
}

/// Decodes to 48 kHz, which is what the engine's plans assume
/// (`specs/02-song-model.md` §2.2).
///
/// # Errors
/// The same errors as [`decode_bytes`].
pub fn decode_working_copy(
    bytes: &[u8],
    extension_hint: Option<&str>,
) -> Result<DecodedPcm, DecodeError> {
    Ok(decode_bytes(bytes, extension_hint)?.resampled_to(SAMPLE_RATE))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// A 48 kHz, 2-channel, 16-bit WAV with four frames.
    fn wav_bytes() -> Vec<u8> {
        let samples: [i16; 8] = [0, 1000, -1000, 2000, -2000, 3000, -3000, 4000];
        let data_len = (samples.len() * 2) as u32;
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&48_000u32.to_le_bytes());
        out.extend_from_slice(&(48_000u32 * 4).to_le_bytes());
        out.extend_from_slice(&4u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        for sample in samples {
            out.extend_from_slice(&sample.to_le_bytes());
        }
        out
    }

    #[test]
    fn decodes_a_wav_to_interleaved_f32() {
        let decoded = decode_bytes(&wav_bytes(), Some("wav")).unwrap();
        assert_eq!(decoded.channels, 2);
        assert_eq!(decoded.sample_rate, 48_000);
        assert_eq!(decoded.frames(), 4);
        assert!((decoded.samples[1] - 1000.0 / 32768.0).abs() < 1e-5);
    }

    #[test]
    fn garbage_is_rejected() {
        assert!(decode_bytes(b"not audio at all", None).is_err());
    }

    #[test]
    fn resampling_changes_the_frame_count() {
        let decoded = decode_bytes(&wav_bytes(), Some("wav")).unwrap();
        let resampled = decoded.resampled_to(24_000);
        assert_eq!(resampled.sample_rate, 24_000);
        assert_eq!(resampled.frames(), 2);
    }
}
