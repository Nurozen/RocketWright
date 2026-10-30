//! GLB output validates against the glTF 2.0 container and JSON rules this
//! writer relies on (a structural validator, no network tools): header and
//! chunks, buffer/view/accessor bounds, POSITION min/max, index range, unit
//! normals and rotations, node naming (`<id>`, `<id>/<n>`), and explode.

mod common;

use std::collections::BTreeSet;

use common::fixture_model;
use rw_geom::{
    Geometry, MeshOptions, build, explode_dirs, frames::is_internal, mesh_glb, mesh_model_glb,
};
use serde_json::Value;

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}

fn f32_at(b: &[u8], at: usize) -> f32 {
    f32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}

/// Validates the container and returns (json, bin).
fn validate(glb: &[u8]) -> (Value, Vec<u8>) {
    assert_eq!(u32_at(glb, 0), 0x4654_6C67, "magic");
    assert_eq!(u32_at(glb, 4), 2, "version");
    assert_eq!(u32_at(glb, 8) as usize, glb.len(), "length");
    assert_eq!(glb.len() % 4, 0);
    let jl = u32_at(glb, 12) as usize;
    assert_eq!(u32_at(glb, 16), 0x4E4F_534A, "JSON chunk");
    assert_eq!(jl % 4, 0);
    let doc: Value = serde_json::from_slice(&glb[20..20 + jl]).expect("json chunk");
    let mut bin = Vec::new();
    if 20 + jl < glb.len() {
        let at = 20 + jl;
        let bl = u32_at(glb, at) as usize;
        assert_eq!(u32_at(glb, at + 4), 0x004E_4942, "BIN chunk");
        assert_eq!(at + 8 + bl, glb.len());
        bin = glb[at + 8..].to_vec();
    }
    assert_eq!(doc["asset"]["version"], "2.0");

    let arr = |k: &str| doc[k].as_array().cloned().unwrap_or_default();
    let (buffers, views, accessors, meshes, nodes, materials) = (
        arr("buffers"),
        arr("bufferViews"),
        arr("accessors"),
        arr("meshes"),
        arr("nodes"),
        arr("materials"),
    );
    if let Some(b) = buffers.first() {
        assert_eq!(buffers.len(), 1);
        assert!(b["byteLength"].as_u64().unwrap() as usize <= bin.len());
    }
    for v in &views {
        let off = v["byteOffset"].as_u64().unwrap() as usize;
        let len = v["byteLength"].as_u64().unwrap() as usize;
        assert_eq!(off % 4, 0);
        assert!(off + len <= buffers[0]["byteLength"].as_u64().unwrap() as usize);
    }
    let view_bytes = |a: &Value| -> (usize, usize) {
        let v = &views[a["bufferView"].as_u64().unwrap() as usize];
        (
            v["byteOffset"].as_u64().unwrap() as usize,
            v["byteLength"].as_u64().unwrap() as usize,
        )
    };
    for m in &meshes {
        for p in m["primitives"].as_array().unwrap() {
            assert_eq!(p["mode"], 4);
            assert!((p["material"].as_u64().unwrap() as usize) < materials.len());
            let pa = &accessors[p["attributes"]["POSITION"].as_u64().unwrap() as usize];
            let na = &accessors[p["attributes"]["NORMAL"].as_u64().unwrap() as usize];
            let ia = &accessors[p["indices"].as_u64().unwrap() as usize];
            let n = pa["count"].as_u64().unwrap() as usize;
            assert_eq!(
                (pa["type"].as_str(), pa["componentType"].as_u64()),
                (Some("VEC3"), Some(5126))
            );
            assert_eq!(
                (na["type"].as_str(), na["componentType"].as_u64()),
                (Some("VEC3"), Some(5126))
            );
            assert_eq!(
                (ia["type"].as_str(), ia["componentType"].as_u64()),
                (Some("SCALAR"), Some(5125))
            );
            assert_eq!(na["count"].as_u64().unwrap() as usize, n);
            let (po, pl) = view_bytes(pa);
            let (no, nl) = view_bytes(na);
            let (io, il) = view_bytes(ia);
            assert!(pl >= n * 12 && nl >= n * 12);
            let ni = ia["count"].as_u64().unwrap() as usize;
            assert!(il >= ni * 4 && ni.is_multiple_of(3) && ni > 0);
            // POSITION min/max are required and must be exact.
            let mut lo = [f32::INFINITY; 3];
            let mut hi = [f32::NEG_INFINITY; 3];
            for i in 0..n {
                for k in 0..3 {
                    let v = f32_at(&bin, po + 12 * i + 4 * k);
                    assert!(v.is_finite());
                    lo[k] = lo[k].min(v);
                    hi[k] = hi[k].max(v);
                }
                let nn: f32 = (0..3)
                    .map(|k| f32_at(&bin, no + 12 * i + 4 * k).powi(2))
                    .sum();
                assert!((nn.sqrt() - 1.0).abs() < 1e-3, "normal not unit");
            }
            for k in 0..3 {
                assert_eq!(pa["min"][k].as_f64().unwrap() as f32, lo[k]);
                assert_eq!(pa["max"][k].as_f64().unwrap() as f32, hi[k]);
            }
            for i in 0..ni {
                assert!(
                    (u32_at(&bin, io + 4 * i) as usize) < n,
                    "index out of range"
                );
            }
        }
    }
    // Nodes form a forest rooted at the scene nodes; each node used once.
    let roots = doc["scenes"][doc["scene"].as_u64().unwrap() as usize]["nodes"]
        .as_array()
        .unwrap()
        .clone();
    let mut seen = BTreeSet::new();
    let mut stack: Vec<u64> = roots.iter().map(|r| r.as_u64().unwrap()).collect();
    while let Some(i) = stack.pop() {
        assert!(seen.insert(i), "node {i} reused");
        let n = &nodes[i as usize];
        if let Some(m) = n["mesh"].as_u64() {
            assert!((m as usize) < meshes.len());
        }
        if let Some(q) = n["rotation"].as_array() {
            let l: f64 = q.iter().map(|v| v.as_f64().unwrap().powi(2)).sum();
            assert!((l.sqrt() - 1.0).abs() < 1e-6);
        }
        if let Some(c) = n["children"].as_array() {
            stack.extend(c.iter().map(|v| v.as_u64().unwrap()));
        }
    }
    assert_eq!(seen.len(), nodes.len(), "orphan nodes");
    (doc, bin)
}

