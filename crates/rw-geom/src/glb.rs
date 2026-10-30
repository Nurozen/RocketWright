//! Binary glTF 2.0 writer (R4.1). One top-level node per component, named by
//! the component id; instanced components get child nodes `<id>/<n>` that
//! share one mesh. Geometry stays in the body frame (+X aft, +Z up); every
//! top-level node carries `extras.rw_frame = "body"` (the loader rotates to
//! three.js Y-up once) and `extras.rw_explode`, the displacement at explode = 1.
//! The top-level node translation is exactly `explode · rw_explode`.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::frames::{explode_dirs, is_internal};
use crate::mesh::{Mesh, fin_plate, rail_button, revolve};
use crate::types::{ComponentGeometry, Geometry, MeshOptions};
use rw_model::ComponentType;

const MAGIC: u32 = 0x4654_6C67; // "glTF"
const VERSION: u32 = 2;
const CHUNK_JSON: u32 = 0x4E4F_534A;
const CHUNK_BIN: u32 = 0x004E_4942;
const FLOAT: u32 = 5126;
const UNSIGNED_INT: u32 = 5125;
const ARRAY_BUFFER: u32 = 34962;
const ELEMENT_ARRAY_BUFFER: u32 = 34963;

/// Material slots (linear base colours).
const MATERIALS: [(&str, [f32; 4], f32, f32); 3] = [
    ("airframe", [0.80, 0.82, 0.85, 1.0], 0.1, 0.45),
    ("fin", [0.70, 0.72, 0.76, 1.0], 0.1, 0.5),
    ("internal", [0.45, 0.47, 0.50, 1.0], 0.3, 0.6),
];

fn material_of(kind: ComponentType) -> usize {
    match kind {
        ComponentType::TrapezoidalFinSet
        | ComponentType::EllipticalFinSet
        | ComponentType::FreeformFinSet
        | ComponentType::TubeFinSet => 1,
        k if is_internal(k) => 2,
        _ => 0,
    }
}

/// The component-local mesh of one instance (see `frames`).
/// cite: n/a pure geometry (mesh dispatch)
pub fn component_mesh(c: &ComponentGeometry, segments: u32) -> Mesh {
    if let Some(fin) = &c.fins {
        return fin_plate(fin);
    }
    if c.kind == ComponentType::RailButton {
        return rail_button_mesh(c, segments);
    }
    revolve(&c.outer, &c.inner, segments)
}

fn rail_button_mesh(c: &ComponentGeometry, segments: u32) -> Mesh {
    // `outer` holds the spool meridian along the button axis (see `profile`).
    rail_button(0.5 * (c.x_fore + c.x_aft), &c.outer, segments)
}

struct Writer {
    bin: Vec<u8>,
    views: Vec<Value>,
    accessors: Vec<Value>,
}

impl Writer {
    fn view(&mut self, bytes: &[u8], target: u32) -> usize {
        while !self.bin.len().is_multiple_of(4) {
            self.bin.push(0);
        }
        let off = self.bin.len();
        self.bin.extend_from_slice(bytes);
        self.views.push(json!({
            "buffer": 0, "byteOffset": off, "byteLength": bytes.len(), "target": target
        }));
        self.views.len() - 1
    }

    fn mesh(&mut self, m: &Mesh) -> (usize, usize, usize) {
        let mut b = Vec::with_capacity(m.positions.len() * 12);
        m.positions
            .iter()
            .flatten()
            .for_each(|v| b.extend_from_slice(&v.to_le_bytes()));
        let pv = self.view(&b, ARRAY_BUFFER);
        b.clear();
        m.normals
            .iter()
            .flatten()
            .for_each(|v| b.extend_from_slice(&v.to_le_bytes()));
        let nv = self.view(&b, ARRAY_BUFFER);
        b.clear();
        m.indices
            .iter()
            .for_each(|v| b.extend_from_slice(&v.to_le_bytes()));
        let iv = self.view(&b, ELEMENT_ARRAY_BUFFER);
        let (lo, hi) = m.bounds();
        let count = m.positions.len();
        self.accessors.push(json!({
            "bufferView": pv, "componentType": FLOAT, "count": count, "type": "VEC3", "min": lo, "max": hi
        }));
        self.accessors.push(json!({
            "bufferView": nv, "componentType": FLOAT, "count": count, "type": "VEC3"
        }));
        self.accessors.push(json!({
            "bufferView": iv, "componentType": UNSIGNED_INT, "count": m.indices.len(), "type": "SCALAR"
        }));
        let n = self.accessors.len();
        (n - 3, n - 2, n - 1)
    }
}

/// Rounds to f32 precision so the JSON is stable and compact.
fn num(v: f64) -> Value {
    json!(v as f32)
}

fn vec3(v: [f64; 3]) -> Value {
    Value::Array(v.iter().map(|&x| num(x)).collect())
}

