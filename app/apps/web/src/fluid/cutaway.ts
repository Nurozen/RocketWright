/**
 * Page 06 cutaway hardware (M5.3, FID-06): the vehicle shell with its ring
 * frames, tank skirts, and aft bulkhead; the clear tank; the plumbed feed
 * line (outlet boss, valve cluster, and the engine-inlet flange on the aft
 * bulkhead, all on the line's path); and the engine (injector head,
 * chamber, brushed bell) bolted to the aft bulkhead. Concept 06 reads as a machined
 * half-section: every solid on the section plane is opened as a half with
 * capped wall-thickness cut faces (explicit cap geometry: the wall's
 * cross-section polygon, triangulated, on both cut planes), never a hollow
 * outline.
 *
 * Section: a wedge facing the camera (body -Y, the side the feed line's
 * dog-leg plane faces) is removed from every revolved part and the feed
 * line, so the outer skin still shows either side of the opening and both
 * cut faces turn toward the viewer. A revolved part is a profile in
 * (x axial, r) lathed about body +X (three's lathe angle phi: body
 * y = -r sin phi, z = r cos phi; body -Y is phi = pi / 2).
 *
 * Looks come from the page 01 presets (`viewport/materials.ts`,
 * `presets.ts`): brushed aluminium shell (circumferential anisotropy),
 * machined steel engine and plumbing, under the page 01 studio rig.
 * Visual tier only (I13).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- TSL node graphs are untyped at this level */
import * as TSL from "three/tsl";
import * as THREE from "three/webgpu";
import { PRESET_LOOKS, type PbrLook } from "../viewport/materials.ts";
import { ensureTangents, physicalMaterial } from "../viewport/presets.ts";
import type { CutawayLayout } from "./layout.ts";
import type { Vec3 } from "./tankSdf.ts";

type N = any;
const { float, mix, normalView, positionViewDirection, smoothstep, vec3 } = TSL as N;

/** A profile point: axial station (body x) and radius, metres. */
export type Pt = readonly [number, number];

/** A smooth run of the profile drawn with one material (consecutive chains share end points). */
export interface ProfileChain {
  pts: readonly Pt[];
  mat: THREE.Material;
}

/** The removed wedge: centre (lathe angle) and half angle. */
export const WEDGE = { centre: Math.PI / 2 + 0.12, half: THREE.MathUtils.degToRad(62) } as const;

/** The kept part's lathe angles. */
export const KEEP: { phi0: number; phi: number } = { phi0: WEDGE.centre + WEDGE.half, phi: 2 * Math.PI - 2 * WEDGE.half };

/** Body (y, z) of radius `r` at lathe angle `phi`. */
export const atPhi = (r: number, phi: number): [number, number] => [-r * Math.sin(phi), r * Math.cos(phi)];

/** The closed cross-section polygon of a chained profile (shared end points once). */
export function profilePolygon(chains: readonly ProfileChain[]): Pt[] {
  const out: Pt[] = [];
  for (const c of chains)
    for (const p of c.pts) {
      const last = out[out.length - 1];
      if (!last || Math.abs(last[0] - p[0]) > 1e-9 || Math.abs(last[1] - p[1]) > 1e-9) out.push(p);
    }
  const first = out[0];
  const last = out[out.length - 1];
  if (first && last && out.length > 1 && Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) out.pop();
  return out;
}

/** Lathes a chain about body +X over `[phi0, phi0 + phi]`. */
export function latheX(pts: readonly Pt[], segments: number, phi0 = 0, phi = Math.PI * 2): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(
    pts.map(([x, r]) => new THREE.Vector2(Math.max(0, r), x)),
    segments,
    phi0,
    phi,
  );
  // Lathe axis (y) -> body +X: (x, y, z) -> (y, -x, z).
  g.rotateZ(-Math.PI / 2);
  return g;
}

/**
 * The two cut faces of a wedge section: the cross-section polygon on the
 * planes at lathe angles `KEEP.phi0` and `KEEP.phi0 + KEEP.phi` (double
 * sided material; normals face out of the kept solid).
 */
