/**
 * Page 05 procedural assembly (M4.7): the liquid propulsion module built from
 * the engine's evaluated feed graph (`EvaluatedModel.engines.<id>`: node
 * stations and radial offsets, inline tank geometry, routed feed-edge
 * waypoints, `docs/dev/page05-layout.md`) and `engine_design`'s chamber and
 * nozzle sizing. Never from fixed numbers: another engine file draws another
 * module.
 *
 * Frames. The layout frame is (station +aft, radial +right, depth +toward the
 * viewer), metres. Parts are built in the body frame `AssemblyModel` expects
 * (its one body -> Y-up rotation gives world = (radial, -station, depth)), so
 * aft hangs down and the tanks sit side by side, as in the concept.
 *
 * Each feed node and edge is one part (node id, `edge:<i>`). The part's base
 * mesh is a simple proxy (picking, BVH); the visible detail (M3.0 helpers:
 * revolved bevelled profiles, hex fittings, rounded boxes) hangs under it,
 * tagged `rwProvenance: "visual"` (I13). The shell panels around the tanks
 * are decorative (the layout doc's fairings), not part of the feed model.
 */
import * as THREE from "three/webgpu";
import type { schema } from "@rw/contracts";
import { chamferedPrism, DetailMaterials, filletPolyline, gridSurface, revolve, roundedBox, triangleCount, tubeProfile, type ProfilePoint } from "../../detail/registry.ts";
import { PRESET_LOOKS, type PbrLook } from "../../viewport/materials.ts";
import { ensureTangents, needsTangents, physicalMaterial } from "../../viewport/presets.ts";
import { AssemblyModel, type PartMeta } from "../../viewport/scene.ts";
import { edgePart, type EvalEngine } from "./model.ts";

type Sizing = schema.EngineSizing;
type V3 = THREE.Vector3;

/** Layout (station, radial, depth; m) → body frame. */
export function layoutToBody(station: number, radial: number, depth = 0): V3 {
  return new THREE.Vector3(radial, -depth, -station);
}

/** Body-frame unit vectors of the layout axes. */
export const AXIS = {
  aft: new THREE.Vector3(0, 0, -1),
  radial: new THREE.Vector3(1, 0, 0),
  depth: new THREE.Vector3(0, -1, 0),
} as const;

const PLUS_X = new THREE.Vector3(1, 0, 0);

/** Looks of the module (visual tier). */
const LOOKS = {
  tank: PRESET_LOOKS.aluminium_brushed,
  panel: { ...PRESET_LOOKS.aluminium_brushed, color: "#b9bec3", roughness: 0.4, anisotropy: 0.35 } satisfies PbrLook,
  line: { ...PRESET_LOOKS.steel_machined, color: "#b4b9be", roughness: 0.3 } satisfies PbrLook,
  nozzle: { ...PRESET_LOOKS.steel_machined, color: "#8f959b", roughness: 0.34, anisotropy: 0.5 } satisfies PbrLook,
  chamber: { ...PRESET_LOOKS.aluminium_brushed, color: "#bfc4c8" } satisfies PbrLook,
  jacket: { ...PRESET_LOOKS.steel_machined, color: "#a9afb4", roughness: 0.28, anisotropy: 0.55 } satisfies PbrLook,
  actuator: { ...PRESET_LOOKS.aluminium_brushed, color: "#c6cacd", roughness: 0.32 } satisfies PbrLook,
};

/** Outer radius of the chamber's cooling jacket (visual): a liner of radius `rc` and wall `wall` inside it. */
export const jacketRadius = (rc: number, wall: number): number => rc + wall + Math.max(0.009, 0.42 * rc);

/** Default chamber sizing when `engine_design` has none yet (drawn only; never reported). */
function fallbackSizing(engine: EvalEngine): Pick<Sizing, "chamber_diameter" | "chamber_length" | "convergent_length" | "throat_diameter" | "nozzle_length" | "exit_diameter"> {
  // A rough area from F = Cf·Pc·At with Cf ≈ 1.4, so the bell is in proportion.
  const at = engine.thrust / (1.4 * Math.max(engine.chamber_pressure, 1e5));
  const dt = Math.sqrt((4 * at) / Math.PI);
  const eps = engine.expansion_ratio ?? 4;
  const cr = engine.contraction_ratio ?? 4;
  return {
    throat_diameter: dt,
    exit_diameter: dt * Math.sqrt(eps),
    chamber_diameter: dt * Math.sqrt(cr),
    chamber_length: 6 * dt,
    convergent_length: 1.4 * dt,
    nozzle_length: (dt * (Math.sqrt(eps) - 1)) / (2 * Math.tan((15 * Math.PI) / 180)),
  };
}

// ---- geometry helpers ------------------------------------------------------------

function oriented(geom: THREE.BufferGeometry, material: THREE.Material, origin: V3, axis: V3, roll = 0): THREE.Mesh {
  const m = new THREE.Mesh(geom, material);
  m.quaternion.setFromUnitVectors(PLUS_X, axis.clone().normalize());
  if (roll !== 0) m.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(PLUS_X, roll));
  m.position.copy(origin);
  if (needsTangents(material)) ensureTangents(geom);
  return m;
}

/** Outer profile of a tank shell along local +X (centred), with its end caps. */
export function tankProfile(length: number, radius: number, endCap: string, segments = 14): ProfilePoint[] {
  const half = length / 2;
  const depth = endCap === "hemispherical" ? Math.min(radius, half) : endCap === "ellipsoidal" ? Math.min(radius / 2, half) : 0;
  if (depth <= 0) {
    return filletPolyline(
      [
        [-half, 0],
        [-half, radius],
        [half, radius],
        [half, 0],
      ],
      Math.min(0.008, radius * 0.2),
      4,
    );
  }
  const pts: ProfilePoint[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * (Math.PI / 2);
    pts.push({ x: -half + depth - depth * Math.cos(a), r: radius * Math.sin(a) });
  }
  for (let i = 0; i <= segments; i++) {
    const a = (Math.PI / 2) * (1 - i / segments);
    pts.push({ x: half - depth + depth * Math.cos(a), r: radius * Math.sin(a) });
  }
  return pts;
}

/** A ring (band, flange, seam) along local +X. */
function ringGeometry(x0: number, x1: number, ro: number, ri: number, bevel: number, segments = 72): THREE.BufferGeometry {
  const p = tubeProfile({ x0, x1, ro, ri, bevel, steps: 2 });
  return revolve(p.points, { segments, closed: p.closed });
}

/** Bolt heads on a circle of radius `r` about `axis` at `x` along it (hex, facing -axis). */
function boltCircle(into: THREE.Group, mat: THREE.Material, origin: V3, axis: V3, x: number, r: number, n: number, head: number, phase = 0): void {
  const q = new THREE.Quaternion().setFromUnitVectors(PLUS_X, axis.clone().normalize());
  for (let k = 0; k < n; k++) {
    const phi = phase + (k / n) * Math.PI * 2;
    const at = origin.clone().add(new THREE.Vector3(x, Math.cos(phi) * r, Math.sin(phi) * r).applyQuaternion(q));
    into.add(oriented(chamferedPrism(-head * 0.7, 0, head, 6, head * 0.18), mat, at, axis));
  }
}

