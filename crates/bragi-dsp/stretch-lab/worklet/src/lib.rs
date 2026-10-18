//! A raw `wasm32-unknown-unknown` `cdylib` wrapping [`bragi_dsp::stretch`] for the AudioWorklet
//! test page (`../web`). No `wasm-bindgen`: the page instantiates the module with only its own
//! `memory` and calls the `pv_*` exports directly.
//!
//! This is a **test shim**, not shipping code: the registry uses a `Mutex` for convenience, and
//! the handle table is fixed. The shipping worklet glue is WP-1.1's job.

use bragi_dsp::stretch::{PhaseVocoder, Quality, Stretcher};
use std::alloc::{Layout, alloc, dealloc};
use std::sync::Mutex;

/// Maximum simultaneous stretchers the shim hands out.
const MAX_HANDLES: usize = 8;
/// Maximum channels a shimmed stretcher supports.
const MAX_CHANNELS: usize = 8;

static REGISTRY: Mutex<Vec<Option<Box<dyn Stretcher>>>> = Mutex::new(Vec::new());

fn with_stretcher<R>(id: u32, f: impl FnOnce(&mut dyn Stretcher) -> R) -> Option<R> {
    let mut reg = REGISTRY.lock().ok()?;
    let slot = reg.get_mut(id.checked_sub(1)? as usize)?.as_mut()?;
    Some(f(slot.as_mut()))
}

/// Creates a stretcher and returns a non-zero handle, or `0` on failure.
#[unsafe(no_mangle)]
pub extern "C" fn pv_new(channels: u32, sample_rate: u32) -> u32 {
    let Ok(st) = PhaseVocoder::new(channels as usize, sample_rate) else {
        return 0;
    };
    let Ok(mut reg) = REGISTRY.lock() else {
        return 0;
    };
    if let Some(i) = reg.iter().position(Option::is_none) {
        reg[i] = Some(Box::new(st));
        return i as u32 + 1;
    }
    if reg.len() >= MAX_HANDLES {
        return 0;
    }
    reg.push(Some(Box::new(st)));
    reg.len() as u32
}

/// Drops the stretcher behind `id`.
#[unsafe(no_mangle)]
pub extern "C" fn pv_free(id: u32) {
    if let Ok(mut reg) = REGISTRY.lock()
        && let Some(slot) = id.checked_sub(1).and_then(|i| reg.get_mut(i as usize))
    {
        *slot = None;
    }
}

/// Configures the stretcher. Returns 0 on success, 1 on a configuration error.
#[unsafe(no_mangle)]
pub extern "C" fn pv_configure(id: u32, ratio: f64, semitones: f32, quality: u32) -> i32 {
    let quality = if quality == 1 {
        Quality::Render
    } else {
        Quality::Preview
    };
    match with_stretcher(id, |st| st.configure(ratio, semitones, quality)) {
        Some(Ok(())) => 0,
        _ => 1,
    }
}

/// Input frames the next `pv_process` call consumes.
#[unsafe(no_mangle)]
pub extern "C" fn pv_input_required(id: u32, out_frames: u32) -> u32 {
    with_stretcher(id, |st| st.input_required(out_frames as usize)).unwrap_or(0) as u32
}

/// Algorithmic latency in output frames.
#[unsafe(no_mangle)]
pub extern "C" fn pv_latency(id: u32) -> u32 {
    with_stretcher(id, |st| st.latency()).unwrap_or(0) as u32
}

/// Forgets stream state.
#[unsafe(no_mangle)]
pub extern "C" fn pv_reset(id: u32) {
    let _ = with_stretcher(id, |st| st.reset());
}

/// Runs one block. `in_ptr`/`out_ptr` point at planar f32 buffers, `channels` × `frames`,
/// laid out channel-major (`ch0[0..frames], ch1[0..frames], …`).
///
/// # Safety
/// Both pointers must point to at least `channels * frames * 4` readable/writable bytes in this
/// module's linear memory for the duration of the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pv_process(
    id: u32,
    in_ptr: u32,
    out_ptr: u32,
    frames: u32,
    channels: u32,
) {
    let channels = (channels as usize).min(MAX_CHANNELS);
    let frames = frames as usize;
    if channels == 0 {
        return;
    }
    let in_base = in_ptr as usize as *const f32;
    let out_base = out_ptr as usize as *mut f32;
    let mut ins: [&[f32]; MAX_CHANNELS] = [&[]; MAX_CHANNELS];
    let mut outs: [&mut [f32]; MAX_CHANNELS] = core::array::from_fn(|_| -> &mut [f32] { &mut [] });
    for c in 0..channels {
        // SAFETY: the caller guarantees `channels * frames` f32 in each buffer.
        ins[c] = unsafe { core::slice::from_raw_parts(in_base.add(c * frames), frames) };
        // SAFETY: as above, for the writable output buffer.
        outs[c] = unsafe { core::slice::from_raw_parts_mut(out_base.add(c * frames), frames) };
    }
    let _ = with_stretcher(id, |st| st.process(&ins[..channels], &mut outs[..channels]));
}

/// Allocates `bytes` in this module's linear memory, returning the pointer (0 on failure).
#[unsafe(no_mangle)]
pub extern "C" fn pv_alloc(bytes: u32) -> u32 {
    let Ok(layout) = Layout::from_size_align(bytes.max(1) as usize, 4) else {
        return 0;
    };
    // SAFETY: `layout` has a non-zero size.
    let ptr = unsafe { alloc(layout) };
    ptr as usize as u32
}

/// Frees a pointer from [`pv_alloc`].
///
/// # Safety
/// `ptr`/`bytes` must come from a matching `pv_alloc` call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pv_dealloc(ptr: u32, bytes: u32) {
    if ptr == 0 {
        return;
    }
    let Ok(layout) = Layout::from_size_align(bytes.max(1) as usize, 4) else {
        return;
    };
    // SAFETY: the caller guarantees `ptr`/`bytes` came from `pv_alloc`.
    unsafe { dealloc(ptr as usize as *mut u8, layout) };
}
