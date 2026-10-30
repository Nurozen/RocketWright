/**
 * Page 06 cutaway layout (M5.3), pure: where the shell, tank, feed line,
 * valve, engine inlet, chamber, and nozzle sit in the body frame (+X aft,
 * +Z up, metres, origin at the tank centre), from a visual study's tank and
 * engine proportions (`VisualRun.tank`, `.geometry`).
 *
 * The engine keeps the design's proportions (D29: chamber, throat, and exit
 * diameters, convergent and nozzle lengths, all from `engine_design`),
 * scaled as one so its exit is 0.72 of the shell diameter; only the chamber
 * is shortened to under half a chamber radius (the design's L* chamber would
 * run off the viewport; the real sizing is on the Engineering tab). The
 * feed line is drawn at least 0.11 tank diameters thick so it reads at
 * viewport scale. The feed line is one continuous path from the tank outlet
 * through the valve cluster to the engine-inlet flange on the aft bulkhead
 * (inside the shell), and on through the bulkhead into the injector.
 */
import type { Vec3 } from "./tankSdf.ts";

export interface StudyGeometry {
  tank: { length: number; od: number; wall: number; end_cap: string };
  geometry: {
    throat_diameter: number;
    exit_diameter: number;
    chamber_diameter: number;
    chamber_length: number;
    convergent_length: number;
    nozzle_length: number;
    feed_diameter: number;
  };
}

/** A lathe profile point: radius and axial station (body x), metres. */
export interface ProfilePoint {
  r: number;
  x: number;
}

