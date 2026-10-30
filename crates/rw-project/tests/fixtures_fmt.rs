//! Every source file of the committed example projects (`fixtures/case1`,
//! `fixtures/simple`, `fixtures/research-vehicle`) and the `rw init`
//! templates is already in `rw fmt` canonical form, so formatting a fresh
//! project or a seeded fixture never produces a diff (plan M1.54b, M1.54c).
//! Set `RW_FMT_FIXTURES=1` to rewrite them in place.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::{Path, PathBuf};

use rw_model::source::doc_kind;
use rw_project::fmt::format_text;

const PROJECTS: &[&str] = &[
    "fixtures/case1",
    "fixtures/simple",
    "fixtures/research-vehicle",
    "templates/simple-rocket",
    "templates/minimum",
];

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            walk(&p, out);
        } else {
            out.push(p);
        }
    }
}

#[test]
fn fixtures_and_templates_are_fmt_canonical() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let rewrite = std::env::var_os("RW_FMT_FIXTURES").is_some();
    let mut dirty = Vec::new();
    let mut seen = 0;
    for rel in PROJECTS {
        let dir = root.join(rel);
        let mut files = Vec::new();
        walk(&dir, &mut files);
        files.sort();
        for p in files {
            let path = p
                .strip_prefix(&dir)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if doc_kind(&path).is_none() {
                continue;
            }
            seen += 1;
            let text = std::fs::read_to_string(&p).unwrap();
            let out = format_text(&path, &text).unwrap_or_else(|e| panic!("{rel}/{path}: {e:#?}"));
            if out != text {
                if rewrite {
                    std::fs::write(&p, &out).unwrap();
                }
                dirty.push(format!("{rel}/{path}"));
            }
        }
    }
    assert!(seen >= 25, "only {seen} source files found");
    assert!(
        dirty.is_empty(),
        "not in `rw fmt` form (RW_FMT_FIXTURES=1 rewrites): {dirty:#?}"
    );
}
