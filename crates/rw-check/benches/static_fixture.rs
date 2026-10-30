//! `cargo bench -p rw-check static_fixture`: the static check tier on the
//! `simple` fixture (IF2 JSON parse → geometry → motors → mass → aero →
//! check → canonical JSON) must stay under 200 ms in a release build (R3.2).
//! Plain harness (no criterion): reports the median and worst of 20 runs and
//! fails when the median exceeds the budget.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

#[path = "../tests/common/mod.rs"]
mod common;

use std::time::{Duration, Instant};

const BUDGET: Duration = Duration::from_millis(200);
const RUNS: usize = 20;

fn main() {
    let mut times: Vec<Duration> = (0..RUNS)
        .map(|_| {
            let t0 = Instant::now();
            let model = common::model(common::SIMPLE);
            let json = rw_check::canonical_json(&common::run(&model));
            std::hint::black_box(json);
            t0.elapsed()
        })
        .collect();
    times.sort();
    let median = times[RUNS / 2];
    let worst = times[RUNS - 1];
    println!(
        "static_fixture: median {:.3} ms, worst {:.3} ms over {RUNS} runs (budget {} ms)",
        median.as_secs_f64() * 1e3,
        worst.as_secs_f64() * 1e3,
        BUDGET.as_millis()
    );
    assert!(
        median < BUDGET,
        "static check median {median:?} exceeds {BUDGET:?}"
    );
}
