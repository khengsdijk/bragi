//! cpal audio output for the desktop host (`specs/03-audio-engine.md` §3.2).
//!
//! The engine runs in the device callback. Transport commands arrive over a
//! lock-free SPSC ring and are drained at the top of the callback; the meters
//! and playhead are published into a shared [`StateBlock`] at the bottom. No
//! allocation, lock, I/O or logging happens in the callback: every buffer is
//! allocated before the stream starts.
//!
//! The default buffer is 256 frames, configurable 64–2048. A device that refuses
//! 48 kHz is an error, because the engine works at the project rate and
//! resampling is a host concern (Q27).
//!
//! This module is only compiled on desktop; it has no automated test because a
//! build machine may have no audio device.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig};
use thiserror::Error;

use bragi_engine::SAMPLE_RATE;
use bragi_engine::engine::Engine;
use bragi_engine::pcm::PcmSource;
use bragi_engine::rt::{SpscU64, StateBlock};

/// Command opcodes packed into the high byte of a ring word.
mod opcode {
    /// Start or resume.
    pub(super) const PLAY: u8 = 1;
    /// Pause.
    pub(super) const PAUSE: u8 = 2;
    /// Stop and rewind.
    pub(super) const STOP: u8 = 3;
    /// Seek to a sample.
    pub(super) const SEEK: u8 = 4;
    /// Disable looping.
    pub(super) const LOOP_CLEAR: u8 = 5;
    /// Set the loop start (followed by a loop end word).
    pub(super) const LOOP_START: u8 = 6;
    /// Set the loop end.
    pub(super) const LOOP_END: u8 = 7;
    /// Enable or disable the audition overlay.
    pub(super) const AUDITION: u8 = 8;
}

/// Packs a command for the ring.
#[must_use]
pub fn command(kind: u8, value: u64) -> u64 {
    (u64::from(kind) << 56) | (value & 0x00FF_FFFF_FFFF_FFFF)
}

/// Splits a ring word back into `(kind, value)`.
#[must_use]
pub fn unpack(word: u64) -> (u8, u64) {
    ((word >> 56) as u8, word & 0x00FF_FFFF_FFFF_FFFF)
}

/// What went wrong opening the output stream.
#[derive(Debug, Error)]
pub enum OutputError {
    /// No output device is available.
    #[error("no audio output device")]
    NoDevice,
    /// The device does not support 48 kHz stereo.
    #[error("unsupported output format: {0}")]
    Unsupported(String),
    /// The device sample format is not handled.
    #[error("unsupported sample format {0:?}")]
    SampleFormat(SampleFormat),
    /// The stream could not be built or started.
    #[error("audio stream error: {0}")]
    Stream(String),
}

/// The desktop player: owns the cpal stream and the command sender.
pub struct NativePlayer {
    _stream: Stream,
    commands: Arc<SpscU64>,
    xruns: Arc<AtomicU64>,
    state: Arc<StateBlock>,
}

impl NativePlayer {
    /// Starts playback of `engine` reading from `pcm`.
    ///
    /// `buffer_frames` is clamped to 64..=2048 (`specs/03-audio-engine.md` §3.2).
    ///
    /// # Errors
    /// [`OutputError`] when there is no device, the device refuses 48 kHz
    /// stereo, or the stream cannot start.
    pub fn start(
        engine: Engine,
        pcm: Box<dyn PcmSource + Send>,
        state: Arc<StateBlock>,
        buffer_frames: usize,
    ) -> Result<Self, OutputError> {
        let host = cpal::default_host();
        let device = host.default_output_device().ok_or(OutputError::NoDevice)?;
        let supported = device
            .default_output_config()
            .map_err(|error| OutputError::Stream(error.to_string()))?;
        if supported.sample_rate().0 != SAMPLE_RATE {
            return Err(OutputError::Unsupported(format!(
                "device rate {} Hz; the engine runs at {SAMPLE_RATE} Hz",
                supported.sample_rate().0
            )));
        }
        if supported.channels() == 0 {
            return Err(OutputError::Unsupported("zero output channels".into()));
        }
        let sample_format = supported.sample_format();
        let mut config: StreamConfig = supported.into();
        let block = buffer_frames.clamp(64, 2048);
        config.buffer_size = cpal::BufferSize::Fixed(block as u32);

        let commands = Arc::new(SpscU64::new(64));
        let xruns = Arc::new(AtomicU64::new(0));
        let stream = match sample_format {
            SampleFormat::F32 => build_stream::<f32>(
                &device,
                &config,
                engine,
                pcm,
                commands.clone(),
                xruns.clone(),
                state.clone(),
                block,
            )?,
            SampleFormat::I16 => build_stream::<i16>(
                &device,
                &config,
                engine,
                pcm,
                commands.clone(),
                xruns.clone(),
                state.clone(),
                block,
            )?,
            other => return Err(OutputError::SampleFormat(other)),
        };
        stream
            .play()
            .map_err(|error| OutputError::Stream(error.to_string()))?;
        Ok(Self {
            _stream: stream,
            commands,
            xruns,
            state,
        })
    }