fn geometry() -> Geometry {
    build(&fixture_model())
}

#[test]
fn fixture_glb_validates_and_names_nodes_by_id() {
    let g = geometry();
    let glb = mesh_glb(&g, &MeshOptions::default());
    let (doc, _) = validate(&glb);
    let nodes = doc["nodes"].as_array().unwrap();
    let roots: Vec<&Value> = doc["scenes"][0]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| &nodes[i.as_u64().unwrap() as usize])
        .collect();
    let names: Vec<&str> = roots.iter().map(|n| n["name"].as_str().unwrap()).collect();
    let ids: Vec<&str> = g.components.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(names, ids);
    for n in &roots {
        assert_eq!(n["extras"]["rw_frame"], "body");
        assert!(
            n.get("translation").is_none(),
            "explode 0 leaves roots in place"
        );
    }
    // Fins: four instance children `fins/0..3` sharing one mesh, rolled about +X.
    let fins = roots.iter().find(|n| n["name"] == "fins").unwrap();
    let kids: Vec<&Value> = fins["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| &nodes[i.as_u64().unwrap() as usize])
        .collect();
    assert_eq!(kids.len(), 4);
    for (k, n) in kids.iter().enumerate() {
        assert_eq!(n["name"], format!("fins/{k}"));
        assert_eq!(n["mesh"], kids[0]["mesh"]);
    }
    let q = kids[1]["rotation"].as_array().unwrap();
    let s = std::f64::consts::FRAC_PI_4.sin();
    assert!((q[0].as_f64().unwrap() - s).abs() < 1e-6 && q[1] == 0.0 && q[2] == 0.0);
    // The lug sits off-axis: one child `lug/0` translated to +Y.
    let lug = roots.iter().find(|n| n["name"] == "lug").unwrap();
    let l0 = &nodes[lug["children"][0].as_u64().unwrap() as usize];
    assert_eq!(l0["name"], "lug/0");
    assert!((l0["translation"][1].as_f64().unwrap() - 0.031).abs() < 1e-6);
}