/** A bolted flange pair on a line of outer radius `ro` at `at` along `dir`. */
function flangePair(into: THREE.Group, mats: DetailMaterials, at: V3, dir: V3, ro: number): void {
  const rf = Math.max(ro * 2.5, ro + 0.007);
  const t = Math.max(0.0035, ro * 0.55);
  into.add(oriented(ringGeometry(-t - 0.0006, -0.0006, rf, ro * 0.9, 0.0008, 36), mats.finish("machined"), at, dir));
  into.add(oriented(ringGeometry(0.0006, t + 0.0006, rf, ro * 0.9, 0.0008, 36), mats.finish("machined"), at, dir));
  // Hubs either side and the bolts through both flanges.
  into.add(oriented(ringGeometry(-t * 2.2, -t, ro * 1.45, ro * 0.9, 0.0006, 24), mats.finish("machined"), at, dir));
  into.add(oriented(ringGeometry(t, t * 2.2, ro * 1.45, ro * 0.9, 0.0006, 24), mats.finish("machined"), at, dir));
  boltCircle(into, mats.finish("thread"), at, dir, -t - 0.0006, rf * 0.78, 4, Math.max(0.0018, rf * 0.16), Math.PI / 4);
}

/**
 * Where a routed line gets bolted flange joints: the middle of its longest
 * straight run (clear of the bends), plus the second longest when that is
 * long too. Body frame.
 */
export function flangeStations(points: readonly V3[], bend: number): { point: V3; dir: V3 }[] {
  const runs: { len: number; point: V3; dir: V3 }[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const d = b.clone().sub(a);
    const full = d.length();
    const trim = (i > 0 ? bend : 0) + (i + 2 < points.length ? bend : 0);
    const len = full - trim;
    if (full < 1e-6 || len < 0.06) continue;
    const dir = d.normalize();
    const mid = (i > 0 ? bend : 0) + len / 2;
    runs.push({ len, point: a.clone().addScaledVector(dir, mid), dir });
  }
  runs.sort((x, y) => y.len - x.len);
  return runs.filter((r, k) => k === 0 || (k === 1 && r.len > 0.12)).map(({ point, dir }) => ({ point, dir }));
}

/**
 * The feed manifold block on the injector head: a bolted body where the line
 * enters (at `at`, the line leaving along `out`), a tee boss on its forward
 * face with a capped purge port, and the bolt heads on its flange.
 */
function manifoldBlock(mats: DetailMaterials, at: V3, out: V3, headAxis: V3, ro: number): THREE.Group {
  const g = new THREE.Group();
  const up = headAxis.clone().negate();
  const side = out.clone().projectOnPlane(headAxis).normalize();
  const depth = side.clone().cross(up).normalize();
  const sx = Math.max(0.024, ro * 3.6);
  const sz = Math.max(0.03, ro * 4.4);
  const sy = Math.max(0.026, ro * 4);
  const block = new THREE.Mesh(roundedBox(sx, sy, sz, 0.003), mats.finish("machined"));
  block.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, up, depth));
  block.position.copy(at).addScaledVector(side, sx / 2 - 0.004);
  g.add(block);
  // Flange plate against the head, with four bolts.
  const plate = new THREE.Mesh(roundedBox(0.005, sy * 1.25, sz * 1.25, 0.0015), mats.finish("anodized_dark"));
  plate.quaternion.copy(block.quaternion);
  plate.position.copy(at).addScaledVector(side, -0.0045);
  g.add(plate);
  for (const [u, v] of [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ] as const) {
    const p = at.clone().addScaledVector(side, -0.0015).addScaledVector(up, u * sy * 0.5).addScaledVector(depth, v * sz * 0.5);
    g.add(oriented(chamferedPrism(0, 0.004, 0.0024, 6, 0.0004), mats.finish("thread"), p, side));
  }
  // Inlet boss where the line enters, and a tee on the top with a capped purge port.
  g.add(oriented(chamferedPrism(sx - 0.004, sx + 0.004, ro * 1.7, 6, 0.001), mats.finish("thread"), at, side));
  const top = at.clone().addScaledVector(side, sx / 2 - 0.004).addScaledVector(up, sy / 2);
  g.add(oriented(ringGeometry(-0.002, 0.012, ro * 1.05, 0, 0.001, 24), mats.finish("machined"), top, up));
  g.add(oriented(chamferedPrism(0.012, 0.019, ro * 1.45, 6, 0.0009), mats.finish("thread"), top, up));
  g.add(oriented(ringGeometry(0.019, 0.024, ro * 1.1, 0, 0.0012, 24), mats.finish("anodized_dark"), top, up));
  return g;
}

/**
 * A pressurant fitting on a tank's top: boss, riser, a fill-and-vent valve
 * with its handle, an elbow and a capped quick-disconnect (visual tier).
 */
function pressurantFitting(mats: DetailMaterials, at: V3, up: V3, toward: V3): THREE.Group {
  const g = new THREE.Group();
  g.add(oriented(chamferedPrism(-0.004, 0.008, 0.013, 6, 0.0012), mats.finish("machined"), at, up));
  g.add(oriented(ringGeometry(0.008, 0.03, 0.0055, 0, 0.001, 24), mats.finish("machined"), at, up));
  const valve = at.clone().addScaledVector(up, 0.036);
  const body = new THREE.Mesh(roundedBox(0.026, 0.02, 0.02, 0.004), mats.finish("machined"));
  body.quaternion.setFromUnitVectors(PLUS_X, toward.clone().normalize());
  body.position.copy(valve);
  g.add(body);
  g.add(oriented(ringGeometry(0.009, 0.022, 0.0035, 0, 0.0008, 16), mats.finish("machined"), valve, up));
  const handle = new THREE.Mesh(roundedBox(0.03, 0.004, 0.008, 0.0015), mats.finish("anodized_dark"));
  handle.quaternion.copy(body.quaternion);
  handle.position.copy(valve).addScaledVector(up, 0.024).addScaledVector(toward, 0.008);
  g.add(handle);
  // Elbow out toward `toward`, then a capped quick-disconnect.
  const side = valve.clone().addScaledVector(toward, 0.013);
  g.add(oriented(ringGeometry(0, 0.016, 0.005, 0, 0.001, 20), mats.finish("machined"), side, toward));
  g.add(oriented(chamferedPrism(0.016, 0.024, 0.0075, 6, 0.001), mats.finish("thread"), side, toward));
  g.add(oriented(ringGeometry(0.024, 0.034, 0.0068, 0, 0.0018, 24), mats.finish("anodized_dark"), side, toward));
  return g;
}

// ---- feed-line routing -----------------------------------------------------------

export interface RoutePoint {
  station: number;
  radial: number;
  depth: number;
}

const nodePoint = (engine: EvalEngine, id: string): RoutePoint | null => {
  const n = engine.nodes[id];
  if (!n || n.station == null) return null;
  return { station: n.station, radial: n.radial ?? 0, depth: 0 };
};

/**
 * The polyline of one feed edge in the layout frame: from the source node's
 * centre along its own station to the first waypoint's radial line, through
 * the waypoints, then into the target node square (an elbow, never a
 * diagonal). Without waypoints: one elbow when both coordinates change.
 */
