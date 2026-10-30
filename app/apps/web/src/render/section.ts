/**
 * Real section cuts with `manifold-3d` (RL1c, M1.13c; research/render-fluids
 * "Section views"). The cut is a boolean difference against a large box whose
 * face lies on the section plane, so the result is closed (caps included) and
 * works anywhere ordinary geometry does: the raster viewport, the path tracer
 * (which ignores clipping planes), and exported stills.
 *
 * The body and the cutter carry distinct manifold original IDs, so every
 * output triangle is tagged `body` (the part's own surface) or `cap` (a face
 * the cut created), and caps can get their own material.
 *
 * Visual tier only (I13): volumes here are for checking the cut, never for
 * mass properties (the Rust core owns those).
 *
 * Units are whatever the caller uses (the spike uses mm; the viewport and
 * stills use metres).
 *
 * M3.3 adds the two production paths:
 * - Live (`StencilCaps`): the viewport keeps its `ClippingGroup` and closes
 *   the cut with a stencil cap. Every clipped base mesh gets two invisible
 *   stencil writers (back faces increment, front faces decrement, no depth
 *   test), so the stencil counts the solids the section plane passes
 *   through at each pixel; one hatched cap quad on the plane draws where the
 *   count is non-zero and resets it. Cheap enough for the slider and orbit.
 * - Stills (`cutObjectForStill`): real cut geometry from `manifold-3d` for the
 *   path tracer (which ignores clipping planes) and the headless section
 *   render. Closed meshes are cut with caps (volume-checked); open surfaces
 *   (fabric, thin detail sheets) are clipped triangle by triangle (no caps:
 *   a sheet has no inside).
 */
import type { Manifold, ManifoldToplevel } from "manifold-3d";
import { float, fract, mix, positionWorld, step, uniform } from "three/tsl";
import * as THREE from "three/webgpu";

export type Axis = "x" | "y" | "z";

/** A thin-walled tube along +Z from z = 0 to z = length. */
export interface TubeSpec {
  length: number;
  outerRadius: number;
  innerRadius: number;
  /** Circular segments of both walls (a regular polygon, not a true circle). */
  segments: number;
}

/** Keep the half-space `axis <= offset` (`keep: "below"`) or `axis >= offset` (`"above"`). */
export interface SectionPlane {
  axis: Axis;
  offset: number;
  keep: "below" | "above";
}

export interface SectionGroup {
  role: "body" | "cap";
  /** First index into `indices` (a multiple of 3). */
  start: number;
  /** Number of indices. */
  count: number;
}

/** A flat triangle mesh: xyz positions, triangle indices, and per-role index ranges. */
export interface SectionMesh {
  positions: Float32Array;
  indices: Uint32Array;
  groups: SectionGroup[];
}

export interface SectionResult {
  /** Volume of the body before the cut. */
  bodyVolume: number;
  /** Volume of what is kept. */
  volume: number;
  /** Area of the cap faces the cut created. */
  capArea: number;
  mesh: SectionMesh;
}

let loading: Promise<ManifoldToplevel> | null = null;

/** Loads and sets up the manifold-3d WASM module once (browser and Node). */
export function loadManifold(): Promise<ManifoldToplevel> {
  loading ??= import("manifold-3d").then(async ({ default: Module }) => {
    const wasm = await Module();
    wasm.setup();
    return wasm;
  });
  return loading;
}

/** The tube as a closed manifold (outer cylinder minus bore). */
export function tubeShell(mf: ManifoldToplevel, t: TubeSpec): Manifold {
  if (!(t.innerRadius > 0 && t.outerRadius > t.innerRadius && t.length > 0 && t.segments >= 3)) {
    throw new Error(`tubeShell: bad tube ${JSON.stringify(t)}`);
  }
  const outer = mf.Manifold.cylinder(t.length, t.outerRadius, t.outerRadius, t.segments, false);
  const bore = mf.Manifold.cylinder(t.length, t.innerRadius, t.innerRadius, t.segments, false);
  const shell = outer.subtract(bore);
  outer.delete();
  bore.delete();
  return shell;
}

/**
 * Exact volume of `tubeShell`: the annulus between two regular `segments`-gons
 * inscribed in the radii, times the length.
 */
export function polygonTubeVolume(t: TubeSpec): number {
  const ring = (r: number) => (t.segments / 2) * r * r * Math.sin((2 * Math.PI) / t.segments);
  return (ring(t.outerRadius) - ring(t.innerRadius)) * t.length;
}

