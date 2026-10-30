/**
 * R2.4 cuts in the rendered geometry: the real rw-wasm GLB of a vented tube
 * (four `cut = true` slots through the wall) carries tagged cutter nodes, and
 * `applyCuts` subtracts them from the tube with manifold-3d (the removed
 * volume is the slots' share of the wall), drops the cutter nodes, and leaves
 * every other part alone. Without `cutters` the GLB has no cutter at all.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRwWasm } from "@rw/rw-wasm";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { applyCuts, cutterNodes } from "./cuts.ts";
import { MESH_OPTIONS } from "./glb-source.ts";
import { AssemblyModel } from "./scene.ts";
import { applyDetail, defaultDetailRegistry } from "../detail/registry.ts";

const FIXTURE = fileURLToPath(new URL("../../../../e2e/fixtures/vented-freeform/", import.meta.url));

function files(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".toml")) out[relative(FIXTURE, p).split("\\").join("/")] = readFileSync(p, "utf8");
    }
  };
  walk(FIXTURE);
  return out;
}

async function parse(bytes: Uint8Array): Promise<THREE.Object3D> {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return (await new GLTFLoader().parseAsync(ab, "")).scene;
}

const volumeOf = (o: THREE.Object3D) => {
  let v = 0;
  o.traverse((m) => {
    if (!(m instanceof THREE.Mesh)) return;
    const g = (m.geometry as THREE.BufferGeometry).index ? (m.geometry as THREE.BufferGeometry).toNonIndexed() : (m.geometry as THREE.BufferGeometry);
    const p = g.getAttribute("position");
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let i = 0; i + 2 < p.count; i += 3) {
      a.fromBufferAttribute(p, i).applyMatrix4(m.matrix);
      b.fromBufferAttribute(p, i + 1).applyMatrix4(m.matrix);
      c.fromBufferAttribute(p, i + 2).applyMatrix4(m.matrix);
      v += a.dot(b.clone().cross(c)) / 6;
    }
  });
  return Math.abs(v);
};

describe("cut components in the viewport (vented tube)", async () => {
  const rw = await loadRwWasm(readFileSync(new URL("../../../../packages/rw-wasm/pkg/rw_wasm_bg.wasm", import.meta.url)));
  const evaluated = rw.evalModel(files());

  it("evaluates the fixture with a cut vent set on the tube", () => {
    const vents = evaluated.components.find((c) => c.id === "vents")!;
    expect(vents.cut).toBe(true);
    expect(vents.parent).toBe("body");
    expect(vents.instances).toHaveLength(4);
    expect(evaluated.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("writes cutters only on request, tagged with their parent", async () => {
    const plain = await parse(rw.meshModelGlb(evaluated, { ...MESH_OPTIONS, cutters: false }));
    expect(cutterNodes(plain)).toHaveLength(0);
    expect(plain.children.map((n) => n.name)).not.toContain("vents");
    const tagged = await parse(rw.meshModelGlb(evaluated, MESH_OPTIONS));
    const [vents] = cutterNodes(tagged);
    expect(vents?.name).toBe("vents");
    expect(vents?.userData["rw_cut_parent"]).toBe("body");
  });

  it("subtracts the vents from the tube and removes the cutter nodes", async () => {
    const scene = await parse(rw.meshModelGlb(evaluated, MESH_OPTIONS));
    const nose0 = volumeOf(scene.children.find((n) => n.name === "nose")!);
    const body0 = volumeOf(scene.children.find((n) => n.name === "body")!);
    const report = await applyCuts(scene);
    expect(report.failed).toEqual([]);
    expect(report).toMatchObject({ cutters: 1, applied: 1 });
    expect(cutterNodes(scene)).toHaveLength(0);
    expect(scene.children.map((n) => n.name)).not.toContain("vents");
    const row = report.parts["body"]!;
    expect(row.cutters).toEqual(["vents"]);
    // Four 6 mm x 30 mm slots through the 0.8 mm wall: about 4 x 30 x 6 x 0.8 mm³ (the
    // cutter's own 0.5 mm bore and the wall curvature take a little off).
    const removed = row.before - row.after;
    expect(removed).toBeGreaterThan(4 * 30 * 5.2 * 0.8 * 1e-9);
    expect(removed).toBeLessThan(4 * 30 * 6 * 0.8 * 1e-9);
    // The drawn tube lost that volume; the nose is untouched.
    expect(body0 - volumeOf(scene.children.find((n) => n.name === "body")!)).toBeCloseTo(removed, 9);
    expect(volumeOf(scene.children.find((n) => n.name === "nose")!)).toBeCloseTo(nose0, 12);
    // The assembly never shows a cutter as a part.
    const model = new AssemblyModel(scene);
    expect([...model.parts.keys()]).not.toContain("vents");
    // Visual detail never redraws the cut tube uncut (its base mesh, with the holes, stays visible).
    const applied = applyDetail(model, evaluated.components, defaultDetailRegistry());
    expect(applied.report.map((r) => r.id)).not.toContain("body");
    expect(applied.report.map((r) => r.id)).toContain("mmt");
    expect(model.parts.get("body")!.meshes.every((m) => (m.material as THREE.Material).visible)).toBe(true);
  });

  it("drops cutters it cannot apply instead of drawing them solid", async () => {
    const scene = await parse(rw.meshModelGlb(evaluated, MESH_OPTIONS));
    const report = await applyCuts(scene, () => Promise.reject(new Error("no wasm")));
    expect(report.applied).toBe(0);
    expect(report.failed[0]).toMatch(/^vents: manifold-3d unavailable/);
    expect(cutterNodes(scene)).toHaveLength(0);
  });
});
