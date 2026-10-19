//! The piecewise-linear source map of a [`Segment`](crate::plan::Segment).
//!
//! `specs/03-audio-engine.md` §4 calls this `SrcMap` ("dst sample → src
//! position, piecewise linear from warp anchors + tempo map") but does not give
//! it a shape. This type is that definition: an ordered list of
//! `(dst_offset, src_sample)` breakpoints, interpolated linearly and
//! extrapolated with the slope of the outermost interval.
//!
//! All offsets are **relative to the segment's `dst_start`** and all source
//! positions are **absolute samples in the asset**, which is what the renderer
//! needs for a chunk-pool or mmap lookup. Every method is allocation-free and
//! panic-free, and is safe to call from the audio thread.
//!
//! ```
//! use bragi_engine::srcmap::{SrcMap, SrcPoint};
//! // Two seconds of destination playing one second of source.
//! let map = SrcMap::new(vec![SrcPoint { dst: 0, src: 0.0 }, SrcPoint { dst: 96_000, src: 48_000.0 }]);
//! assert!((map.src_at(48_000) - 24_000.0).abs() < 1e-9);
//! assert!((map.slope_at(48_000) - 0.5).abs() < 1e-12);
//! ```

/// One breakpoint: at destination offset `dst` the source position is `src`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SrcPoint {
    /// Offset in output samples, relative to the segment start.
    pub dst: u64,
    /// Absolute position in the source, in samples (fractional between frames).
    pub src: f64,
}

/// A monotonic piecewise-linear destination → source map.
#[derive(Clone, Debug, PartialEq)]
pub struct SrcMap {
    points: Vec<SrcPoint>,
}

impl SrcMap {
    /// Builds a map from `points`, sorting them by destination offset and
    /// dropping duplicate destinations (the last one wins).
    ///
    /// ```
    /// use bragi_engine::srcmap::{SrcMap, SrcPoint};
    /// let map = SrcMap::new(vec![SrcPoint { dst: 0, src: 10.0 }]);
    /// assert_eq!(map.first().unwrap().src, 10.0);
    /// ```
    #[must_use]
    pub fn new(mut points: Vec<SrcPoint>) -> Self {
        points.sort_by_key(|p| p.dst);
        // Keep the *last* point for a duplicated destination: it is the one the
        // caller listed last, matching how a plan's breakpoints are built.
        let mut deduped: Vec<SrcPoint> = Vec::with_capacity(points.len());
        for point in points {
            if let Some(previous) = deduped.last_mut()
                && previous.dst == point.dst
            {
                *previous = point;
                continue;
            }
            deduped.push(point);
        }
        points = deduped;
        if points.is_empty() {
            points.push(SrcPoint { dst: 0, src: 0.0 });
        }
        Self { points }
    }

    /// A map that plays `src` at every destination offset (used for a
    /// zero-length or degenerate segment).
    #[must_use]
    pub fn constant(src: f64) -> Self {
        Self {
            points: vec![SrcPoint { dst: 0, src }],
        }
    }

    /// A linear map from `(0, src_start)` to `(dst_len, src_end)`.
    #[must_use]
    pub fn linear(dst_len: u64, src_start: u64, src_end: u64) -> Self {
        Self::new(vec![
            SrcPoint {
                dst: 0,
                src: src_start as f64,
            },
            SrcPoint {
                dst: dst_len,
                src: src_end as f64,
            },
        ])
    }

    /// The breakpoints, in destination order.
    #[must_use]
    pub fn points(&self) -> &[SrcPoint] {
        &self.points
    }

    /// The first breakpoint. Always present.
    #[must_use]
    pub fn first(&self) -> Option<&SrcPoint> {
        self.points.first()
    }

    /// The last breakpoint. Always present.
    #[must_use]
    pub fn last(&self) -> Option<&SrcPoint> {
        self.points.last()
    }