const AXIS_INDEX: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

/**
 * Cuts `body` by `plane` and returns the kept part with caps. `body` is left
 * intact (the caller still owns it).
 */
export function sectionCut(mf: ManifoldToplevel, body: Manifold, plane: SectionPlane): SectionResult {
  const box = body.boundingBox();
  const span = Math.max(...[0, 1, 2].map((i) => (box.max[i] ?? 0) - (box.min[i] ?? 0))) * 4 + 1;
  const a = AXIS_INDEX[plane.axis];
  // The cutter covers the discarded half-space: [offset, offset + span] on the
  // axis (keep below) or [offset - span, offset] (keep above), centred elsewhere.
  const size: [number, number, number] = [span, span, span];
  const origin: [number, number, number] = [0, 1, 2].map((i) => ((box.min[i] ?? 0) + (box.max[i] ?? 0)) / 2 - span / 2) as [number, number, number];
  origin[a] = plane.keep === "below" ? plane.offset : plane.offset - span;

  // `asOriginal` gives each input a fresh original ID that the boolean keeps per triangle run.
  const tagged = body.asOriginal();
  const cube = mf.Manifold.cube(size, false);
  const moved = cube.translate(origin);
  const cutter = moved.asOriginal();
  cube.delete();
  moved.delete();
  const kept = tagged.subtract(cutter);
  const mesh = kept.getMesh();
  const bodyOriginal = tagged.originalID();
  const cutterOriginal = cutter.originalID();

  const result: SectionResult = {
    bodyVolume: body.volume(),
    volume: kept.volume(),
    capArea: 0,
    mesh: { positions: new Float32Array(0), indices: new Uint32Array(0), groups: [] },
  };

  // Positions: the first three properties of each vertex.
  const n = mesh.vertProperties.length / mesh.numProp;
  const positions = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    for (let k = 0; k < 3; k++) positions[v * 3 + k] = mesh.vertProperties[v * mesh.numProp + k] ?? 0;
  }
  // Runs are sorted by original ID; reorder triangles body-first, caps after.
  const runIndex = mesh.runIndex;
  const runOriginal = mesh.runOriginalID;
  const ranges: Record<SectionGroup["role"], [number, number][]> = { body: [], cap: [] };
  for (let r = 0; r < runOriginal.length; r++) {
    const id = runOriginal[r];
    const role = id === cutterOriginal ? "cap" : id === bodyOriginal ? "body" : null;
    if (role === null) throw new Error(`sectionCut: run with unknown original ID ${String(id)}`);
    ranges[role].push([runIndex[r] ?? 0, runIndex[r + 1] ?? mesh.triVerts.length]);
  }
  const indices = new Uint32Array(mesh.triVerts.length);
  const groups: SectionGroup[] = [];
  let at = 0;
  for (const role of ["body", "cap"] as const) {
    const start = at;
    for (const [s, e] of ranges[role]) {
      indices.set(mesh.triVerts.subarray(s, e), at);
      at += e - s;
    }
    if (at > start) groups.push({ role, start, count: at - start });
  }
  result.mesh = { positions, indices, groups };
  const cap = groups.find((g) => g.role === "cap");
  result.capArea = cap ? meshArea(positions, indices.subarray(cap.start, cap.start + cap.count)) : 0;

  tagged.delete();
  cutter.delete();
  kept.delete();
  return result;
}

/** Signed volume of a closed, outward-wound triangle mesh (divergence theorem). */
export function meshVolume(positions: ArrayLike<number>, indices: ArrayLike<number>): number {
  let v6 = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const [a, b, c] = [indices[t] ?? 0, indices[t + 1] ?? 0, indices[t + 2] ?? 0].map((i) => i * 3);
    const ax = positions[a!] ?? 0, ay = positions[a! + 1] ?? 0, az = positions[a! + 2] ?? 0;
    const bx = positions[b!] ?? 0, by = positions[b! + 1] ?? 0, bz = positions[b! + 2] ?? 0;
    const cx = positions[c!] ?? 0, cy = positions[c! + 1] ?? 0, cz = positions[c! + 2] ?? 0;
    v6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v6 / 6;
}

