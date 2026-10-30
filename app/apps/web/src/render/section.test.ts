/** RL1c: manifold-3d section cut of a tube, with caps, volume-checked (F:82: 49871.1 / 24935.6). */
import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import {
  capMaterial,
  CAP_LAYER,
  clipTriangles,
  cutMeshForStill,
  cutObjectForStill,
  loadManifold,
  meshArea,
  meshVolume,
  polygonTubeVolume,
  sectionCut,
  StencilCaps,
  tubeShell,
  type TubeSpec,
} from "./section.ts";

/** The F:82 native spike tube: 300 mm long, 54 mm OD, 52 mm ID, 64 segments. */
const TUBE: TubeSpec = { length: 300, outerRadius: 27, innerRadius: 26, segments: 64 };

describe("section cut (manifold-3d)", () => {
  it("matches the native manifold3d spike volumes and the analytic polygon tube", async () => {
    const mf = await loadManifold();
    const shell = tubeShell(mf, TUBE);
    const cut = sectionCut(mf, shell, { axis: "x", offset: 0, keep: "below" });
    shell.delete();
    expect(cut.bodyVolume.toFixed(1)).toBe("49871.1");
    expect(cut.volume.toFixed(1)).toBe("24935.6");
    expect(cut.bodyVolume).toBeCloseTo(polygonTubeVolume(TUBE), 3);
    expect(cut.volume).toBeCloseTo(polygonTubeVolume(TUBE) / 2, 3);
  });

  it("is closed with caps: mesh volume equals the manifold volume, caps are the two cut walls", async () => {
    const mf = await loadManifold();
    const shell = tubeShell(mf, TUBE);
    const cut = sectionCut(mf, shell, { axis: "x", offset: 0, keep: "below" });
    shell.delete();
    const { positions, indices, groups } = cut.mesh;
    expect(meshVolume(positions, indices)).toBeCloseTo(cut.volume, 1);
    expect(groups.map((g) => g.role)).toEqual(["body", "cap"]);
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(indices.length);
    // Plane x = 0 passes through polygon vertices, so each cap is exactly 1 mm x 300 mm.
    expect(cut.capArea).toBeCloseTo(2 * (TUBE.outerRadius - TUBE.innerRadius) * TUBE.length, 3);
    // Every kept vertex is on the kept side.
    for (let i = 0; i < positions.length; i += 3) expect(positions[i]!).toBeLessThanOrEqual(1e-4);
  });

  it("keeps the other half with keep: above, and an off-centre cut keeps less", async () => {
    const mf = await loadManifold();
    const shell = tubeShell(mf, TUBE);
    const above = sectionCut(mf, shell, { axis: "x", offset: 0, keep: "above" });
    const slice = sectionCut(mf, shell, { axis: "z", offset: 100, keep: "below" });
    shell.delete();
    expect(above.volume).toBeCloseTo(polygonTubeVolume(TUBE) / 2, 3);
    expect(slice.volume).toBeCloseTo(polygonTubeVolume(TUBE) / 3, 3);
    // A cross-cut cap is the annulus itself.
    expect(slice.capArea).toBeCloseTo(polygonTubeVolume(TUBE) / TUBE.length, 3);
  });

  it("meshVolume and meshArea on a unit cube", () => {
    // 8 corners, 12 outward-wound triangles.
    const p = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
    const i = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
    expect(meshVolume(p, i)).toBeCloseTo(1, 9);
    expect(meshArea(p, i)).toBeCloseTo(6, 9);
  });

  it("rejects a tube whose bore is not inside the wall", async () => {
    const mf = await loadManifold();
    expect(() => tubeShell(mf, { ...TUBE, innerRadius: 30 })).toThrow(/bad tube/);
  });
});

/** The F:82 tube as a three geometry in metres (manifold mesh, flat-shaded triangle soup like a GLB part). */
async function tubeGeometry(): Promise<THREE.BufferGeometry> {
  const mf = await loadManifold();
  const shell = tubeShell(mf, TUBE);
  const mesh = shell.getMesh();
  shell.delete();
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array((mesh.vertProperties.length / mesh.numProp) * 3);
  for (let v = 0; v < pos.length / 3; v++) for (let k = 0; k < 3; k++) pos[v * 3 + k] = mesh.vertProperties[v * mesh.numProp + k]! / 1000;
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.triVerts), 1));
  // Split per triangle, as GLB parts with flat normals are: the weld must rejoin them.
  return g.toNonIndexed();
}

const M3 = 1e-9; // mm^3 -> m^3