export function capGeometry(poly: readonly Pt[]): THREE.BufferGeometry {
  const contour = poly.map(([x, r]) => new THREE.Vector2(x, r));
  if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  const pos: number[] = [];
  for (const [phi, flip] of [
    [KEEP.phi0, false],
    [KEEP.phi0 + KEEP.phi, true],
  ] as const) {
    for (const t of tris) {
      const idx = flip ? [t[0]!, t[2]!, t[1]!] : [t[0]!, t[1]!, t[2]!];
      for (const i of idx) {
        const p = contour[i]!;
        const [y, z] = atPhi(p.y, phi);
        pos.push(p.x, y, z);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Adds a zero `uv` attribute (the physical node material reads one). */
export function withUv(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!g.getAttribute("uv")) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute("position").count * 2), 2));
  return g;
}

/** A revolved solid: whole (no caps) or the kept half with its cut faces. */
export function revolve(chains: readonly ProfileChain[], opts: { cut: boolean; capMat: THREE.Material; segments?: number }): THREE.Group {
  const g = new THREE.Group();
  const segs = opts.segments ?? 96;
  const [phi0, phi] = opts.cut ? [KEEP.phi0, KEEP.phi] : [0, Math.PI * 2];
  for (const c of chains) {
    if (c.pts.length < 2) continue;
    const geo = latheX(c.pts, opts.cut ? Math.ceil((segs * phi) / (2 * Math.PI)) : segs, phi0, phi);
    ensureTangents(geo);
    g.add(new THREE.Mesh(geo, c.mat));
  }
  if (opts.cut) g.add(new THREE.Mesh(withUv(capGeometry(profilePolygon(chains))), opts.capMat));
  return g;
}

/**
 * A pipe along a polyline in the plane y = 0: whole, or with the camera
 * wedge (centred on -Y) removed and its two cut strips. Frames: tangent t
 * in the xz plane, in-plane normal n = Y x t, ring = c + r (cos a n + sin a Y).
 */