/** Total area of the indexed triangles. */
export function meshArea(positions: ArrayLike<number>, indices: ArrayLike<number>): number {
  let area = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const p = [indices[t] ?? 0, indices[t + 1] ?? 0, indices[t + 2] ?? 0].map((i) => [positions[i * 3] ?? 0, positions[i * 3 + 1] ?? 0, positions[i * 3 + 2] ?? 0]);
    const [a, b, c] = p as [number[], number[], number[]];
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const x = u[1]! * w[2]! - u[2]! * w[1]!;
    const y = u[2]! * w[0]! - u[0]! * w[2]!;
    const z = u[0]! * w[1]! - u[1]! * w[0]!;
    area += Math.hypot(x, y, z) / 2;
  }
  return area;
}

// ---- M3.3 live stencil caps -------------------------------------------------

/** Layer of the cap quad: the main view camera enables it; the outline and AO cameras do not. */
export const CAP_LAYER = 3;
/** Hatch pitch on the cap (world metres). */
export const HATCH_PITCH_M = 0.0035;
/** Cap hatch (light, dark) per scheme: studio grey; the check scheme's blue-violet is the headless mask colour. */
export const CAP_COLORS = { studio: ["#aab3b8", "#4e565b"], check: ["#7b80e6", "#4d52b8"] } as const;

export type CapScheme = keyof typeof CAP_COLORS;

/**
 * The cut-face material: a 45° hatch in world metres (raster). With
 * `stencil`, it draws only where the stencil count is non-zero and resets
 * the count (`StencilCaps`).
 */
export function capMaterial(scheme: CapScheme = "studio", stencil = false): THREE.MeshStandardNodeMaterial {
  const [light, dark] = CAP_COLORS[scheme];
  const m = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(light), roughness: 0.62, metalness: 0.05, side: THREE.FrontSide });
  const stripe = step(float(0.62), fract(positionWorld.x.add(positionWorld.y).add(positionWorld.z).div(HATCH_PITCH_M)));
  m.colorNode = mix(uniform(new THREE.Color(light)), uniform(new THREE.Color(dark)), stripe);
  m.name = `rw-section-cap-${scheme}`;
  m.userData["rwSectionCap"] = true;
  if (stencil) {
    m.stencilWrite = true;
    m.stencilRef = 0;
    m.stencilFunc = THREE.NotEqualStencilFunc;
    m.stencilFail = THREE.ReplaceStencilOp;
    m.stencilZFail = THREE.ReplaceStencilOp;
    m.stencilZPass = THREE.ReplaceStencilOp;
  }
  return m;
}

function writerMaterial(side: THREE.Side, op: THREE.StencilOp): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ side });
  m.colorWrite = false;
  m.depthWrite = false;
  m.depthTest = false;
  m.stencilWrite = true;
  m.stencilFunc = THREE.AlwaysStencilFunc;
  m.stencilFail = op;
  m.stencilZFail = op;
  m.stencilZPass = op;
  m.name = side === THREE.BackSide ? "rw-section-writer-back" : "rw-section-writer-front";
  return m;
}

/** Render order of the writers (after every ordinary opaque mesh) and of the cap (after the writers). */
export const WRITER_ORDER = 10;
export const CAP_ORDER = 11;

export interface StencilCapStats {
  /** Stencil writer meshes (two per source mesh). */
  writers: number;
  /** Writers currently drawn (visible source parts). */
  activeWriters: number;
  /** The cap quad is in the scene and enabled. */
  cap: boolean;
  enabled: boolean;
}

/**
 * Live section caps for meshes clipped by `plane` (keeps `plane.distanceToPoint >= 0`).
 * The writers are children of their source meshes, so they explode, hide,
 * and clip with them; `cap` lives outside the clipping group (add it to the
 * scene). The renderer's scene pass needs a stencil buffer.
 */
export class StencilCaps {
  readonly cap: THREE.Mesh;
  private readonly writers: THREE.Mesh[] = [];
  private readonly back = writerMaterial(THREE.BackSide, THREE.IncrementWrapStencilOp);
  private readonly front = writerMaterial(THREE.FrontSide, THREE.DecrementWrapStencilOp);
  private readonly capMat: THREE.MeshStandardNodeMaterial;
  private on = false;

