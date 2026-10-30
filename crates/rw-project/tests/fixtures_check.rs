//! The committed example projects pass the real static check (rw_check via
//! the Session, M1.40 x M1.54) in every configuration with strict semantics:
//! no errors, and only the warnings `fixtures/README.md` documents under
//! "Accepted check warnings" (each of which must still fire).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use rw_api::{CallCtx, Command, DesignCheckIn, Origin, Response};
use rw_check::CheckReport;
use rw_model::Severity;
use rw_project::{Session, SessionOptions};

const PROJECTS: &[&str] = &["case1", "simple", "research-vehicle"];

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

/// `(project, config, "<code>@<path>")` rows of the README table.
fn accepted() -> BTreeSet<(String, String, String)> {
    let text = std::fs::read_to_string(fixtures().join("README.md")).unwrap();
    let section = text
        .split("## Accepted check warnings")
        .nth(1)
        .expect("fixtures/README.md has an `Accepted check warnings` section");
    section
        .lines()
        .filter_map(|l| {
            let cells: Vec<&str> = l.split('|').map(str::trim).collect();
            let tick = |s: &str| {
                s.strip_prefix('`')
                    .and_then(|s| s.strip_suffix('`'))
                    .map(str::to_string)
            };
            Some((
                tick(cells.get(1)?)?,
                tick(cells.get(2)?)?,
                tick(cells.get(3)?)?,
            ))
        })
        .collect()
}

fn check(s: &mut Session, config: &str) -> CheckReport {
    let ctx = CallCtx {
        origin: Origin::Cli,
        thread: None,
        tool_call: None,
        label: None,
    };
    let cmd = Command::DesignCheck(DesignCheckIn {
        config: Some(config.to_string()),
        strict: true,
        ..Default::default()
    });
    match s.execute(&cmd, &ctx).unwrap() {
        Response::DesignCheck(r) => r,
        other => panic!("{other:?}"),
    }
}

#[test]
fn fixtures_pass_the_real_static_check_strictly() {
    let accepted = accepted();
    let mut seen = BTreeSet::new();
    let mut failures = Vec::new();
    for project in PROJECTS {
        let mut s = Session::open(&fixtures().join(project), SessionOptions::read_only()).unwrap();
        let configs: Vec<String> = s.model().configs.keys().cloned().collect();
        assert!(!configs.is_empty(), "{project} has configurations");
        for config in configs {
            let r = check(&mut s, &config);
            // Real physics, every motor resolved.
            assert!(
                r.mass.liftoff > r.mass.dry && r.mass.dry > 0.0,
                "{project}/{config}"
            );
            assert!(r.aero.cp > r.mass.cg, "{project}/{config}: CP aft of CG");
            assert!(
                r.stability.min >= 1.0,
                "{project}/{config}: {:?}",
                r.stability
            );
            assert!(!r.motor.is_empty(), "{project}/{config}: motor resolved");
            assert!(r.assertions.iter().all(|a| a.pass), "{project}/{config}");
            for d in &r.diagnostics {
                let row = (project.to_string(), config.clone(), d.key());
                match d.severity {
                    Severity::Warning if accepted.contains(&row) => {
                        seen.insert(row);
                    }
                    Severity::Warning | Severity::Error => {
                        failures.push(format!("{project} [{config}] {}: {}", d.key(), d.message))
                    }
                    _ => {}
                }
            }
        }
    }
    assert!(
        failures.is_empty(),
        "undocumented diagnostics:\n{}",
        failures.join("\n")
    );
    let stale: Vec<_> = accepted.difference(&seen).collect();
    assert!(
        stale.is_empty(),
        "README rows that no longer fire: {stale:?}"
    );
}