#[test]
fn mesh_stays_inside_component_bbox() {
    let g = geometry();
    let (doc, _) = validate(&mesh_glb(&g, &MeshOptions::default()));
    let nodes = doc["nodes"].as_array().unwrap();
    for c in g
        .components
        .iter()
        .filter(|c| c.instances.len() == 1 && c.instances[0].offset == [0.0; 3])
    {
        let node = nodes.iter().find(|n| n["name"] == c.id.as_str()).unwrap();
        let mesh = &doc["meshes"][node["mesh"].as_u64().unwrap() as usize];
        let acc = &doc["accessors"][mesh["primitives"][0]["attributes"]["POSITION"]
            .as_u64()
            .unwrap() as usize];
        for k in 0..3 {
            let (lo, hi) = (
                acc["min"][k].as_f64().unwrap(),
                acc["max"][k].as_f64().unwrap(),
            );
            assert!(
                lo >= c.bbox.min[k] - 1e-6 && hi <= c.bbox.max[k] + 1e-6,
                "{} axis {k}",
                c.id
            );
            // 64 segments: the polygon reaches the true radius within 0.2%.
            assert!(
                hi >= c.bbox.max[k] - 2e-3 * c.bbox.max[k].abs() - 1e-6,
                "{} axis {k}",
                c.id
            );
        }
    }
}

#[test]
fn explode_and_internals() {
    let g = geometry();
    let dirs = explode_dirs(&g);
    let opts = MeshOptions {
        radial_segments: 24,
        explode: 0.6,
        internals: false,
        cutters: false,
    };
    let (doc, _) = validate(&mesh_glb(&g, &opts));
    let nodes = doc["nodes"].as_array().unwrap();
    let roots: Vec<&Value> = doc["scenes"][0]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| &nodes[i.as_u64().unwrap() as usize])
        .collect();
    for c in &g.components {
        let node = roots.iter().find(|n| n["name"] == c.id.as_str());
        assert_eq!(node.is_none(), is_internal(c.kind), "{}", c.id);
        if let Some(n) = node {
            let d = dirs[&c.id];
            let ex = n["extras"]["rw_explode"].as_array().unwrap();
            for k in 0..3 {
                assert!((ex[k].as_f64().unwrap() - d[k]).abs() < 1e-6);
                let t = n["translation"][k].as_f64().unwrap();
                assert!((t - 0.6 * d[k]).abs() < 1e-6, "{} translation", c.id);
            }
        }
    }
}

#[test]
fn glb_is_deterministic() {
    let g = geometry();
    let o = MeshOptions::default();
    assert_eq!(mesh_glb(&g, &o), mesh_glb(&g, &o));
}

#[test]
fn empty_geometry_is_a_valid_glb() {
    let mut g = geometry();
    g.components.clear();
    let (doc, bin) = validate(&mesh_glb(&g, &MeshOptions::default()));
    assert!(bin.is_empty());
    assert_eq!(doc["scenes"][0]["nodes"].as_array().unwrap().len(), 0);
}

#[test]
fn cutters_are_tagged_with_their_parent_only_on_request() {
    let mut m = fixture_model();
    let lug = m.components.iter_mut().find(|c| c.id == "lug").unwrap();
    lug.cut = true;
    let parent = lug.parent.clone().expect("the fixture lug has a parent");
    let root_names = |glb: &[u8]| -> Vec<(String, Value)> {
        let (doc, _) = validate(glb);
        let nodes = doc["nodes"].as_array().unwrap().clone();
        doc["scenes"][0]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| nodes[i.as_u64().unwrap() as usize].clone())
            .map(|n| (n["name"].as_str().unwrap().to_string(), n))
            .collect()
    };
    // Default: the cutter is left out (exports, `rw render`).
    let plain = root_names(&mesh_model_glb(&m, &MeshOptions::default()));
    assert!(plain.iter().all(|(n, _)| n != "lug"));
    // `cutters`: a tagged node naming the parent it subtracts from; other parts untouched.
    let opts = MeshOptions {
        cutters: true,
        ..MeshOptions::default()
    };
    let tagged = root_names(&mesh_model_glb(&m, &opts));
    let (_, node) = tagged
        .iter()
        .find(|(n, _)| n == "lug")
        .expect("cutter node");
    assert_eq!(node["extras"]["rw_cut"], true);
    assert_eq!(node["extras"]["rw_cut_parent"], parent.as_str());
    assert!(
        tagged
            .iter()
            .filter(|(n, _)| n != "lug")
            .all(|(_, n)| n["extras"].get("rw_cut").is_none())
    );
    assert_eq!(tagged.len(), plain.len() + 1);
}