  constructor(
    sources: Iterable<THREE.Mesh>,
    readonly plane: THREE.Plane,
    scheme: CapScheme = "studio",
  ) {
    for (const src of sources) {
      for (const mat of [this.back, this.front]) {
        const w = new THREE.Mesh(src.geometry, mat);
        w.name = "rw-section-writer";
        w.renderOrder = WRITER_ORDER;
        w.castShadow = false;
        w.receiveShadow = false;
        w.visible = false;
        w.userData["rwSectionWriter"] = true;
        w.raycast = () => undefined;
        src.add(w);
        this.writers.push(w);
      }
    }
    this.capMat = capMaterial(scheme, true);
    this.cap = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.capMat);
    this.cap.name = "rw-section-cap";
    this.cap.renderOrder = CAP_ORDER;
    this.cap.castShadow = false;
    this.cap.receiveShadow = false;
    this.cap.visible = false;
    this.cap.layers.set(CAP_LAYER);
    this.cap.raycast = () => undefined;
    // The quad faces the removed side (-normal): the view looks into the cut.
    this.cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal.clone().negate());
  }

  get enabled(): boolean {
    return this.on;
  }

  setEnabled(on: boolean): void {
    this.on = on;
    this.cap.visible = on;
    for (const w of this.writers) w.visible = on;
  }

  /** Sizes and centres the cap quad on the plane to cover `box` (world). */
  fit(box: THREE.Box3): void {
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length() * 1.5 + 1e-3;
    this.plane.projectPoint(c, this.cap.position);
    this.cap.scale.set(size, size, 1);
    this.cap.updateMatrixWorld(true);
  }

  stats(): StencilCapStats {
    let active = 0;
    for (const w of this.writers) {
      let vis = w.visible;
      for (let o: THREE.Object3D | null = w.parent; o && vis; o = o.parent) vis = o.visible;
      if (vis) active++;
    }
    return { writers: this.writers.length, activeWriters: active, cap: this.cap.parent !== null, enabled: this.on };
  }

  dispose(): void {
    for (const w of this.writers) w.removeFromParent();
    this.writers.length = 0;
    this.cap.removeFromParent();
    this.cap.geometry.dispose();
    this.back.dispose();
    this.front.dispose();
    this.capMat.dispose();
  }
}

// ---- M3.3 still cuts (manifold-3d) --------------------------------------------

/** Merge tolerance for welding a triangle soup into a manifold (metres). */
const WELD_TOL = 1e-7;

/**
 * World-space positions and welded triangle indices of a mesh geometry
 * (`matrix` applied). Vertices closer than `tol` share an index.
 */
export function weldedTriangles(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, tol = WELD_TOL): { positions: Float32Array; indices: Uint32Array } {
  const pos = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const triCount = index ? index.count : pos.count;
  const map = new Map<string, number>();
  const out: number[] = [];
  const tris = new Uint32Array(triCount - (triCount % 3));
  const v = new THREE.Vector3();
  const inv = 1 / tol;
  for (let i = 0; i < tris.length; i++) {
    const src = index ? index.getX(i) : i;
    v.fromBufferAttribute(pos, src).applyMatrix4(matrix);
    const key = `${Math.round(v.x * inv)},${Math.round(v.y * inv)},${Math.round(v.z * inv)}`;
    let k = map.get(key);
    if (k === undefined) {
      k = out.length / 3;
      map.set(key, k);
      out.push(v.x, v.y, v.z);
    }
    tris[i] = k;
  }
  // Drop triangles collapsed by the weld (manifold rejects them).
  const kept: number[] = [];
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const a = tris[t]!, b = tris[t + 1]!, c = tris[t + 2]!;
    if (a !== b && b !== c && a !== c) kept.push(a, b, c);
  }
  return { positions: new Float32Array(out), indices: new Uint32Array(kept) };
}

/** A closed manifold from welded triangles, or null when the surface is open or not 2-manifold. */
export function toManifold(mf: ManifoldToplevel, positions: Float32Array, indices: Uint32Array): Manifold | null {
  if (indices.length < 12) return null;
  try {
    const mesh = new mf.Mesh({ numProp: 3, vertProperties: positions, triVerts: indices });
    mesh.merge();
    const m = new mf.Manifold(mesh);
    if (m.status() !== "NoError" || m.isEmpty()) {
      m.delete();
      return null;
    }
    return m;
  } catch {
    return null;
  }
}

