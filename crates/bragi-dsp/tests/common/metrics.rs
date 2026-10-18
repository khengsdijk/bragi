//! Objective proxies for the "no flamming" listening criterion (WP-0.4).
//!
//! They supplement the owner's ears, they do not replace them. Everything works on a
//! 1 ms-hop energy envelope (5 ms RMS window, all channels pooled):
//!
//! - **onsets**: an envelope rise of ≥ 9 dB over the minimum of the previous 8 ms, above
//!   −45 dBFS, with a 30 ms refractory period. A stretcher that doubles attacks far enough
//!   apart to hear as two hits produces extra onsets.
//! - **secondary attack** (flam): after an onset, how far the envelope climbs back up out of
//!   its own decay within 8–50 ms. A clean hit decays; a flam rises again.
//! - **pre-echo**: mean energy 5–35 ms *before* an onset relative to the hit's peak. Phase
//!   vocoders smear energy ahead of transients; this measures it.
//! - **image**: left/right energy ratio over the first 30 ms of a hit.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

/// Envelope hop and resolution of every measure here: one frame per millisecond.
pub const HOP_MS: f64 = 1.0;

/// 1 ms-hop, 5 ms-window RMS envelope in dBFS, channels pooled. `sr` in Hz.
pub fn envelope_db(channels: &[Vec<f32>], sr: u32) -> Vec<f32> {
    let hop = (sr as usize) / 1000;
    let win = hop * 5;
    let frames = channels.first().map_or(0, Vec::len);
    let n = frames / hop;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let start = (i * hop).saturating_sub(win / 2);
        let end = (start + win).min(frames);
        let mut acc = 0.0f64;
        for c in channels {
            for &s in &c[start..end] {
                acc += f64::from(s) * f64::from(s);
            }
        }
        let ms = acc / ((end - start).max(1) * channels.len().max(1)) as f64;
        out.push((10.0 * (ms + 1e-12).log10()) as f32);
    }
    out
}

/// Per-channel envelope in linear power (same framing as [`envelope_db`]).
pub fn channel_power(channel: &[f32], sr: u32) -> Vec<f64> {
    let hop = (sr as usize) / 1000;
    let win = hop * 5;
    let n = channel.len() / hop;
    (0..n)
        .map(|i| {
            let start = (i * hop).saturating_sub(win / 2);
            let end = (start + win).min(channel.len());
            channel[start..end].iter().map(|&s| f64::from(s) * f64::from(s)).sum::<f64>()
                / (end - start).max(1) as f64
        })
        .collect()
}

/// Onset frames (= milliseconds) from an envelope.
pub fn detect_onsets(env: &[f32]) -> Vec<usize> {
    let mut onsets = Vec::new();
    let mut last: Option<usize> = None;
    for i in 8..env.len() {
        let floor = env[i - 8..i].iter().copied().fold(f32::INFINITY, f32::min);
        if env[i] - floor >= 9.0 && env[i] > -45.0 && last.is_none_or(|l| i - l >= 30) {
            // Walk forward to the local maximum slope region: keep the first frame of the rise.
            onsets.push(i);
            last = Some(i);
        }
    }
    onsets
}

/// How far (dB) the envelope climbs back up out of its decay 8–50 ms after `onset`.
pub fn secondary_attack_db(env: &[f32], onset: usize) -> f32 {
    let start = onset + 3;
    let end = (onset + 50).min(env.len().saturating_sub(1));
    if start >= end {
        return 0.0;
    }
    let mut running_min = env[start];
    let mut worst = 0.0f32;
    for (j, &e) in env.iter().enumerate().take(end + 1).skip(start) {
        running_min = running_min.min(e);
        if j >= onset + 8 {
            worst = worst.max(e - running_min);
        }
    }
    worst
}

/// Mean energy 5–35 ms before `onset`, relative to the hit's peak (first 10 ms), in dB.
pub fn pre_echo_db(env: &[f32], onset: usize) -> f32 {
    if onset < 35 || onset + 10 >= env.len() {
        return f32::NEG_INFINITY;
    }
    let pre: f64 = env[onset - 35..onset - 5].iter().map(|&d| 10f64.powf(f64::from(d) / 10.0)).sum::<f64>()
        / 30.0;
    let peak = env[onset..onset + 10].iter().copied().fold(f32::NEG_INFINITY, f32::max);
    (10.0 * pre.log10()) as f32 - peak
}

/// Left/right energy ratio (dB) over the first 30 ms after `onset`.
pub fn image_db(left: &[f64], right: &[f64], onset: usize) -> f64 {
    let end = (onset + 30).min(left.len()).min(right.len());
    let l: f64 = left[onset.min(end)..end].iter().sum();
    let r: f64 = right[onset.min(end)..end].iter().sum();
    10.0 * ((l + 1e-15) / (r + 1e-15)).log10()
}

