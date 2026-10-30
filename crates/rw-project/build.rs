//! Embeds `templates/<name>/**` (the `rw init --template` projects, plan
//! M1.54c) so `project_create` needs no files beside the binary.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::{Path, PathBuf};

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out);
        } else {
            out.push(p);
        }
    }
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let dir = manifest.join("../../templates");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut src = String::from(
        "/// `(template, path inside it, text)`, sorted.\npub static TEMPLATE_FILES: &[(&str, &str, &str)] = &[\n",
    );
    let mut names: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    for t in names {
        println!("cargo:rerun-if-changed={}", t.display());
        let name = t.file_name().expect("name").to_string_lossy().into_owned();
        let mut files = Vec::new();
        walk(&t, &mut files);
        files.sort();
        for f in files {
            println!("cargo:rerun-if-changed={}", f.display());
            let rel = f
                .strip_prefix(&t)
                .expect("under template")
                .to_string_lossy()
                .replace('\\', "/");
            let abs = f.canonicalize().expect("template path");
            src.push_str(&format!(
                "    ({name:?}, {rel:?}, include_str!({:?})),\n",
                abs.display().to_string()
            ));
        }
    }
    src.push_str("];\n");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("templates_gen.rs");
    std::fs::write(out, src).expect("write templates_gen.rs");
}