describe("still section cuts (M3.3)", () => {
  it("cuts a closed GLB-style tube through its axis: half the analytic volume, caps tagged", async () => {
    const mf = await loadManifold();
    const geom = await tubeGeometry();
    // Keep x <= 0 (plane normal -x), the tube axis is z.
    const plane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
    const r = cutMeshForStill(mf, geom, new THREE.Matrix4(), plane);
    expect(r.method).toBe("manifold");
    expect(r.bodyVolume! / M3).toBeCloseTo(polygonTubeVolume(TUBE), 1);
    expect(r.volume! / M3).toBeCloseTo(polygonTubeVolume(TUBE) / 2, 1);
    expect(r.capArea / 1e-6).toBeCloseTo(2 * (TUBE.outerRadius - TUBE.innerRadius) * TUBE.length, 1);
    const g = r.geometry!;
    expect(g.groups.map((x) => x.materialIndex)).toEqual([0, 1]);
    const p = g.getAttribute("position");
    for (let i = 0; i < p.count; i++) expect(p.getX(i)).toBeLessThanOrEqual(1e-9);
    // The mesh itself is closed: its volume equals manifold's.
    const idx = new Uint32Array(p.count).map((_, i) => i);
    expect(meshVolume(p.array as Float32Array, idx)).toBeCloseTo(r.volume!, 12);
  });

  it("applies the world matrix and keeps or drops meshes wholly on one side", async () => {
    const mf = await loadManifold();
    const geom = await tubeGeometry();
    const plane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
    const right = new THREE.Matrix4().makeTranslation(0.1, 0, 0);
    const left = new THREE.Matrix4().makeTranslation(-0.1, 0, 0);
    expect(cutMeshForStill(mf, geom, right, plane).method).toBe("dropped");
    const kept = cutMeshForStill(mf, geom, left, plane);
    expect(kept.method).toBe("kept");
    expect(kept.volume! / M3).toBeCloseTo(polygonTubeVolume(TUBE), 1);
  });

  it("clips open surfaces per triangle (no caps)", async () => {
    const mf = await loadManifold();
    // An open square sheet in the x-y plane, [-1, 1]^2, two triangles.
    const pos = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
    const idx = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const plane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
    const clipped = clipTriangles(pos, idx, plane);
    const p = clipped.getAttribute("position");
    let area = 0;
    const tri = new THREE.Triangle();
    for (let i = 0; i < p.count; i += 3) {
      tri.set(new THREE.Vector3().fromBufferAttribute(p, i), new THREE.Vector3().fromBufferAttribute(p, i + 1), new THREE.Vector3().fromBufferAttribute(p, i + 2));
      area += tri.getArea();
    }
    expect(area).toBeCloseTo(2, 9);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    expect(cutMeshForStill(mf, g, new THREE.Matrix4(), plane).method).toBe("clip");
  });

  it("cuts a whole object tree into a still group with a per-part report", async () => {
    const mf = await loadManifold();
    const root = new THREE.Group();
    const a = new THREE.Mesh(await tubeGeometry(), new THREE.MeshStandardNodeMaterial());
    a.userData["rwPart"] = "tube";
    const hidden = new THREE.Mesh(await tubeGeometry(), new THREE.MeshStandardNodeMaterial());
    hidden.visible = false;
    root.add(a, hidden);
    const cap = capMaterial("check");
    const { group, report } = cutObjectForStill(mf, root, new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0), cap, (m) => (m.userData["rwPart"] as string) ?? null);
    expect(report).toMatchObject({ meshes: 1, manifold: 1, clip: 0 });
    expect(report.parts["tube"]!.volume / report.parts["tube"]!.bodyVolume).toBeCloseTo(0.5, 6);
    expect(group.children).toHaveLength(1);
    expect((group.children[0] as THREE.Mesh).material).toEqual([a.material, cap]);
  });
});

describe("live stencil caps (M3.3)", () => {
  it("adds two hidden writers per source mesh and a cap quad on the plane", () => {
    const meshes = [new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)), new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))];
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
    const caps = new StencilCaps(meshes, plane);
    expect(meshes.every((m) => m.children.length === 2)).toBe(true);
    expect(caps.stats()).toMatchObject({ writers: 4, activeWriters: 0, cap: false, enabled: false });
    new THREE.Scene().add(caps.cap);
    caps.setEnabled(true);
    expect(caps.stats()).toMatchObject({ writers: 4, activeWriters: 4, cap: true, enabled: true });
    meshes[1]!.visible = false;
    expect(caps.stats().activeWriters).toBe(2);
    // The quad faces +z (into the removed half) on z = 0, and lives on the cap layer only.
    caps.fit(new THREE.Box3(new THREE.Vector3(-1, -2, -3), new THREE.Vector3(1, 2, 3)));
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(caps.cap.quaternion);
    expect(n.z).toBeCloseTo(1, 9);
    expect(caps.cap.position.z).toBeCloseTo(0, 9);
    expect(caps.cap.layers.mask).toBe(1 << CAP_LAYER);
    const back = meshes[0]!.children[0] as THREE.Mesh;
    const m = back.material as THREE.Material;
    expect([m.colorWrite, m.depthWrite, m.depthTest, m.stencilWrite]).toEqual([false, false, false, true]);
    caps.dispose();
    expect(meshes.every((x) => x.children.length === 0)).toBe(true);
  });
});