/// Pairs each expected onset (ms) with the nearest detected onset within `tol_ms`.
/// Returns `(pairs (expected_ms, detected_frame), extra detected onsets)`.
pub fn match_onsets(expected_ms: &[f64], detected: &[usize], tol_ms: f64) -> (Vec<(f64, Option<usize>)>, Vec<usize>) {
    let mut used = vec![false; detected.len()];
    let mut pairs = Vec::new();
    for &e in expected_ms {
        let best = detected
            .iter()
            .enumerate()
            .filter(|(k, d)| !used[*k] && (**d as f64 - e).abs() <= tol_ms)
            .min_by(|a, b| (*a.1 as f64 - e).abs().total_cmp(&(*b.1 as f64 - e).abs()));
        if let Some((k, &d)) = best {
            used[k] = true;
            pairs.push((e, Some(d)));
        } else {
            pairs.push((e, None));
        }
    }
    let extra = detected.iter().zip(&used).filter(|(_, u)| !**u).map(|(d, _)| *d).collect();
    (pairs, extra)
}

/// Frequency of a (near-)pure tone by interpolated zero crossings over `x`. `sr` in Hz.
pub fn zero_crossing_hz(x: &[f32], sr: u32) -> f64 {
    let mut first: Option<f64> = None;
    let mut last = 0.0f64;
    let mut count = 0usize;
    for i in 1..x.len() {
        let (a, b) = (x[i - 1], x[i]);
        if a <= 0.0 && b > 0.0 {
            let t = (i - 1) as f64 + f64::from(-a) / f64::from(b - a);
            if first.is_none() {
                first = Some(t);
            } else {
                count += 1;
            }
            last = t;
        }
    }
    match first {
        Some(f) if count > 0 => f64::from(sr) * count as f64 / (last - f),
        _ => 0.0,
    }
}

/// Summary of the flam proxies for one rendering, compared against its source.
#[derive(Debug, Clone)]
pub struct FlamReport {
    /// Onsets detected in the source.
    pub source_onsets: usize,
    /// Source onsets found again at the expected (stretched, latency-shifted) time.
    pub matched: usize,
    /// Onsets in the output that correspond to no source onset (doubled attacks, chatter).
    pub extra: usize,
    /// Worst increase of the secondary-attack measure over the source, in dB.
    pub worst_secondary_increase_db: f32,
    /// Worst increase of pre-echo over the source, in dB.
    pub worst_pre_echo_increase_db: f32,
    /// Median pre-echo increase over the source, in dB.
    pub median_pre_echo_increase_db: f32,
    /// Worst change of the per-hit left/right energy ratio, in dB (0 for mono).
    pub worst_image_shift_db: f64,
    /// Worst timing error of a matched onset, in ms.
    pub worst_timing_ms: f64,
}

/// Compares an output against its source. `ratio` = output/input duration, `latency` in
/// output frames. Onsets closer than 60 ms to either end are ignored.
pub fn flam_report(source: &[Vec<f32>], output: &[Vec<f32>], sr: u32, ratio: f64, latency: usize) -> FlamReport {
    let env_in = envelope_db(source, sr);
    let env_out = envelope_db(output, sr);
    let lat_ms = latency as f64 * 1000.0 / f64::from(sr);
    let src_onsets: Vec<usize> = detect_onsets(&env_in)
        .into_iter()
        .filter(|&o| o >= 60 && (o as f64 * ratio + lat_ms + 60.0) < env_out.len() as f64)
        .collect();
    let expected: Vec<f64> = src_onsets.iter().map(|&o| o as f64 * ratio + lat_ms).collect();
    let lo = expected.first().copied().unwrap_or(0.0) - 20.0;
    let hi = expected.last().copied().unwrap_or(0.0) + 20.0;
    let out_onsets: Vec<usize> =
        detect_onsets(&env_out).into_iter().filter(|&o| (o as f64) >= lo && (o as f64) <= hi).collect();
    let (pairs, extra) = match_onsets(&expected, &out_onsets, 6.0);
    let stereo = source.len() == 2 && output.len() == 2;
    let (pl_in, pr_in, pl_out, pr_out) = if stereo {
        (
            channel_power(&source[0], sr),
            channel_power(&source[1], sr),
            channel_power(&output[0], sr),
            channel_power(&output[1], sr),
        )
    } else {
        (vec![], vec![], vec![], vec![])
    };
    let mut worst_sec = f32::NEG_INFINITY;
    let mut pre_incs = Vec::new();
    let mut worst_img = 0.0f64;
    let mut worst_t = 0.0f64;
    let mut matched = 0;
    for (k, (e, d)) in pairs.iter().enumerate() {
        let Some(d) = *d else { continue };
        matched += 1;
        let s = src_onsets[k];
        worst_t = worst_t.max((d as f64 - e).abs());
        worst_sec = worst_sec.max(secondary_attack_db(&env_out, d) - secondary_attack_db(&env_in, s));
        let pi = pre_echo_db(&env_in, s);
        let po = pre_echo_db(&env_out, d);
        if pi.is_finite() && po.is_finite() {
            pre_incs.push(po - pi);
        }
        if stereo {
            let shift = (image_db(&pl_out, &pr_out, d) - image_db(&pl_in, &pr_in, s)).abs();
            worst_img = worst_img.max(shift);
        }
    }
    pre_incs.sort_by(f32::total_cmp);
    FlamReport {
        source_onsets: src_onsets.len(),
        matched,
        extra: extra.len(),
        worst_secondary_increase_db: worst_sec,
        worst_pre_echo_increase_db: pre_incs.last().copied().unwrap_or(0.0),
        median_pre_echo_increase_db: pre_incs.get(pre_incs.len() / 2).copied().unwrap_or(0.0),
        worst_image_shift_db: worst_img,
        worst_timing_ms: worst_t,
    }
}
