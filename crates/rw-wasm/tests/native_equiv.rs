//! The WASM bodies equal the sidecar's `Session` on `fixtures/research-vehicle`
//! (I4): same evaluated model, same static check, and a draft patch previews
//! the model the Session commits. The node-target twin of this test is
//! `app/packages/rw-wasm/src/index.test.ts` (it runs the wasm32 build).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::{Path, PathBuf};

use rw_api::{CallCtx, Command, ModelPatchIn, Origin};
use rw_model::PatchOp;
use rw_project::session::{Session, SessionOptions};
use rw_project::testutil::TempDir;
use serde_json::Value;

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/research-vehicle")
}

fn files_json(s: &Session) -> String {
    serde_json::to_string(&s.files().files).unwrap()
}

#[test]
fn eval_and_check_equal_the_session() {
    let s = Session::open(&fixture(), SessionOptions::read_only()).expect("open fixture");
    let files = files_json(&s);

    let m = rw_wasm::api::eval_model(&files).expect("eval");
    assert_eq!(&m, s.model(), "eval_model == Session model");
    // The 12 concept-tree parts plus the stowed streamer and flight computer.
    assert_eq!(m.components.len(), 14);

    let d = rw_wasm::api::apply_and_eval(&files, "[]").expect("apply_and_eval");
    assert_eq!(&d.evaluated, s.model());
    assert_eq!(
        &d.check,
        s.report(),
        "apply_and_eval check == Session report"
    );

    // Without the texts, check_static's inputs list only the motors.
    let mut c = rw_wasm::api::check_static(&serde_json::to_string(s.model()).unwrap()).unwrap();
    let mut want = s.report().clone();
    c.inputs.clear();
    want.inputs.clear();
    assert_eq!(c, want);
}

#[test]
fn glb_nodes_are_component_ids() {
    let s = Session::open(&fixture(), SessionOptions::read_only()).expect("open fixture");
    let glb = rw_wasm::api::mesh_glb(&serde_json::to_string(s.model()).unwrap(), "{}").unwrap();
    assert_eq!(&glb[0..4], b"glTF");
    let len = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
    let doc: Value = serde_json::from_slice(&glb[20..20 + len]).unwrap();
    let roots: Vec<String> = doc["scenes"][0]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            doc["nodes"][i.as_u64().unwrap() as usize]["name"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    let ids: Vec<String> = s.model().components.iter().map(|c| c.id.clone()).collect();
    assert_eq!(roots, ids);
    let fins = doc["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["name"] == "fins")
        .unwrap();
    assert_eq!(
        fins["children"].as_array().map(Vec::len),
        Some(4),
        "4 fin instances"
    );
}

#[test]
fn draft_preview_equals_the_committed_patch() {
    let tmp = TempDir::new("wasm-equiv");
    copy_dir(&fixture(), tmp.path());
    let mut s = Session::open(tmp.path(), SessionOptions::writer()).expect("open copy");
    let files = files_json(&s);
    let ops: Vec<PatchOp> = serde_json::from_str(
        r#"[{"op":"replace","path":"/params/fin_span/value","value":"100 mm"},
            {"op":"replace","path":"/c/airframe/length","value":"320 mm"}]"#,
    )
    .unwrap();
    let preview =
        rw_wasm::api::apply_and_eval(&files, &serde_json::to_string(&ops).unwrap()).unwrap();
    let ctx = CallCtx {
        origin: Origin::Ui,
        thread: None,
        tool_call: None,
        label: None,
    };
    s.execute(
        &Command::ModelPatch(ModelPatchIn {
            ops,
            dry_run: false,
            label: None,
        }),
        &ctx,
    )
    .expect("patch");
    assert_eq!(
        &preview.evaluated,
        s.model(),
        "preview == committed model (I4)"
    );
    let (mut a, mut b) = (preview.check.clone(), s.report().clone());
    a.inputs.clear();
    b.inputs.clear();
    assert_eq!(a, b, "preview check == committed check (inputs aside)");
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let dst = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &dst);
        } else {
            std::fs::copy(e.path(), &dst).unwrap();
        }
    }
}
