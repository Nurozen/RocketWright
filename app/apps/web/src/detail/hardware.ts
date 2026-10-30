/**
 * Bay hardware (RL5): threaded rods, hex nuts, eyebolts, machined end caps,
 * the clear recovery bay assembly, and bevelled tubes, rings, and bulkheads.
 * Dimensions derive from the component (od, id, length, joint); fastener
 * sizes scale with the bay radius. Visual tier only (I13).
 */
import * as THREE from "three/webgpu";
import { chamferedPrism, merge, revolve, tubeProfile, type ProfilePoint } from "./bevel.ts";
import { dim } from "./dims.ts";
import { twistLockLugs } from "./fittings.ts";
import type { DetailContext, DetailResult, EvalComponent } from "./types.ts";


/** Hardware layout of a bay tube (shared by the bay and the parachute's shroud lines). */
export interface BayHardware {
  ro: number;
  ri: number;
  capLen: number;
  /** Inner faces of the fore and aft end plates. */
  foreFace: number;
  aftFace: number;
  /** Eyebolt eye centres (shroud lines meet the fore one). */
  foreEye: number;
  aftEye: number;
  rodR: number;
  /** Radius of the rod circle. */
  rodCircle: number;
  rodAngles: number[];
  plateT: number;
  eye: { ringR: number; wireR: number; shank: number; nutH: number; nutAf: number };
}

export function bayHardware(bay: EvalComponent): BayHardware {
  const ro = dim(bay, "od") / 2;
  const ri = dim(bay, "id") / 2 || ro * 0.96;
  const len = bay.x_aft - bay.x_fore;
  const capLen = Math.min(0.012, Math.max(0.005, 0.08 * len));
  const plateT = Math.min(0.003, 0.3 * capLen);
  const rodR = Math.max(0.0009, 0.058 * ri);
  const rodCircle = ri - 2.1 * rodR;
  const eye = { ringR: 0.11 * ri, wireR: 0.032 * ri, shank: 0.12 * ri, nutH: 0.09 * ri, nutAf: 0.26 * ri };
  const foreFace = bay.x_fore + capLen;
  const aftFace = bay.x_aft - capLen;
  const reach = eye.nutH + eye.shank + eye.ringR;
  return {
    ro,
    ri,
    capLen,
    foreFace,
    aftFace,
    foreEye: foreFace + reach,
    aftEye: aftFace - reach,
    rodR,
    rodCircle,
    rodAngles: [0, 1, 2, 3].map((k) => Math.PI / 4 + (k * Math.PI) / 2),
    plateT,
    eye,
  };
}

const at = (g: THREE.BufferGeometry, y: number, z: number): THREE.BufferGeometry => g.translate(0, y, z);

/** A threaded rod along +X at (y, z): rounded crests at `pitch`, chamfered ends. */
export function threadedRod(x0: number, x1: number, r: number, pitch: number, y: number, z: number, segments = 10): THREE.BufferGeometry {
  const depth = 0.32 * pitch;
  const rmin = r - depth;
  const c = Math.min(0.6 * pitch, 0.25 * (x1 - x0));
  const pts: ProfilePoint[] = [{ x: x0, r: 0 }, { x: x0, r: rmin - depth }, { x: x0 + c, r: rmin }];
  const half = pitch / 2;
  let k = 0;
  for (let x = x0 + c + half / 2; x < x1 - c; x += half, k++) pts.push({ x, r: k % 2 === 0 ? r : rmin });
  pts.push({ x: x1 - c, r: rmin }, { x: x1, r: rmin - depth }, { x: x1, r: 0 });
  return at(revolve(pts, { segments }), y, z);
}

/** A hex nut centred at station `xc` on the axis (y, z). */
export function hexNut(xc: number, h: number, af: number, bore: number, y: number, z: number): THREE.BufferGeometry {
  const rc = af / 2 / Math.cos(Math.PI / 6);
  return at(chamferedPrism(xc - h / 2, xc + h / 2, rc, 6, 0.18 * h, bore), y, z);
}

/**
 * An eyebolt standing on a plate face at station `x`, pointing `dir` (+1 aft,
 * -1 fore): hex nut, shank, and an eye whose plane contains the body axis.
 */
export function eyebolt(x: number, dir: 1 | -1, e: BayHardware["eye"], segments = 20): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(hexNut(x + (dir * e.nutH) / 2, e.nutH, e.nutAf, 0, 0, 0));
  const s0 = x + dir * e.nutH;
  const s1 = s0 + dir * e.shank;
  const shank = revolve(
    [
      { x: Math.min(s0, s1), r: 0 },
      { x: Math.min(s0, s1), r: e.wireR },
      { x: Math.max(s0, s1), r: e.wireR },
      { x: Math.max(s0, s1), r: 0 },
    ],
    { segments: 12 },
  );
  parts.push(shank);
  const ring = new THREE.TorusGeometry(e.ringR, e.wireR, 10, segments);
  // Torus lies in XY with its hole on Z: its plane already contains body +X.
  ring.translate(s1 + dir * (e.ringR - e.wireR * 0.5), 0, 0);
  parts.push(ring);
  return merge(parts);
}