export function pipe(points: readonly Vec3[], rOut: number, rIn: number, mats: { outer: THREE.Material; inner: THREE.Material; cap: THREE.Material }, cut: boolean, around = 32): THREE.Group {
  const group = new THREE.Group();
  const n = points.length;
  const frames = points.map((c, i) => {
    const a = points[Math.max(0, i - 1)]!;
    const b = points[Math.min(n - 1, i + 1)]!;
    const t = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
    const nrm = new THREE.Vector3(t.z, 0, -t.x).normalize();
    return { c: new THREE.Vector3(...c), n: nrm, b: new THREE.Vector3(0, 1, 0) };
  });
  const a0 = cut ? -Math.PI / 2 + WEDGE.half : 0;
  const span = cut ? 2 * Math.PI - 2 * WEDGE.half : Math.PI * 2;
  const surface = (r: number, inward: boolean) => {
    const pos: number[] = [];
    const nor: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const f = frames[i]!;
      for (let k = 0; k <= around; k++) {
        const ang = a0 + (span * k) / around;
        const d = f.n.clone().multiplyScalar(Math.cos(ang)).addScaledVector(f.b, Math.sin(ang));
        pos.push(f.c.x + d.x * r, f.c.y + d.y * r, f.c.z + d.z * r);
        const s = inward ? -1 : 1;
        nor.push(d.x * s, d.y * s, d.z * s);
      }
    }
    const row = around + 1;
    for (let i = 0; i + 1 < n; i++)
      for (let k = 0; k < around; k++) {
        const p = i * row + k;
        if (inward) idx.push(p, p + 1, p + row, p + 1, p + row + 1, p + row);
        else idx.push(p, p + row, p + 1, p + 1, p + row, p + row + 1);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    g.setIndex(idx);
    return withUv(g);
  };
  group.add(new THREE.Mesh(surface(rOut, false), mats.outer), new THREE.Mesh(surface(rIn, true), mats.inner));
  if (cut) {
    // The cut strips at both wedge edges, between the inner and outer wall.
    const pos: number[] = [];
    for (const edge of [a0, a0 + span])
      for (let i = 0; i + 1 < n; i++) {
        const f0 = frames[i]!;
        const f1 = frames[i + 1]!;
        const q = (f: (typeof frames)[number], r: number) =>
          f.c.clone().addScaledVector(f.n, Math.cos(edge) * r).addScaledVector(f.b, Math.sin(edge) * r);
        const a = q(f0, rIn);
        const b = q(f0, rOut);
        const c = q(f1, rOut);
        const d = q(f1, rIn);
        pos.push(...a.toArray(), ...b.toArray(), ...c.toArray(), ...a.toArray(), ...c.toArray(), ...d.toArray());
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    group.add(new THREE.Mesh(withUv(g), mats.cap));
  }
  return group;
}

/** The cutaway looks (page 01 presets, tuned for the section). */
export interface CutawayMaterials {
  shell: THREE.Material;
  shellInner: THREE.Material;
  frame: THREE.Material;
  cut: THREE.Material;
  engine: THREE.Material;
  engineInner: THREE.Material;
  engineCut: THREE.Material;
  pipe: THREE.Material;
  pipeInner: THREE.Material;
  fitting: THREE.Material;
  bolt: THREE.Material;
  glass: THREE.Material;
  glassBack: THREE.Material;
}

const look = (base: PbrLook, over: Partial<PbrLook>): PbrLook => ({ ...base, ...over });

/**
 * Clear tank wall: a thin, faintly teal-tinted dielectric whose opacity and
 * glow rise toward grazing angles (Fresnel), so the wall's silhouette and
 * domed ends draw as bright edge lines round the liquid without hiding it,
 * plus a soft softbox reflection streak along the cylinder (view-space
 * normals in a band), which is what reads as a glass wall in concept 06.
 */
export function glassMaterial(side: THREE.Side, faceOpacity: number, rimOpacity: number, streak = 1): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial({ color: new THREE.Color("#d3eaee"), metalness: 0, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.03, side });
  const facing = normalView.dot(positionViewDirection).abs();
  const rim = float(1).sub(facing).pow(2.2);
  const edge = float(1).sub(facing).pow(7.0);
  const ny = normalView.y;
  // Softbox reflections: a crisp bright line and a soft band on the upper wall, a faint one below.
  const line = smoothstep(0.5, 0.54, ny).mul(float(1).sub(smoothstep(0.57, 0.61, ny)));
  const band = smoothstep(0.3, 0.42, ny).mul(float(1).sub(smoothstep(0.62, 0.78, ny)));
  const low = smoothstep(-0.62, -0.52, ny).mul(float(1).sub(smoothstep(-0.44, -0.34, ny)));
  const gloss = line.add(band.mul(0.4)).add(low.mul(0.3)).mul(streak);
  m.opacityNode = mix(float(faceOpacity), float(rimOpacity), rim).add(gloss.mul(0.3)).add(edge.mul(0.3)).min(0.95);
  m.emissiveNode = vec3(0.5, 0.74, 0.78).mul(rim.mul(0.6)).add(vec3(0.88, 0.97, 1.0).mul(edge.mul(1.0).add(gloss.mul(0.6))));
  m.transparent = true;
  m.depthWrite = false;
  return m;
}

