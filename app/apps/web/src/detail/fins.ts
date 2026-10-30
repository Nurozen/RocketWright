/**
 * Fin plates with real thickness and rounded edges (BC5 fidelity): the
 * rw-geom plate is a sharp-edged extrusion that reads as a zero-thickness
 * card at page 01 scale. This rebuilds each fin from the evaluated planform
 * (trapezoidal fin sets) at the fin's own thickness, with the leading,
 * trailing, and tip edges rounded per `cross_section` (rounded: a full
 * half-round; square: a small bevel; airfoil: a full round, slightly larger
 * than square), so the edge catches a highlight line and the faces a soft
 * gradient. The root runs a little into the body tube so no seam shows.
 *
 * Visual tier only (I13): the planform and thickness are the model's; the
 * edge rounding never feeds mass or aero.
 */
import * as THREE from "three/webgpu";
import { dim } from "./dims.ts";
import { placeAtRoll } from "./fittings.ts";
import type { DetailContext, DetailResult, EvalComponent } from "./types.ts";

type P2 = readonly [number, number];

/** Signed area (CCW positive). */
export function polygonArea(poly: readonly P2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Outward unit normal of edge p -> q of a CCW polygon. */
function edgeNormal(p: P2, q: P2): [number, number] {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dy / l, -dx / l];
}

/**
 * Insets a convex CCW polygon by `d` (each edge moved inward, neighbours
 * intersected). Parallel neighbours keep the moved vertex.
 */
export function insetConvex(poly: readonly P2[], d: number): [number, number][] {
  const n = poly.length;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a0 = poly[(i - 1 + n) % n]!;
    const a1 = poly[i]!;
    const b1 = poly[(i + 1) % n]!;
    const na = edgeNormal(a0, a1);
    const nb = edgeNormal(a1, b1);
    // Lines: (p - a1 + na d) . na = 0 and (p - a1 + nb d) . nb = 0, i.e. p . n = a1 . n - d.
    const ca = a1[0] * na[0] + a1[1] * na[1] - d;
    const cb = a1[0] * nb[0] + a1[1] * nb[1] - d;
    const det = na[0] * nb[1] - na[1] * nb[0];
    if (Math.abs(det) < 1e-9) out.push([a1[0] - na[0] * d, a1[1] - na[1] * d]);
    else out.push([(ca * nb[1] - cb * na[1]) / det, (na[0] * cb - nb[0] * ca) / det]);
  }
  return out;
}

export interface RoundedPlateOptions {
  /** Plate thickness (local z). */
  thickness: number;
  /** Edge radius (clamped to half the thickness). */
  radius: number;
  /** Segments across the edge (half-round) and around each corner. */
  edgeSegments?: number;
  cornerSegments?: number;
}

/**
 * A plate of a convex CCW polygon (local x, y), `thickness` along local z
 * centred on z = 0, with its rim rounded at `radius`. Smooth normals around
 * the rim, flat faces. The polygon is the plate's outer silhouette.
 */
