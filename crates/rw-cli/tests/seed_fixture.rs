//! M1.55 (D10a): `fixtures/research-vehicle/seed.sh` replays real `rw`
//! commands under `RW_CLOCK` with this build's binary, and the result matches
//! `seed.expected.json` (step titles, origins, times, Rev 07, run statuses,
//! hash relationships; checked by `scripts/fixtures/seed.ts --check`). Also
//! covers `--snapshot-label` and `history tag --number`, which the seed uses.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

mod common;

use std::process::Command;

use common::*;

#[test]
fn seed_script_produces_the_expected_history_and_runs() {
    let root = repo_root();
    let tmp = TempProject::new();
    let dest = tmp.path().join("Research vehicle");
    let bin = env!("CARGO_BIN_EXE_rocketwright");
    let seed = Command::new("bash")
        .arg(root.join("fixtures/research-vehicle/seed.sh"))
        .arg(&dest)
        .env("RW", bin)
        .env_remove("RW_CLOCK")
        .output()
        .expect("bash");
    assert!(
        seed.status.success(),
        "seed.sh failed\n{}\n{}",
        String::from_utf8_lossy(&seed.stdout),
        String::from_utf8_lossy(&seed.stderr)
    );
    assert!(!dest.join("seed.sh").exists() && !dest.join("seed.expected.json").exists());
    let check = Command::new("node")
        .arg(root.join("scripts/fixtures/seed.ts"))
        .arg("--check")
        .arg(&dest)
        .env("RW", bin)
        .env_remove("ELECTRON_RUN_AS_NODE")
        .output()
        .expect("node");
    assert!(
        check.status.success(),
        "seed check failed\n{}\n{}",
        String::from_utf8_lossy(&check.stdout),
        String::from_utf8_lossy(&check.stderr)
    );
}
