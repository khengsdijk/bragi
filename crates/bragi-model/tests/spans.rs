//! `section_spans` and friends (`specs/02-song-model.md` §3.5, §8).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use bragi_model::section_spans;
use bragi_model::spans::{section_index_at, total_ticks};
use common::{BAR_TICKS, SEC_A, SEC_B, fixture};

#[test]
fn spans_are_the_cumulative_lengths() {
    let doc = fixture();
    let spans = section_spans(&doc);
    assert_eq!(spans.len(), 2);
    assert_eq!(spans[0].id.to_string(), SEC_A);
    assert_eq!(spans[0].start_tick, 0);
    assert_eq!(spans[0].end_tick, BAR_TICKS as i64);
    assert_eq!(spans[1].id.to_string(), SEC_B);
    assert_eq!(spans[1].start_tick, BAR_TICKS as i64);
    assert_eq!(total_ticks(&doc), 2 * BAR_TICKS as i64);
}

#[test]
fn contains_is_half_open_and_lookup_matches() {
    let doc = fixture();
    let spans = section_spans(&doc);
    assert!(spans[0].contains(0));
    assert!(spans[0].contains(BAR_TICKS as i64 - 1));
    assert!(!spans[0].contains(BAR_TICKS as i64));
    assert_eq!(section_index_at(&doc, 10), Some(0));
    assert_eq!(section_index_at(&doc, BAR_TICKS as i64 + 10), Some(1));
    assert_eq!(section_index_at(&doc, 100_000), None);
}
