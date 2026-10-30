/**
 * Bevel and normal helpers for detail geometry (RL5). Every primitive the
 * detail pipeline emits goes through here, so it has rounded (filleted)
 * edges and smooth normals except at deliberate machined creases.
 *
 * - Revolved parts: a profile in the (x, r) half-plane (x = body station,
 *   r = radius), walked so the solid lies on the walker's right (outer
 *   surface fore -> aft, aft face outward -> inward, bore aft -> fore, fore
 *   face inward -> outward). `revolve` spins it about body +X (phi from +Y
 *   toward +Z, the IF2 roll convention) with outward normals.
 * - `filletPolyline` rounds corners; `crease: true` keeps a hard edge.
 * - `gridSurface` is the shared parametric mesher (seam vertices shared, so
 *   wrapped surfaces shade smoothly across the seam).
 */
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries, toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import * as THREE from "three/webgpu";

export interface ProfilePoint {
  x: number;
  r: number;
  /** Split normals here (a hard edge). */
  crease?: boolean;
}

type P2 = readonly [number, number];

/**
 * Replaces each interior corner of `points` (x, r) with a circular fillet of
 * `radius` (per corner or one value; 0 keeps the corner sharp) in `steps`
 * segments. The fillet shrinks to fit when the adjacent edges are short.
 * With `closed`, the first and last points are corners too.
 */
export function filletPolyline(points: readonly P2[], radius: number | readonly number[], steps = 3, closed = false): ProfilePoint[] {
  const n = points.length;
  const out: ProfilePoint[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const isEnd = !closed && (i === 0 || i === n - 1);
    const rad = typeof radius === "number" ? radius : (radius[i] ?? 0);
    if (isEnd || rad <= 0) {
      out.push({ x: p[0], r: p[1], crease: rad <= 0 && !isEnd });
      continue;
    }
    const a = points[(i - 1 + n) % n]!;
    const b = points[(i + 1) % n]!;
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]);
    const lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    if (la < 1e-12 || lb < 1e-12) {
      out.push({ x: p[0], r: p[1] });
      continue;
    }
    const u: P2 = [(a[0] - p[0]) / la, (a[1] - p[1]) / la];
    const v: P2 = [(b[0] - p[0]) / lb, (b[1] - p[1]) / lb];
    const cos = Math.min(1, Math.max(-1, u[0] * v[0] + u[1] * v[1]));
    const theta = Math.acos(cos);
    if (theta < 1e-3 || theta > Math.PI - 1e-3) {
      out.push({ x: p[0], r: p[1] });
      continue;
    }
    // Tangent distance for the requested radius, clamped to 45% of the shorter edge.
    let t = rad / Math.tan(theta / 2);
    const tMax = 0.45 * Math.min(la, lb);
    if (t > tMax) t = tMax;
    const r = t * Math.tan(theta / 2);
    const bis: P2 = [u[0] + v[0], u[1] + v[1]];
    const bl = Math.hypot(bis[0], bis[1]);
    const c: P2 = [p[0] + (bis[0] / bl) * (r / Math.sin(theta / 2)), p[1] + (bis[1] / bl) * (r / Math.sin(theta / 2))];
    const t1: P2 = [p[0] + u[0] * t, p[1] + u[1] * t];
    const t2: P2 = [p[0] + v[0] * t, p[1] + v[1] * t];
    const a1 = Math.atan2(t1[1] - c[1], t1[0] - c[0]);
    let d = Math.atan2(t2[1] - c[1], t2[0] - c[0]) - a1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    for (let s = 0; s <= steps; s++) {
      const ang = a1 + (d * s) / steps;
      out.push({ x: c[0] + r * Math.cos(ang), r: Math.max(0, c[1] + r * Math.sin(ang)) });
    }
  }
  return out;
}

export interface TubeProfileOptions {
  /** Fore and aft stations (m). */
  x0: number;
  x1: number;
  /** Outer and inner radius (m); `ri = 0` is a solid disc. */
  ro: number;
  ri: number;
  /** Edge fillet radius (m). */
  bevel: number;
  /** Fillet segments per corner. */
  steps?: number;
  /** V-grooves on the outer surface: axial fractions (0..1) of the length. */
  grooves?: readonly number[];
  /** Groove depth and half-width (m). */
  grooveDepth?: number;
  grooveWidth?: number;
}

/**
 * Closed profile of a bevelled tube or ring (or a disc when `ri` is 0), with
 * optional machined V-grooves on the outer surface (hard-edged).
 */
export function tubeProfile(o: TubeProfileOptions): { points: ProfilePoint[]; closed: boolean } {
  const { x0, x1, ro, ri, bevel } = o;
  const steps = o.steps ?? 3;
  const outer: P2[] = [[x0, ro]];
  const radii: number[] = [bevel];
  const gd = o.grooveDepth ?? Math.min(0.15 * (ro - ri), 0.0006);
  const gw = o.grooveWidth ?? gd;
  for (const f of [...(o.grooves ?? [])].sort((a, b) => a - b)) {
    const xc = x0 + f * (x1 - x0);
    outer.push([xc - gw, ro], [xc, ro - gd], [xc + gw, ro]);
    radii.push(0, 0, 0);
  }
  outer.push([x1, ro]);
  radii.push(bevel);
  if (ri <= 1e-9) {
    const pts: P2[] = [[x0, 0], ...outer, [x1, 0]];
    return { points: filletPolyline(pts, [0, ...radii, 0], steps, false), closed: false };
  }
  const pts: P2[] = [...outer, [x1, ri], [x0, ri]];
  const bi = Math.min(bevel, 0.45 * (ro - ri));
  return { points: filletPolyline(pts, [...radii.map((r) => Math.min(r, 0.45 * (ro - ri)) || 0), bi, bi], steps, true), closed: true };
}