export function routeOf(engine: EvalEngine, index: number): RoutePoint[] | null {
  const e = engine.edges[index];
  if (!e) return null;
  const a = nodePoint(engine, e.from);
  const b = nodePoint(engine, e.to);
  if (!a || !b) return null;
  const wps: RoutePoint[] = (e.waypoints ?? []).map((w) => ({ station: w.station, radial: w.radial, depth: w.depth ?? 0 }));
  const pts: RoutePoint[] = [a];
  const push = (p: RoutePoint) => {
    const last = pts[pts.length - 1]!;
    if (Math.abs(last.station - p.station) + Math.abs(last.radial - p.radial) + Math.abs(last.depth - p.depth) > 1e-6) pts.push(p);
  };
  if (wps.length > 0) {
    const first = wps[0]!;
    push({ station: a.station, radial: first.radial, depth: first.depth });
    for (const w of wps) push(w);
    const last = wps[wps.length - 1]!;
    push({ station: b.station, radial: last.radial, depth: last.depth });
  } else if (a.station !== b.station && a.radial !== b.radial) {
    push({ station: b.station, radial: a.radial, depth: 0 });
  }
  push(b);
  return pts;
}

/** A path of straight runs with circular-ish (quadratic) bends of `bend` radius at each corner. */
function bentPath(points: readonly V3[], bend: number): THREE.CurvePath<V3> {
  const path = new THREE.CurvePath<V3>();
  let prev = points[0]!.clone();
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const din = p.clone().sub(points[i - 1]!);
    const dout = points[i + 1]!.clone().sub(p);
    const b = Math.min(bend, 0.45 * din.length(), 0.45 * dout.length());
    const a = p.clone().addScaledVector(din.normalize(), -b);
    const c = p.clone().addScaledVector(dout.normalize(), b);
    if (a.distanceTo(prev) > 1e-6) path.add(new THREE.LineCurve3(prev, a));
    path.add(new THREE.QuadraticBezierCurve3(a, p.clone(), c));
    prev = c;
  }
  const end = points[points.length - 1]!;
  if (end.distanceTo(prev) > 1e-6) path.add(new THREE.LineCurve3(prev, end.clone()));
  return path;
}

/** Outer radius of a feed line drawn for an inner diameter (1.5 mm wall, at least 3 mm). */
export const lineRadius = (diameter: number | null | undefined): number => Math.max(0.003, (diameter ?? 0.006) / 2 + 0.0015);

// ---- the scene -------------------------------------------------------------------

export interface LiquidScene {
  model: AssemblyModel;
  /**
   * Teal glow on the given line parts (the selected flow path); others
   * plain. Every lit line also shows through what hides it (a valve body,
   * the injector head) as a faint teal x-ray, so each selected edge reads
   * end to end (POL: page 05's Valve A to Engine run sits behind the valve).
   */
  setGlow(parts: readonly string[]): void;
  /** Hides the aeroshell panels of hidden tanks (the panels are decor, not parts). */
  setHidden(parts: Iterable<string>): void;
  /** The decorative aeroshell panels (visual tier; not parts). */
  decor: THREE.Group;
  /** Visual-only detail per part (for the probe). */
  report: { id: string; builder: string; meshes: number; triangles: number }[];
}

interface PartBuild {
  id: string;
  kind: string;
  /** Proxy geometry for picking (body frame, already placed). */
  proxy: THREE.Mesh[];
  /** Visible detail (body frame). */
  detail: THREE.Group;
  builder: string;
}

const SEGMENTS = 96;
/** The selected flow path's teal (the accent). */
const GLOW = "#61b5ad";

