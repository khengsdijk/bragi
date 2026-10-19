//! WAV encoder (`specs/03-audio-engine.md` §9): 16/24-bit integer PCM and 32-bit
//! IEEE float, with a `LIST/INFO` chunk for metadata.

use super::quantize::Quantizer;
use super::{ExportError, ExportMeta};
use crate::SAMPLE_RATE;

/// Encodes interleaved `f32` samples as a WAV file.
///
/// `bits` is 16, 24 or 32 (float). `dither_seed` only affects 16 and 24 bit.
///
/// # Errors
/// [`ExportError::TooLarge`] when the data would not fit a RIFF container.
pub fn encode_wav(
    samples: &[f32],
    channels: u16,
    bits: u8,
    meta: &ExportMeta,
    dither_seed: Option<u64>,
) -> Result<Vec<u8>, ExportError> {
    let channels = channels.max(1);
    let bytes_per_sample = usize::from(bits / 8);
    let data_len = samples.len() * bytes_per_sample;
    let float = bits == 32;

    let info = info_chunk(meta);
    let fmt_len = 16usize;
    let fact_len = if float { 12 } else { 0 };
    let riff_len = 4 + (8 + fmt_len) + fact_len + info.len() + 8 + data_len + (data_len & 1);
    if u32::try_from(riff_len).is_err() {
        return Err(ExportError::TooLarge);
    }

    let mut out = Vec::with_capacity(riff_len + 8);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(riff_len as u32).to_le_bytes());
    out.extend_from_slice(b"WAVE");

    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&(fmt_len as u32).to_le_bytes());
    out.extend_from_slice(&(if float { 3u16 } else { 1u16 }).to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    let block_align = channels * u16::from(bits / 8);
    out.extend_from_slice(&(SAMPLE_RATE * u32::from(block_align)).to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&u16::from(bits).to_le_bytes());

    if float {
        // Non-PCM formats require a `fact` chunk with the frame count.
        out.extend_from_slice(b"fact");
        out.extend_from_slice(&4u32.to_le_bytes());
        out.extend_from_slice(&((samples.len() / usize::from(channels)) as u32).to_le_bytes());
    }

    out.extend_from_slice(&info);

    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());
    match bits {
        32 => {
            for sample in samples {
                // Keep float output finite: a NaN would poison a DAW.
                let value = if sample.is_finite() { *sample } else { 0.0 };
                out.extend_from_slice(&value.to_le_bytes());
            }
        }
        16 => {
            let mut quantizer = Quantizer::new(16, dither_seed);
            for sample in samples {
                out.extend_from_slice(&(quantizer.quantize(*sample) as i16).to_le_bytes());
            }
        }
        _ => {
            let mut quantizer = Quantizer::new(24, dither_seed);
            for sample in samples {
                out.extend_from_slice(&quantizer.quantize(*sample).to_le_bytes()[..3]);
            }
        }
    }
    if data_len & 1 == 1 {
        out.push(0);
    }
    Ok(out)
}

/// A `LIST` chunk of type `INFO`, or empty when there is nothing to say.
fn info_chunk(meta: &ExportMeta) -> Vec<u8> {
    let mut body = Vec::new();
    for tag in meta.tags() {
        let Some(id) = tag.wav_id else { continue };
        let mut text = tag.value.into_bytes();
        text.push(0);
        body.extend_from_slice(id.as_bytes());
        body.extend_from_slice(&(text.len() as u32).to_le_bytes());
        body.extend_from_slice(&text);
        if text.len() & 1 == 1 {
            body.push(0);
        }
    }
    if body.is_empty() {
        return body;
    }
    let mut chunk = Vec::with_capacity(body.len() + 12);
    chunk.extend_from_slice(b"LIST");
    chunk.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
    chunk.extend_from_slice(b"INFO");
    chunk.extend_from_slice(&body);
    chunk
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn meta() -> ExportMeta {
        ExportMeta {
            title: Some("Song".into()),
            ..ExportMeta::default()
        }
    }

    #[test]
    fn sixteen_bit_header_and_payload() {
        let bytes = encode_wav(&[0.5, -0.5, 1.0, -1.0], 2, 16, &ExportMeta::bare(), None).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..16], b"WAVEfmt ");
        assert_eq!(u16::from_le_bytes([bytes[20], bytes[21]]), 1); // PCM
        assert_eq!(u16::from_le_bytes([bytes[22], bytes[23]]), 2);
        assert_eq!(
            u32::from_le_bytes(bytes[24..28].try_into().unwrap()),
            48_000
        );
        assert_eq!(u16::from_le_bytes([bytes[34], bytes[35]]), 16);
        let payload = &bytes[bytes.len() - 8..];
        assert_eq!(i16::from_le_bytes([payload[0], payload[1]]), 16384);
        assert_eq!(i16::from_le_bytes([payload[4], payload[5]]), 32767);
        assert_eq!(i16::from_le_bytes([payload[6], payload[7]]), -32768);
        let riff = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        assert_eq!(riff + 8, bytes.len());
    }

    #[test]
    fn float_has_a_fact_chunk_and_exact_samples() {
        let bytes = encode_wav(&[0.25, -0.125], 2, 32, &ExportMeta::bare(), None).unwrap();
        assert_eq!(u16::from_le_bytes([bytes[20], bytes[21]]), 3);
        assert_eq!(&bytes[36..40], b"fact");
        let payload = &bytes[bytes.len() - 8..];
        assert_eq!(f32::from_le_bytes(payload[0..4].try_into().unwrap()), 0.25);
        assert_eq!(
            f32::from_le_bytes(payload[4..8].try_into().unwrap()),
            -0.125
        );
    }

    #[test]
    fn twenty_four_bit_is_three_bytes_per_sample() {
        let bytes = encode_wav(&[1.0, -1.0], 2, 24, &ExportMeta::bare(), None).unwrap();
        let payload = &bytes[bytes.len() - 6..];
        assert_eq!(payload, &[0xff, 0xff, 0x7f, 0x00, 0x00, 0x80]);
    }

    #[test]
    fn metadata_goes_into_a_list_info_chunk() {
        let bytes = encode_wav(&[0.0, 0.0], 2, 16, &meta(), None).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("LIST") && text.contains("INFO"));
        assert!(text.contains("INAM"));
        assert!(text.contains("Song"));
        assert!(text.contains("ISFT"));
        let riff = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        assert_eq!(riff + 8, bytes.len());
    }

    #[test]
    fn same_input_same_bytes() {
        let samples: Vec<f32> = (0..200).map(|i| (i as f32 * 0.05).sin()).collect();
        let a = encode_wav(&samples, 2, 16, &meta(), Some(3)).unwrap();
        let b = encode_wav(&samples, 2, 16, &meta(), Some(3)).unwrap();
        let c = encode_wav(&samples, 2, 16, &meta(), None).unwrap();
        assert_eq!(a, b);
        assert_ne!(a, c);
    }
}
