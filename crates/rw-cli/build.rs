//! With the `doubles` feature, embeds every `fixtures/contracts/**/*.json`
//! (except `oracle/`) so the sidecar can serve contract-fixture doubles
//! (`src/mcp/doubles.rs`). Without it, nothing is embedded.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::{Path, PathBuf};

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if p.file_name().is_some_and(|n| n != "oracle") {
                walk(&p, out);
            }
        } else if p.extension().is_some_and(|x| x == "json") {
            out.push(p);
        }
    }
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var_os("CARGO_FEATURE_DOUBLES").is_none() {
        return;
    }
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let dir = manifest.join("../../fixtures/contracts");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut files = Vec::new();
    walk(&dir, &mut files);
    files.sort();
    let mut src = String::from(
        "/// `(path under fixtures/contracts/, file text)`, sorted by path.\npub static FIXTURES: &[(&str, &str)] = &[\n",
    );
    for f in &files {
        println!("cargo:rerun-if-changed={}", f.display());
        let rel = f
            .strip_prefix(&dir)
            .expect("under fixtures")
            .to_string_lossy()
            .replace('\\', "/");
        let abs = f.canonicalize().expect("fixture path");
        src.push_str(&format!(
            "    ({rel:?}, include_str!({:?})),\n",
            abs.display().to_string()
        ));
    }
    src.push_str("];\n");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("doubles_gen.rs");
    std::fs::write(out, src).expect("write doubles_gen.rs");
}