export function cutawayMaterials(): CutawayMaterials {
  const front = { side: THREE.FrontSide };
  const double = { side: THREE.DoubleSide };
  return {
    shell: physicalMaterial(look(PRESET_LOOKS.aluminium_brushed, { color: "#dce0e3", roughness: 0.3 }), double),
    shellInner: physicalMaterial(look(PRESET_LOOKS.aluminium_brushed, { color: "#525a60", roughness: 0.5, anisotropy: 0.3 }), double),
    frame: physicalMaterial(look(PRESET_LOOKS.aluminium_brushed, { color: "#7c848a", roughness: 0.42, anisotropy: 0.3 }), double),
    cut: physicalMaterial(look(PRESET_LOOKS.composite_white, { color: "#d9dde0", metalness: 0.45, roughness: 0.38, clearcoat: 0 }), double),
    engine: physicalMaterial(look(PRESET_LOOKS.steel_machined, { color: "#c3c8cc", roughness: 0.34, anisotropy: 0.6 }), double),
    engineInner: physicalMaterial(look(PRESET_LOOKS.steel_machined, { color: "#5a6167", roughness: 0.42, anisotropy: 0.3 }), double),
    engineCut: physicalMaterial(look(PRESET_LOOKS.composite_white, { color: "#c9ced2", metalness: 0.5, roughness: 0.36, clearcoat: 0 }), double),
    pipe: physicalMaterial(look(PRESET_LOOKS.steel_machined, { color: "#bfc4c8", roughness: 0.26 }), double),
    pipeInner: physicalMaterial(look(PRESET_LOOKS.steel_machined, { color: "#5e666c", roughness: 0.4, anisotropy: 0 }), double),
    fitting: physicalMaterial(look(PRESET_LOOKS.steel_machined, { color: "#a7adb2", roughness: 0.3 }), front),
    bolt: physicalMaterial(look(PRESET_LOOKS.steel_machined, { color: "#d0d4d7", roughness: 0.22, anisotropy: 0 }), front),
    // A clear wall: faint across the face (the teal liquid reads through it), bright at the silhouette.
    glass: glassMaterial(THREE.FrontSide, 0.025, 0.9, 0.5),
    glassBack: glassMaterial(THREE.BackSide, 0.1, 0.5, 0.3),
  };
}

/** The cutaway's parts (body frame); the stage switches whole/section variants with the layers. */
export interface CutawayParts {
  shellFull: THREE.Group;
  shellCut: THREE.Group;
  /** Clear tank: back wall, front wall, dome weld rings. The liquid draws between back and front. */
  tank: { back: THREE.Mesh; front: THREE.Mesh; rings: THREE.Group };
  feedFull: THREE.Group;
  feedCut: THREE.Group;
  /** Flanges, valve, actuator, outlet boss (whole in both views). */
  fittings: THREE.Group;
  engineFull: THREE.Group;
  engineCut: THREE.Group;
  /** Low-poly silhouettes (whole) for the floor shadow bake. */
  shadowProxy: THREE.BufferGeometry[];
}

/** Shell, frames, skirts, and the aft bulkhead as profile chains. */
export function shellChains(l: CutawayLayout, m: CutawayMaterials): { wall: ProfileChain[]; rings: ProfileChain[][] } {
  const ro = l.shell.od / 2;
  const ri = ro - l.shell.wall;
  const b = l.bulkhead;
  const wall: ProfileChain[] = [
    { pts: [[l.shell.foreX, ri], [l.shell.foreX, ro]], mat: m.cut },
    { pts: [[l.shell.foreX, ro], [l.shell.aftX, ro]], mat: m.shell },
    // Aft bulkhead (thrust plate): aft face, the bore the feed line passes, fore face.
    { pts: [[l.shell.aftX, ro], [l.shell.aftX, b.hole]], mat: m.shell },
    { pts: [[l.shell.aftX, b.hole], [l.shell.aftX - b.thickness, b.hole]], mat: m.shellInner },
    { pts: [[l.shell.aftX - b.thickness, b.hole], [l.shell.aftX - b.thickness, ri]], mat: m.shellInner },
    { pts: [[l.shell.aftX - b.thickness, ri], [l.shell.foreX, ri]], mat: m.shellInner },
  ];
  const rings: ProfileChain[][] = [];
  for (const f of l.frames) {
    const x0 = f.x - f.width / 2;
    const x1 = f.x + f.width / 2;
    const r0 = ri - f.depth;
    rings.push([
      { pts: [[x0, ri], [x0, r0]], mat: m.frame },
      { pts: [[x0, r0], [x1, r0]], mat: m.frame },
      { pts: [[x1, r0], [x1, ri]], mat: m.frame },
      { pts: [[x1, ri], [x0, ri]], mat: m.frame },
    ]);
  }
  return { wall, rings };
}