export interface CutawayLayout {
  /** Tank outer diameter and length. */
  tankOd: number;
  tankLength: number;
  /** Aft dome apex (the outlet), body x. */
  outletX: number;
  /** Shell; `aftX` is the aft face of the aft bulkhead the engine bolts to. */
  shell: { od: number; wall: number; foreX: number; aftX: number };
  /** Aft bulkhead (thrust plate): thickness and the bore the feed line passes. */
  bulkhead: { thickness: number; hole: number };
  /** Internal ring frames: station, axial width, radial depth. */
  frames: { x: number; width: number; depth: number }[];
  /** Tank dome seams (cylinder ends; weld rings and skirts), body x. */
  tankSeams: number[];
  /** Flat-ended tank (else domed). */
  tankFlat: boolean;
  /** Feed line centreline from the outlet to the injector (body frame). */
  feed: Vec3[];
  feedRadius: number;
  /** Valve body: a point of the feed line, the line's direction there, and its size. */
  valve: { at: Vec3; dir: Vec3; radius: number; length: number };
  /**
   * The engine inlet: a bolted flange on the aft bulkhead's fore face where
   * the feed line passes into the engine (on a feed line point, inside the
   * shell). The feed line runs on through the bulkhead to the injector.
   */
  inlet: { at: Vec3; dir: Vec3; radius: number; thickness: number };
  /** Injector head (the engine's manifold, bolted to the bulkhead's aft face). */
  injector: { x: number; radius: number; length: number };
  /** Chamber and nozzle inner contour from the injector face to the exit (body x increasing). */
  nozzle: ProfilePoint[];
  /** Illustrative engine scale. */
  engineScale: number;
  throat: ProfilePoint;
  exit: ProfilePoint;
  /** Label anchors (body frame). */
  anchors: { liquid: Vec3; feed: Vec3; inlet: Vec3; nozzle: Vec3 };
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

export function cutawayLayout(s: StudyGeometry): CutawayLayout {
  const D = s.tank.od;
  const L = s.tank.length;
  const g = s.geometry;
  const shellOd = D * 1.2;
  const outletX = L / 2;
  const k = Math.max(1, (0.72 * shellOd) / Math.max(g.exit_diameter, 1e-3));
  const rc = (k * g.chamber_diameter) / 2;
  const rt = (k * g.throat_diameter) / 2;
  const re = (k * g.exit_diameter) / 2;
  const lc = Math.min(k * g.chamber_length, 0.45 * rc);
  // Convergent and nozzle lengths as designed (D29); a floor only for a degenerate design.
  const lconv = Math.max(k * g.convergent_length, 0.5 * (rc - rt), 0.02 * D);
  const lnoz = Math.max(k * g.nozzle_length, 1.2 * (re - rt), 0.05 * D);
  const feedRadius = Math.max(g.feed_diameter * 0.8, 0.055 * D);
  const bulkT = 0.05 * D;
  // The engine bay: the engine's injector bolts to the bulkhead's aft face at injX.
  const injX = outletX + 0.56 * D;
  // Engine inlet: a flange on the bulkhead's fore face, on the axis, where the feed line enters the engine.
  const inletT = 0.035 * D;
  const inletX = injX - bulkT - inletT / 2;
  // Feed line: aft from the outlet, a dog-leg through the valve cluster, and back to the axis into the
  // engine inlet (a routed line). The valve sits on a feed line point, the inlet on another. The
  // dog-leg drops below the axis (body -Z): that side of the bay is open to the camera through the section.
  const valveAt: Vec3 = [outletX + 0.25 * D, 0, -0.115 * D];
  const feed: Vec3[] = [
    [outletX - 0.01 * D, 0, 0],
    [outletX + 0.06 * D, 0, 0],
    [outletX + 0.14 * D, 0, -0.075 * D],
    valveAt,
    [outletX + 0.355 * D, 0, -0.09 * D],
    [inletX - 0.06 * D, 0, -0.02 * D],
    [inletX, 0, 0],
    [injX, 0, 0],
  ];
  const vi = feed.indexOf(valveAt);
  const vd: Vec3 = [feed[vi + 1]![0] - feed[vi - 1]![0], 0, feed[vi + 1]![2] - feed[vi - 1]![2]];
  const vn = Math.hypot(vd[0], vd[2]) || 1;
  const injector = { x: injX, radius: rc * 1.18, length: 0.13 * D };
  const x0 = injX + injector.length;
  const shellOdW = 0.05 * shellOd;
  const foreX = -L / 2 - 1.8 * L;
  // Ring frames every ~0.42 shell diameters forward of the bulkhead, clear of the tank seams.
  const seams = s.tank.end_cap === "flat" ? [-L / 2, L / 2] : [-(L - D) / 2, (L - D) / 2];
  const frames: { x: number; width: number; depth: number }[] = [];
  for (let x = injX - bulkT - 0.32 * shellOd; x > foreX + 0.1 * shellOd; x -= 0.42 * shellOd)
    if (seams.every((sx) => Math.abs(sx - x) > 0.08 * shellOd)) frames.push({ x, width: 0.03 * shellOd, depth: Math.min(0.034 * shellOd, 0.8 * (shellOd / 2 - shellOdW - D / 2)) });
  const nozzle: ProfilePoint[] = [];
  const N1 = 6;
  for (let i = 0; i <= N1; i++) nozzle.push({ r: rc, x: x0 + (lc * i) / N1 });
  const N2 = 10;
  for (let i = 1; i <= N2; i++) {
    const f = i / N2;
    // Cosine blend from the chamber to the throat.
    nozzle.push({ r: lerp(rc, rt, 0.5 - 0.5 * Math.cos(Math.PI * f)), x: x0 + lc + lconv * f });
  }
  const N3 = 18;
  for (let i = 1; i <= N3; i++) {
    const f = i / N3;
    // Bell: a round throat blending into the flare, opening to the exit (the design's area ratio).
    nozzle.push({ r: rt + (re - rt) * (1 - Math.pow(1 - f, 1.7)), x: x0 + lc + lconv + lnoz * f });
  }
  const throat = { r: rt, x: x0 + lc + lconv };
  const exit = { r: re, x: x0 + lc + lconv + lnoz };
  return {
    tankOd: D,
    tankLength: L,
    outletX,
    shell: { od: shellOd, wall: shellOdW, foreX, aftX: injX },
    bulkhead: { thickness: bulkT, hole: feedRadius * 1.15 },
    frames,
    tankSeams: seams,
    tankFlat: s.tank.end_cap === "flat",
    feed,
    feedRadius,
    // The valve cluster reads at viewport scale: a body well over twice the line's radius.
    valve: { at: valveAt, dir: [vd[0] / vn, 0, vd[2] / vn], radius: feedRadius * 2.5, length: 0.17 * D },
    inlet: { at: [inletX, 0, 0], dir: [1, 0, 0], radius: feedRadius * 3.2, thickness: inletT },
    injector,
    nozzle,
    engineScale: k,
    throat,
    exit,
    anchors: {
      // In the liquid (aft, low side of the tank, toward the viewer).
      liquid: [0.12 * L, -0.25 * D, -0.12 * D],
      feed: feed[2]!,
      // On the inlet flange's face, on the camera's side (body -Y).
      inlet: [inletX, -0.8 * feedRadius * 3.2, 0],
      nozzle: [lerp(throat.x, exit.x, 0.6), 0, lerp(rt, re, 0.75)],
    },
  };
}

/** Distance from `p` to the polyline (closest segment). */
export function distanceToPolyline(p: Vec3, line: readonly Vec3[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ap: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    const f = len2 > 0 ? Math.min(1, Math.max(0, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2)) : 0;
    best = Math.min(best, Math.hypot(ap[0] - f * ab[0], ap[1] - f * ab[1], ap[2] - f * ab[2]));
  }
  return best;
}

/** Nozzle inner radius at body x (linear in the profile; 0 outside it). */
export function nozzleRadiusAt(l: CutawayLayout, x: number): number {
  const p = l.nozzle;
  if (x < p[0]!.x || x > p[p.length - 1]!.x) return 0;
  for (let i = 0; i + 1 < p.length; i++) {
    const a = p[i]!;
    const b = p[i + 1]!;
    if (x >= a.x && x <= b.x) return b.x > a.x ? lerp(a.r, b.r, (x - a.x) / (b.x - a.x)) : a.r;
  }
  return p[p.length - 1]!.r;
}
