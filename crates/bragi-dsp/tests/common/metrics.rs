//! Objective proxies for the "no flamming" listening criterion (WP-0.4).
//!
//! They supplement the owner's ears, they do not replace them. Everything works on a
//! 1 ms-hop energy envelope (20 ms RMS window, all channels pooled). The window is wide enough
//! that a 48 Hz kick does not ripple the estimate.
//!
//! `hit_report` is given the fixture's known hit times and measures, per hit:
//!
//! - **timing**: how far the output envelope's peak for that hit is from `latency + ratio·t`.
//! - **secondary attack ("flam")**: how far the envelope climbs back up out of its own decay
//!   8–60 ms after the peak. A hit that is reproduced twice shows up here.
//! - **pre-echo**: mean energy 5–35 ms *before* the peak relative to the hit's own peak. Phase
//!   vocoders smear energy ahead of transients; this measures it.
//! - **image**: left/right energy ratio over the first 30 ms of the hit.
//!
//! Anchoring to the known hit times, instead of detecting onsets in the source, is deliberate:
//! a kick's decay is not perfectly smooth, and a generic onset detector splits it into two, at
//! which point a perfect stretcher looks like it flammed.

#![allow(
    dead_code,
    unreachable_pub,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic
)]

/// Envelope hop and resolution of every measure here: one frame per millisecond.
pub const HOP_MS: f64 = 1.0;

/// Group delay of the centred RMS envelope, in ms (half the 20 ms window). A hit at time `t`
/// peaks at frame `t + ENVELOPE_LAG_MS`, because the window that peaks over an attack is the
/// one centred just after it.
pub const ENVELOPE_LAG_MS: f64 = 10.0;

/// Energy (dB) of a secondary attack that counts as a flam.
pub const FLAM_SECONDARY_DB: f32 = 12.0;