/** Injector head, chamber, and bell as one walled profile (body x aft). */
export function engineChains(l: CutawayLayout, m: CutawayMaterials): ProfileChain[] {
  const inj = l.injector;
  const prof = l.nozzle;
  const x0 = prof[0]!.x;
  const rc = prof[0]!.r;
  const exit = l.exit;
  // A thin machined wall that follows the contour, so the outside shows the throat's neck and the
  // bell's flare; a rolled stiffening lip at the exit.
  const wc = 0.14 * rc;
  const we = Math.max(0.035 * exit.r, 0.05 * rc);
  const wall = (x: number) => wc + (we - wc) * Math.min(1, Math.max(0, (x - x0) / Math.max(1e-9, exit.x - x0)));
  const plate = 0.3 * inj.length;
  const bore = l.feedRadius * 0.85;
  const lip = 2.2 * we;
  const lipX = Math.max(l.throat.x, exit.x - 1.6 * lip);
  const outer: Pt[] = prof.map((p) => {
    const bump = p.x > lipX ? (lip - we) * Math.sin((Math.PI / 2) * Math.min(1, (p.x - lipX) / Math.max(1e-9, exit.x - lipX))) : 0;
    return [p.x, p.r + wall(p.x) + bump] as const;
  });
  const inner: Pt[] = [...prof].reverse().map((p) => [p.x, p.r] as const);
  return [
    { pts: [[inj.x, bore], [inj.x, inj.radius]], mat: m.engine },
    { pts: [[inj.x, inj.radius], [x0, inj.radius]], mat: m.engine },
    { pts: [[x0, inj.radius], [x0, rc + wc]], mat: m.engine },
    { pts: outer, mat: m.engine },
    { pts: [outer[outer.length - 1]!, [exit.x, exit.r]], mat: m.engineCut },
    { pts: inner, mat: m.engineInner },
    { pts: [[x0, rc], [inj.x + plate, rc * 0.92]], mat: m.engineInner },
    { pts: [[inj.x + plate, rc * 0.92], [inj.x + plate, bore]], mat: m.engineInner },
    { pts: [[inj.x + plate, bore], [inj.x, bore]], mat: m.engineInner },
  ];
}

/** Orients a Y-axis mesh along `dir` (body frame). */
function orient(obj: THREE.Object3D, dir: Vec3): void {
  obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...dir).normalize());
}

/** A bolted flange (whole) centred on `at`, normal `dir`. */
export function flange(m: CutawayMaterials, at: Vec3, dir: Vec3, r: number, thick: number, bolts: number): THREE.Group {
  const g = new THREE.Group();
  const disc = new THREE.CylinderGeometry(r, r, thick, 48);
  g.add(new THREE.Mesh(disc, m.fitting));
  const head = new THREE.CylinderGeometry(r * 0.1, r * 0.1, thick * 2.0, 6);
  for (let i = 0; i < bolts; i++) {
    const a = (2 * Math.PI * (i + 0.5)) / bolts;
    const b = new THREE.Mesh(head, m.bolt);
    b.position.set(Math.cos(a) * r * 0.8, 0, Math.sin(a) * r * 0.8);
    g.add(b);
  }
  g.position.set(...at);
  orient(g, dir);
  return g;
}

/**
 * A bolted ring flange about body +X at station `x` (between radii `rIn` and
 * `rOut`), sectioned by the wedge: the kept arc with its two cut faces and
 * only the bolts on the kept arc, so the section opens the part it rings.
 */