/** Machined end cap of a bay: grooved outer ring plus the end plate. `end` -1 = fore, +1 = aft. */
export function bayEndCap(bay: EvalComponent, hw: BayHardware, end: -1 | 1, segments: number): { ring: THREE.BufferGeometry; plate: THREE.BufferGeometry } {
  const x0 = end < 0 ? bay.x_fore : bay.x_aft - hw.capLen;
  const x1 = end < 0 ? bay.x_fore + hw.capLen : bay.x_aft;
  const lipOut = hw.ro + Math.max(0.0005, 0.03 * hw.ro);
  const lipIn = hw.ri - Math.max(0.0012, 0.07 * hw.ri);
  const ring = tubeProfile({ x0, x1, ro: lipOut, ri: lipIn, bevel: 0.07 * hw.capLen, grooves: [0.32, 0.68], grooveDepth: 0.0005, grooveWidth: 0.00045, steps: 3 });
  const p0 = end < 0 ? x1 - hw.plateT : x0;
  const p1 = end < 0 ? x1 : x0 + hw.plateT;
  const plate = tubeProfile({ x0: p0, x1: p1, ro: lipIn + 0.0002, ri: 0, bevel: 0.25 * hw.plateT, steps: 2 });
  return {
    ring: revolve(ring.points, { segments, closed: ring.closed }),
    plate: revolve(plate.points, { segments, closed: plate.closed }),
  };
}

/**
 * The clear recovery bay: a glass tube (far and near walls drawn in order),
 * machined end caps with twist-lock lugs (`joint.count`), end plates,
 * eyebolts, and threaded rods with nuts. Contents (parachute, streamer) are
 * their own parts; this builds only the bay.
 */
export function clearBayDetail(ctx: DetailContext): DetailResult | null {
  const bay = ctx.component;
  if (dim(bay, "od") <= 0) return null;
  const hw = bayHardware(bay);
  const seg = ctx.segments;
  const group = new THREE.Group();
  const mats = ctx.materials;
  const machined = mats.finish("machined");

  // Glass: the tube's ends sit inside the caps.
  const tx0 = bay.x_fore + 0.45 * hw.capLen;
  const tx1 = bay.x_aft - 0.45 * hw.capLen;
  const tube = tubeProfile({ x0: tx0, x1: tx1, ro: hw.ro, ri: hw.ri, bevel: 0.4 * (hw.ro - hw.ri), steps: 2 });
  const glassGeom = revolve(tube.points, { segments: seg, closed: true });
  const back = new THREE.Mesh(glassGeom, mats.glass(ctx.look, true));
  back.name = "bay-glass-far";
  back.renderOrder = 1;
  back.castShadow = false;
  const front = new THREE.Mesh(glassGeom, mats.glass(ctx.look, false));
  front.name = "bay-glass-near";
  front.renderOrder = 2;
  front.castShadow = false;
  group.add(back, front);

  const outline: THREE.Mesh[] = [front];
  for (const end of [-1, 1] as const) {
    const cap = bayEndCap(bay, hw, end, seg);
    const ring = new THREE.Mesh(cap.ring, machined);
    ring.name = end < 0 ? "bay-cap-fore" : "bay-cap-aft";
    const plate = new THREE.Mesh(cap.plate, mats.finish("anodized_dark"));
    plate.name = end < 0 ? "bay-plate-fore" : "bay-plate-aft";
    group.add(ring, plate);
    outline.push(ring);
    const face = end < 0 ? hw.foreFace : hw.aftFace;
    const eye = new THREE.Mesh(eyebolt(face, end < 0 ? 1 : -1, hw.eye), machined);
    eye.name = end < 0 ? "bay-eyebolt-fore" : "bay-eyebolt-aft";
    group.add(eye);
    const count = bay.joint?.count ?? (bay.joint ? 3 : 0);
    if (count > 0) {
      const xc = end < 0 ? bay.x_fore + 0.5 * hw.capLen : bay.x_aft - 0.5 * hw.capLen;
      const lugs = new THREE.Mesh(twistLockLugs(xc, hw.ro + 0.03 * hw.ro, count, Math.PI / count + (end < 0 ? 0 : Math.PI / (2 * count)), hw.capLen), machined);
      lugs.name = "bay-twist-lugs";
      group.add(lugs);
    }
  }

  const rods: THREE.BufferGeometry[] = [];
  const nuts: THREE.BufferGeometry[] = [];
  const nutH = 1.6 * hw.rodR;
  for (const a of hw.rodAngles) {
    const y = hw.rodCircle * Math.cos(a);
    const z = hw.rodCircle * Math.sin(a);
    rods.push(threadedRod(hw.foreFace - hw.plateT, hw.aftFace + hw.plateT, hw.rodR, Math.max(0.0008, 0.9 * hw.rodR), y, z));
    nuts.push(hexNut(hw.foreFace + nutH / 2, nutH, 3.4 * hw.rodR, hw.rodR * 0.9, y, z));
    nuts.push(hexNut(hw.aftFace - nutH / 2, nutH, 3.4 * hw.rodR, hw.rodR * 0.9, y, z));
  }
  const rodMesh = new THREE.Mesh(merge(rods), mats.finish("thread"));
  rodMesh.name = "bay-threaded-rods";
  const nutMesh = new THREE.Mesh(merge(nuts), machined);
  nutMesh.name = "bay-nuts";
  group.add(rodMesh, nutMesh);
  return { group, outline };
}

