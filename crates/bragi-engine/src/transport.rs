//! The transport state machine and block scheduling
//! (`specs/03-audio-engine.md` §5).
//!
//! `Stopped → Playing ⇄ Paused`, `Playing → Looping(region)`,
//! `any → Scrubbing → previous`, plus an audition overlay that can be active
//! while playing or looping.
//!
//! The playhead is an integer sample counter, so it cannot drift against the
//! device clock: a host that has rendered `n` frames is at `start + n` exactly.
//! Every transition is applied on a block boundary; the scheduler reports loop
//! wraps and song ends so the mixer never overshoots.
//!
//! ```
//! use bragi_engine::transport::{Transport, TransportState};
//! let mut transport = Transport::new(48_000);
//! transport.play();
//! assert_eq!(transport.state(), TransportState::Playing);
//! let schedule = transport.schedule(128, 240);
//! assert!(schedule.playing);
//! assert_eq!(schedule.first_frames, 128);
//! assert_eq!(transport.playhead(), 128);
//! ```

/// The five states of the transport (`specs/03-audio-engine.md` §5.1).
///
/// Auditioning is an **overlay** (`is_auditioning`), not a sixth state, exactly
/// as the spec describes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TransportState {
    /// No audio; the playhead is wherever it was last placed.
    Stopped,
    /// Playing the arrangement.
    Playing,
    /// Held at the playhead with all stream state intact.
    Paused,
    /// Playing within a loop region.
    Looping,
    /// The playhead is being dragged; audio follows the drag.
    Scrubbing,
}

/// A loop region in output samples: `[start, end)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LoopRegion {
    /// First sample.
    pub start: u64,
    /// End sample (exclusive).
    pub end: u64,
}

impl LoopRegion {
    /// The region's length in samples.
    #[must_use]
    pub fn len(&self) -> u64 {
        self.end.saturating_sub(self.start)
    }

    /// Whether the region is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// How one block continues after a loop wrap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LoopWrap {
    /// Where the outgoing (post-loop-end) tail is read from.
    pub outgoing_start: u64,
    /// Where the incoming (loop-start) material is read from.
    pub incoming_start: u64,
    /// Crossfade length in frames.
    pub frames: usize,
}

/// What the mixer should render for one block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlockSchedule {
    /// Whether any audio should sound.
    pub playing: bool,
    /// First range's start sample.
    pub first_start: u64,
    /// First range's length in frames.
    pub first_frames: usize,
    /// The crossfade at a loop wrap, if this block contains one.
    pub wrap: Option<LoopWrap>,
    /// Where the remainder of the block starts (after a wrap, the loop start).
    pub resume_start: u64,
    /// How many frames remain after `first_frames` and the wrap crossfade.
    pub resume_frames: usize,
}

impl BlockSchedule {
    /// A silent block.
    #[must_use]
    pub fn silent() -> Self {
        Self {
            playing: false,
            first_start: 0,
            first_frames: 0,
            wrap: None,
            resume_start: 0,
            resume_frames: 0,
        }
    }
}

/// The transport state machine.
#[derive(Clone, Debug)]
pub struct Transport {
    state: TransportState,
    playhead: u64,
    length: u64,
    loop_region: Option<LoopRegion>,
    scrub_return: TransportState,
    auditioning: bool,
}

impl Transport {
    /// A stopped transport for an arrangement of `length` samples.
    #[must_use]
    pub fn new(length: u64) -> Self {
        Self {
            state: TransportState::Stopped,
            playhead: 0,
            length,
            loop_region: None,
            scrub_return: TransportState::Stopped,
            auditioning: false,
        }
    }

    /// The current state.
    #[must_use]
    pub fn state(&self) -> TransportState {
        self.state
    }

    /// The current playhead in output samples.
    #[must_use]
    pub fn playhead(&self) -> u64 {
        self.playhead
    }

    /// The arrangement length in samples.
    #[must_use]
    pub fn length(&self) -> u64 {
        self.length
    }

    /// The active loop region.
    #[must_use]
    pub fn loop_region(&self) -> Option<LoopRegion> {
        self.loop_region
    }

    /// Whether the audition overlay is active.
    #[must_use]
    pub fn is_auditioning(&self) -> bool {
        self.auditioning
    }

