/**
 * Fittings (RL5): twist-lock lugs, the motor casing with its closures,
 * retainer, and nozzle, and the roll-frame helper builders use to face
 * details toward the viewer. Visual tier only (I13).
 */
import * as THREE from "three/webgpu";
import { merge, revolve, roundedBox, tubeProfile, type ProfilePoint } from "./bevel.ts";
import { dim } from "./dims.ts";
import type { DetailContext, DetailResult, Vec3 } from "./types.ts";

/** Body-frame basis at roll `phi` (from +Y toward +Z): axial, radial, tangential (right-handed). */
export function rollBasis(phi: number): { axial: THREE.Vector3; radial: THREE.Vector3; tangent: THREE.Vector3 } {
  return {
    axial: new THREE.Vector3(1, 0, 0),
    radial: new THREE.Vector3(0, Math.cos(phi), Math.sin(phi)),
    tangent: new THREE.Vector3(0, -Math.sin(phi), Math.cos(phi)),
  };
}

/** Roll angle that faces a body-frame direction (its Y/Z part). */
export function rollToward(v: Vec3): number {
  return Math.atan2(v[2], v[1]);
}

/** Places geometry built in a local (axial, radial, tangent) frame at roll `phi`, offset `radius` outward. */
export function placeAtRoll(g: THREE.BufferGeometry, phi: number, radius: number, x = 0): THREE.BufferGeometry {
  const b = rollBasis(phi);
  const m = new THREE.Matrix4().makeBasis(b.axial, b.radial, b.tangent);
  m.setPosition(b.radial.clone().multiplyScalar(radius).add(new THREE.Vector3(x, 0, 0)));
  return g.applyMatrix4(m);
}

/** `count` twist-lock lugs (rounded blocks) around station `xc` at radius `r`, starting at roll `phase`. */
export function twistLockLugs(xc: number, r: number, count: number, phase: number, capLen: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const h = Math.max(0.0007, 0.04 * r);
  for (let k = 0; k < count; k++) {
    const g = roundedBox(0.55 * capLen, 2 * h, 0.16 * r, 0.45 * h, 2);
    parts.push(placeAtRoll(g, phase + (2 * Math.PI * k) / count, r + 0.5 * h, xc));
  }
  return merge(parts);
}

/**
 * Motor casing (inner tube with `motor_mount`): turned aluminium case with
 * thread reliefs, a dark forward closure, an aft retainer ring, and a
 * graphite nozzle protruding aft.
 */
export function motorCasingDetail(ctx: DetailContext): DetailResult | null {
  const c = ctx.component;
  const ro = dim(c, "od") / 2;
  const len = c.x_aft - c.x_fore;
  if (!(ro > 0) || !(len > 0)) return null;
  const seg = ctx.segments;
  const group = new THREE.Group();
  const caseProf = tubeProfile({ x0: c.x_fore, x1: c.x_aft, ro, ri: 0.9 * ro, bevel: 0.04 * ro, grooves: [0.06, 0.09, 0.91, 0.94], grooveDepth: 0.00035, grooveWidth: 0.0003 });
  const shell = new THREE.Mesh(revolve(caseProf.points, { segments: seg, closed: true }), ctx.materials.look(ctx.look));
  shell.name = "motor-case";
  const cl = Math.min(0.08 * len, 1.4 * ro);
  const fore = tubeProfile({ x0: c.x_fore - 0.15 * cl, x1: c.x_fore + 0.6 * cl, ro: 0.97 * ro, ri: 0, bevel: 0.18 * cl });
  const foreCap = new THREE.Mesh(revolve(fore.points, { segments: seg, closed: fore.closed }), ctx.materials.finish("anodized_dark"));
  foreCap.name = "motor-forward-closure";
  const ret = tubeProfile({ x0: c.x_aft - 0.9 * cl, x1: c.x_aft + 0.1 * cl, ro: 1.1 * ro, ri: 0.72 * ro, bevel: 0.08 * ro, grooves: [0.3, 0.55, 0.8], grooveDepth: 0.0003, grooveWidth: 0.00028 });
  const retainer = new THREE.Mesh(revolve(ret.points, { segments: seg, closed: true }), ctx.materials.finish("anodized_dark"));
  retainer.name = "motor-retainer";
  const nl = 0.9 * cl;
  const nozzleProf: ProfilePoint[] = [
    { x: c.x_aft - 0.2 * cl, r: 0.74 * ro },
    { x: c.x_aft + 0.35 * nl, r: 0.7 * ro },
    { x: c.x_aft + nl, r: 0.62 * ro },
    { x: c.x_aft + nl, r: 0.5 * ro, crease: true },
    { x: c.x_aft + 0.3 * nl, r: 0.22 * ro, crease: true },
    { x: c.x_aft - 0.1 * cl, r: 0.22 * ro },
  ];
  const nozzle = new THREE.Mesh(revolve(nozzleProf, { segments: seg, closed: true }), ctx.materials.finish("graphite"));
  nozzle.name = "motor-nozzle";
  group.add(shell, foreCap, retainer, nozzle);
  return { group, outline: [shell, retainer] };
}
