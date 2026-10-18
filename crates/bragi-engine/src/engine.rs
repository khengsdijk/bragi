//! The engine facade: documents in, audio out, plus the state a host publishes.
//!
//! [`Engine`] owns the renderer, the transport and the plan version, and is what
//! both `EngineHost` implementations drive. It is platform-free: it takes a
//! [`PcmSource`] per call, so the browser can pass a
//! [`ChunkPool`](crate::chunkpool) and desktop an mmap cache.
//!
//! ```
//! use bragi_engine::engine::Engine;
//! use bragi_engine::pcm::MemoryPcm;
//! # fn plan() -> bragi_engine::plan::RenderPlan {
//! #   let doc: bragi_model::generated::Project = serde_json::from_value(serde_json::json!({
//! #     "schemaVersion": 1, "id": "prj_01",
//! #     "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
//! #     "sources": [], "analyses": {}, "tracks": [],
//! #     "arrangement": { "timebase": { "ppq": 960,
//! #         "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }], "timeSignatures": [] },
//! #         "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } } })).unwrap();
//! #   bragi_engine::plan::compile(&doc, &bragi_model::AssetIndex::new(), 48_000, 1).unwrap()
//! # }
//! let mut engine = Engine::new(plan(), 128);
//! engine.transport_mut().play();
//! let pcm = MemoryPcm::new();
//! let mut left = [0.0f32; 128];
//! let mut right = [0.0f32; 128];
//! engine.process(&pcm, &mut [&mut left, &mut right]);
//! ```

use std::sync::Arc;

use bragi_model::AssetIndex;
use bragi_model::EngineDelta;
use bragi_model::generated::{Project, ProjectId};

use crate::error::EngineError;
use crate::meters::Meters;
use crate::pcm::PcmSource;
use crate::plan::{RenderPlan, compile, compile_delta};
use crate::preview::{PreviewPatch, apply as apply_preview};
use crate::render::{PreparedPlan, RenderStats, Renderer};
use crate::rt::StateBlock;
use crate::transport::Transport;

/// Something the UI should know about (`specs/03-audio-engine.md` §3.3).
///
/// Kept `Copy` and `String`-free so the audio thread can push it into a
/// pre-allocated ring without allocating.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineEvent {
    /// A block read PCM that was not resident.
    Underrun {
        /// The playhead when it happened.
        sample: u64,
        /// How many reads missed in that block.
        count: u32,
    },
    /// A new plan was installed.
    PlanCompiled {
        /// The new plan version.
        version: u64,
    },
    /// The preview overlay was set or cleared.
    PreviewChanged {
        /// Whether a preview is active.
        active: bool,
    },
}

/// A fixed-capacity ring of events. Pushing to a full ring overwrites the
/// oldest event, so the audio thread never blocks and never allocates.
#[derive(Debug)]
pub struct EventRing {
    buf: Vec<EngineEvent>,
    head: usize,
    len: usize,
}

impl EventRing {
    /// A ring of `capacity` events (at least 1).
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        Self {
            buf: vec![EngineEvent::PlanCompiled { version: 0 }; capacity.max(1)],
            head: 0,
            len: 0,
        }
    }

    /// Adds one event, dropping the oldest when full.
    pub fn push(&mut self, event: EngineEvent) {
        let capacity = self.buf.len();
        if self.len < capacity {
            let index = (self.head + self.len) % capacity;
            self.buf[index] = event;
            self.len += 1;
        } else {
            self.buf[self.head] = event;
            self.head = (self.head + 1) % capacity;
        }
    }

    /// The events, oldest first.
    pub fn iter(&self) -> impl Iterator<Item = &EngineEvent> {
        let capacity = self.buf.len();
        (0..self.len).map(move |offset| &self.buf[(self.head + offset) % capacity])
    }

    /// How many events are buffered.
    #[must_use]
    pub fn len(&self) -> usize {
        self.len
    }

    /// Whether no events are buffered.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Drops every buffered event.
    pub fn clear(&mut self) {
        self.head = 0;
        self.len = 0;
    }
}

/// The engine.
#[derive(Debug)]
pub struct Engine {
    renderer: Renderer,
    block_size: usize,
    underruns: u64,
    events: EventRing,
    preview: Option<PreviewPatch>,
    project_id: Option<ProjectId>,
}

impl Engine {
    /// Creates an engine for `plan`, processing blocks of at most `block_size`.
    #[must_use]
    pub fn new(plan: RenderPlan, block_size: usize) -> Self {
        let version = plan.plan_version;
        let renderer = Renderer::new(Arc::new(plan), block_size);
        let mut events = EventRing::new(64);
        events.push(EngineEvent::PlanCompiled { version });
        Self {
            renderer,
            block_size,
            underruns: 0,
            events,
            preview: None,
            project_id: None,
        }
    }

    /// Compiles and loads a document, replacing any current plan.
    ///
    /// # Errors
    /// [`EngineError::Plan`] when the document cannot be compiled.
    pub fn load_document(
        &mut self,
        doc: &Project,
        assets: &AssetIndex,
    ) -> Result<u64, EngineError> {
        let version = self.renderer.plan().plan_version + 1;
        let plan = compile(doc, assets, crate::SAMPLE_RATE, version)?;
        self.project_id = Some(doc.id.clone());
        Ok(self.install(plan))
    }