    /// Whether audio is sounding (playing, looping or scrubbing).
    #[must_use]
    pub fn is_playing(&self) -> bool {
        matches!(
            self.state,
            TransportState::Playing | TransportState::Looping | TransportState::Scrubbing
        )
    }

    /// Updates the arrangement length (a plan reload). Clamps the playhead and
    /// drops a loop that no longer fits.
    pub fn set_length(&mut self, length: u64) {
        self.length = length;
        if self.playhead > length {
            self.playhead = length;
            self.state = TransportState::Stopped;
        }
        if let Some(region) = self.loop_region
            && (region.end > length || region.start > length)
        {
            self.loop_region = None;
            if self.state == TransportState::Looping {
                self.state = TransportState::Playing;
            }
        }
    }

    /// Starts or resumes playback. Playing from the end restarts at the top.
    pub fn play(&mut self) {
        if self.state == TransportState::Paused {
            self.state = self.playing_state();
            return;
        }
        if self.state == TransportState::Stopped {
            if self.playhead >= self.length {
                self.playhead = self.loop_region.map_or(0, |region| region.start);
            }
            self.state = self.playing_state();
        }
    }

    fn playing_state(&self) -> TransportState {
        if self.loop_region.is_some() {
            TransportState::Looping
        } else {
            TransportState::Playing
        }
    }

    /// Pauses at the current playhead.
    pub fn pause(&mut self) {
        if self.is_playing() {
            self.state = TransportState::Paused;
        }
    }

    /// Stops and rewinds to the start.
    pub fn stop(&mut self) {
        self.state = TransportState::Stopped;
        self.playhead = 0;
    }

    /// Moves the playhead. The change takes effect on the next block.
    pub fn seek(&mut self, sample: u64) {
        self.playhead = sample.min(self.length);
    }

    /// Enables or disables looping. An invalid region is ignored.
    pub fn set_loop(&mut self, region: Option<(u64, u64)>) {
        self.loop_region = region.and_then(|(start, end)| {
            let start = start.min(self.length);
            let end = end.min(self.length);
            if end > start {
                Some(LoopRegion { start, end })
            } else {
                None
            }
        });
        match self.state {
            TransportState::Playing if self.loop_region.is_some() => {
                self.state = TransportState::Looping;
            }
            TransportState::Looping if self.loop_region.is_none() => {
                self.state = TransportState::Playing;
            }
            _ => {}
        }
    }

    /// Begins a playhead drag.
    pub fn scrub_begin(&mut self) {
        if self.state != TransportState::Scrubbing {
            self.scrub_return = self.state;
            self.state = TransportState::Scrubbing;
        }
    }

    /// Moves the playhead during a drag.
    pub fn scrub_to(&mut self, sample: u64) {
        self.seek(sample);
    }

    /// Ends a playhead drag, returning to the previous state.
    pub fn scrub_end(&mut self) {
        if self.state == TransportState::Scrubbing {
            self.state = self.scrub_return;
        }
    }

    /// Enables or disables the audition overlay.
    pub fn set_auditioning(&mut self, auditioning: bool) {
        self.auditioning = auditioning;
    }

