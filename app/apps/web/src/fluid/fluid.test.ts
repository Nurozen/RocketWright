/**
 * M5.2/M5.3 page 06 visual fluid, the pure parts: the tank SDF and volume,
 * the MLS-MPM grid over the tank, settled seeding (fill and the centre of
 * mass shift with the apparent gravity), the study timeline, the cutaway
 * layout, and the streamlines' continuity from the tank to the nozzle exit.
 * The GPU kernels are covered live by `app/e2e/fluid.spec.ts`.
 */
import { describe, expect, it } from "vitest";
import study from "../../spikes/propsim/study-01.visual.json";
import { cutawayLayout, distanceToPolyline, nozzleRadiusAt } from "./layout.ts";
import { catmullRom, pointAt, arcLengths, streamlines } from "./streamlines.ts";
import { activeCount, centreOfMass, downOf, fillOf, fluidGrid, seedSettled, tankShape, tankSdf, tankVolume, type Vec3 } from "./tankSdf.ts";
import { clockLabel, parseVisualRun, sampleAt, traces, type VisualRun } from "./timeline.ts";

const RUN = study as unknown as VisualRun;
const TANK = { length: 0.4112, od: 0.1524, wall: 0.003, end_cap: "hemispherical" as const };

describe("tank SDF", () => {
  const s = tankShape(TANK);
  it("is the inner capsule of the demo tank, its volume the design's", () => {
    expect(s.radius).toBeCloseTo(0.0732, 6);
    expect(s.halfLength).toBeCloseTo(0.1294, 6);
    expect(tankVolume(s)).toBeCloseTo(RUN.tank.volume, 6);
  });
  it("is negative inside, zero on the wall, positive outside", () => {
    expect(tankSdf(s, [0, 0, 0])).toBeCloseTo(-s.radius, 9);
    expect(tankSdf(s, [0, s.radius, 0])).toBeCloseTo(0, 9);
    expect(tankSdf(s, [s.halfLength + s.radius, 0, 0])).toBeCloseTo(0, 9);
    expect(tankSdf(s, [0, 0, s.radius + 0.01])).toBeCloseTo(0.01, 9);
  });
  it("flat ends make a capped cylinder", () => {
    const f = tankShape({ ...TANK, end_cap: "flat" });
    expect(f.capsule).toBe(false);
    expect(tankVolume(f)).toBeCloseTo(Math.PI * f.radius ** 2 * (TANK.length - 2 * TANK.wall), 9);
    expect(tankSdf(f, [f.halfLength + 0.01, 0, 0])).toBeCloseTo(0.01, 9);
  });
});

describe("MLS-MPM grid and seeding", () => {
  const s = tankShape(TANK);
  const g = fluidGrid(s, RUN.tank.fill0);
  it("holds about 32k particles at the initial fill, the tank inside its margin", () => {
    expect(g.maxParticles).toBeGreaterThan(30000);
    expect(g.maxParticles).toBeLessThan(36000);
    expect(fillOf(g, g.maxParticles)).toBeCloseTo(RUN.tank.fill0, 9);
    expect(g.dims[0] * g.h).toBeGreaterThan(TANK.length - 2 * TANK.wall);
    expect(g.dims[1] * g.h).toBeGreaterThan(2 * s.radius);
  });
  it("drains by particle count: fill fraction to active particles and back within one particle", () => {
    for (const f of [0.6, 0.45, 0.2, 0.01, 0]) expect(Math.abs(fillOf(g, activeCount(g, f)) - f)).toBeLessThanOrEqual(g.particleVolume / g.tankVolume);
    expect(activeCount(g, 2)).toBe(g.maxParticles);
  });
  it("settles the liquid along the apparent gravity: lowest first, all inside the tank", () => {
    const f = RUN.samples[0]!.specific_force;
    const { positions, active } = seedSettled(g, s, 0.6, downOf(f), 7);
    expect(active).toBe(g.maxParticles);
    for (let i = 0; i < 2000; i++) {
      const p: Vec3 = [positions[i * 3]! * g.h + g.origin[0], positions[i * 3 + 1]! * g.h + g.origin[1], positions[i * 3 + 2]! * g.h + g.origin[2]];
      expect(tankSdf(s, p)).toBeLessThan(0);
    }
    // Ordered by height along the apparent gravity: the last particle is the highest.
    const d = downOf(f);
    const k = (i: number) => positions[i * 3]! * d[0] + positions[i * 3 + 1]! * d[1] + positions[i * 3 + 2]! * d[2];
    expect(k(0)).toBeGreaterThan(k(g.maxParticles - 1));
  });
  it("shifts the centre of mass with the tilt", () => {
    const com = (tilt: number) => {
      const th = (tilt * Math.PI) / 180;
      const f = [-9.81 * Math.cos(th), 0, 9.81 * Math.sin(th)];
      const { positions } = seedSettled(g, s, 0.4, downOf(f), 3);
      return centreOfMass(g, positions, activeCount(g, 0.4));
    };
    const upright = com(0);
    const tilted = com(70);
    expect(upright[0]).toBeGreaterThan(0.05); // aft
    expect(Math.abs(upright[2])).toBeLessThan(0.005);
    expect(tilted[2]).toBeLessThan(upright[2] - 0.02); // down the body's -Z side
    expect(tilted[0]).toBeLessThan(upright[0]); // less aft
  });
});