export function cutFlange(m: CutawayMaterials, x: number, rIn: number, rOut: number, thick: number, bolts: number): THREE.Group {
  const ring: ProfileChain[] = [
    { pts: [[x - thick / 2, rIn], [x - thick / 2, rOut]], mat: m.fitting },
    { pts: [[x - thick / 2, rOut], [x + thick / 2, rOut]], mat: m.fitting },
    { pts: [[x + thick / 2, rOut], [x + thick / 2, rIn]], mat: m.fitting },
    { pts: [[x + thick / 2, rIn], [x - thick / 2, rIn]], mat: m.fitting },
  ];
  const g = revolve(ring, { cut: true, capMat: m.engineCut, segments: 96 });
  const rb = 0.5 * (rIn + rOut);
  const head = new THREE.CylinderGeometry(0.1 * rOut, 0.1 * rOut, thick * 2.0, 6);
  head.rotateZ(-Math.PI / 2);
  for (let i = 0; i < bolts; i++) {
    const phi = (2 * Math.PI * (i + 0.5)) / bolts;
    // Kept arc only: [KEEP.phi0, KEEP.phi0 + KEEP.phi] (mod 2 pi), with a bolt's width of margin.
    const rel = (((phi - KEEP.phi0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const margin = (0.12 * rOut) / rb;
    if (rel < margin || rel > KEEP.phi - margin) continue;
    const b = new THREE.Mesh(head, m.bolt);
    const [y, z] = atPhi(rb, phi);
    b.position.set(x, y, z);
    g.add(b);
  }
  return g;
}

/** Builds every cutaway part from the layout. */
export function buildCutaway(l: CutawayLayout, m: CutawayMaterials): CutawayParts {
  // ---- shell, frames, skirts, bulkhead
  const { wall, rings } = shellChains(l, m);
  const shellFull = revolve(wall, { cut: false, capMat: m.cut, segments: 128 });
  const shellCut = revolve(wall, { cut: true, capMat: m.cut, segments: 128 });
  for (const r of rings) shellCut.add(revolve(r, { cut: true, capMat: m.cut, segments: 128 }));
  // Longitudinal stringers on the kept half, between the bulkhead and the fore end.
  const ri = l.shell.od / 2 - l.shell.wall;
  const sLen = l.shell.aftX - l.bulkhead.thickness - l.shell.foreX;
  const sGeo = new THREE.BoxGeometry(sLen, 0.026 * l.shell.od, 0.018 * l.shell.od);
  for (const f of [0.12, 0.5, 0.88]) {
    const phi = KEEP.phi0 + f * KEEP.phi;
    const s = new THREE.Mesh(sGeo, m.frame);
    const [y, z] = atPhi(ri - 0.012 * l.shell.od, phi);
    s.position.set(l.shell.foreX + sLen / 2, y, z);
    s.rotation.x = phi + Math.PI / 2;
    shellCut.add(s);
  }

  // ---- clear tank (whole: the liquid lives inside it)
  const D = l.tankOd;
  const capsule = () => {
    const g = l.tankFlat
      ? new THREE.CylinderGeometry(D / 2, D / 2, l.tankLength, 96, 1, false)
      : new THREE.CapsuleGeometry(D / 2, Math.max(1e-4, l.tankLength - D), 32, 96);
    g.rotateZ(-Math.PI / 2);
    return g;
  };
  const back = new THREE.Mesh(capsule(), m.glassBack);
  const front = new THREE.Mesh(capsule(), m.glass);
  const tankRings = new THREE.Group();
  for (const x of l.tankSeams) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(D / 2 + 0.003 * D, 0.01 * D, 10, 96), m.fitting);
    ring.rotation.set(0, Math.PI / 2, 0);
    ring.position.x = x;
    tankRings.add(ring);
  }
  // Tank skirts: annular supports from the tank seams to the shell wall.
  for (const x of l.tankSeams) {
    const t = 0.018 * D;
    const r0 = D / 2;
    const skirt: ProfileChain[] = [
      { pts: [[x - t / 2, r0], [x - t / 2, ri]], mat: m.frame },
      { pts: [[x - t / 2, ri], [x + t / 2, ri]], mat: m.frame },
      { pts: [[x + t / 2, ri], [x + t / 2, r0]], mat: m.frame },
      { pts: [[x + t / 2, r0], [x - t / 2, r0]], mat: m.frame },
    ];
    shellCut.add(revolve(skirt, { cut: true, capMat: m.cut, segments: 128 }));
  }

  // ---- feed line: pipe runs, outlet boss, flanges, valve
  const curve = new THREE.CatmullRomCurve3(l.feed.map((p) => new THREE.Vector3(...p)));
  const samples = curve.getSpacedPoints(96).map((v) => v.toArray() as Vec3);
  const rOut = l.feedRadius;
  const rIn = l.feedRadius * 0.78;
  const pipeMats = { outer: m.pipe, inner: m.pipeInner, cap: m.engineCut };
  const feedFull = pipe(samples, rOut, rIn, pipeMats, false);
  const feedCut = pipe(samples, rOut, rIn, pipeMats, true);
  const fittings = new THREE.Group();
  const tangentAt = (u: number): Vec3 => curve.getTangentAt(u).toArray() as Vec3;
  const pointOn = (u: number): Vec3 => curve.getPointAt(u).toArray() as Vec3;
  // Outlet boss on the aft dome and its flange.
  fittings.add(flange(m, pointOn(0.05), tangentAt(0.05), rOut * 1.9, rOut * 0.55, 6));
  fittings.add(flange(m, pointOn(0.13), tangentAt(0.13), rOut * 1.6, rOut * 0.45, 6));
  // Valve cluster, on the line: body, bonnet flanges, actuator.
  const vAt = l.valve.at;
  const vDir = l.valve.dir;
  const valveBody = new THREE.Mesh(new THREE.CylinderGeometry(l.valve.radius, l.valve.radius, l.valve.length, 40), m.fitting);
  valveBody.position.set(...vAt);
  orient(valveBody, vDir);
  fittings.add(valveBody);
  const half = l.valve.length / 2;
  for (const s of [-1, 1])
    fittings.add(flange(m, [vAt[0] + vDir[0] * half * s, vAt[1] + vDir[1] * half * s, vAt[2] + vDir[2] * half * s], vDir, l.valve.radius * 1.28, rOut * 0.55, 8));
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(l.valve.radius * 0.28, l.valve.radius * 0.28, l.valve.radius * 1.4, 20), m.bolt);
  // The actuator stands off the valve away from the axis (toward the nearer shell wall).
  const away = Math.sign(vAt[2]) || 1;
  stem.position.set(vAt[0], vAt[1], vAt[2] + away * l.valve.radius * 1.3);
  stem.rotation.x = Math.PI / 2;
  const actuator = new THREE.Mesh(new THREE.BoxGeometry(l.valve.radius * 1.5, l.valve.radius * 1.2, l.valve.radius * 0.9), m.fitting);
  actuator.position.set(vAt[0], vAt[1], vAt[2] + away * l.valve.radius * 2.2);
  fittings.add(stem, actuator);
  // Engine inlet: the bolted flange on the bulkhead's fore face where the line enters the engine
  // (on the line, inside the shell; the line runs on through the bulkhead bore into the injector).
  fittings.add(flange(m, l.inlet.at, l.inlet.dir, l.inlet.radius, l.inlet.thickness, 10));

  // ---- engine: injector head, chamber, bell
  const inj = l.injector;
  const ec = engineChains(l, m);
  const engineFull = revolve(ec, { cut: false, capMat: m.engineCut });
  const engineCut = revolve(ec, { cut: true, capMat: m.engineCut });
  const mountX = inj.x + inj.length * 0.12;
  const headX = inj.x + inj.length - inj.length * 0.1;
  const mount = flange(m, [mountX, 0, 0], [1, 0, 0], inj.radius * 1.16, inj.length * 0.24, 12);
  const headFlange = flange(m, [headX, 0, 0], [1, 0, 0], inj.radius * 1.08, inj.length * 0.2, 12);
  engineFull.add(mount, headFlange);
  // The section cuts the flanges with the engine (R20-06: one cut plane through the shell, tank bay, and engine).
  engineCut.add(cutFlange(m, mountX, inj.radius * 0.98, inj.radius * 1.16, inj.length * 0.24, 12), cutFlange(m, headX, inj.radius * 0.98, inj.radius * 1.08, inj.length * 0.2, 12));

  // ---- shadow proxies (whole, low poly)
  const ro = l.shell.od / 2;
  const proxyShell = latheX(
    [
      [l.shell.foreX, ro],
      [l.shell.aftX, ro],
    ],
    24,
  );
  const proxyEngine = latheX(
    [[inj.x, inj.radius] as Pt, ...l.nozzle.map((p) => [p.x, p.r * 1.08] as Pt)],
    24,
  );
  return {
    shellFull,
    shellCut,
    tank: { back, front, rings: tankRings },
    feedFull,
    feedCut,
    fittings,
    engineFull,
    engineCut,
    shadowProxy: [proxyShell, proxyEngine],
  };
}