/** Builds the module for one engine. `sizing` is `engine_design`'s chamber sizing (null: proportional stand-in). */
export function buildLiquidScene(engine: EvalEngine, sizing: Sizing | null): LiquidScene {
  const mats = new DetailMaterials();
  const look = (l: PbrLook) => mats.look(l);
  const proxyMat = new THREE.MeshBasicNodeMaterial();
  const builds: PartBuild[] = [];
  const lineMats = new Map<string, THREE.MeshPhysicalNodeMaterial>();
  /** Each line's x-ray: its tube drawn only where something in front hides it (depth test GREATER), shown while lit. */
  const ghosts = new Map<string, THREE.Mesh>();
  const ghostMat = new THREE.MeshBasicNodeMaterial({ color: GLOW, transparent: true, opacity: 0.6, depthWrite: false });
  ghostMat.depthFunc = THREE.GreaterDepth;
  const ghostGroup = new THREE.Group();
  ghostGroup.name = "rw-line-glow";
  /** `band`: offset (m, along the axis, unsigned) of the clamp bands from the tank centre. */
  const tanks = new Map<string, { centre: V3; axis: V3; radius: number; half: number; band: number }>();

  /** Engine injector heads (body frame): the feed manifolds bolt on where the lines reach them. */
  const heads = new Map<string, { origin: V3; axis: V3; radius: number; top: number }>();
  /** Tanks the aeroshell panels flank (built after the engine, which sets how far down they reach). */
  const aeroshells: AeroshellTank[] = [];

  // Tanks first: lines need their surfaces for the exit fittings.
  for (const [id, n] of Object.entries(engine.nodes)) {
    if (!n || n.kind !== "tank" || n.station == null) continue;
    const spec = n.tank;
    const radius = (spec?.od ?? 0.12) / 2;
    const length = spec?.length ?? Math.max(4 * radius, (n.volume ?? 0.003) / (Math.PI * radius * radius));
    const endCap = spec?.end_cap ?? "hemispherical";
    const centre = layoutToBody(n.station, n.radial ?? 0);
    // Tanks lie across the vehicle axis with their heads facing the engine (layout doc).
    const axis = AXIS.radial.clone();
    const capLen = endCap === "hemispherical" ? radius : endCap === "ellipsoidal" ? radius / 2 : 0;
    tanks.set(id, { centre, axis, radius, half: length / 2, band: 0.3 * (length - 2 * capLen) });
    const detail = new THREE.Group();
    const prof = tankProfile(length, radius, endCap);
    detail.add(oriented(revolve(prof, { segments: SEGMENTS }), look(LOOKS.tank), centre, axis));
    const cap = endCap === "hemispherical" ? radius : endCap === "ellipsoidal" ? radius / 2 : 0;
    const cyl0 = -length / 2 + cap;
    const cyl1 = length / 2 - cap;
    // Girth welds at the head joints, two clamp bands, and pole bosses.
    for (const x of [cyl0, cyl1]) detail.add(oriented(ringGeometry(x - 0.0025, x + 0.0025, radius + 0.0012, radius - 0.002, 0.0011), mats.finish("machined"), centre, axis));
    const bandW = Math.min(0.022, (cyl1 - cyl0) * 0.08);
    for (const f of [0.2, 0.8]) {
      const x = cyl0 + f * (cyl1 - cyl0);
      detail.add(oriented(ringGeometry(x - bandW / 2, x + bandW / 2, radius + 0.004, radius - 0.001, 0.0018), mats.finish("anodized_dark"), centre, axis));
      // Band clamp blocks on top (bolted).
      const blk = new THREE.Mesh(roundedBox(bandW * 1.15, 0.016, 0.014, 0.003), mats.finish("anodized_dark"));
      blk.position.copy(centre).add(new THREE.Vector3(x, 0, radius + 0.009));
      detail.add(blk);
    }
    for (const sgn of [-1, 1]) {
      const x0 = sgn * (length / 2);
      const boss = sgn < 0 ? [x0 - 0.012, x0 + 0.004] : [x0 - 0.004, x0 + 0.012];
      detail.add(oriented(chamferedPrism(boss[0]!, boss[1]!, Math.min(0.016, radius * 0.22), 6, 0.0015), mats.finish("machined"), centre, axis));
    }
    // Pressurant fill-and-vent fitting on the top, toward the outboard end (the pressurant `n.pressurant`).
    {
      const out = Math.sign(n.radial ?? 0) || 1;
      const x = out * 0.16 * (cyl1 - cyl0);
      const topUp = AXIS.aft.clone().negate();
      const at = centre.clone().add(new THREE.Vector3(x, 0, 0)).addScaledVector(topUp, radius - 0.002);
      detail.add(pressurantFitting(mats, at, topUp, AXIS.depth.clone()));
    }
    aeroshells.push({ tank: id, station: n.station, radial: n.radial ?? 0, radius, half: length / 2 });
    const proxy = oriented(revolve(prof, { segments: 32 }), proxyMat, centre, axis);
    builds.push({ id, kind: "tank", proxy: [proxy], detail, builder: "liquid-tank" });
  }

  // Engine: injector head and manifold, chamber, convergent, throat, conical bell.
  for (const [id, n] of Object.entries(engine.nodes)) {
    if (!n || n.kind !== "engine" || n.station == null) continue;
    const s = sizing ?? fallbackSizing(engine);
    const origin = layoutToBody(n.station, n.radial ?? 0);
    const axis = AXIS.aft.clone();
    const rc = s.chamber_diameter / 2;
    const rt = s.throat_diameter / 2;
    const re = s.exit_diameter / 2;
    const wall = Math.max(0.0025, rc * 0.08);
    const lc = s.chamber_length;
    const x1 = lc + s.convergent_length;
    const x2 = x1 + s.nozzle_length;
    const rHead = Math.max(jacketRadius(rc, wall) + 0.006, 0.04);
    heads.set(id, { origin: origin.clone(), axis: axis.clone(), radius: rHead, top: -0.04 });
    const detail = new THREE.Group();
    // Injector head (station - 20 mm .. face) with a bolted flange.
    detail.add(oriented(ringGeometry(-0.022, 0, rHead, 0, 0.004), mats.finish("machined"), origin, axis));
    detail.add(oriented(ringGeometry(-0.006, 0.008, rHead + 0.008, rc, 0.0015), mats.finish("machined"), origin, axis));
    const bolts = 10;
    for (let k = 0; k < bolts; k++) {
      const phi = (k / bolts) * Math.PI * 2;
      const local = new THREE.Vector3(0, Math.cos(phi), Math.sin(phi)).multiplyScalar(rHead + 0.004);
      const q = new THREE.Quaternion().setFromUnitVectors(PLUS_X, axis);
      const at = origin.clone().add(local.applyQuaternion(q));
      detail.add(oriented(chamferedPrism(-0.012, -0.006, 0.0032, 6, 0.0006), mats.finish("thread"), at, axis));
    }
    // Manifold dome on the head (the lines' tee at the manifold station).
    detail.add(
      oriented(
        revolve(
          filletPolyline(
            [
              [-0.022, rHead * 0.92],
              [-0.034, rHead * 0.7],
              [-0.04, rHead * 0.32],
              [-0.04, 0],
            ],
            [0, 0.004, 0.004, 0],
            3,
          ).reverse(),
          { segments: SEGMENTS },
        ),
        mats.finish("machined"),
        origin,
        axis,
      ),
    );
    // Chamber: the liner (the computed cylinder) inside a cooling jacket with bolted end collars, so
    // the chamber reads as a compact machined module (D29: the liner keeps `engine_design`'s length and
    // diameter; the jacket is visual, I13).
    const q = new THREE.Quaternion().setFromUnitVectors(PLUS_X, axis);
    detail.add(oriented(ringGeometry(0.008, lc, rc + wall, rc, 0.0015), look(LOOKS.chamber), origin, axis));
    const rj = jacketRadius(rc, wall);
    const xj0 = Math.min(0.03, 0.12 * lc);
    const xj1 = Math.max(xj0 + 0.01, lc - Math.min(0.016, 0.08 * lc));
    const jacket = tubeProfile({ x0: xj0, x1: xj1, ro: rj, ri: rc + wall, bevel: 0.004, steps: 3, grooves: [0.25, 0.5, 0.75], grooveDepth: 0.0012, grooveWidth: 0.0012 });
    detail.add(oriented(revolve(jacket.points, { segments: SEGMENTS, closed: jacket.closed }), look(LOOKS.jacket), origin, axis));
    for (const [x, dir] of [
      [xj0, 1],
      [xj1, -1],
    ] as const) {
      const w = 0.011;
      const a = dir > 0 ? x - 0.002 : x - w + 0.002;
      detail.add(oriented(ringGeometry(a, a + w, rj + 0.0065, rc + wall, 0.0015), mats.finish("machined"), origin, axis));
      boltCircle(detail, mats.finish("thread"), origin, axis, dir > 0 ? a : a + w + 0.0035, rj + 0.0035, 12, 0.0026);
    }
    // Coolant inlet (low) and outlet (high) bosses on the jacket, toward the viewer's side, joined by
    // the coolant return line running up the jacket with two clamps.
    const coolPhi = Math.PI * 0.42;
    const out = new THREE.Vector3(0, Math.cos(coolPhi), Math.sin(coolPhi)).applyQuaternion(q);
    const coolX = [xj1 - 0.03, xj0 + 0.036] as const;
    for (const x of coolX) {
      const at = origin.clone().addScaledVector(axis, x);
      detail.add(oriented(ringGeometry(rj - 0.002, rj + 0.012, 0.0075, 0, 0.0012, 28), mats.finish("machined"), at, out));
      detail.add(oriented(chamferedPrism(rj + 0.012, rj + 0.02, 0.0095, 6, 0.0012), mats.finish("thread"), at, out));
    }
    if (coolX[0] - coolX[1] > 0.04) {
      const pipeAt = origin.clone().addScaledVector(out, rj + 0.016).addScaledVector(axis, coolX[1]);
      detail.add(oriented(ringGeometry(0, coolX[0] - coolX[1], 0.0042, 0, 0.0008, 20), look(LOOKS.line), pipeAt, axis));
      for (const f of [0.3, 0.7]) {
        const x = coolX[1] + f * (coolX[0] - coolX[1]);
        const clamp = new THREE.Mesh(roundedBox(0.012, 0.016, 0.01, 0.002), mats.finish("anodized_dark"));
        clamp.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(axis, out, axis.clone().cross(out).normalize()));
        clamp.position.copy(origin).addScaledVector(axis, x).addScaledVector(out, rj + 0.008);
        detail.add(clamp);
      }
    }
    // Bolted flange between the chamber and the nozzle.
    detail.add(oriented(ringGeometry(lc - 0.007, lc + 0.003, rc + wall + 0.012, rc, 0.0014), mats.finish("machined"), origin, axis));
    boltCircle(detail, mats.finish("thread"), origin, axis, lc + 0.006, rc + wall + 0.008, 10, 0.0022);
    const ign = new THREE.Vector3(0, Math.cos(Math.PI * 0.75), Math.sin(Math.PI * 0.75)).applyQuaternion(q);
    detail.add(oriented(ringGeometry(rHead - 0.004, rHead + 0.016, 0.0055, 0, 0.0012, 24), mats.finish("thread"), origin.clone().addScaledVector(axis, -0.011), ign));
    detail.add(oriented(chamferedPrism(rHead + 0.004, rHead + 0.01, 0.0075, 6, 0.001), mats.finish("machined"), origin.clone().addScaledVector(axis, -0.011), ign));
    // Convergent, throat, and the bell: a solid machined wall (thick lip) outside, the hot-gas
    // surface inside in a darker finish so the bell reads as solid metal, not a thin shell (D29: the
    // proportions are the computed design's).
    const lip = Math.max(wall, 0.004);
    const outer: [number, number][] = [
      [lc, rc + wall],
      [x1, rt + wall],
      [x2 - lip * 0.6, re + lip],
      [x2, re + lip * 0.8],
      [x2, re],
    ];
    const bell = filletPolyline(outer, [0, rt * 1.2, lip * 0.4, lip * 0.35, 0], 6, false);
    detail.add(oriented(revolve(bell, { segments: SEGMENTS }), look(LOOKS.nozzle), origin, axis));
    const inner = filletPolyline(
      [
        [x2, re],
        [x1, rt],
        [lc, rc],
      ],
      [0, rt * 1.0, 0],
      6,
      false,
    );
    detail.add(oriented(revolve(inner, { segments: SEGMENTS }), mats.finish("anodized_dark"), origin, axis));
    // A hat band at mid bell.
    const xm = (x1 + x2) / 2;
    const rm = rt + wall + ((re + lip - (rt + wall)) * (xm - x1)) / Math.max(1e-6, x2 - x1);
    detail.add(oriented(ringGeometry(xm - 0.003, xm + 0.003, rm + 0.0025, rm - 0.001, 0.001), mats.finish("machined"), origin, axis));
    // Thrust structure: a ring round the jacket just under its top collar (clear of the manifold
    // blocks on the head) and two struts per tank to the tank's inboard band, so the engine hangs from
    // the tanks (mounted, not floating).
    const ringX = xj0 + 0.014;
    detail.add(oriented(ringGeometry(ringX, ringX + 0.014, rj + 0.018, rj + 0.002, 0.0015), mats.finish("anodized_dark"), origin, axis));
    for (const t of tanks.values()) {
      const toEngine = Math.sign(origin.clone().sub(t.centre).dot(t.axis)) || 1;
      const band = t.centre.clone().addScaledVector(t.axis, toEngine * t.band).addScaledVector(AXIS.aft, t.radius + 0.006);
      const radialDir = band.clone().sub(origin).projectOnPlane(axis).normalize();
      for (const side of [-1, 1]) {
        const from = band.clone().addScaledVector(AXIS.depth, side * 0.4 * t.radius);
        const to = origin.clone().addScaledVector(radialDir, rj + 0.016).addScaledVector(AXIS.depth, side * 0.014).addScaledVector(axis, ringX + 0.007);
        const d = to.clone().sub(from);
        const len = d.length();
        if (len < 1e-4) continue;
        const strut = new THREE.Mesh(roundedBox(len, 0.012, 0.016, 0.003), mats.finish("anodized_dark"));
        strut.quaternion.setFromUnitVectors(PLUS_X, d.clone().normalize());
        strut.position.copy(from).addScaledVector(d, 0.5);
        detail.add(strut);
        // Clevis blocks at both ends.
        for (const at of [from, to]) {
          const lug = new THREE.Mesh(roundedBox(0.018, 0.018, 0.02, 0.003), mats.finish("machined"));
          lug.quaternion.copy(strut.quaternion);
          lug.position.copy(at);
          detail.add(lug);
        }
      }
    }
    // Throat ring and exit stiffener.
    detail.add(oriented(ringGeometry(x1 - 0.004, x1 + 0.004, rt + wall + 0.004, rt + wall - 0.001, 0.0012), mats.finish("machined"), origin, axis));
    detail.add(oriented(ringGeometry(x2 - 0.006, x2, re + wall * 0.6 + 0.003, re + wall * 0.3, 0.0012), mats.finish("machined"), origin, axis));
    const proxyProf: ProfilePoint[] = [
      { x: -0.04, r: 0 },
      { x: -0.04, r: rHead },
      { x: 0.008, r: rHead },
      { x: 0.008, r: rj + 0.006 },
      { x: lc, r: rj + 0.006 },
      { x: lc, r: rc + wall },
      { x: x1, r: rt + wall },
      { x: x2, r: re + wall },
      { x: x2, r: 0 },
    ];
    builds.push({ id, kind: "engine", proxy: [oriented(revolve(proxyProf, { segments: 32 }), proxyMat, origin, axis)], detail, builder: "liquid-engine" });
  }

  // Aeroshell panels round the tanks, reaching down toward the nozzle exit.
  const decor = new THREE.Group();
  decor.name = "rw-liquid-aeroshell";
  decor.userData["rwProvenance"] = "visual";
  const exitStation = engineExitStation(engine, sizing);
  const shellByTank = new Map<string, THREE.Group>();
  for (const t of aeroshells) {
    const g = aeroshellPanel(t, exitStation, mats);
    shellByTank.set(t.tank, g);
    decor.add(g);
  }

  // Feed lines, with a fitting where each leaves a tank.
  const routes = engine.edges.map((_, i) => routeOf(engine, i));
  for (let i = 0; i < engine.edges.length; i++) {
    const route = routes[i];
    const e = engine.edges[i]!;
    if (!route || route.length < 2) continue;
    // Lines start and end at a tank's shell, not at its centre (nothing hidden inside to outline).
    let pts = route.map((p) => layoutToBody(p.station, p.radial, p.depth));
    const from = tanks.get(e.from);
    const to = tanks.get(e.to);
    if (from) pts = trimInside(pts, (p) => insideTank(p, from));
    if (to) pts = trimInside([...pts].reverse(), (p) => insideTank(p, to)).reverse();
    if (pts.length < 2) continue;
    const ro = lineRadius(e.diameter);
    const path = bentPath(pts, Math.max(3.5 * ro, 0.012));
    const len = path.getLength();
    const seg = Math.min(800, Math.max(24, Math.ceil(len / 0.003)));
    const tube = new THREE.TubeGeometry(path, seg, ro, 18, false);
    const mat = physicalMaterial(LOOKS.line);
    mat.emissive = new THREE.Color("#000000");
    lineMats.set(edgePart(i), mat);
    const ghost = new THREE.Mesh(tube, ghostMat);
    ghost.name = `rw-glow:${edgePart(i)}`;
    ghost.visible = false;
    ghost.renderOrder = 2;
    ghosts.set(edgePart(i), ghost);
    ghostGroup.add(ghost);
    const detail = new THREE.Group();
    detail.add(new THREE.Mesh(tube, mat));
    // A boss where the line leaves (or enters) a tank.
    if (from) detail.add(oriented(chamferedPrism(-0.008, 0.004, ro * 1.9, 6, 0.0012), mats.finish("machined"), path.getPointAt(0), path.getTangentAt(0)));
    if (to) detail.add(oriented(chamferedPrism(-0.004, 0.008, ro * 1.9, 6, 0.0012), mats.finish("machined"), path.getPointAt(1), path.getTangentAt(1)));
    // Union nuts at both ends of the visible run (just outside the end nodes).
    for (const [u, sign] of [
      [0.04, 1],
      [0.96, -1],
    ] as const) {
      const at = path.getPointAt(u);
      const dir = path.getTangentAt(u).multiplyScalar(sign);
      if (insideAnyTank(at, tanks)) continue;
      detail.add(oriented(chamferedPrism(-0.005, 0.005, ro * 1.6, 6, 0.001), mats.finish("thread"), at, dir));
    }
    // Bolted flange joints on the long straight runs (the longest, and a second when it is long too).
    for (const at of flangeStations(pts, Math.max(3.5 * ro, 0.012))) {
      if (insideAnyTank(at.point, tanks)) continue;
      flangePair(detail, mats, at.point, at.dir, ro);
    }
    // Into an engine: a bolted manifold block on the injector head where the line reaches it.
    const head = heads.get(e.to);
    const engineBuild = builds.find((b) => b.id === e.to);
    if (head && engineBuild && ro > 0.004) {
      const inHead = (p: V3) => {
        const d = p.clone().sub(head.origin);
        const x = d.dot(head.axis);
        return x >= head.top - 0.004 && x <= 0.012 && d.addScaledVector(head.axis, -x).length() < head.radius + 0.002;
      };
      const back = trimInside([...pts].reverse(), inHead);
      if (back.length >= 2 && inHead(pts[pts.length - 1]!)) {
        engineBuild.detail.add(manifoldBlock(mats, back[0]!, back[1]!.clone().sub(back[0]!).normalize(), head.axis, ro));
      }
    }
    const proxy = new THREE.Mesh(new THREE.TubeGeometry(path, Math.min(200, seg), ro * 1.6, 8, false), proxyMat);
    builds.push({ id: edgePart(i), kind: "line", proxy: [proxy], detail, builder: "liquid-line" });
  }

  // Valves: ball-valve body on the line, actuator and lever beside it.
  for (const [id, n] of Object.entries(engine.nodes)) {
    if (!n || n.kind !== "valve" || n.station == null) continue;
    const at = layoutToBody(n.station, n.radial ?? 0);
    const inIdx = engine.edges.findIndex((e) => e.to === id);
    const inRoute = inIdx >= 0 ? routes[inIdx] : null;
    let axis = AXIS.aft.clone();
    if (inRoute && inRoute.length >= 2) {
      const a = inRoute[inRoute.length - 2]!;
      const b = inRoute[inRoute.length - 1]!;
      const d = layoutToBody(b.station, b.radial, b.depth).sub(layoutToBody(a.station, a.radial, a.depth));
      if (d.lengthSq() > 1e-12) axis = d.normalize();
    }
    const ro = lineRadius(inIdx >= 0 ? engine.edges[inIdx]!.diameter : null);
    const rb = Math.max(0.022, ro * 3.4);
    const detail = new THREE.Group();
    // Ball-valve body: a bulbous centre, necked ends, and hex union nuts onto the line.
    const body = filletPolyline(
      [
        [-rb * 1.55, 0],
        [-rb * 1.55, rb * 0.62],
        [-rb * 0.8, rb * 0.62],
        [-rb * 0.58, rb],
        [rb * 0.58, rb],
        [rb * 0.8, rb * 0.62],
        [rb * 1.55, rb * 0.62],
        [rb * 1.55, 0],
      ],
      [0, 0.0015, 0.002, rb * 0.35, rb * 0.35, 0.002, 0.0015, 0],
      3,
    );
    detail.add(oriented(revolve(body, { segments: 64 }), mats.finish("machined"), at, axis));
    for (const sgn of [-1, 1]) {
      detail.add(oriented(chamferedPrism(sgn * rb * 1.55 - 0.006, sgn * rb * 1.55 + 0.006, rb * 0.74, 6, 0.0012), mats.finish("thread"), at, axis));
      detail.add(oriented(ringGeometry(sgn > 0 ? rb * 1.55 + 0.006 : -rb * 1.55 - 0.012, sgn > 0 ? rb * 1.55 + 0.012 : -rb * 1.55 - 0.006, ro * 1.35, 0, 0.0008, 24), mats.finish("machined"), at, axis));
    }
    // Actuator toward the viewer and up: bonnet and stem, a mounting yoke, the pneumatic cylinder
    // across it (end caps, tie rods), a solenoid pilot and a position indicator on top.
    // The stem points away from the viewer (Iso looks from the front, right, and above), so the
    // actuator stands above and behind the body on screen and the body stays in view.
    let stemDir = AXIS.depth.clone().negate().addScaledVector(AXIS.radial, -0.3);
    stemDir = stemDir.projectOnPlane(axis);
    if (stemDir.lengthSq() < 1e-6) stemDir = AXIS.depth.clone().negate();
    stemDir.normalize();
    const across = axis.clone().cross(stemDir).normalize();
    const lineAlong = stemDir.clone().cross(across).normalize();
    detail.add(oriented(ringGeometry(rb * 0.7, rb * 1.25, rb * 0.42, 0, 0.0012, 32), mats.finish("machined"), at, stemDir));
    detail.add(oriented(chamferedPrism(rb * 1.25, rb * 1.45, rb * 0.5, 4, 0.0008), mats.finish("thread"), at, stemDir));
    const basis = new THREE.Matrix4().makeBasis(across, stemDir, lineAlong);
    const yoke = new THREE.Mesh(roundedBox(rb * 1.5, rb * 0.55, rb * 1.3, rb * 0.12), mats.finish("anodized_dark"));
    yoke.quaternion.setFromRotationMatrix(basis);
    yoke.position.copy(at).addScaledVector(stemDir, rb * 1.7);
    detail.add(yoke);
    const cylAt = at.clone().addScaledVector(stemDir, rb * 2.75);
    const rcy = rb * 0.95;
    const lcy = rb * 3.4;
    const cyl = tubeProfile({ x0: -lcy / 2, x1: lcy / 2, ro: rcy, ri: 0, bevel: rcy * 0.12, steps: 3, grooves: [0.5], grooveDepth: 0.0008, grooveWidth: 0.0008 });
    detail.add(oriented(revolve(cyl.points, { segments: 48, closed: cyl.closed }), look(LOOKS.actuator), cylAt, across));
    for (const sgn of [-1, 1]) {
      const capAt = cylAt.clone().addScaledVector(across, (sgn * lcy) / 2);
      const cap = new THREE.Mesh(roundedBox(rb * 0.42, rcy * 2.25, rcy * 2.25, rb * 0.1), mats.finish("anodized_dark"));
      cap.quaternion.setFromRotationMatrix(basis);
      cap.position.copy(capAt);
      detail.add(cap);
    }
    for (const [u, v] of [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ] as const) {
      const rodAt = cylAt.clone().addScaledVector(stemDir, u * rcy * 0.9).addScaledVector(lineAlong, v * rcy * 0.9);
      detail.add(oriented(ringGeometry(-lcy / 2 - rb * 0.25, lcy / 2 + rb * 0.25, Math.max(0.0012, rb * 0.06), 0, 0.0004, 10), mats.finish("thread"), rodAt, across));
    }
    const pilot = new THREE.Mesh(roundedBox(rb * 1.2, rb * 0.8, rb * 0.9, rb * 0.12), mats.finish("anodized_dark"));
    pilot.quaternion.setFromRotationMatrix(basis);
    pilot.position.copy(cylAt).addScaledVector(stemDir, rcy + rb * 0.4).addScaledVector(across, -lcy * 0.22);
    detail.add(pilot);
    detail.add(oriented(ringGeometry(rcy, rcy + rb * 0.32, rb * 0.36, 0, rb * 0.08, 24), mats.finish("machined"), cylAt.clone().addScaledVector(across, lcy * 0.22), stemDir));
    detail.add(oriented(ringGeometry(rcy + rb * 0.32, rcy + rb * 0.5, rb * 0.26, 0, rb * 0.1, 24), mats.finish("brass"), cylAt.clone().addScaledVector(across, lcy * 0.22), stemDir));
    const proxy = oriented(revolve(body, { segments: 24 }), proxyMat, at, axis);
    builds.push({ id, kind: "valve", proxy: [proxy], detail, builder: "liquid-valve" });
  }

  // Sensors: pressure transducers on their stub lines.
  for (const [id, n] of Object.entries(engine.nodes)) {
    if (!n || n.kind !== "sensor" || n.station == null) continue;
    const at = layoutToBody(n.station, n.radial ?? 0);
    const stub = engine.edges.findIndex((e) => e.to === id || e.from === id);
    const r = stub >= 0 ? routes[stub] : null;
    let axis = AXIS.aft.clone().negate();
    if (r && r.length >= 2) {
      const toward = engine.edges[stub]!.to === id;
      const a = toward ? r[r.length - 2]! : r[1]!;
      const d = at.clone().sub(layoutToBody(a.station, a.radial, a.depth));
      if (d.lengthSq() > 1e-12) axis = d.normalize();
    }
    const detail = new THREE.Group();
    detail.add(oriented(chamferedPrism(0, 0.008, 0.0095, 6, 0.0012), mats.finish("machined"), at, axis));
    detail.add(oriented(ringGeometry(0.008, 0.036, 0.0078, 0, 0.0018, 40), mats.finish("anodized_dark"), at, axis));
    detail.add(oriented(ringGeometry(0.036, 0.046, 0.0042, 0, 0.0012, 24), mats.finish("graphite"), at, axis));
    const proxy = oriented(ringGeometry(0, 0.046, 0.01, 0, 0, 16), proxyMat, at, axis);
    builds.push({ id, kind: "sensor", proxy: [proxy], detail, builder: "liquid-sensor" });
  }

  // Into an AssemblyModel: one node per part (name = part id), proxies as the base meshes.
  const root = new THREE.Group();
  for (const b of builds) {
    const node = new THREE.Group();
    node.name = b.id;
    node.userData["rw_type"] = b.kind;
    for (const m of b.proxy) node.add(m);
    root.add(node);
  }
  const meta: Record<string, PartMeta> = {};
  for (const b of builds) meta[b.id] = { name: b.id, appearance: null, parent: null };
  const model = new AssemblyModel(root, meta, null);
  const report: LiquidScene["report"] = [];
  for (const b of builds) {
    const part = model.parts.get(b.id);
    if (!part) continue;
    const group = b.detail;
    group.name = `rw-detail:${b.id}`;
    group.userData["rwProvenance"] = "visual";
    group.userData["rwDetail"] = b.builder;
    let meshes = 0;
    let tris = 0;
    const outline: THREE.Mesh[] = [];
    group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.userData["rwPart"] = b.id;
      o.userData["rwProvenance"] = "visual";
      o.castShadow = true;
      o.receiveShadow = true;
      if (needsTangents(o.material as THREE.Material)) ensureTangents(o.geometry);
      meshes++;
      tris += triangleCount(o.geometry);
      outline.push(o);
    });
    part.node.add(group);
    part.detail = group;
    part.detailReplacesBase = true;
    for (const m of part.materials) m.visible = false;
    part.meshes.push(...outline);
    report.push({ id: b.id, builder: b.builder, meshes, triangles: tris });
  }
  model.detailReport = report;
  // Decorative, not a part: no pick, no label, no outline; it follows its tank's visibility (`setHidden`).
  decor.traverse((o) => {
    if (o instanceof THREE.Mesh) o.userData["rwProvenance"] = "visual";
  });
  model.body.add(decor);
  model.decor.push(...shellByTank.values());
  // The x-ray glow is no part and no decor: never picked, outlined, framed, or shadowed.
  ghostGroup.userData["rwProvenance"] = "visual";
  ghostGroup.traverse((o) => {
    if (o instanceof THREE.Mesh) o.userData["rwProvenance"] = "visual";
  });
  model.body.add(ghostGroup);
  model.onDispose(() => {
    for (const b of builds) b.detail.traverse((o) => o instanceof THREE.Mesh && o.geometry.dispose());
    for (const m of lineMats.values()) m.dispose();
    ghostMat.dispose();
    decor.traverse((o) => o instanceof THREE.Mesh && o.geometry.dispose());
    proxyMat.dispose();
    mats.dispose();
  });
  model.root.updateMatrixWorld(true);
  const glow = new THREE.Color(GLOW);
  return {
    model,
    report,
    decor,
    setHidden(parts) {
      const off = new Set(parts);
      for (const [tank, g] of shellByTank) g.visible = !off.has(tank);
    },
    setGlow(parts) {
      const on = new Set(parts);
      for (const [id, m] of lineMats) {
        const lit = on.has(id);
        m.emissive.copy(lit ? glow : new THREE.Color("#000000"));
        m.emissiveIntensity = lit ? 0.55 : 0;
        m.color.set(lit ? "#cfe9e6" : LOOKS.line.color);
        m.needsUpdate = true;
      }
      for (const [id, g] of ghosts) g.visible = on.has(id);
    },
  };
}

