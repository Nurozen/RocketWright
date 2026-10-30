//! M1.28: `cargo test -p rw-cli --test mcp_jobs`. Simulations run on the
//! job queue, never on the MCP stdio loop: `simulate` answers at once with a
//! `job_id`, `model_get` stays fast while a 10 s job runs, `job_cancel`
//! stops it, a `rw://jobs/<id>` subscription fires on completion, and no
//! `notifications/progress` is ever sent after the response.
//!
//! The long job uses the test hook `RW_TEST_HOOKS=1` +
//! `RW_TEST_SIM_DELAY_MS` (I12): the job waits that long (reporting progress
//! and honouring cancellation) before flying.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::time::{Duration, Instant};

use common::*;
use serde_json::{Value, json};

fn simulate(s: &mut Sidecar, force: bool) -> (Value, Duration) {
    let t0 = Instant::now();
    let r = s.rpc.result(
        "tools/call",
        json!({"name": "simulate", "arguments": {"sim": "simulation_5", "force": force},
               "_meta": {"progressToken": "p-sim"}}),
    );
    let dt = t0.elapsed();
    assert!(r.get("isError").is_none_or(|v| v == false), "{r}");
    (r["structuredContent"].clone(), dt)
}

fn no_progress(s: &mut Sidecar) {
    s.rpc.result("ping", json!({}));
    let p = s
        .rpc
        .notifications("notifications/progress", Duration::from_millis(100));
    assert!(p.is_empty(), "progress notifications were sent: {p:?}");
}

#[test]
fn model_get_answers_fast_during_a_10_s_job_and_cancel_stops_it() {
    let p = TempProject::fixture("fixtures/case1");
    let mut s = Sidecar::started_env(
        &p.0,
        &[("RW_TEST_HOOKS", "1"), ("RW_TEST_SIM_DELAY_MS", "10000")],
    );
    // Warm the evaluation path once.
    s.rpc.ok("model_get", json!({}));
    let (out, dt) = simulate(&mut s, false);
    let job = out["job_id"].as_str().expect("a job id").to_string();
    assert_eq!(out["cached"], false);
    assert_eq!(out["status"], "running");
    assert!(dt < Duration::from_secs(1), "simulate took {dt:?}");

    let mut slowest = Duration::ZERO;
    let end = Instant::now() + Duration::from_millis(1500);
    let mut n = 0;
    while Instant::now() < end {
        let t0 = Instant::now();
        let m = s.rpc.ok("model_get", json!({"path": "/name"}));
        slowest = slowest.max(t0.elapsed());
        assert_eq!(m["value"], "A simple model rocket");
        n += 1;
    }
    println!("model_get x{n} during the job: slowest {slowest:?}");
    assert!(
        slowest < Duration::from_millis(100),
        "model_get took {slowest:?} during a running job"
    );
    let st = s.rpc.ok("job_status", json!({"job_id": job}));
    assert_eq!(st["state"], "running", "{st}");
    let runs = s.rpc.ok("run_list", json!({}));
    assert_eq!(runs["runs"][0]["status"], "running");
    assert_eq!(runs["runs"][0]["job_id"], job.as_str());

    // A second request for the same inputs joins the running job.
    let (again, _) = simulate(&mut s, false);
    assert_eq!(again["job_id"], job.as_str());

    s.rpc.ok("job_cancel", json!({"job_id": job}));
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let st = s.rpc.ok("job_status", json!({"job_id": job}));
        if st["state"] == "cancelled" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "cancel did not stop the job: {st}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !p.0.join("runs/simulation_5")
            .join(out["run_id"].as_str().unwrap())
            .exists(),
        "a cancelled job writes no run"
    );
    no_progress(&mut s);
    assert!(s.stop().success());
}

#[test]
fn job_subscription_fires_on_complete() {
    let p = TempProject::fixture("fixtures/case1");
    let mut s = Sidecar::started_env(
        &p.0,
        &[("RW_TEST_HOOKS", "1"), ("RW_TEST_SIM_DELAY_MS", "600")],
    );
    let (out, _) = simulate(&mut s, false);
    let job = out["job_id"].as_str().unwrap().to_string();
    let uri = format!("rw://jobs/{job}");
    s.rpc.result("resources/subscribe", json!({"uri": uri}));
    s.rpc
        .result("resources/subscribe", json!({"uri": "rw://runs/index"}));

    let deadline = Instant::now() + TIMEOUT * 6;
    let mut job_updates = 0;
    let mut index_updates = 0;
    let state = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        assert!(!left.is_zero(), "no completion update");
        for n in s
            .rpc
            .notifications("notifications/resources/updated", Duration::from_millis(50))
        {
            match n["params"]["uri"].as_str() {
                Some(u) if u == uri => job_updates += 1,
                Some("rw://runs/index") => index_updates += 1,
                _ => {}
            }
        }
        if job_updates == 0 {
            continue;
        }
        let r = s.rpc.result("resources/read", json!({"uri": uri}));
        let v: Value = serde_json::from_str(r["contents"][0]["text"].as_str().unwrap()).unwrap();
        if v["state"] == "complete" {
            break v;
        }
    };
    assert!(job_updates >= 1 && index_updates >= 1);
    assert_eq!(state["run_id"], out["run_id"]);
    assert!(state["summary"]["apogee_m"].as_f64().unwrap() > 300.0);
    let runs = s.rpc.ok("run_list", json!({}));
    assert_eq!(runs["runs"][0]["status"], "complete");
    // Same inputs again: a cache hit, answered without a job.
    let (hit, _) = simulate(&mut s, false);
    assert_eq!(hit["cached"], true);
    assert!(hit.get("job_id").is_none());
    no_progress(&mut s);
    assert!(s.stop().success());
}
