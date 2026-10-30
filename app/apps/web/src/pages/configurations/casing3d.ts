/**
 * Page 03 motor casing render (C §4.3, U11; FID-03-05): a sealed motor at the
 * motor file's length and diameter, built along local +X (fore at -L/2):
 *
 * - the case: turned aluminium (brushed, anisotropic) with seal grooves
 *   near each end;
 * - the forward end cap: a machined closure with a chamfered, domed face, a
 *   dark seal ring at the joint, and a snap-ring groove;
 * - the aft end: a steel retainer flange with knurl grooves, then the stepped
 *   nozzle (machined closure ring, graphite insert stepping down twice, and
 *   the throat bore).
 *
 * `realistic` uses the PBR presets; `flat` a matte grey of the same shapes.
 * Shown on the shared studio stage (`viewport/productStage.ts`). Visual tier
 * only (I13): the proportions come from the motor file, nothing else here
 * is engineering data.
 */
import * as THREE from "three/webgpu";
import { DetailMaterials, filletPolyline, revolve, triangleCount, tubeProfile, type ProfilePoint } from "../../detail/registry.ts";
import { PRESET_LOOKS, type PbrLook } from "../../viewport/materials.ts";
import { ensureTangents, needsTangents, physicalMaterial } from "../../viewport/presets.ts";
import type { ProductShot } from "../../viewport/productStage.ts";
import { STAGE_LOOK, type StageLook } from "../../viewport/stage.ts";

export type CasingStyle = "realistic" | "flat";

/**
 * The casing's studio floor (R19-03): the shared look with a tight, dark
 * contact core along the line the case rests on and a shorter penumbra, so
 * the single small part reads grounded instead of floating over a broad
 * smudge (the assembly look spreads its shade across a whole stack).
 * R20-03 tightens it again: a near-black line of contact and a short skirt.
 */
export const CASING_STAGE_LOOK: StageLook = { ...STAGE_LOOK, contactSigma: 0.2, contactOpacity: 0.96, broadSigma: 0.75, broadOpacity: 0.34 };

/** The casing rests on the floor: no gap under its lowest point. */
export const CASING_FLOOR_GAP = 0;

/** Casing proportions (m): length and outer diameter, clamped to a drawable aspect. */
export function casingDims(length: number, diameter: number): { length: number; radius: number } {
  const d = diameter > 0 ? diameter : 0.018;
  const l = length > 0 ? length : 4 * d;
  return { length: Math.max(1.5 * d, l), radius: d / 2 };
}

/** The named parts of the casing and the order they are built in (tests and probes). */
export const CASING_PARTS = ["case", "fore-cap", "fore-seal", "aft-retainer", "nozzle-ring", "nozzle-insert", "nozzle-throat"] as const;

export interface CasingModel {
  group: THREE.Group;
  /** Triangles per named part. */
  parts: Record<(typeof CASING_PARTS)[number], number>;
  dispose(): void;
}

const FLAT: PbrLook = { ...PRESET_LOOKS.composite_gray, color: "#9aa3a8", metalness: 0.15, roughness: 0.78, anisotropy: 0, clearcoat: 0 };

/**
 * The nozzle insert's graphite (R20-03): a mid grey with a satin sheen, a
 * few stops lighter than the shared near-black finish, so the steps down to
 * the throat read against the dark bore at card size.
 */
const NOZZLE_GRAPHITE: PbrLook = { ...PRESET_LOOKS.composite_gray, color: "#5a6064", metalness: 0.35, roughness: 0.4, anisotropy: 0, clearcoat: 0 };