// ---- aeroshell panels ------------------------------------------------------------

export interface AeroshellTank {
  tank: string;
  /** Tank centre (layout frame, m). */
  station: number;
  radial: number;
  radius: number;
  half: number;
}

/** Station (m) of the nozzle exit: the engine node's station plus the chamber, convergent, and nozzle lengths. */
export function engineExitStation(engine: EvalEngine, sizing: Sizing | null): number | null {
  for (const n of Object.values(engine.nodes)) {
    if (!n || n.kind !== "engine" || n.station == null) continue;
    const s = sizing ?? fallbackSizing(engine);
    return n.station + s.chamber_length + s.convergent_length + s.nozzle_length;
  }
  return null;
}

/**
 * The panel's shape in the layout frame (station, radial, depth; m): the
 * outboard-front quarter of a vertical skin round the tank's outboard half,
 * from just under the tank down toward the nozzle exit, opened like a door
 * about its outboard edge (the hinge), so its convex skin faces the viewer
 * and the outboard side. Pure (tests).
 */
export function aeroshellShape(t: AeroshellTank, exitStation: number | null): { top: number; bottom: number; axisRadial: number; r: number; sweep: number; open: number; hinge: number } {
  const side = Math.sign(t.radial) || 1;
  const r = 0.9 * t.half;
  // The top edge tucks up under the tank (into its lower half), so the hinge's top is on the tank's head.
  const top = t.station + 0.5 * t.radius;
  const under = t.station + t.radius + 0.012;
  const reach = exitStation !== null ? exitStation - 0.03 - under : 2.4 * t.radius;
  const bottom = under + Math.max(1.2 * t.radius, Math.min(2.6 * t.radius, reach));
  return { top, bottom, axisRadial: t.radial, r, sweep: (78 * Math.PI) / 180, open: side * ((32 * Math.PI) / 180), hinge: t.radial + side * r };
}

