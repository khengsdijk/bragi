//! A small, dependency-free FLAC encoder (`specs/03-audio-engine.md` §9).
//!
//! Produces a standards-conformant stream: `fLaC`, STREAMINFO (with the MD5 of
//! the unencoded audio), a VORBIS_COMMENT block, then fixed-blocksize frames.
//! Per frame the encoder picks the best stereo decorrelation (independent,
//! left/side, right/side, mid/side) and, per subframe, the best of constant,
//! fixed predictor order 0 to 4 with partitioned Rice residuals, or verbatim.
//! That is the same toolbox as `flac -0`/`-1`: lossless and reasonably small,
//! not the smallest possible. Correctness is proven by decoding the output
//! with symphonia in the tests.

use super::md5::Md5;
use super::quantize::Quantizer;
use super::{ExportError, ExportMeta};
use crate::SAMPLE_RATE;

/// Samples per channel in a frame.
pub const BLOCK_SIZE: usize = 4096;

/// The highest Rice partition order tried.
const MAX_PARTITION_ORDER: u32 = 6;

/// The smallest block a decoder will accept.
const MIN_BLOCK: usize = 16;

const fn crc8_table() -> [u8; 256] {
    let mut table = [0u8; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = i as u8;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 0x80 != 0 {
                (crc << 1) ^ 0x07
            } else {
                crc << 1
            };
            bit += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
}

const fn crc16_table() -> [u16; 256] {
    let mut table = [0u16; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = (i as u16) << 8;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x8005
            } else {
                crc << 1
            };
            bit += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
}

static CRC8: [u8; 256] = crc8_table();
static CRC16: [u16; 256] = crc16_table();

/// CRC-8 (poly 0x07) of `data`, as used by FLAC frame headers.
#[must_use]
pub fn crc8(data: &[u8]) -> u8 {
    data.iter()
        .fold(0u8, |crc, byte| CRC8[usize::from(crc ^ byte)])
}

/// CRC-16 (poly 0x8005) of `data`, as used by FLAC frame footers.
#[must_use]
pub fn crc16(data: &[u8]) -> u16 {
    data.iter().fold(0u16, |crc, byte| {
        (crc << 8) ^ CRC16[usize::from((crc >> 8) as u8 ^ byte)]
    })
}

/// An MSB-first bit sink.
#[derive(Clone, Debug, Default)]
struct BitWriter {
    bytes: Vec<u8>,
    acc: u64,
    filled: u32,
}

impl BitWriter {
    fn bit_len(&self) -> usize {
        self.bytes.len() * 8 + self.filled as usize
    }

    /// Writes the low `count` (<= 32) bits of `value`.
    fn write(&mut self, value: u64, count: u32) {
        debug_assert!(count <= 32);
        if count == 0 {
            return;
        }
        let masked = value & ((1u64 << count) - 1);
        self.acc = (self.acc << count) | masked;
        self.filled += count;
        while self.filled >= 8 {
            self.filled -= 8;
            self.bytes.push((self.acc >> self.filled) as u8);
        }
        self.acc &= (1u64 << self.filled) - 1;
    }

    fn write_signed(&mut self, value: i64, count: u32) {
        self.write(value as u64, count);
    }

    /// `count` zero bits followed by a one.
    fn write_unary(&mut self, mut count: u64) {
        while count >= 32 {
            self.write(0, 32);
            count -= 32;
        }
        self.write(1, count as u32 + 1);
    }

    fn align(&mut self) {
        if self.filled > 0 {
            self.write(0, 8 - self.filled);
        }
    }

    fn append(&mut self, other: &BitWriter) {
        for byte in &other.bytes {
            self.write(u64::from(*byte), 8);
        }
        if other.filled > 0 {
            self.write(other.acc, other.filled);
        }
    }
}

/// The winning fixed predictor for a subframe.
struct FixedChoice {
    order: usize,
    residual: Vec<i64>,
    partition_order: u32,
    params: Vec<u32>,
}

/// One encoded subframe and its size.
struct Subframe {
    bits: BitWriter,
}

fn zigzag(value: i64) -> u64 {
    ((value << 1) ^ (value >> 63)) as u64
}

fn fixed_residual(x: &[i32], order: usize) -> Vec<i64> {
    let at = |i: usize| i64::from(x[i]);
    (order..x.len())
        .map(|i| match order {
            0 => at(i),
            1 => at(i) - at(i - 1),
            2 => at(i) - 2 * at(i - 1) + at(i - 2),
            3 => at(i) - 3 * at(i - 1) + 3 * at(i - 2) - at(i - 3),
            _ => at(i) - 4 * at(i - 1) + 6 * at(i - 2) - 4 * at(i - 3) + at(i - 4),
        })
        .collect()
}

/// Estimated Rice cost of `count` values summing to `sum`, and the parameter.
fn rice_estimate(sum: u64, count: u64) -> (u32, u64) {
    if count == 0 {
        return (0, 0);
    }
    let mean = sum / count;
    let guess = if mean == 0 {
        0
    } else {
        63 - mean.leading_zeros()
    };
    let mut best = (0u32, u64::MAX);
    for k in guess.saturating_sub(1)..=(guess + 1).min(30) {
        let cost = count * u64::from(k + 1) + (sum >> k);
        if cost < best.1 {
            best = (k, cost);
        }
    }
    best
}

/// Picks the partition order and Rice parameters for `residual`.
///
/// `n` is the subframe length and `order` the predictor order, because the
/// first partition is `order` samples shorter (the warm-up).
fn plan_partitions(residual: &[i64], n: usize, order: usize) -> (u32, Vec<u32>, u64) {
    let mut max_order = 0u32;
    while max_order < MAX_PARTITION_ORDER
        && n.is_multiple_of(1usize << (max_order + 1))
        && (n >> (max_order + 1)) > order
    {
        max_order += 1;
    }
    // Sums of zigzagged residuals at the finest partitioning, merged upward.
    let parts = 1usize << max_order;
    let per = n >> max_order;
    let mut sums = vec![0u64; parts];
    let mut counts = vec![0u64; parts];
    for (index, value) in residual.iter().enumerate() {
        let partition = ((index + order) / per).min(parts - 1);
        sums[partition] += zigzag(*value);
        counts[partition] += 1;
    }
    let mut best: Option<(u32, Vec<u32>, u64)> = None;
    let mut level = max_order;
    loop {
        let mut params = Vec::with_capacity(sums.len());
        let mut cost = 0u64;
        for (sum, count) in sums.iter().zip(&counts) {
            let (k, bits) = rice_estimate(*sum, *count);
            params.push(k);
            cost += bits + 5;
        }
        if best.as_ref().is_none_or(|(_, _, current)| cost < *current) {
            best = Some((level, params, cost));
        }
        if level == 0 {
            break;
        }
        level -= 1;
        sums = sums.chunks(2).map(|pair| pair.iter().sum()).collect();
        counts = counts.chunks(2).map(|pair| pair.iter().sum()).collect();
    }
    best.unwrap_or((0, vec![0], 0))
}

fn encode_subframe(x: &[i32], bps: u32) -> Subframe {
    let n = x.len();
    let verbatim_bits = 8 + n as u64 * u64::from(bps);

    // Constant.
    if n > 0 && x.iter().all(|value| *value == x[0]) {
        let mut bits = BitWriter::default();
        bits.write(0, 8);
        bits.write_signed(i64::from(x[0]), bps);
        return Subframe { bits };
    }

    let mut chosen: Option<FixedChoice> = None;
    if n > 4 {
        let mut best_order = 0usize;
        let mut best_residual = fixed_residual(x, 0);
        let mut best_sum: u64 = best_residual.iter().map(|value| zigzag(*value)).sum();
        for order in 1..=4usize {
            let residual = fixed_residual(x, order);
            let sum: u64 = residual.iter().map(|value| zigzag(*value)).sum();
            if sum < best_sum {
                best_sum = sum;
                best_order = order;
                best_residual = residual;
            }
        }
        let (partition_order, params, rice_bits) = plan_partitions(&best_residual, n, best_order);
        let estimated = 8 + best_order as u64 * u64::from(bps) + 6 + rice_bits;
        if estimated < verbatim_bits {
            chosen = Some(FixedChoice {
                order: best_order,
                residual: best_residual,
                partition_order,
                params,
            });
        }
    }

    let mut bits = BitWriter::default();
    match chosen {
        Some(FixedChoice {
            order,
            residual,
            partition_order,
            params,
        }) => {
            // Header: pad bit 0, type 001ooo (fixed), wasted-bits flag 0.
            bits.write(0, 1);
            bits.write(0b001_000 | order as u64, 6);
            bits.write(0, 1);
            for value in &x[..order] {
                bits.write_signed(i64::from(*value), bps);
            }
            bits.write(1, 2); // residual coding method: 5-bit parameters
            bits.write(u64::from(partition_order), 4);
            let parts = 1usize << partition_order;
            let per = n >> partition_order;
            let mut cursor = 0usize;
            for (index, k) in params.iter().enumerate().take(parts) {
                let count = if index == 0 { per - order } else { per };
                bits.write(u64::from(*k), 5);
                for value in &residual[cursor..cursor + count] {
                    let u = zigzag(*value);
                    bits.write_unary(u >> k);
                    bits.write(u & ((1u64 << k) - 1), *k);
                }
                cursor += count;
            }
        }
        None => {
            bits.write(0, 1);
            bits.write(0b000_001, 6);
            bits.write(0, 1);
            for value in x {
                bits.write_signed(i64::from(*value), bps);
            }
        }
    }
    Subframe { bits }
}

fn write_utf8_number(out: &mut Vec<u8>, value: u64) {
    if value < 0x80 {
        out.push(value as u8);
        return;
    }
    let mut extra = 1;
    while extra < 6 && value >= (1u64 << (5 * extra + 6)) {
        extra += 1;
    }
    let lead_mask = !(0xffu8 >> (extra + 1));
    out.push(lead_mask | (value >> (6 * extra)) as u8);
    for shift in (0..extra).rev() {
        out.push(0x80 | ((value >> (6 * shift)) & 0x3f) as u8);
    }
}

#[derive(Clone, Copy)]
enum Stereo {
    Independent,
    LeftSide,
    RightSide,
    MidSide,
}

fn encode_frame(
    channels: &[&[i32]],
    number: u64,
    variable: bool,
    bits: u32,
) -> Result<Vec<u8>, ExportError> {
    let n = channels[0].len();
    // Sync code; the last bit of the second byte is the blocking strategy.
    let mut header = vec![0xff, if variable { 0xf9 } else { 0xf8 }];
    let size_code: u8 = match n {
        4096 => 0b1100,
        0..=256 => 0b0110,
        _ => 0b0111,
    };
    let sample_size: u8 = match bits {
        16 => 0b100,
        24 => 0b110,
        _ => return Err(ExportError::UnsupportedBits(bits as u8)),
    };

    let mut frame = BitWriter::default();
    let assignment: u8;
    if channels.len() == 1 {
        assignment = 0b0000;
        frame.append(&encode_subframe(channels[0], bits).bits);
    } else {
        let (left, right) = (channels[0], channels[1]);
        let side: Vec<i32> = left.iter().zip(right).map(|(l, r)| l - r).collect();
        let mid: Vec<i32> = left
            .iter()
            .zip(right)
            .map(|(l, r)| ((i64::from(*l) + i64::from(*r)) >> 1) as i32)
            .collect();
        let l = encode_subframe(left, bits);
        let r = encode_subframe(right, bits);
        let s = encode_subframe(&side, bits + 1);
        let m = encode_subframe(&mid, bits);
        let sizes = [
            (Stereo::Independent, l.bits.bit_len() + r.bits.bit_len()),
            (Stereo::LeftSide, l.bits.bit_len() + s.bits.bit_len()),
            (Stereo::RightSide, s.bits.bit_len() + r.bits.bit_len()),
            (Stereo::MidSide, m.bits.bit_len() + s.bits.bit_len()),
        ];
        let mut best = sizes[0];
        for candidate in &sizes[1..] {
            if candidate.1 < best.1 {
                best = *candidate;
            }
        }
        match best.0 {
            Stereo::Independent => {
                assignment = 0b0001;
                frame.append(&l.bits);
                frame.append(&r.bits);
            }
            Stereo::LeftSide => {
                assignment = 0b1000;
                frame.append(&l.bits);
                frame.append(&s.bits);
            }
            Stereo::RightSide => {
                assignment = 0b1001;
                frame.append(&s.bits);
                frame.append(&r.bits);
            }
            Stereo::MidSide => {
                assignment = 0b1010;
                frame.append(&m.bits);
                frame.append(&s.bits);
            }
        }
    }
    frame.align();

    header.push((size_code << 4) | 0b1010); // 48 kHz
    header.push((assignment << 4) | (sample_size << 1));
    write_utf8_number(&mut header, number);
    match size_code {
        0b0110 => header.push((n - 1) as u8),
        0b0111 => header.extend_from_slice(&((n - 1) as u16).to_be_bytes()),
        _ => {}
    }
    header.push(crc8(&header));

    let mut out = header;
    out.extend_from_slice(&frame.bytes);
    let checksum = crc16(&out);
    out.extend_from_slice(&checksum.to_be_bytes());
    Ok(out)
}

fn vorbis_comment_block(meta: &ExportMeta) -> Vec<u8> {
    let vendor = format!("Bragi {}", crate::ENGINE_VERSION);
    let mut body = Vec::new();
    body.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    body.extend_from_slice(vendor.as_bytes());
    let tags = meta.tags();
    body.extend_from_slice(&(tags.len() as u32).to_le_bytes());
    for tag in tags {
        let entry = format!("{}={}", tag.vorbis_name, tag.value);
        body.extend_from_slice(&(entry.len() as u32).to_le_bytes());
        body.extend_from_slice(entry.as_bytes());
    }
    body
}

/// Encodes interleaved `f32` samples as FLAC (16 or 24 bit, 1 or 2 channels).
///
/// # Errors
/// [`ExportError::UnsupportedBits`] for bit depths other than 16 and 24,
/// [`ExportError::UnsupportedChannels`] for more than two channels.
pub fn encode_flac(
    samples: &[f32],
    channels: u16,
    bits: u8,
    meta: &ExportMeta,
    dither_seed: Option<u64>,
) -> Result<Vec<u8>, ExportError> {
    if bits != 16 && bits != 24 {
        return Err(ExportError::UnsupportedBits(bits));
    }
    if channels == 0 || channels > 2 {
        return Err(ExportError::UnsupportedChannels(channels));
    }
    let channel_count = usize::from(channels);
    let frames = samples.len() / channel_count;

    let mut quantizer = Quantizer::new(bits, dither_seed);
    let ints: Vec<i32> = samples[..frames * channel_count]
        .iter()
        .map(|sample| quantizer.quantize(*sample))
        .collect();

    // De-interleave and encode block by block.
    let mut body: Vec<u8> = Vec::new();
    let mut md5 = Md5::new();
    let mut min_frame = u32::MAX;
    let mut max_frame = 0u32;
    let mut block_sizes: Vec<usize> = Vec::new();
    let mut md5_bytes: Vec<u8> = Vec::with_capacity(BLOCK_SIZE * channel_count * 3);
    // Fixed 4096-sample blocks. Decoders reject a final block under 16
    // samples, so a tiny remainder is traded against the previous block, which
    // makes the stream variable-blocksize (the frame header then carries the
    // sample offset instead of the frame number).
    let mut plan: Vec<usize> = Vec::new();
    let mut remaining = frames;
    while remaining > 0 {
        let n = remaining.min(BLOCK_SIZE);
        plan.push(n);
        remaining -= n;
    }
    let mut variable = false;
    if plan.len() > 1 {
        let last = plan[plan.len() - 1];
        if last < MIN_BLOCK {
            let take = MIN_BLOCK - last;
            let previous = plan.len() - 2;
            plan[previous] -= take;
            plan[previous + 1] = MIN_BLOCK;
            variable = true;
        }
    }
    let mut start = 0usize;
    for (index, &n) in plan.iter().enumerate() {
        let mut split: Vec<Vec<i32>> = vec![Vec::with_capacity(n); channel_count];
        md5_bytes.clear();
        for frame in start..start + n {
            for (channel, lane) in split.iter_mut().enumerate() {
                let value = ints[frame * channel_count + channel];
                lane.push(value);
                md5_bytes.extend_from_slice(&value.to_le_bytes()[..usize::from(bits / 8)]);
            }
        }
        md5.update(&md5_bytes);
        let lanes: Vec<&[i32]> = split.iter().map(Vec::as_slice).collect();
        let number = if variable { start as u64 } else { index as u64 };
        let encoded = encode_frame(&lanes, number, variable, u32::from(bits))?;
        min_frame = min_frame.min(encoded.len() as u32);
        max_frame = max_frame.max(encoded.len() as u32);
        body.extend_from_slice(&encoded);
        block_sizes.push(n);
        start += n;
    }
    if block_sizes.is_empty() {
        min_frame = 0;
    }

    let (min_block, max_block) = if block_sizes.len() <= 1 {
        let only = block_sizes.first().copied().unwrap_or(0);
        (only, only)
    } else {
        // The last block may be shorter and is excluded from the minimum.
        let full = &block_sizes[..block_sizes.len() - 1];
        let max = full.iter().copied().max().unwrap_or(0);
        let min = if variable {
            block_sizes.iter().copied().min().unwrap_or(0)
        } else {
            full.iter().copied().min().unwrap_or(0)
        };
        (min, max)
    };

    let mut info = BitWriter::default();
    info.write(min_block as u64, 16);
    info.write(max_block as u64, 16);
    info.write(u64::from(min_frame), 24);
    info.write(u64::from(max_frame), 24);
    info.write(u64::from(SAMPLE_RATE), 20);
    info.write(u64::from(channels - 1), 3);
    info.write(u64::from(bits - 1), 5);
    info.write(frames as u64 >> 32, 4);
    info.write(frames as u64 & 0xffff_ffff, 32);
    let digest = md5.finalize();

    let comments = vorbis_comment_block(meta);
    let mut out = Vec::with_capacity(body.len() + comments.len() + 64);
    out.extend_from_slice(b"fLaC");
    out.push(0); // STREAMINFO, not last
    out.extend_from_slice(&[0, 0, 34]);
    out.extend_from_slice(&info.bytes);
    out.extend_from_slice(&digest);
    out.push(0x80 | 4); // VORBIS_COMMENT, last
    out.extend_from_slice(&(comments.len() as u32).to_be_bytes()[1..]);
    out.extend_from_slice(&comments);
    out.extend_from_slice(&body);
    Ok(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn crc_vectors() {
        // CRC-8 poly 0x07 and CRC-16 poly 0x8005 (init 0, no reflection).
        assert_eq!(crc8(b"123456789"), 0xf4);
        assert_eq!(crc16(b"123456789"), 0xfee8);
    }

    #[test]
    fn utf8_frame_numbers() {
        let mut out = Vec::new();
        write_utf8_number(&mut out, 0x7f);
        assert_eq!(out, [0x7f]);
        out.clear();
        write_utf8_number(&mut out, 0x80);
        assert_eq!(out, [0xc2, 0x80]);
        out.clear();
        write_utf8_number(&mut out, 0x800);
        assert_eq!(out, [0xe0, 0xa0, 0x80]);
        out.clear();
        write_utf8_number(&mut out, 0x1_0000);
        assert_eq!(out, [0xf0, 0x90, 0x80, 0x80]);
    }

    #[test]
    fn bit_writer_packs_msb_first() {
        let mut w = BitWriter::default();
        w.write(0b101, 3);
        w.write(0b1, 1);
        w.write(0b0110, 4);
        w.write_unary(2);
        w.align();
        assert_eq!(w.bytes, [0b1011_0110, 0b0010_0000]);
    }

    #[test]
    fn rejects_unsupported_shapes() {
        let meta = ExportMeta::bare();
        assert!(matches!(
            encode_flac(&[0.0; 4], 2, 32, &meta, None),
            Err(ExportError::UnsupportedBits(32))
        ));
        assert!(matches!(
            encode_flac(&[0.0; 6], 3, 16, &meta, None),
            Err(ExportError::UnsupportedChannels(3))
        ));
    }

    #[test]
    fn streaminfo_describes_the_stream() {
        let samples = vec![0.25f32; 10_000 * 2];
        let bytes = encode_flac(&samples, 2, 24, &ExportMeta::bare(), None).unwrap();
        assert_eq!(&bytes[0..4], b"fLaC");
        assert_eq!(bytes[4], 0); // STREAMINFO, not last
        // min/max block size: only full blocks count when there are several.
        assert_eq!(u16::from_be_bytes([bytes[8], bytes[9]]), 4096);
        assert_eq!(u16::from_be_bytes([bytes[10], bytes[11]]), 4096);
    }
}