/** The plane as manifold's `{normal, offset}` keep-side: `keep` the half where `plane.distanceToPoint >= 0`. */
function planeCutter(mf: ManifoldToplevel, body: Manifold, plane: THREE.Plane): Manifold {
  const box = body.boundingBox();
  const span = Math.max(...[0, 1, 2].map((i) => (box.max[i] ?? 0) - (box.min[i] ?? 0))) * 4 + 1;
  // A cube on the discarded side (distance < 0), its face on the plane.
  const c = new THREE.Vector3(...([0, 1, 2].map((i) => ((box.min[i] ?? 0) + (box.max[i] ?? 0)) / 2) as [number, number, number]));
  const onPlane = plane.projectPoint(c, new THREE.Vector3());
  const centre = onPlane.addScaledVector(plane.normal, -span / 2);
  const cube = mf.Manifold.cube([span, span, span], true);
  // Orient the cube so its local +Z face normal is the plane normal (column-major affine, manifold's Mat4).
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal);
  const m = new THREE.Matrix4().compose(centre, q, new THREE.Vector3(1, 1, 1));
  const moved = cube.transform(m.elements as unknown as Parameters<Manifold["transform"]>[0]);
  cube.delete();
  return moved;
}

export interface StillCutResult {
  /** `manifold`: closed cut with caps; `clip`: open surface clipped (no caps); `kept`/`dropped`: wholly on one side. */
  method: "manifold" | "clip" | "kept" | "dropped";
  /** Closed body volume before / after the cut (manifold only). */
  bodyVolume: number | null;
  volume: number | null;
  capArea: number;
  /** World-space geometry with groups 0 = surface, 1 = cap; null when dropped. */
  geometry: THREE.BufferGeometry | null;
}

/**
 * Cuts one mesh (world transform `matrix`) by `plane` for a still. Closed
 * meshes go through manifold-3d (caps tagged group 1); open ones are
 * clipped per triangle.
 */
export function cutMeshForStill(mf: ManifoldToplevel, geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, plane: THREE.Plane): StillCutResult {
  const { positions, indices } = weldedTriangles(geometry, matrix);
  let lo = Infinity;
  let hi = -Infinity;
  const p = new THREE.Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    const d = plane.distanceToPoint(p.set(positions[i]!, positions[i + 1]!, positions[i + 2]!));
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  if (hi <= 0) return { method: "dropped", bodyVolume: null, volume: null, capArea: 0, geometry: null };
  const solid = toManifold(mf, positions, indices);
  if (lo >= 0) {
    const vol = solid ? solid.volume() : null;
    solid?.delete();
    return { method: "kept", bodyVolume: vol, volume: vol, capArea: 0, geometry: groupedGeometry(positions, indices, []) };
  }
  if (solid) {
    const tagged = solid.asOriginal();
    const cutter0 = planeCutter(mf, tagged, plane);
    const cutter = cutter0.asOriginal();
    cutter0.delete();
    const kept = tagged.subtract(cutter);
    const mesh = kept.getMesh();
    const n = mesh.vertProperties.length / mesh.numProp;
    const pos = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) pos[v * 3 + k] = mesh.vertProperties[v * mesh.numProp + k] ?? 0;
    const capTris: number[] = [];
    const bodyTris: number[] = [];
    const cutterId = cutter.originalID();
    for (let r = 0; r < mesh.runOriginalID.length; r++) {
      const s = mesh.runIndex[r] ?? 0;
      const e = mesh.runIndex[r + 1] ?? mesh.triVerts.length;
      const dst = mesh.runOriginalID[r] === cutterId ? capTris : bodyTris;
      for (let i = s; i < e; i++) dst.push(mesh.triVerts[i]!);
    }
    const all = new Uint32Array([...bodyTris, ...capTris]);
    const capIdx = all.subarray(bodyTris.length);
    const result: StillCutResult = {
      method: "manifold",
      bodyVolume: solid.volume(),
      volume: kept.volume(),
      capArea: meshArea(pos, capIdx),
      geometry: groupedGeometry(pos, all, [[bodyTris.length, capTris.length]]),
    };
    for (const m of [solid, tagged, cutter, kept]) m.delete();
    return result;
  }
  return { method: "clip", bodyVolume: null, volume: null, capArea: 0, geometry: clipTriangles(positions, indices, plane) };
}