/** Layout point of the panel at azimuth `th` (0 = outboard, sweep = front) and station `s`, after the door opens. */
function aeroshellPoint(sh: ReturnType<typeof aeroshellShape>, side: number, th: number, s: number, inset = 0): V3 {
  const rr = sh.r - inset;
  // Closed: round the vertical axis at (axisRadial, depth 0).
  const x = sh.axisRadial + side * rr * Math.cos(th);
  const z = rr * Math.sin(th);
  // Open: rotate about the hinge line (radial = hinge, depth 0), the front edge swinging outboard.
  const dx = x - sh.hinge;
  const c = Math.cos(sh.open);
  const sn = Math.sin(sh.open);
  return layoutToBody(s, sh.hinge + dx * c - z * sn, dx * sn + z * c);
}

/** One aeroshell panel (body frame): the curved skin, rolled lips on its edges, inner ring frames, and the front web. */
function aeroshellPanel(t: AeroshellTank, exitStation: number | null, mats: DetailMaterials): THREE.Group {
  const sh = aeroshellShape(t, exitStation);
  const side = Math.sign(t.radial) || 1;
  const g = new THREE.Group();
  g.name = `rw-aeroshell:${t.tank}`;
  const nu = 24;
  const nv = 40;
  const skin = gridSurface(nu, nv, (i, j, out) => out.copy(aeroshellPoint(sh, side, (sh.sweep * j) / nv, sh.top + ((sh.bottom - sh.top) * i) / nu)), false);
  const skinMat = mats.look(LOOKS.panel);
  g.add(new THREE.Mesh(skin, skinMat));
  const edge = (pts: V3[], r: number, mat: THREE.Material) => {
    const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
    g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(8, pts.length * 2), r, 10, false), mat));
  };
  const arc = (s: number, inset: number) => Array.from({ length: 25 }, (_, k) => aeroshellPoint(sh, side, (sh.sweep * k) / 24, s, inset));
  const line = (th: number, inset: number) => Array.from({ length: 9 }, (_, k) => aeroshellPoint(sh, side, th, sh.top + ((sh.bottom - sh.top) * k) / 8, inset));
  const lip = mats.finish("machined");
  edge(arc(sh.top, 0), 0.0045, lip);
  edge(arc(sh.bottom, 0), 0.0045, lip);
  edge(line(0, 0), 0.0045, lip);
  edge(line(sh.sweep, 0), 0.0045, lip);
  // Ring frames on the inner face.
  const frame = mats.finish("anodized_dark");
  for (const f of [0.33, 0.66]) edge(arc(sh.top + f * (sh.bottom - sh.top), 0.008), 0.0055, frame);
  // The hinge line (the panel's outboard edge, which stays put as the panel peels open): a pin,
  // alternating knuckles on the panel and fixed leaves, and a mount lug up into the tank's head.
  const hingeTop = layoutToBody(sh.top, sh.hinge, 0);
  const hingeBottom = layoutToBody(sh.bottom, sh.hinge, 0);
  const hingeAxis = hingeBottom.clone().sub(hingeTop);
  const hingeLen = hingeAxis.length();
  hingeAxis.normalize();
  const knuckleMat = mats.finish("machined");
  g.add(oriented(ringGeometry(-0.006, hingeLen + 0.006, 0.0032, 0, 0.0008, 16), mats.finish("thread"), hingeTop, hingeAxis));
  const knuckles = 5;
  for (let k = 0; k < knuckles; k++) {
    const x0 = ((k + 0.08) / knuckles) * hingeLen;
    const x1 = ((k + 0.92) / knuckles) * hingeLen;
    g.add(oriented(ringGeometry(x0, x1, 0.0072, 0.0032, 0.001, 24), k % 2 === 0 ? knuckleMat : mats.finish("anodized_dark"), hingeTop, hingeAxis));
  }
  const lug = new THREE.Mesh(roundedBox(0.016, 0.018, Math.max(0.03, 0.9 * (sh.top - t.station)), 0.003), mats.finish("anodized_dark"));
  lug.position.copy(layoutToBody((sh.top + t.station + 0.4 * t.radius) / 2, sh.hinge - side * 0.004, 0));
  g.add(lug);
  // The front web: a flat stiffener plate standing in from the front edge.
  const a = aeroshellPoint(sh, side, sh.sweep, (sh.top + sh.bottom) / 2);
  const b = aeroshellPoint(sh, side, sh.sweep, (sh.top + sh.bottom) / 2, 0.06);
  const web = new THREE.Mesh(roundedBox(sh.bottom - sh.top - 0.01, 0.06, 0.004, 0.0015), mats.finish("machined"));
  // Box x along the station (body -Z), y from the skin inward.
  const inward = b.clone().sub(a).normalize();
  const along = AXIS.aft.clone();
  const m = new THREE.Matrix4().makeBasis(along, inward, along.clone().cross(inward).normalize());
  web.quaternion.setFromRotationMatrix(m);
  web.position.copy(a).addScaledVector(inward, 0.03);
  g.add(web);
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.userData["rwProvenance"] = "visual";
      if (needsTangents(o.material as THREE.Material)) ensureTangents(o.geometry);
    }
  });
  return g;
}