/// RMS envelope in dBFS, channels pooled, with a `win_ms`-wide centred window, 1 ms hop.
pub fn envelope_db_win(channels: &[Vec<f32>], sr: u32, win_ms: usize) -> Vec<f32> {
    let hop = (sr as usize) / 1000;
    let win = hop * win_ms;
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

/// 1 ms-hop, 20 ms-window RMS envelope in dBFS, channels pooled.
pub fn envelope_db(channels: &[Vec<f32>], sr: u32) -> Vec<f32> {
    envelope_db_win(channels, sr, 20)
}

/// Per-channel envelope in linear power (same framing as [`envelope_db`]).
pub fn channel_power(channel: &[f32], sr: u32) -> Vec<f64> {
    let hop = (sr as usize) / 1000;
    let win = hop * 20;
    let n = channel.len() / hop;
    (0..n)
        .map(|i| {
            let start = (i * hop).saturating_sub(win / 2);
            let end = (start + win).min(channel.len());
            channel[start..end]
                .iter()
                .map(|&s| f64::from(s) * f64::from(s))
                .sum::<f64>()
                / (end - start).max(1) as f64
        })
        .collect()
}

/// How far (dB) the envelope climbs back up out of its decay 8–60 ms after `hit`.
pub fn secondary_attack_db(env: &[f32], hit: usize) -> f32 {
    let start = hit + 3;
    let end = (hit + 60).min(env.len().saturating_sub(1));
    if start >= end {
        return 0.0;
    }
    let mut running_min = env[start];
    let mut worst = 0.0f32;
    for (j, &e) in env.iter().enumerate().take(end + 1).skip(start) {
        running_min = running_min.min(e);
        if j >= hit + 8 {
            worst = worst.max(e - running_min);
        }
    }
    worst
}

/// Mean energy 5–35 ms before `hit`, relative to the hit's peak (first 10 ms), in dB.
pub fn pre_echo_db(env: &[f32], hit: usize) -> f32 {
    if hit < 35 || hit + 10 >= env.len() {
        return f32::NEG_INFINITY;
    }
    let pre: f64 = env[hit - 35..hit - 5]
        .iter()
        .map(|&d| 10f64.powf(f64::from(d) / 10.0))
        .sum::<f64>()
        / 30.0;
    let peak = env[hit..hit + 10]
        .iter()
        .copied()
        .fold(f32::NEG_INFINITY, f32::max);
    (10.0 * pre.log10()) as f32 - peak
}

/// Left/right energy ratio (dB) over the first 30 ms after `hit`.
pub fn image_db(left: &[f64], right: &[f64], hit: usize) -> f64 {
    let end = (hit + 30).min(left.len()).min(right.len());
    let l: f64 = left[hit.min(end)..end].iter().sum();
    let r: f64 = right[hit.min(end)..end].iter().sum();
    10.0 * ((l + 1e-15) / (r + 1e-15)).log10()
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
    /// Number of known hits considered.
    pub hits: usize,
    /// Hits whose output peak is within `timing_tol_ms` of `latency + ratio·t`.
    pub matched: usize,
    /// Hits with a clear secondary attack (≥ [`FLAM_SECONDARY_DB`]): the audible flams.
    pub flams: usize,
    /// Worst increase of the secondary-attack measure over the source, in dB.
    pub worst_secondary_increase_db: f32,
    /// Worst increase of pre-echo over the source, in dB.
    pub worst_pre_echo_increase_db: f32,
    /// Median pre-echo increase over the source, in dB.
    pub median_pre_echo_increase_db: f32,
    /// Worst change of the per-hit left/right energy ratio, in dB (0 for mono).
    pub worst_image_shift_db: f64,
    /// Worst timing error of a matched hit, in ms.
    pub worst_timing_ms: f64,
}

/// Measures the flam proxies for `output` against `source`, for the hits at `hit_times_ms`
/// (source milliseconds). `ratio` = output/input duration, `latency` in output frames.
pub fn hit_report(
    source: &[Vec<f32>],
    output: &[Vec<f32>],
    sr: u32,
    ratio: f64,
    latency: usize,
    hit_times_ms: &[f64],
) -> FlamReport {
    let env_in = envelope_db(source, sr);
    let env_out = envelope_db(output, sr);
    // A finer envelope isolates pre-echo, which the 20 ms envelope smooths away.
    let fine_in = envelope_db_win(source, sr, 5);
    let fine_out = envelope_db_win(output, sr, 5);
    let lat_ms = latency as f64 * 1000.0 / f64::from(sr);
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

    let mut matched = 0usize;
    let mut flams = 0usize;
    let mut worst_sec = f32::NEG_INFINITY;
    let mut pre_incs: Vec<f32> = Vec::new();
    let mut worst_img = 0.0f64;
    let mut worst_t = 0.0f64;
    let mut hits = 0usize;

    for &t in hit_times_ms {
        let out_ms = t * ratio + lat_ms;
        if out_ms < 45.0 || out_ms + 90.0 >= env_out.len() as f64 {
            continue;
        }
        hits += 1;
        // `t` is already in milliseconds; the source envelopes are 1 ms-hop, so the hit's
        // source frame is `t` (not `t * sr / 1000`, which is a sample index and would index the
        // envelopes far out of range). A hit at `t` peaks at `t + ENVELOPE_LAG_MS` in the 20 ms
        // envelope and `t + 2` in the 5 ms fine envelope.
        let src_ms = t as usize;
        let target = out_ms + ENVELOPE_LAG_MS;
        let lo = (target - 30.0) as usize;
        let hi = ((target + 60.0) as usize).min(env_out.len() - 1);
        // The hit's main peak is the envelope maximum in the window around `target`.
        let mut pk = lo;
        for j in lo..=hi {
            if env_out[j] > env_out[pk] {
                pk = j;
            }
        }
        // Within 12 ms counts as "the hit arrived"; more is a timing error.
        if (pk as f64 - target).abs() <= 12.0 {
            matched += 1;
        }
        worst_t = worst_t.max((pk as f64 - target).abs());
        let sec_out = secondary_attack_db(&env_out, pk);
        if sec_out >= FLAM_SECONDARY_DB {
            flams += 1;
        }
        worst_sec = worst_sec
            .max(sec_out - secondary_attack_db(&env_in, src_ms + ENVELOPE_LAG_MS as usize));
        let pi = pre_echo_db(&fine_in, src_ms + 2);
        let po = pre_echo_db(&fine_out, pk);
        if pi.is_finite() && po.is_finite() {
            pre_incs.push(po - pi);
        }
        if stereo {
            worst_img = worst_img.max(
                (image_db(&pl_out, &pr_out, pk)
                    - image_db(&pl_in, &pr_in, src_ms + ENVELOPE_LAG_MS as usize))
                .abs(),
            );
        }
    }
    pre_incs.sort_by(f32::total_cmp);
    FlamReport {
        hits,
        matched,
        flams,
        worst_secondary_increase_db: worst_sec,
        worst_pre_echo_increase_db: pre_incs.last().copied().unwrap_or(0.0),
        median_pre_echo_increase_db: pre_incs.get(pre_incs.len() / 2).copied().unwrap_or(0.0),
        worst_image_shift_db: worst_img,
        worst_timing_ms: worst_t,
    }
}
