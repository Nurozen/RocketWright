/**
 * Cut components in the rendered geometry (R2.4): a component with
 * `cut = true` (fin slots, vents, lightening holes) removes material from its
 * parent in the mass model, so the 3D views remove it too. rw-geom writes
 * each cutter as a tagged node (`MeshOptions.cutters`: `extras.rw_cut`,
 * `rw_cut_parent`); after the GLB is parsed, `applyCuts` subtracts every
 * cutter from its parent's meshes with `manifold-3d` (a boolean difference in
 * the body frame, before explode or the Y-up rotation), and removes the
 * cutter nodes, so a cutter never renders as a solid even when the cut
 * cannot be made (manifold unavailable, an open parent surface).
 *
 * Visual tier (I13): the removed volume is reported for checking the view
 * against the model, never fed into mass properties (rw-mass owns those).
 */
import type { Manifold, ManifoldToplevel } from "manifold-3d";
import * as THREE from "three/webgpu";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { loadManifold, toManifold, weldedTriangles } from "../render/section.ts";

export interface CutPartReport {
  /** Closed volume of the parent's meshes before and after the cut (m³). */
  before: number;
  after: number;
  /** Cutter component ids subtracted from this part. */
  cutters: string[];
}

export interface CutReport {
  /** Cutter components in the GLB. */
  cutters: number;
  /** Cutters subtracted from their parent. */
  applied: number;
  /** Why a cutter was not applied (`<cutter>: <reason>`). */
  failed: string[];
  parts: Record<string, CutPartReport>;
}

export const EMPTY_CUT_REPORT: CutReport = { cutters: 0, applied: 0, failed: [], parts: {} };

/** Normals are smoothed across edges flatter than this (tube walls stay round, cut faces crisp). */
const CREASE = Math.PI / 5;

/** The cutter nodes (top-level `extras.rw_cut`) of a parsed GLB scene. */
export function cutterNodes(scene: THREE.Object3D): THREE.Object3D[] {
  return scene.children.filter((n) => n.userData["rw_cut"] === true);
}

/** A mesh's matrix relative to its top-level part node, without that node's own (explode) transform. */
function partMatrix(root: THREE.Object3D, o: THREE.Object3D): THREE.Matrix4 {
  return new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(o.matrixWorld);
}

function meshesOf(node: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  node.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
}

/** Manifold mesh → geometry in `inverse` space (the mesh's own local frame), creased normals. */
function toGeometry(m: Manifold, inverse: THREE.Matrix4): THREE.BufferGeometry {
  const mesh = m.getMesh();
  const n = mesh.vertProperties.length / mesh.numProp;
  const pos = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) pos[v * 3 + k] = mesh.vertProperties[v * mesh.numProp + k] ?? 0;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.triVerts), 1));
  g.applyMatrix4(inverse);
  const out = toCreasedNormals(g, CREASE);
  g.dispose();
  return out;
}

/**
 * Subtracts every cutter node of `scene` (a freshly parsed rw-geom GLB) from
 * its parent part and removes the cutter nodes. Parts without a cutter are
 * untouched. Never throws: what could not be cut is listed in `failed`.
 */
export async function applyCuts(scene: THREE.Object3D, load: () => Promise<ManifoldToplevel> = loadManifold): Promise<CutReport> {
  const cutters = cutterNodes(scene);
  if (cutters.length === 0) return { ...EMPTY_CUT_REPORT, failed: [], parts: {} };
  const report: CutReport = { cutters: cutters.length, applied: 0, failed: [], parts: {} };
  scene.updateMatrixWorld(true);
  const byParent = new Map<string, THREE.Object3D[]>();
  for (const c of cutters) {
    const p = c.userData["rw_cut_parent"];
    if (typeof p !== "string" || p === "") report.failed.push(`${c.name}: no parent to cut`);
    else byParent.set(p, [...(byParent.get(p) ?? []), c]);
  }
  for (const c of cutters) scene.remove(c);
  if (byParent.size === 0) return report;

  let mf: ManifoldToplevel;
  try {
    mf = await load();
  } catch (e) {
    for (const cs of byParent.values()) for (const c of cs) report.failed.push(`${c.name}: manifold-3d unavailable (${e instanceof Error ? e.message : String(e)})`);
    return report;
  }

  for (const [parentId, cs] of byParent) {
    const parent = scene.children.find((n) => n.name === parentId);
    if (parent === undefined) {
      for (const c of cs) report.failed.push(`${c.name}: parent ${parentId} is not drawn`);
      continue;
    }
    // One solid of every cutter instance, in the body frame.
    const tools: Manifold[] = [];
    const used: string[] = [];
    for (const c of cs) {
      let ok = false;
      for (const m of meshesOf(c)) {
        const { positions, indices } = weldedTriangles(m.geometry as THREE.BufferGeometry, partMatrix(c, m));
        const solid = toManifold(mf, positions, indices);
        if (solid !== null) {
          tools.push(solid);
          ok = true;
        }
      }
      if (ok) used.push(c.name);
      else report.failed.push(`${c.name}: the cutter is not a closed solid`);
    }
    if (tools.length === 0) continue;
    const tool = tools.length === 1 ? tools[0]! : mf.Manifold.union(tools);
    const row: CutPartReport = { before: 0, after: 0, cutters: used };
    let cutAny = false;
    for (const m of meshesOf(parent)) {
      const rel = partMatrix(parent, m);
      const { positions, indices } = weldedTriangles(m.geometry as THREE.BufferGeometry, rel);
      const body = toManifold(mf, positions, indices);
      if (body === null) continue;
      const kept = body.subtract(tool);
      const before = body.volume();
      const after = kept.volume();
      row.before += before;
      row.after += after;
      if (before - after > 1e-15) {
        m.geometry = toGeometry(kept, rel.clone().invert());
        m.userData["rwCut"] = true;
        cutAny = true;
      }
      body.delete();
      kept.delete();
    }
    if (tools.length > 1) tool.delete();
    for (const t of tools) t.delete();
    if (row.before === 0) {
      for (const c of used) report.failed.push(`${c}: parent ${parentId} is not a closed solid`);
      continue;
    }
    report.parts[parentId] = row;
    if (cutAny) report.applied += used.length;
    else for (const c of used) report.failed.push(`${c}: does not overlap ${parentId}`);
  }
  return report;
}

/** DOM attributes for a viewport (`data-cuts="1/1"`, removed volume in mm³), empty without cutters. */
export function cutAttrs(r: CutReport | null): Record<string, string> {
  if (r === null || r.cutters === 0) return {};
  const removed = Object.values(r.parts).reduce((s, p) => s + (p.before - p.after), 0);
  const out: Record<string, string> = { "data-cuts": `${r.applied}/${r.cutters}`, "data-cut-removed-mm3": (removed * 1e9).toFixed(1) };
  if (r.failed.length > 0) out["data-cut-failed"] = r.failed.join("; ");
  return out;
}