function insideAnyTank(p: V3, tanks: ReadonlyMap<string, { centre: V3; axis: V3; radius: number; half: number }>): boolean {
  for (const t of tanks.values()) if (insideTank(p, t)) return true;
  return false;
}

/** Inside the tank's capsule (the shell, approximated by a capsule of its radius). */
function insideTank(p: V3, t: { centre: V3; axis: V3; radius: number; half: number }): boolean {
  const d = p.clone().sub(t.centre);
  const along = d.dot(t.axis);
  const core = Math.max(0, t.half - t.radius);
  const clamped = Math.max(-core, Math.min(core, along));
  const nearest = t.centre.clone().addScaledVector(t.axis, clamped);
  return p.distanceTo(nearest) < t.radius;
}

/**
 * Drops the leading run of a polyline that lies inside a solid, starting the
 * line where it crosses the surface (bisection on the crossing segment).
 */
export function trimInside(points: readonly V3[], inside: (p: V3) => boolean): V3[] {
  if (points.length < 2 || !inside(points[0]!)) return [...points];
  for (let i = 1; i < points.length; i++) {
    if (inside(points[i]!)) continue;
    let lo = points[i - 1]!.clone();
    let hi = points[i]!.clone();
    for (let k = 0; k < 30; k++) {
      const mid = lo.clone().lerp(hi, 0.5);
      if (inside(mid)) lo = mid;
      else hi = mid;
    }
    return hi.distanceTo(points[i]!) > 1e-6 ? [hi, ...points.slice(i)] : points.slice(i);
  }
  return [...points];
}
