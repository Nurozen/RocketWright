/**
 * Stowed recovery fabric (RL5): a folded parachute bundle with shroud lines
 * running to the bay's fore eyebolt, and a rolled streamer. Procedural and
 * deterministic (no randomness: the same component always folds the same).
 * Visual tier only (I13): the packed size comes from the component's
 * `packed_length`/`packed_diameter`, nothing here feeds mass.
 */
import * as THREE from "three/webgpu";
import { gridSurface } from "./bevel.ts";
import { dim } from "./dims.ts";
import { bayHardware } from "./hardware.ts";
import type { DetailContext, DetailResult } from "./types.ts";

export interface BundleOptions {
  /** Fore and aft stations of the packed bundle (m). */
  x0: number;
  x1: number;
  /** Packed radius (m). */
  radius: number;
  /** Folded gores showing on the outside. */
  lobes: number;
  /** Lobe twist over the bundle length (rad). */
  twist: number;
  /** Lobe depth as a fraction of the radius. */
  depth: number;
  /** Axial fractions where a fold crosses the bundle (shallow waists). */
  folds: readonly number[];
  /** End roundness exponent (2 = spherical caps, larger = flatter ends). */
  endPower: number;
  /** Phase (rad) so neighbouring bundles do not fold alike. */
  phase?: number;
  nu?: number;
  nv?: number;
}

/** Radius of the bundle surface at axial fraction `u` (0..1) and roll `phi`. */
export function bundleRadius(o: BundleOptions, u: number, phi: number): number {
  const p = o.endPower;
  const e = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(2 * u - 1), p)), 1 / p);
  const a = (o.lobes / 2) * (phi + o.twist * u + (o.phase ?? 0));
  const lobe = Math.pow(Math.abs(Math.cos(a)), 0.55);
  let waist = 1;
  for (const f of o.folds) waist -= 0.11 * Math.exp(-(((u - f) / 0.045) ** 2));
  // Small creases across the gores (fabric wrinkles), fading toward the ends.
  const wrinkle = 0.022 * Math.sin(3 * o.lobes * phi + 11 * u + 1.3) * Math.sin(Math.PI * u);
  return o.radius * e * waist * (1 - o.depth + o.depth * lobe + wrinkle);
}