export function roundedPlate(poly: readonly P2[], o: RoundedPlateOptions): THREE.BufferGeometry {
  const ccw = polygonArea(poly) < 0 ? [...poly].reverse() : [...poly];
  const t = Math.max(1e-6, o.thickness);
  const r = Math.min(Math.max(0, o.radius), t / 2);
  const flat = t / 2 - r;
  const es = Math.max(2, o.edgeSegments ?? 6);
  const cs = Math.max(1, o.cornerSegments ?? 4);
  const inner = insetConvex(ccw, r);
  const n = inner.length;
  // Spine: inset vertices with their outward normals; each corner fans from the incoming to the outgoing edge normal.
  const spine: { p: [number, number]; n: [number, number] }[] = [];
  for (let i = 0; i < n; i++) {
    const na = edgeNormal(ccw[(i - 1 + n) % n]!, ccw[i]!);
    const nb = edgeNormal(ccw[i]!, ccw[(i + 1) % n]!);
    const a0 = Math.atan2(na[1], na[0]);
    let a1 = Math.atan2(nb[1], nb[0]);
    while (a1 < a0) a1 += 2 * Math.PI;
    if (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
    for (let k = 0; k <= cs; k++) {
      const a = a0 + ((a1 - a0) * k) / cs;
      spine.push({ p: inner[i]!, n: [Math.cos(a), Math.sin(a)] });
    }
  }
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  // Rim rings from the bottom face (theta -90 deg) round the edge to the top face (+90 deg), split at the flat band.
  const thetas: { th: number; z0: number }[] = [];
  for (let k = 0; k <= es; k++) thetas.push({ th: -Math.PI / 2 + (Math.PI * k) / es, z0: k <= es / 2 ? -flat : flat });
  if (flat > 1e-9) thetas.splice(Math.floor(es / 2) + 1, 0, { th: thetas[Math.floor(es / 2)]!.th, z0: flat });
  const m = spine.length;
  for (const { th, z0 } of thetas) {
    for (const s of spine) {
      const c = Math.cos(th);
      pos.push(s.p[0] + s.n[0] * r * c, s.p[1] + s.n[1] * r * c, z0 + r * Math.sin(th));
      nrm.push(s.n[0] * c, s.n[1] * c, Math.sin(th));
    }
  }
  for (let k = 0; k + 1 < thetas.length; k++)
    for (let j = 0; j < m; j++) {
      const a = k * m + j;
      const b = k * m + ((j + 1) % m);
      const c = (k + 1) * m + j;
      const d = (k + 1) * m + ((j + 1) % m);
      idx.push(a, b, d, a, d, c);
    }
  // Faces: fans over the inset polygon (convex).
  for (const [z, s] of [
    [t / 2, 1],
    [-t / 2, -1],
  ] as const) {
    const base = pos.length / 3;
    for (const p of inner) {
      pos.push(p[0], p[1], z);
      nrm.push(0, 0, s);
    }
    for (let i = 1; i + 1 < n; i++) {
      if (s > 0) idx.push(base, base + i, base + i + 1);
      else idx.push(base, base + i + 1, base + i);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

/** Edge radius for a fin cross-section (fraction of the thickness). */
export function edgeRadius(crossSection: string | undefined, thickness: number): number {
  switch (crossSection) {
    case "rounded":
    case "airfoil":
      return thickness / 2;
    default:
      return 0.25 * thickness;
  }
}

/** Root radius of a fin set: its `root_le` anchor, else the parent body's outer radius. */
export function finRootRadius(c: EvalComponent, lookup: (id: string) => EvalComponent | undefined): number {
  const a = c.anchors?.find((x) => x.name === "root_le");
  if (a && a.r > 0) return a.r;
  const p = c.parent ? lookup(c.parent) : undefined;
  return p ? dim(p, "od") / 2 : 0;
}

/**
 * Trapezoidal fin sets: one rounded plate per instance, standing on the body
 * at the instance roll. Null (the rw-geom plates stay) for canted fins and
 * other planforms.
 */
export function finSetDetail(ctx: DetailContext): DetailResult | null {
  const c = ctx.component;
  if (c.shape.type !== "trapezoidal_fin_set") return null;
  const root = dim(c, "root_chord");
  const tip = dim(c, "tip_chord");
  const span = dim(c, "span");
  const sweep = dim(c, "sweep");
  const t = dim(c, "thickness");
  const cant = dim(c, "cant");
  const r0 = finRootRadius(c, ctx.lookup);
  if (!(root > 0) || !(span > 0) || !(t > 0) || !(r0 > 0) || Math.abs(cant) > 1e-9) return null;
  // The root edge sinks into the tube wall so no seam or rounded root shows.
  const sink = Math.min(0.3 * r0, 0.004);
  const poly: P2[] = [
    [0, -sink],
    [root, -sink],
    [sweep + tip, span],
    [sweep, span],
  ];
  const plate = roundedPlate(poly, { thickness: t, radius: edgeRadius((c.shape as unknown as { cross_section?: string }).cross_section, t), edgeSegments: 8, cornerSegments: 5 });
  const instances = c.instances.length > 0 ? c.instances : [{ roll: c.roll, index: 0, offset: [0, 0, 0] }];
  const group = new THREE.Group();
  const mat = ctx.materials.look(ctx.look);
  const meshes: THREE.Mesh[] = [];
  for (const inst of instances) {
    const g = placeAtRoll(plate.clone(), inst.roll, r0, c.x_fore);
    const off = inst.offset ?? [0, 0, 0];
    g.translate(off[0] ?? 0, off[1] ?? 0, off[2] ?? 0);
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = `fin-plate-${inst.index ?? meshes.length}`;
    group.add(mesh);
    meshes.push(mesh);
  }
  plate.dispose();
  return { group, outline: meshes };
}
