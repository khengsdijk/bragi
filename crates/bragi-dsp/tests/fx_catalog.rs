//! The Rust parameter tables in `bragi_dsp::fx` must match `crates/bragi-dsp/fx_catalog.json`,
//! the single source the UI, the planner and the validator read (03 §6).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

use bragi_dsp::fx::{FxKind, MATCH_EQ_BANDS};
use serde_json::Value;

fn catalogue() -> Value {
    serde_json::from_str(include_str!("../fx_catalog.json")).unwrap()
}

#[test]
fn every_catalogue_kind_has_a_kind_and_back() {
    let cat = catalogue();
    let fx = cat["fx"].as_object().unwrap();
    assert_eq!(fx.len(), FxKind::ALL.len());
    for name in fx.keys() {
        let kind = FxKind::from_name(name).unwrap_or_else(|| panic!("no FxKind for {name}"));
        assert_eq!(kind.name(), name);
    }
}

#[test]
fn numeric_params_match_the_catalogue() {
    let cat = catalogue();
    for kind in FxKind::ALL {
        let params = cat["fx"][kind.name()]["params"].as_object().unwrap();
        let mut expected: Vec<(String, f64, f64, f64)> = Vec::new();
        for (name, spec) in params {
            match spec["type"].as_str().unwrap() {
                "number" => expected.push((
                    name.clone(),
                    spec["min"].as_f64().unwrap(),
                    spec["max"].as_f64().unwrap(),
                    spec["default"].as_f64().unwrap(),
                )),
                // `match_eq.bands` is flattened to band0..band30 ahead of the rest.
                "number[]" => {
                    assert_eq!(kind, FxKind::MatchEq);
                    for band in 0..MATCH_EQ_BANDS {
                        expected.push((format!("band{band}"), -18.0, 18.0, 0.0));
                    }
                }
                // Routing (sidechain source), not an indexed number.
                "trackId" => assert_eq!(kind, FxKind::SidechainDuck),
                other => panic!("unknown param type {other}"),
            }
        }
        let actual: Vec<(String, f64, f64, f64)> = kind
            .params()
            .iter()
            .map(|p| {
                (
                    p.name.to_string(),
                    f64::from(p.min),
                    f64::from(p.max),
                    f64::from(p.default),
                )
            })
            .collect();
        // serde_json's map is sorted by key, so compare by name; the Rust order is the file's.
        let mut actual = actual;
        actual.sort_by(|a, b| a.0.cmp(&b.0));
        expected.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(actual.len(), expected.len(), "{}", kind.name());
        for (a, e) in actual.iter().zip(&expected) {
            assert_eq!(a.0, e.0, "{}", kind.name());
            for (x, y) in [(a.1, e.1), (a.2, e.2), (a.3, e.3)] {
                assert!(
                    (x - y).abs() <= 1e-6 * y.abs().max(1.0),
                    "{}.{}",
                    kind.name(),
                    a.0
                );
            }
        }
    }
}

#[test]
fn flags_match_the_catalogue() {
    let cat = catalogue();
    for kind in FxKind::ALL {
        let entry = &cat["fx"][kind.name()];
        assert_eq!(
            kind.master_only(),
            entry["masterOnly"].as_bool().unwrap_or(false)
        );
        assert_eq!(kind.system(), entry["system"].as_bool().unwrap_or(false));
    }
}