/** Non-indexed geometry with creased normals; `capRanges` ([start, count] in indices) become group 1. */
function groupedGeometry(positions: Float32Array, indices: Uint32Array, capRanges: [number, number][]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  flat.clearGroups();
  const caps = [...capRanges].sort((a, b) => a[0] - b[0]);
  let at = 0;
  for (const [start, count] of caps) {
    if (start > at) flat.addGroup(at, start - at, 0);
    if (count > 0) flat.addGroup(start, count, 1);
    at = start + count;
  }
  if (at < indices.length) flat.addGroup(at, indices.length - at, 0);
  g.dispose();
  return flat;
}

/** Clips an open triangle surface to `plane.distanceToPoint >= 0` (Sutherland-Hodgman per triangle). */
export function clipTriangles(positions: Float32Array, indices: Uint32Array, plane: THREE.Plane): THREE.BufferGeometry {
  const out: number[] = [];
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) v[k]!.fromArray(positions, indices[t + k]! * 3);
    const d = v.map((x) => plane.distanceToPoint(x));
    const poly: THREE.Vector3[] = [];
    for (let k = 0; k < 3; k++) {
      const a = v[k]!, b = v[(k + 1) % 3]!;
      const da = d[k]!, db = d[(k + 1) % 3]!;
      if (da >= 0) poly.push(a.clone());
      if ((da >= 0) !== (db >= 0)) poly.push(a.clone().lerp(b, da / (da - db)));
    }
    for (let k = 1; k + 1 < poly.length; k++) out.push(...poly[0]!.toArray(), ...poly[k]!.toArray(), ...poly[k + 1]!.toArray());
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  g.computeVertexNormals();
  g.addGroup(0, out.length / 3, 0);
  return g;
}

export interface StillCutReport {
  meshes: number;
  manifold: number;
  clip: number;
  kept: number;
  dropped: number;
  /** Per part: summed closed volumes before and after the cut (manifold meshes only), and cap area. */
  parts: Record<string, { bodyVolume: number; volume: number; capArea: number; meshes: number; method: string[] }>;
}

/**
 * Builds the cut copy of every visible mesh under `root` (world space) for a
 * still: a new group holding one mesh per cut, with `[surface material,
 * cap material]`. `partOf` names the part a mesh belongs to (report keys).
 * The source scene is untouched; hide it while the copy renders.
 */
export function cutObjectForStill(
  mf: ManifoldToplevel,
  root: THREE.Object3D,
  plane: THREE.Plane,
  cap: THREE.Material,
  partOf: (m: THREE.Mesh) => string | null = () => null,
  accept: (m: THREE.Mesh) => boolean = () => true,
): { group: THREE.Group; report: StillCutReport } {
  root.updateWorldMatrix(true, true);
  const group = new THREE.Group();
  group.name = "rw-section-still";
  const report: StillCutReport = { meshes: 0, manifold: 0, clip: 0, kept: 0, dropped: 0, parts: {} };
  const visibleChain = (o: THREE.Object3D) => {
    for (let x: THREE.Object3D | null = o; x; x = x.parent) if (!x.visible) return false;
    return true;
  };
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o.userData["rwSectionWriter"] === true || o.userData["rwSectionCap"] === true) return;
    const mat = o.material as THREE.Material | THREE.Material[];
    const shown = Array.isArray(mat) ? mat.some((m) => m.visible) : mat.visible;
    if (!shown || !visibleChain(o) || !accept(o)) return;
    meshes.push(o);
  });
  for (const m of meshes) {
    report.meshes++;
    const r = cutMeshForStill(mf, m.geometry as THREE.BufferGeometry, m.matrixWorld, plane);
    report[r.method]++;
    const id = partOf(m);
    if (id !== null) {
      const row = (report.parts[id] ??= { bodyVolume: 0, volume: 0, capArea: 0, meshes: 0, method: [] });
      row.meshes++;
      row.method.push(r.method);
      if (r.bodyVolume !== null && r.volume !== null) {
        row.bodyVolume += r.bodyVolume;
        row.volume += r.volume;
      }
      row.capArea += r.capArea;
    }
    if (!r.geometry) continue;
    const surface = Array.isArray(m.material) ? m.material[0]! : m.material;
    const copy = new THREE.Mesh(r.geometry, [surface, cap]);
    copy.castShadow = m.castShadow;
    copy.receiveShadow = m.receiveShadow;
    copy.renderOrder = m.renderOrder;
    copy.userData["rwPart"] = id;
    copy.userData["rwStillCut"] = r.method;
    group.add(copy);
  }
  return { group, report };
}