    /// The index of the interval containing `dst` (clamped to the ends).
    ///
    /// `points()[i].dst <= dst < points()[i + 1].dst`, or the last interval when
    /// `dst` is past the end.
    #[must_use]
    pub fn interval_at(&self, dst: u64) -> usize {
        if self.points.len() < 2 {
            return 0;
        }
        // `partition_point` is a binary search and does not allocate.
        let index = self.points.partition_point(|p| p.dst <= dst);
        index.saturating_sub(1).min(self.points.len() - 2)
    }

    /// The source position at destination offset `dst`.
    #[must_use]
    pub fn src_at(&self, dst: u64) -> f64 {
        let (src, _) = self.lookup(dst);
        src
    }

    /// The local slope (source frames per destination frame) at `dst`.
    #[must_use]
    pub fn slope_at(&self, dst: u64) -> f64 {
        let (_, slope) = self.lookup(dst);
        slope
    }

    /// The source position at a signed destination offset.
    ///
    /// Before `0` the map is extrapolated with the slope of its first interval.
    /// A section-boundary crossfade uses this for an incoming segment's
    /// pre-roll, which reads the source handle before the clip's window
    /// (`specs/03-audio-engine.md` §5.5).
    ///
    /// # Examples
    ///
    /// ```
    /// use bragi_engine::srcmap::SrcMap;
    /// let map = SrcMap::linear(100, 200, 300);
    /// assert!((map.src_at_signed(50) - 250.0).abs() < 1e-9);
    /// assert!((map.src_at_signed(-10) - 190.0).abs() < 1e-9);
    /// ```
    #[must_use]
    pub fn src_at_signed(&self, dst: i64) -> f64 {
        if dst >= 0 {
            return self.src_at(dst as u64);
        }
        let Some(first) = self.points.first() else {
            return 0.0;
        };
        let slope = match self.points.get(1) {
            Some(b) if b.dst > first.dst => (b.src - first.src) / b.dst as f64,
            _ => return first.src,
        };
        first.src + slope * dst as f64
    }

    /// The source position and slope at `dst`, in one lookup.
    #[must_use]
    pub fn lookup(&self, dst: u64) -> (f64, f64) {
        if self.points.len() < 2 {
            return (self.points[0].src, 1.0);
        }
        let index = self.interval_at(dst);
        let a = self.points[index];
        let b = self.points[index + 1];
        let span = b.dst.saturating_sub(a.dst);
        if span == 0 {
            return (b.src, 1.0);
        }
        let slope = (b.src - a.src) / span as f64;
        let offset = dst.saturating_sub(a.dst) as f64;
        (a.src + slope * offset, slope)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn interpolation_and_extrapolation() {
        let map = SrcMap::new(vec![
            SrcPoint { dst: 0, src: 100.0 },
            SrcPoint {
                dst: 100,
                src: 200.0,
            },
            SrcPoint {
                dst: 300,
                src: 300.0,
            },
        ]);
        assert!((map.src_at(50) - 150.0).abs() < 1e-12);
        assert!((map.src_at(200) - 250.0).abs() < 1e-12);
        // Past the end: continue the last slope (0.5).
        assert!((map.src_at(400) - 350.0).abs() < 1e-12);
        assert!((map.slope_at(250) - 0.5).abs() < 1e-12);
    }

    #[test]
    fn unsorted_and_duplicate_points_are_normalised() {
        let map = SrcMap::new(vec![
            SrcPoint { dst: 10, src: 1.0 },
            SrcPoint { dst: 0, src: 0.0 },
            SrcPoint { dst: 10, src: 2.0 },
        ]);
        assert_eq!(map.points().len(), 2);
        assert_eq!(map.src_at(10), 2.0);
    }

    #[test]
    fn single_point_is_constant() {
        let map = SrcMap::constant(42.0);
        assert_eq!(map.src_at(1_000_000), 42.0);
        assert_eq!(map.slope_at(0), 1.0);
    }
}