/** The folded bundle as one smooth indexed surface with per-vertex shade (deep folds darker). */
export function bundleGeometry(o: BundleOptions): THREE.BufferGeometry {
  const nu = o.nu ?? 72;
  const nv = o.nv ?? 96;
  const g = gridSurface(
    nu,
    nv,
    (i, j, out) => {
      const u = i / nu;
      const phi = (2 * Math.PI * j) / nv;
      const r = bundleRadius(o, u, phi);
      out.set(o.x0 + u * (o.x1 - o.x0), r * Math.cos(phi), r * Math.sin(phi));
    },
    true,
  );
  // Ambient-occlusion-like shade: radius relative to the local envelope.
  const pos = g.getAttribute("position");
  const col = new Float32Array(pos.count * 3);
  const cols = nv;
  for (let i = 0; i <= nu; i++) {
    const u = i / nu;
    let max = 1e-9;
    for (let j = 0; j < cols; j++) max = Math.max(max, bundleRadius(o, u, (2 * Math.PI * j) / nv));
    for (let j = 0; j < cols; j++) {
      const r = bundleRadius(o, u, (2 * Math.PI * j) / nv);
      const t = Math.min(1, Math.max(0, r / max));
      const s = 0.3 + 0.7 * t * t * t;
      const k = 3 * (i * cols + j);
      col[k] = s;
      col[k + 1] = s;
      col[k + 2] = s;
    }
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}

/** A closed tie band hugging the bundle at axial fraction `u` (a wrap of shroud line). */
function tieCurve(o: BundleOptions, u: number, lift: number): THREE.CatmullRomCurve3 {
  const pts: THREE.Vector3[] = [];
  const n = 48;
  for (let j = 0; j < n; j++) {
    const phi = (2 * Math.PI * j) / n;
    const r = bundleRadius(o, u, phi) + lift;
    pts.push(new THREE.Vector3(o.x0 + u * (o.x1 - o.x0), r * Math.cos(phi), r * Math.sin(phi)));
  }
  return new THREE.CatmullRomCurve3(pts, true, "centripetal");
}

/** Shroud lines: from points around the bundle's fore shoulder, converging on `to` (the eyebolt). */
function lineCurves(o: BundleOptions, count: number, to: THREE.Vector3): THREE.CatmullRomCurve3[] {
  const out: THREE.CatmullRomCurve3[] = [];
  for (let k = 0; k < count; k++) {
    const phi = (2 * Math.PI * (k + 0.5)) / count;
    const u0 = 0.16;
    const r0 = bundleRadius(o, u0, phi) + 0.0004;
    const a = new THREE.Vector3(o.x0 + u0 * (o.x1 - o.x0), r0 * Math.cos(phi), r0 * Math.sin(phi));
    const r1 = 0.55 * r0;
    const b = new THREE.Vector3(o.x0 - 0.25 * (o.x0 - to.x), r1 * Math.cos(phi + 0.35), r1 * Math.sin(phi + 0.35));
    out.push(new THREE.CatmullRomCurve3([a, b, to.clone()], false, "centripetal"));
  }
  return out;
}

/** Folded parachute in its bay: bundle, two line wraps, and shroud lines to the fore eyebolt. */
export function parachuteDetail(ctx: DetailContext): DetailResult | null {
  const c = ctx.component;
  const len = dim(c, "packed_length") || c.x_aft - c.x_fore;
  const dia = dim(c, "packed_diameter");
  if (!(len > 0) || !(dia > 0)) return null;
  const x0 = c.x_fore;
  const x1 = c.x_fore + len;
  const bay = c.parent ? ctx.lookup(c.parent) : undefined;
  const hw = bay && bay.shape.type === "body_tube" && bay.shape.od > 0 ? bayHardware(bay) : null;
  // Visual only: the bundle shrinks to clear the bay's rod cage when the packed size would not fit.
  const radius = hw ? Math.min(dia / 2, (hw.rodCircle - hw.rodR - 0.0006) / 1.03) : dia / 2;
  const o: BundleOptions = { x0, x1, radius, lobes: 4, twist: 2.0, depth: 0.34, folds: [0.38, 0.7], endPower: 2.6, phase: 0.4 };
  const group = new THREE.Group();
  const fabric = new THREE.Mesh(bundleGeometry(o), ctx.materials.vertexColored("fabric"));
  fabric.name = "chute-bundle";
  group.add(fabric);
  const lineMat = ctx.materials.finish("line");
  const lineR = Math.max(0.00028, radius * 0.024);
  for (const u of [0.3, 0.66]) {
    const tie = new THREE.Mesh(new THREE.TubeGeometry(tieCurve(o, u, lineR * 0.4), 96, 0.6 * lineR, 6, true), lineMat);
    tie.name = "chute-tie";
    group.add(tie);
  }
  const eye = new THREE.Vector3(hw ? hw.foreEye : x0 - 0.008, 0, 0);
  const count = Math.max(3, Math.min(12, Math.round(dim(c, "line_count")) || 6));
  for (const curve of lineCurves(o, count, eye)) {
    const line = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, lineR * 0.85, 5, false), lineMat);
    line.name = "shroud-line";
    group.add(line);
  }
  return { group, outline: [fabric] };
}

/** Rolled streamer: a short, flat-ended roll with a few shallow folds. */
export function streamerDetail(ctx: DetailContext): DetailResult | null {
  const c = ctx.component;
  const len = dim(c, "packed_length") || c.x_aft - c.x_fore;
  const dia = dim(c, "packed_diameter");
  if (!(len > 0) || !(dia > 0)) return null;
  const o: BundleOptions = { x0: c.x_fore, x1: c.x_fore + len, radius: dia / 2, lobes: 3, twist: 0.5, depth: 0.1, folds: [0.5], endPower: 5, phase: 1.7, nu: 40 };
  const group = new THREE.Group();
  const roll = new THREE.Mesh(bundleGeometry(o), ctx.materials.vertexColored("fabric_shade"));
  roll.name = "streamer-roll";
  group.add(roll);
  return { group, outline: [roll] };
}