    /// The schedule for a block of at most `frames` frames with a loop
    /// crossfade of at most `fade_frames`.
    pub fn schedule(&mut self, frames: usize, fade_frames: usize) -> BlockSchedule {
        if !self.is_playing() || self.length == 0 || frames == 0 {
            return BlockSchedule::silent();
        }
        let frames_u64 = frames as u64;
        if let Some(region) = self.loop_region {
            if self.playhead < region.start || self.playhead >= region.end {
                self.playhead = region.start;
            }
            let available = region.end.saturating_sub(self.playhead);
            if available >= frames_u64 {
                let schedule = BlockSchedule {
                    playing: true,
                    first_start: self.playhead,
                    first_frames: frames,
                    wrap: None,
                    resume_start: 0,
                    resume_frames: 0,
                };
                self.playhead += frames_u64;
                return schedule;
            }
            let first = available as usize;
            let remaining = frames - first;
            let fade = fade_frames
                .min(remaining)
                .min((region.len() / 2).max(1) as usize);
            let resume_frames = remaining.saturating_sub(fade);
            let resume_start = region.start + fade as u64;
            let after = resume_start + resume_frames as u64;
            let wrapped = if after >= region.end {
                region.start + (after - region.start) % region.len().max(1)
            } else {
                after
            };
            let schedule = BlockSchedule {
                playing: true,
                first_start: self.playhead,
                first_frames: first,
                wrap: if fade > 0 {
                    Some(LoopWrap {
                        outgoing_start: region.end,
                        incoming_start: region.start,
                        frames: fade,
                    })
                } else {
                    None
                },
                resume_start,
                resume_frames,
            };
            self.playhead = wrapped;
            return schedule;
        }

        let available = self.length.saturating_sub(self.playhead);
        if available >= frames_u64 {
            let schedule = BlockSchedule {
                playing: true,
                first_start: self.playhead,
                first_frames: frames,
                wrap: None,
                resume_start: 0,
                resume_frames: 0,
            };
            self.playhead += frames_u64;
            return schedule;
        }
        let first = available as usize;
        let schedule = BlockSchedule {
            playing: true,
            first_start: self.playhead,
            first_frames: first,
            wrap: None,
            resume_start: 0,
            resume_frames: 0,
        };
        self.playhead = self.length;
        self.state = TransportState::Stopped;
        schedule
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn stop_play_pause_transitions() {
        let mut transport = Transport::new(1_000);
        assert_eq!(transport.state(), TransportState::Stopped);
        transport.play();
        assert_eq!(transport.state(), TransportState::Playing);
        transport.pause();
        assert_eq!(transport.state(), TransportState::Paused);
        transport.play();
        assert_eq!(transport.state(), TransportState::Playing);
        transport.stop();
        assert_eq!(transport.state(), TransportState::Stopped);
        assert_eq!(transport.playhead(), 0);
    }

    #[test]
    fn block_advances_the_playhead_exactly() {
        let mut transport = Transport::new(1_000);
        transport.play();
        for _ in 0..3 {
            let schedule = transport.schedule(128, 240);
            assert_eq!(schedule.first_frames, 128);
        }
        assert_eq!(transport.playhead(), 384);
    }

    #[test]
    fn play_from_the_end_restarts() {
        let mut transport = Transport::new(100);
        transport.seek(100);
        transport.play();
        assert_eq!(transport.playhead(), 0);
    }

    #[test]
    fn looping_wraps_at_the_boundary_with_a_crossfade() {
        let mut transport = Transport::new(10_000);
        transport.set_loop(Some((1_000, 1_500)));
        transport.seek(1_400);
        transport.play();
        assert_eq!(transport.state(), TransportState::Looping);
        let schedule = transport.schedule(200, 240);
        assert_eq!(schedule.first_frames, 100);
        let wrap = schedule.wrap.unwrap();
        assert_eq!(wrap.frames, 100);
        assert_eq!(wrap.incoming_start, 1_000);
        assert_eq!(wrap.outgoing_start, 1_500);
        assert_eq!(schedule.resume_start, 1_100);
        assert_eq!(schedule.resume_frames, 0);
        assert_eq!(transport.playhead(), 1_100);
    }

    #[test]
    fn song_end_stops_after_the_last_block() {
        let mut transport = Transport::new(300);
        transport.play();
        let schedule = transport.schedule(128, 240);
        assert_eq!(schedule.first_frames, 128);
        let schedule = transport.schedule(128, 240);
        assert_eq!(schedule.first_frames, 128);
        let schedule = transport.schedule(128, 240);
        assert_eq!(schedule.first_frames, 44);
        assert_eq!(transport.state(), TransportState::Stopped);
        assert_eq!(transport.playhead(), 300);
    }

    #[test]
    fn scrubbing_returns_to_the_previous_state() {
        let mut transport = Transport::new(1_000);
        transport.play();
        transport.scrub_begin();
        assert_eq!(transport.state(), TransportState::Scrubbing);
        transport.scrub_to(500);
        assert_eq!(transport.playhead(), 500);
        transport.scrub_end();
        assert_eq!(transport.state(), TransportState::Playing);
    }

    #[test]
    fn invalid_loop_is_ignored() {
        let mut transport = Transport::new(1_000);
        transport.set_loop(Some((800, 800)));
        assert_eq!(transport.loop_region(), None);
        transport.set_loop(Some((800, 2_000)));
        assert_eq!(
            transport.loop_region(),
            Some(LoopRegion {
                start: 800,
                end: 1_000
            })
        );
    }
}