describe("study timeline", () => {
  it("parses visual.json and refuses other records", () => {
    expect(parseVisualRun(JSON.stringify(RUN)).provenance).toBe("visual");
    expect(() => parseVisualRun(JSON.stringify({ engine: "demo", run_id: "x", provenance: "engineering", blowdown: {} }))).toThrow(/not a visual run/);
  });
  it("samples linearly between grid points and clamps to the study", () => {
    const a = RUN.samples[10]!;
    const b = RUN.samples[11]!;
    const mid = sampleAt(RUN, (a.t + b.t) / 2);
    expect(mid.fillFraction).toBeCloseTo((a.fill_fraction + b.fill_fraction) / 2, 9);
    expect(mid.specificForce[2]).toBeCloseTo((a.specific_force[2]! + b.specific_force[2]!) / 2, 9);
    expect(sampleAt(RUN, -1).t).toBe(0);
    expect(sampleAt(RUN, 99).t).toBe(RUN.duration);
    expect(sampleAt(RUN, 0).fillFraction).toBeCloseTo(RUN.tank.fill0, 6);
  });
  it("traces run over normalized time from the record", () => {
    const tr = traces(RUN);
    expect(tr.flow).toHaveLength(RUN.samples.length);
    expect(tr.flow[0]).toEqual([0, 1]);
    expect(tr.fill.at(-1)![0]).toBe(1);
    expect(clockLabel(0, 10)).toBe("0.0 s / 10.0 s");
  });
});

describe("cutaway layout and streamlines", () => {
  const l = cutawayLayout(RUN);
  const s = tankShape(TANK);
  it("orders the parts aft: outlet, feed line, inlet, chamber, throat, exit", () => {
    expect(l.feed[0]![0]).toBeLessThan(l.outletX);
    expect(l.feed.at(-1)![0]).toBe(l.injector.x);
    expect(l.nozzle[0]!.x).toBeGreaterThan(l.injector.x);
    expect(l.throat.x).toBeGreaterThan(l.nozzle[0]!.x);
    expect(l.exit.x).toBeGreaterThan(l.throat.x);
    expect(l.throat.r).toBeLessThan(l.exit.r);
    // Exit at 0.72 of the shell diameter (illustrative scale); diameters and the convergent and nozzle lengths in the design's proportions (D29).
    expect(2 * l.exit.r).toBeCloseTo(0.72 * l.shell.od, 6);
    const g = RUN.geometry;
    expect(l.nozzle[0]!.r / l.throat.r).toBeCloseTo(g.chamber_diameter / g.throat_diameter, 6);
    expect((l.exit.x - l.throat.x) / l.throat.r).toBeCloseTo((2 * g.nozzle_length) / g.throat_diameter, 6);
    expect((l.throat.x - l.nozzle[0]!.x) / l.throat.r).toBeGreaterThan(0);
    expect(l.exit.r / l.throat.r).toBeCloseTo(RUN.geometry.exit_diameter / RUN.geometry.throat_diameter, 6);
    expect(nozzleRadiusAt(l, l.throat.x)).toBeCloseTo(l.throat.r, 9);
  });
  it("run continuously from the liquid through the feed line and nozzle to the exit", () => {
    const lines = streamlines(l, s, 11);
    expect(lines).toHaveLength(11);
    const feed = catmullRom(l.feed, 8);
    for (const line of lines) {
      const pts = line.points;
      for (let i = 0; i <= line.tankEnd; i++) expect(tankSdf(s, pts[i]!)).toBeLessThan(0.002);
      // No jumps: every step is short against the tank diameter.
      for (let i = 1; i < pts.length; i++) expect(Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1], pts[i]![2] - pts[i - 1]![2])).toBeLessThan(0.15 * l.tankOd);
      // Inside the feed line, inside the nozzle, ending on the exit plane (no stubs past it, R20-06).
      for (const p of pts.filter((p) => p[0] > l.outletX + 0.02 * l.tankOd && p[0] < l.injector.x - 0.02 * l.tankOd)) expect(distanceToPolyline(p, feed)).toBeLessThan(l.feedRadius);
      for (const p of pts.filter((p) => p[0] > l.nozzle[0]!.x)) expect(Math.hypot(p[1], p[2])).toBeLessThanOrEqual(nozzleRadiusAt(l, Math.min(p[0], l.exit.x)) + 1e-9);
      for (const p of pts) expect(p[0]).toBeLessThanOrEqual(l.exit.x + 1e-12);
      expect(pts.at(-1)![0]).toBeCloseTo(l.exit.x, 12);
    }
  });
  it("fan out in the tank toward the viewer and converge on the outlet (flow lines, not ribs round the liquid)", () => {
    const lines = streamlines(l, s, 8);
    const R = s.radius;
    for (const line of lines) {
      const tank = line.points.slice(0, line.tankEnd + 1);
      // On the camera's side of the axis (-Y), never wrapped round the back of the liquid.
      for (const p of tank) expect(p[1]).toBeLessThanOrEqual(l.feedRadius);
      for (const p of tank) expect(p[1]).toBeGreaterThan(-0.6 * R);
      // Heading aft all the way to the outlet.
      for (let i = 1; i < tank.length; i++) expect(tank[i]![0]).toBeGreaterThanOrEqual(tank[i - 1]![0] - 1e-9);
      expect(Math.hypot(tank.at(-1)![1], tank.at(-1)![2])).toBeLessThan(l.feedRadius);
    }
    // The fan spans the tank's height (body z) at the start.
    const z = lines.map((x) => x.points[0]![2]);
    expect(Math.max(...z) - Math.min(...z)).toBeGreaterThan(R);
  });
  it("places arrowheads along a line by arc length", () => {
    const line = streamlines(l, s, 3)[0]!;
    const len = arcLengths(line.points);
    const a = pointAt(line.points, len, 0);
    const b = pointAt(line.points, len, 1);
    expect(a.p).toEqual(line.points[0]);
    expect(b.p[0]).toBeCloseTo(line.points.at(-1)![0], 9);
    expect(Math.hypot(...a.t)).toBeCloseTo(1, 9);
  });
});