/**
 * Indexed parametric surface: `nu + 1` rows along u, `nv` (wrapped) or
 * `nv + 1` columns along v. Triangles wind so that, for u running fore -> aft
 * and v increasing roll, the normal points away from the axis.
 */
export function gridSurface(nu: number, nv: number, at: (i: number, j: number, out: THREE.Vector3) => void, wrapV: boolean): THREE.BufferGeometry {
  const cols = wrapV ? nv : nv + 1;
  const pos = new Float32Array((nu + 1) * cols * 3);
  const uv = new Float32Array((nu + 1) * cols * 2);
  const p = new THREE.Vector3();
  for (let i = 0; i <= nu; i++) {
    for (let j = 0; j < cols; j++) {
      at(i, j, p);
      const k = i * cols + j;
      pos[3 * k] = p.x;
      pos[3 * k + 1] = p.y;
      pos[3 * k + 2] = p.z;
      uv[2 * k] = j / nv;
      uv[2 * k + 1] = i / Math.max(1, nu);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const j1 = wrapV ? (j + 1) % nv : j + 1;
      const a = i * cols + j;
      const b = i * cols + j1;
      const c = (i + 1) * cols + j;
      const d = (i + 1) * cols + j1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export interface RevolveOptions {
  segments: number;
  /** Profile closes back on its first point. */
  closed?: boolean;
  /** Partial revolution (radians, from +Y toward +Z). Default full. */
  phiStart?: number;
  phiLength?: number;
}

/**
 * Revolves a profile about body +X. Runs between `crease` points shade
 * separately (hard machined edges); everything else is smooth.
 */
export function revolve(profile: readonly ProfilePoint[], o: RevolveOptions): THREE.BufferGeometry {
  const pts = o.closed ? [...profile, { ...profile[0]!, crease: profile[0]!.crease ?? false }] : [...profile];
  const full = o.phiLength === undefined || o.phiLength >= 2 * Math.PI - 1e-9;
  const phi0 = o.phiStart ?? 0;
  const dphi = full ? 2 * Math.PI : o.phiLength!;
  const runs: ProfilePoint[][] = [];
  let run: ProfilePoint[] = [];
  pts.forEach((p, k) => {
    run.push(p);
    if (p.crease && k > 0 && k < pts.length - 1) {
      runs.push(run);
      run = [p];
    }
  });
  if (run.length > 1) runs.push(run);
  const geoms = runs
    .filter((r) => r.length > 1)
    .map((r) =>
      gridSurface(
        r.length - 1,
        o.segments,
        (i, j, out) => {
          const q = r[i]!;
          const phi = phi0 + (dphi * j) / o.segments;
          out.set(q.x, q.r * Math.cos(phi), q.r * Math.sin(phi));
        },
        full,
      ),
    );
  return merge(geoms);
}

/** Merges geometries (position/normal/uv), dropping the index when they disagree. */
export function merge(geoms: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geoms.length === 1) return geoms[0]!;
  const indexed = geoms.every((g) => g.index !== null);
  const norm = geoms.map((g) => {
    const h = indexed ? g : g.index !== null ? g.toNonIndexed() : g;
    for (const name of Object.keys(h.attributes)) if (name !== "position" && name !== "normal" && name !== "uv") h.deleteAttribute(name);
    if (!h.getAttribute("uv")) h.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(h.getAttribute("position").count * 2), 2));
    return h;
  });
  const g = mergeGeometries(norm, false);
  if (!g) throw new Error("detail: geometry merge failed (attribute mismatch)");
  return g;
}

/** Flat facets where the dihedral angle exceeds `creaseDeg`, smooth elsewhere (machined parts). */
export function smoothNormals(g: THREE.BufferGeometry, creaseDeg = 40): THREE.BufferGeometry {
  return toCreasedNormals(g, (creaseDeg * Math.PI) / 180);
}

/** A box with rounded edges, centred on the origin (x, y, z sizes in metres). */
export function roundedBox(x: number, y: number, z: number, radius: number, segments = 2): THREE.BufferGeometry {
  const r = Math.min(radius, 0.49 * Math.min(x, y, z));
  return new RoundedBoxGeometry(x, y, z, segments, r);
}

/** A prism with `sides` flat faces about +X (hex nuts, bolt heads), chamfered on both ends. */
export function chamferedPrism(x0: number, x1: number, r: number, sides: number, chamfer: number, bore = 0): THREE.BufferGeometry {
  const c = Math.min(chamfer, 0.3 * (x1 - x0), 0.3 * r);
  const outer: P2[] = [
    [x0, r - c],
    [x0 + c, r],
    [x1 - c, r],
    [x1, r - c],
  ];
  const pts: P2[] = bore > 0 ? [...outer, [x1, bore], [x0, bore]] : [[x0, 0], ...outer, [x1, 0]];
  const prof: ProfilePoint[] = pts.map(([x, rr]) => ({ x, r: rr, crease: true }));
  // Offset by half a facet so a flat faces +Y.
  const g = revolve(prof, { segments: sides, closed: bore > 0, phiStart: Math.PI / sides });
  return smoothNormals(g, 20);
}

/** Count of triangles in a geometry. */
export function triangleCount(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.getAttribute("position").count) / 3;
}