/// Writes the geometry as GLB (see the module docs for the node layout).
/// Cut components are skipped unless `opts.cutters`, which writes them as
/// cutter nodes (`extras.rw_cut = true`, `rw_cut_parent` from `parents`) for
/// the renderer to subtract from their parent.
/// cite: n/a file format encoding (glTF 2.0)
pub fn write(geometry: &Geometry, opts: &MeshOptions) -> Vec<u8> {
    write_with_parents(geometry, opts, &BTreeMap::new())
}

/// [`write`] with each component's parent id (for cutter nodes).
/// cite: n/a file format encoding (glTF 2.0)
pub fn write_with_parents(
    geometry: &Geometry,
    opts: &MeshOptions,
    parents: &BTreeMap<String, String>,
) -> Vec<u8> {
    let dirs = explode_dirs(geometry);
    let explode = if opts.explode.is_finite() {
        opts.explode.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let mut w = Writer {
        bin: Vec::new(),
        views: Vec::new(),
        accessors: Vec::new(),
    };
    let (mut meshes, mut nodes, mut roots) = (Vec::new(), Vec::new(), Vec::new());
    for c in &geometry.components {
        if (c.cut && !opts.cutters) || (!opts.internals && is_internal(c.kind) && !c.cut) {
            continue;
        }
        let m = component_mesh(c, opts.radial_segments);
        let mesh_idx = (!m.is_empty()).then(|| {
            let (p, n, i) = w.mesh(&m);
            meshes.push(json!({
                "name": c.id,
                "primitives": [{
                    "attributes": { "POSITION": p, "NORMAL": n },
                    "indices": i,
                    "material": material_of(c.kind),
                    "mode": 4
                }]
            }));
            meshes.len() - 1
        });
        let dir = dirs.get(&c.id).copied().unwrap_or([0.0; 3]);
        let mut node = json!({
            "name": c.id,
            "extras": { "rw_frame": "body", "rw_explode": vec3(dir), "rw_type": c.kind.name() }
        });
        if c.cut {
            node["extras"]["rw_cut"] = json!(true);
            if let Some(p) = parents.get(&c.id) {
                node["extras"]["rw_cut_parent"] = json!(p);
            }
        }
        if explode > 0.0 {
            node["translation"] = vec3(dir.map(|d| d * explode));
        }
        let identity = c.instances.len() == 1
            && c.instances[0].roll == 0.0
            && c.instances[0].offset == [0.0; 3];
        let root = nodes.len();
        nodes.push(node);
        if identity || c.instances.is_empty() {
            if let Some(mi) = mesh_idx {
                nodes[root]["mesh"] = json!(mi);
            }
        } else {
            let mut kids = Vec::new();
            for (n, inst) in c.instances.iter().enumerate() {
                let (s, co) = (0.5 * inst.roll).sin_cos();
                let mut child = json!({ "name": format!("{}/{n}", c.id) });
                if inst.offset != [0.0; 3] {
                    child["translation"] = vec3(inst.offset);
                }
                if inst.roll != 0.0 {
                    child["rotation"] = json!([num(s), 0.0, 0.0, num(co)]);
                }
                if let Some(mi) = mesh_idx {
                    child["mesh"] = json!(mi);
                }
                kids.push(nodes.len());
                nodes.push(child);
            }
            nodes[root]["children"] = json!(kids);
        }
        roots.push(root);
    }
    let materials: Vec<Value> = MATERIALS
        .iter()
        .map(|(name, color, metal, rough)| {
            json!({
                "name": name,
                "pbrMetallicRoughness": {
                    "baseColorFactor": color, "metallicFactor": metal, "roughnessFactor": rough
                }
            })
        })
        .collect();
    while !w.bin.len().is_multiple_of(4) {
        w.bin.push(0);
    }
    let mut doc = json!({
        "asset": {
            "version": "2.0",
            "generator": concat!("rocketwright rw-geom ", env!("CARGO_PKG_VERSION")),
            "extras": { "rw_frame": "body", "model_hash": geometry.model_hash }
        },
        "scene": 0,
        "scenes": [{ "nodes": roots }],
        "nodes": nodes,
        "materials": materials,
    });
    if !meshes.is_empty() {
        doc["meshes"] = json!(meshes);
        doc["accessors"] = json!(w.accessors);
        doc["bufferViews"] = json!(w.views);
        doc["buffers"] = json!([{ "byteLength": w.bin.len() }]);
    }
    container(doc.to_string().into_bytes(), w.bin)
}

fn container(mut json_bytes: Vec<u8>, bin: Vec<u8>) -> Vec<u8> {
    while !json_bytes.len().is_multiple_of(4) {
        json_bytes.push(b' ');
    }
    let has_bin = !bin.is_empty();
    let total = 12 + 8 + json_bytes.len() + if has_bin { 8 + bin.len() } else { 0 };
    let mut out = Vec::with_capacity(total);
    for word in [MAGIC, VERSION, total as u32] {
        out.extend_from_slice(&word.to_le_bytes());
    }
    out.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&CHUNK_JSON.to_le_bytes());
    out.extend_from_slice(&json_bytes);
    if has_bin {
        out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
        out.extend_from_slice(&CHUNK_BIN.to_le_bytes());
        out.extend_from_slice(&bin);
    }
    out
}