/** Builds the casing for a motor `length` x `diameter` (m), centred on the origin along +X. */
export function buildCasing(length: number, diameter: number, style: CasingStyle, segments = 96): CasingModel {
  const { length: L, radius: ro } = casingDims(length, diameter);
  const mats = new DetailMaterials();
  const own: THREE.Material[] = [];
  const realistic = style === "realistic";
  const flat = (): THREE.Material => {
    const m = physicalMaterial(FLAT);
    own.push(m);
    return m;
  };
  const caseMat = realistic ? physicalMaterial(PRESET_LOOKS.aluminium_brushed) : flat();
  if (realistic) own.push(caseMat);
  const machined = realistic ? mats.finish("machined") : flat();
  const dark = realistic ? mats.finish("anodized_dark") : flat();
  const graphite = realistic ? physicalMaterial(NOZZLE_GRAPHITE) : flat();
  if (realistic) own.push(graphite);
  const steel = realistic ? mats.finish("thread") : flat();
  const x0 = -L / 2;
  const x1 = L / 2;
  const cap = Math.min(0.09 * L, 0.9 * ro);
  const group = new THREE.Group();
  group.name = "rw-motor-casing";
  const parts = {} as CasingModel["parts"];
  const add = (name: (typeof CASING_PARTS)[number], geom: THREE.BufferGeometry, mat: THREE.Material) => {
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = `casing-${name}`;
    mesh.userData["rwProvenance"] = "visual";
    if (needsTangents(mat)) ensureTangents(geom);
    group.add(mesh);
    parts[name] = triangleCount(geom);
  };

  // Case tube: from just inside the forward cap to the retainer, with seal grooves near each end.
  const caseProf = tubeProfile({ x0: x0 + 0.6 * cap, x1: x1 - 0.7 * cap, ro, ri: 0.88 * ro, bevel: 0.05 * ro, grooves: [0.04, 0.07, 0.93, 0.96], grooveDepth: 0.025 * ro, grooveWidth: 0.02 * ro });
  add("case", revolve(caseProf.points, { segments, closed: true }), caseMat);

  // Forward end cap: a short machined closure, chamfered into a shallow dome, with a snap-ring groove.
  const fore: ProfilePoint[] = filletPolyline(
    [
      [x0 + 1.05 * cap, 0.985 * ro],
      [x0 + 0.42 * cap, 0.985 * ro],
      [x0 + 0.38 * cap, 0.94 * ro],
      [x0 + 0.34 * cap, 0.985 * ro],
      [x0 + 0.1 * cap, 0.985 * ro],
      [x0, 0.82 * ro],
      [x0 - 0.06 * cap, 0.45 * ro],
      [x0 - 0.08 * cap, 0],
    ],
    [0, 0, 0, 0, 0.12 * ro, 0.18 * ro, 0.2 * ro, 0],
    4,
  ).reverse();
  add("fore-cap", revolve(fore, { segments }), machined);
  const seal = tubeProfile({ x0: x0 + 0.55 * cap, x1: x0 + 0.72 * cap, ro: 1.006 * ro, ri: 0.9 * ro, bevel: 0.02 * ro, steps: 2 });
  add("fore-seal", revolve(seal.points, { segments, closed: true }), dark);

  // Aft retainer flange (slightly proud of the case), knurl grooves round it.
  const ret = tubeProfile({ x0: x1 - 0.75 * cap, x1: x1 + 0.05 * cap, ro: 1.07 * ro, ri: 0.8 * ro, bevel: 0.06 * ro, grooves: [0.25, 0.45, 0.65], grooveDepth: 0.02 * ro, grooveWidth: 0.018 * ro });
  add("aft-retainer", revolve(ret.points, { segments, closed: true }), steel);

  // Stepped nozzle: the machined closure ring, the graphite insert stepping down twice, and the throat bore.
  const ring = tubeProfile({ x0: x1 - 0.1 * cap, x1: x1 + 0.18 * cap, ro: 0.8 * ro, ri: 0.58 * ro, bevel: 0.05 * ro, steps: 2 });
  add("nozzle-ring", revolve(ring.points, { segments, closed: true }), machined);
  const insert: ProfilePoint[] = [
    { x: x1 - 0.2 * cap, r: 0.58 * ro },
    { x: x1 + 0.32 * cap, r: 0.58 * ro, crease: true },
    { x: x1 + 0.32 * cap, r: 0.46 * ro, crease: true },
    { x: x1 + 0.46 * cap, r: 0.46 * ro, crease: true },
    { x: x1 + 0.46 * cap, r: 0.34 * ro, crease: true },
    // Exit cone into the throat.
    { x: x1 + 0.2 * cap, r: 0.2 * ro, crease: true },
    { x: x1 - 0.2 * cap, r: 0.2 * ro },
  ];
  add("nozzle-insert", revolve(insert, { segments, closed: true }), graphite);
  // The throat: a dark disc deep in the bore (reads as a hole, not a cap).
  const throat: ProfilePoint[] = [
    { x: x1 - 0.1 * cap, r: 0 },
    { x: x1 - 0.1 * cap, r: 0.21 * ro },
  ];
  const throatMat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color("#0b0c0d") });
  own.push(throatMat);
  add("nozzle-throat", revolve(throat, { segments: 32 }), throatMat);

  return {
    group,
    parts,
    dispose() {
      group.traverse((o) => o instanceof THREE.Mesh && o.geometry.dispose());
      for (const m of own) m.dispose();
      mats.dispose();
    },
  };
}

/** Toolbar views of the casing (`ui.view`): world direction toward the camera and the casing's lie on the floor. */
export interface CasingPose {
  shot: Omit<ProductShot, "radius">;
  /** Yaw of the casing axis about world up (rad; + turns the aft end toward the viewer). */
  yaw: number;
}

/**
 * Iso (concept 03): the casing lying on the floor on a diagonal, forward end
 * upper left, the stepped nozzle lower right facing the camera, seen from
 * front-above. Top, Side, Front, Rear: the toolbar's views of the same lie.
 */
export function casingPose(view: string): CasingPose {
  const fit = { x0: 0.1, y0: 0.12, x1: 0.9, y1: 0.8 };
  switch (view) {
    case "top":
      return { yaw: 0.35, shot: { dir: [0, 1, 0.02], axisTiltDeg: null, fovDeg: 22, fit } };
    case "side":
      return { yaw: 0, shot: { dir: [0, 0.12, 1], axisTiltDeg: null, fovDeg: 22, fit } };
    case "front":
      return { yaw: 0, shot: { dir: [-1, 0.28, 0.08], axisTiltDeg: null, fovDeg: 22, fit: { x0: 0.25, y0: 0.1, x1: 0.75, y1: 0.86 } } };
    case "rear":
      return { yaw: 0, shot: { dir: [1, 0.28, 0.08], axisTiltDeg: null, fovDeg: 22, fit: { x0: 0.25, y0: 0.1, x1: 0.75, y1: 0.86 } } };
    default:
      // R20-03: the casing fills its card (the fit is on the casing's axis-aligned box, whose corners lie outside the
      // diagonal silhouette, so it may overhang the frame), and the aft end turns further toward the camera so the
      // stepped nozzle reads.
      return { yaw: 0.58, shot: { dir: [0.12, 0.62, 1], axisTiltDeg: null, fovDeg: 20, fit: { x0: -0.04, y0: 0.0, x1: 1.04, y1: 0.92 } } };
  }
}
