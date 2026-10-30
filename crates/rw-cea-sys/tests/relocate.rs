//! M4.1b relocation test: a copied binary plus `share/rocketwright/cea/`
//! solves with the build tree unreadable and matches the in-tree result.
//!
//! Its own test binary (one test), because it makes this crate's `OUT_DIR`
//! (the CEA build, its source copy, and the build-tree databases) mode 000
//! for the duration; a guard restores the mode even on panic.
#![cfg(all(feature = "cea", unix))]
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use rw_cea_sys::{BUILD_DATA_DIR, data};

const PROBE: &str = env!("CARGO_BIN_EXE_rw-cea-probe");

fn run(cmd: &mut Command) -> Output {
    cmd.output()
        .unwrap_or_else(|e| panic!("spawn {cmd:?}: {e}"))
}

fn stdout(o: &Output) -> String {
    assert!(
        o.status.success(),
        "probe failed ({}): {}",
        o.status,
        String::from_utf8_lossy(&o.stderr)
    );
    String::from_utf8(o.stdout.clone()).unwrap()
}

/// `key=value` lines other than `data_dir`.
fn results(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| !l.starts_with("data_dir="))
        .map(String::from)
        .collect()
}

/// Restores a directory's mode on drop.
struct Unreadable {
    dir: PathBuf,
    mode: u32,
}

impl Unreadable {
    fn new(dir: &Path) -> Self {
        let mode = fs::metadata(dir).unwrap().permissions().mode();
        fs::set_permissions(dir, fs::Permissions::from_mode(0o000)).unwrap();
        Unreadable {
            dir: dir.to_path_buf(),
            mode,
        }
    }
}

impl Drop for Unreadable {
    fn drop(&mut self) {
        let _ = fs::set_permissions(&self.dir, fs::Permissions::from_mode(self.mode));
    }
}

#[test]
fn relocated_binary_matches_in_tree() {
    // In tree: the build databases through $RW_CEA_DATA.
    let in_tree = stdout(&run(Command::new(PROBE).env("RW_CEA_DATA", BUILD_DATA_DIR)));
    let want = results(&in_tree);
    assert!(want.len() >= 8, "probe output:\n{in_tree}");

    // Relocated: <root>/bin/rw-cea-probe + <root>/share/rocketwright/cea/.
    let root = std::env::temp_dir().join(format!("rw-reloc-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("bin")).unwrap();
    let root = root.canonicalize().unwrap();
    let exe = root.join("bin/rw-cea-probe");
    fs::copy(PROBE, &exe).unwrap();
    let share = data::install_data(Path::new(BUILD_DATA_DIR), &root).unwrap();
    assert_eq!(share, root.join("share/rocketwright/cea"));

    // BUILD_DATA_DIR = $OUT_DIR/install/share/cea.
    let out_dir = Path::new(BUILD_DATA_DIR).ancestors().nth(3).unwrap();
    assert!(out_dir.join("cea-src").is_dir(), "{}", out_dir.display());
    let got = {
        let _locked = Unreadable::new(out_dir);
        assert!(
            fs::read_dir(BUILD_DATA_DIR).is_err(),
            "build tree still readable"
        );
        let found = stdout(&run(Command::new(&exe)
            .env_remove("RW_CEA_DATA")
            .current_dir(&root)));
        // $RW_CEA_DATA is authoritative: a bad value fails, never falls back.
        let bad = run(Command::new(&exe).env("RW_CEA_DATA", root.join("nope")));
        assert_eq!(bad.status.code(), Some(2), "{bad:?}");
        found
    };
    assert!(
        got.lines()
            .any(|l| l == format!("data_dir={}", share.display())),
        "relocated probe used another data dir:\n{got}"
    );
    assert_eq!(results(&got), want, "relocated solve differs from in-tree");

    // A copy without share/ reports the paths it tried and exits 2.
    fs::remove_dir_all(root.join("share")).unwrap();
    let missing = run(Command::new(&exe).env_remove("RW_CEA_DATA"));
    assert_eq!(missing.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&missing.stderr).contains("RW_CEA_DATA"),
        "{missing:?}"
    );
    let _ = fs::remove_dir_all(&root);
}