/**
 * Bevelled tube for opaque body tubes, couplers, and inner tubes: rounded
 * lips on both ends, the bore in a liner finish so open ends read.
 */
export function bevelledTubeDetail(ctx: DetailContext): DetailResult | null {
  const c = ctx.component;
  const ro = dim(c, "od") / 2;
  const ri = dim(c, "id") / 2;
  if (!(ro > 0) || !(ri > 0) || ri >= ro) return null;
  const wall = ro - ri;
  const prof = tubeProfile({ x0: c.x_fore, x1: c.x_aft, ro, ri, bevel: 0.45 * wall, steps: 3 });
  const group = new THREE.Group();
  const shell = new THREE.Mesh(revolve(prof.points, { segments: ctx.segments, closed: true }), ctx.materials.look(ctx.look));
  shell.name = "tube-shell";
  // A liner just inside the bore (paper/composite inner wall), visible through open ends.
  const liner = new THREE.Mesh(
    revolve(
      [
        { x: c.x_aft - 0.2 * wall, r: ri - 0.0001 },
        { x: c.x_fore + 0.2 * wall, r: ri - 0.0001 },
      ],
      { segments: ctx.segments },
    ),
    ctx.materials.finish("liner"),
  );
  liner.name = "tube-liner";
  group.add(shell, liner);
  return { group, outline: [shell] };
}

/** Machined ring (centering rings): chamfered faces and one turned groove. */
export function ringDetail(ctx: DetailContext): DetailResult | null {
  const c = ctx.component;
  const ro = dim(c, "od") / 2;
  const ri = dim(c, "id") / 2;
  const len = c.x_aft - c.x_fore;
  if (!(ro > 0) || !(len > 0)) return null;
  const prof = tubeProfile({ x0: c.x_fore, x1: c.x_aft, ro, ri: Math.max(0, ri), bevel: Math.min(0.3 * len, 0.0008), grooves: len > 0.0025 ? [0.5] : [], grooveDepth: 0.0004, grooveWidth: 0.0003 });
  const group = new THREE.Group();
  const ring = new THREE.Mesh(revolve(prof.points, { segments: ctx.segments, closed: prof.closed }), ctx.materials.look(ctx.look));
  ring.name = "machined-ring";
  group.add(ring);
  return { group, outline: [ring] };
}

/** Bulkhead: chamfered disc with a forward-facing eyebolt for the shock cord. */
export function bulkheadDetail(ctx: DetailContext): DetailResult | null {
  const c = ctx.component;
  const parent = c.parent ? ctx.lookup(c.parent) : undefined;
  const ro = dim(c, "od") / 2 || (parent ? dim(parent, "id") / 2 : 0);
  const len = c.x_aft - c.x_fore;
  if (!(ro > 0) || !(len > 0)) return null;
  const prof = tubeProfile({ x0: c.x_fore, x1: c.x_aft, ro, ri: 0, bevel: Math.min(0.35 * len, 0.0008) });
  const group = new THREE.Group();
  const disc = new THREE.Mesh(revolve(prof.points, { segments: ctx.segments, closed: prof.closed }), ctx.materials.look(ctx.look));
  disc.name = "bulkhead-disc";
  const e = { ringR: 0.11 * ro, wireR: 0.032 * ro, shank: 0.12 * ro, nutH: 0.09 * ro, nutAf: 0.26 * ro };
  const eye = new THREE.Mesh(eyebolt(c.x_fore, -1, e), ctx.materials.finish("machined"));
  eye.name = "bulkhead-eyebolt";
  group.add(disc, eye);
  return { group, outline: [disc] };
}