    /// Applies a delta, recompiling only the tracks it can have changed.
    ///
    /// # Errors
    /// [`EngineError::Plan`] when the delta cannot be compiled.
    pub fn apply_delta(
        &mut self,
        doc: &Project,
        assets: &AssetIndex,
        delta: &EngineDelta,
    ) -> Result<u64, EngineError> {
        if self
            .project_id
            .as_ref()
            .is_some_and(|project_id| project_id != &delta.project_id)
        {
            return Err(EngineError::WrongProject(delta.project_id.to_string()));
        }
        let plan = compile_delta(self.renderer.plan(), doc, assets, delta)?;
        Ok(self.install(plan))
    }

    /// Installs a compiled plan.
    pub fn install(&mut self, plan: RenderPlan) -> u64 {
        let version = plan.plan_version;
        let prepared = PreparedPlan::new(Arc::new(plan), crate::plan::quality_for(false));
        let previous = self.renderer.set_prepared(prepared);
        drop(previous);
        self.preview = None;
        self.events.push(EngineEvent::PlanCompiled { version });
        version
    }

    /// Sets (or clears) the transient preview overlay
    /// (`specs/03-audio-engine.md` §5.3).
    ///
    /// The plan is cloned and patched, which is a planner-side operation, not an
    /// audio-thread one.
    pub fn set_preview(&mut self, patch: Option<PreviewPatch>) {
        let mut plan = self.renderer.plan().clone();
        if let Some(patch) = &patch {
            apply_preview(&mut plan, patch);
        }
        let prepared = PreparedPlan::new(Arc::new(plan), crate::plan::quality_for(false));
        let previous = self.renderer.set_prepared(prepared);
        drop(previous);
        self.preview = patch;
        self.events.push(EngineEvent::PreviewChanged {
            active: self.preview.is_some(),
        });
    }

    /// The active preview, if any.
    #[must_use]
    pub fn preview(&self) -> Option<&PreviewPatch> {
        self.preview.as_ref()
    }

    /// The transport.
    #[must_use]
    pub fn transport(&self) -> &Transport {
        self.renderer.transport()
    }

    /// The transport, mutably.
    pub fn transport_mut(&mut self) -> &mut Transport {
        self.renderer.transport_mut()
    }

    /// The active plan.
    #[must_use]
    pub fn plan(&self) -> &RenderPlan {
        self.renderer.plan()
    }

    /// The plan version.
    #[must_use]
    pub fn plan_version(&self) -> u64 {
        self.renderer.plan().plan_version
    }

    /// Total underruns since the engine started.
    #[must_use]
    pub fn underruns(&self) -> u64 {
        self.underruns
    }

    /// The meters from the last block.
    #[must_use]
    pub fn meters(&self) -> &Meters {
        self.renderer.meters()
    }

    /// The buffered events.
    #[must_use]
    pub fn events(&self) -> &EventRing {
        &self.events
    }

    /// The renderer's block size.
    #[must_use]
    pub fn block_size(&self) -> usize {
        self.block_size
    }

    /// Renders one block and updates the counters.
    pub fn process(&mut self, pcm: &dyn PcmSource, out: &mut [&mut [f32]]) -> RenderStats {
        let stats = self.renderer.process(pcm, out);
        if stats.underruns > 0 {
            self.underruns = self.underruns.saturating_add(stats.underruns);
            self.events.push(EngineEvent::Underrun {
                sample: self.renderer.transport().playhead(),
                count: stats.underruns.min(u32::MAX as u64) as u32,
            });
        }
        stats
    }

    /// Publishes the transport state, counters and meters into a state block.
    ///
    /// `scratch` must be at least [`Meters::word_count`] words; the engine's
    /// meter layout starts at [`StateBlock`]'s header.
    pub fn publish(&self, block: &StateBlock, scratch: &mut [u32]) {
        let transport = self.renderer.transport();
        block.set_transport(
            transport_code(transport.state()),
            transport.is_auditioning(),
            transport.playhead(),
        );
        block.set_counters(self.underruns, self.plan_version());
        let written = self.renderer.meters().write_words(scratch);
        block.set_meters(&scratch[..written]);
    }
}

/// The transport state as the state block's numeric code.
#[must_use]
pub fn transport_code(state: crate::transport::TransportState) -> u32 {
    use crate::transport::TransportState;
    match state {
        TransportState::Stopped => 0,
        TransportState::Playing => 1,
        TransportState::Paused => 2,
        TransportState::Looping => 3,
        TransportState::Scrubbing => 4,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::pcm::MemoryPcm;

    fn plan() -> RenderPlan {
        let doc: Project = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "id": "prj_01",
            "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
            "sources": [], "analyses": {}, "tracks": [],
            "arrangement": { "timebase": { "ppq": 960,
                "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }], "timeSignatures": [] },
                "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } }
        }))
        .unwrap();
        compile(&doc, &AssetIndex::new(), 48_000, 1).unwrap()
    }

    #[test]
    fn process_counts_underruns() {
        let mut engine = Engine::new(plan(), 128);
        engine.transport_mut().set_length(1_000);
        engine.transport_mut().play();
        let pcm = MemoryPcm::new();
        let mut left = [0.0f32; 128];
        let mut right = [0.0f32; 128];
        engine.process(&pcm, &mut [&mut left, &mut right]);
        // An empty plan has no segments, so no reads happen and no underruns.
        assert_eq!(engine.underruns(), 0);
        assert_eq!(engine.events().len(), 1);
    }

    #[test]
    fn preview_is_applied_and_cleared() {
        let mut engine = Engine::new(plan(), 128);
        let patch = PreviewPatch::MoveSection {
            section_id: "sec_a".parse().unwrap(),
            to_index: 0,
        };
        engine.set_preview(Some(patch));
        assert!(engine.preview().is_some());
        engine.set_preview(None);
        assert!(engine.preview().is_none());
        assert_eq!(engine.events().len(), 3);
    }
}