    /// The shared state block the UI reads.
    #[must_use]
    pub fn state(&self) -> &Arc<StateBlock> {
        &self.state
    }

    /// How many device callbacks reported an error.
    #[must_use]
    pub fn xruns(&self) -> u64 {
        self.xruns.load(Ordering::Relaxed)
    }

    /// Queues a raw command word. Returns `false` when the ring is full.
    pub fn send(&self, word: u64) -> bool {
        self.commands.push(word)
    }

    /// Starts or resumes playback.
    pub fn play(&self) -> bool {
        self.send(command(opcode::PLAY, 0))
    }

    /// Pauses playback.
    pub fn pause(&self) -> bool {
        self.send(command(opcode::PAUSE, 0))
    }

    /// Stops and rewinds.
    pub fn stop(&self) -> bool {
        self.send(command(opcode::STOP, 0))
    }

    /// Seeks to `sample`.
    pub fn seek(&self, sample: u64) -> bool {
        self.send(command(opcode::SEEK, sample))
    }

    /// Sets the loop region (two words).
    pub fn set_loop(&self, start: u64, end: u64) -> bool {
        self.send(command(opcode::LOOP_START, start)) && self.send(command(opcode::LOOP_END, end))
    }

    /// Clears the loop region.
    pub fn clear_loop(&self) -> bool {
        self.send(command(opcode::LOOP_CLEAR, 0))
    }

    /// Enables or disables the audition overlay.
    pub fn set_auditioning(&self, on: bool) -> bool {
        self.send(command(opcode::AUDITION, u64::from(on)))
    }
}

#[allow(clippy::too_many_arguments)]
fn build_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    mut engine: Engine,
    pcm: Box<dyn PcmSource + Send>,
    commands: Arc<SpscU64>,
    xruns: Arc<AtomicU64>,
    state: Arc<StateBlock>,
    block: usize,
) -> Result<Stream, OutputError>
where
    T: SizedSample + FromSample<f32> + Sample,
{
    let channels = config.channels as usize;
    let mut left = vec![0.0f32; block];
    let mut right = vec![0.0f32; block];
    let mut meter_words = vec![0u32; state.word_count()];
    let mut pending_loop_start: Option<u64> = None;
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _info: &cpal::OutputCallbackInfo| {
                while let Some(word) = commands.pop() {
                    let (kind, value) = unpack(word);
                    match kind {
                        opcode::PLAY => engine.transport_mut().play(),
                        opcode::PAUSE => engine.transport_mut().pause(),
                        opcode::STOP => engine.transport_mut().stop(),
                        opcode::SEEK => engine.transport_mut().seek(value),
                        opcode::LOOP_CLEAR => engine.transport_mut().set_loop(None),
                        opcode::LOOP_START => pending_loop_start = Some(value),
                        opcode::LOOP_END => {
                            if let Some(start) = pending_loop_start.take() {
                                engine.transport_mut().set_loop(Some((start, value)));
                            }
                        }
                        opcode::AUDITION => engine.transport_mut().set_auditioning(value != 0),
                        _ => {}
                    }
                }
                let frames = (data.len() / channels).min(block);
                engine.process(
                    pcm.as_ref(),
                    &mut [&mut left[..frames], &mut right[..frames]],
                );
                for frame in 0..frames {
                    let base = frame * channels;
                    if channels == 1 {
                        data[base] = T::from_sample(0.5 * (left[frame] + right[frame]));
                        continue;
                    }
                    data[base] = T::from_sample(left[frame]);
                    data[base + 1] = T::from_sample(right[frame]);
                    for channel in 2..channels {
                        data[base + channel] = T::from_sample(0.0f32);
                    }
                }
                engine.publish(&state, &mut meter_words);
            },
            move |_error| {
                xruns.fetch_add(1, Ordering::Relaxed);
            },
            None,
        )
        .map_err(|error| OutputError::Stream(error.to_string()))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn command_words_round_trip() {
        let word = command(opcode::SEEK, 123_456_789);
        assert_eq!(unpack(word), (opcode::SEEK, 123_456_789));
        assert_eq!(unpack(command(opcode::PLAY, 0)), (opcode::PLAY, 0));
    }
}
