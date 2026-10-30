/** Recursive exploded-view layout (explode.ts) on a research-vehicle-shaped stack. */
import { describe, expect, it } from "vitest";
import { ASSEMBLY_SPACING, explodeOffsets, planExplode, type ExplodeItem } from "./explode.ts";
import { ISO_DIR } from "./views.ts";

const D = 0.0416;
const item = (id: string, kind: string, parent: string | null, lo: number, hi: number, extra: Partial<ExplodeItem> = {}): ExplodeItem => ({
  id,
  kind,
  parent,
  lo,
  hi,
  centreYZ: [0, 0],
  diameter: kind === "body_tube" || kind === "nose_cone" ? D : 0.03,
  clear: false,
  ...extra,
});

// Stations of fixtures/research-vehicle (m from the nose tip).
const RV: ExplodeItem[] = [
  item("nose", "nose_cone", null, 0, 0.18),
  item("recovery_bay", "body_tube", "nose", 0.15, 0.26, { clear: true }),
  item("chute", "parachute", "recovery_bay", 0.17, 0.225),
  item("streamer", "streamer", "recovery_bay", 0.23, 0.25),
  item("airframe", "body_tube", "recovery_bay", 0.26, 0.56),
  item("bulkhead", "bulkhead", "airframe", 0.26, 0.263),
  item("lug", "launch_lug", "airframe", 0.38, 0.43, { centreYZ: [0.017, 0.017], diameter: 0.0056 }),
  item("ebay", "coupler", "airframe", 0.46, 0.56),
  item("flight_computer", "mass_component", "ebay", 0.48, 0.54),
  item("fin_can", "body_tube", "airframe", 0.56, 0.76),
  item("fins", "trapezoidal_fin_set", "fin_can", 0.62, 0.76, { diameter: 0.22 }),
  item("motor_casing", "inner_tube", "fin_can", 0.66, 0.77),
  item("ring_upper", "centering_ring", "motor_casing", 0.665, 0.668),
  item("ring_lower", "centering_ring", "fin_can", 0.752, 0.755),
];

describe("recursive explode", () => {
  const plan = planExplode(RV);

  it("sequences nested parts out of their hosts, fore half ahead and aft half behind", () => {
    expect(plan.order).toEqual(["nose", "recovery_bay", "bulkhead", "airframe", "ebay", "flight_computer", "fin_can", "ring_lower", "ring_upper", "motor_casing"]);
    // Fins ride on the fin can, the stowed contents stay in the clear bay, the lug pops out radially.
    expect(plan.follows.get("fins")).toBe("fin_can");
    expect(plan.follows.get("chute")).toBe("recovery_bay");
    expect(plan.follows.get("streamer")).toBe("recovery_bay");
    expect(plan.follows.get("lug")).toBe("airframe");
    expect(plan.radial.get("lug")![0]).toBeCloseTo(Math.SQRT1_2, 9);
    expect(plan.diameter).toBe(D);
  });

  it("is zero when assembled and separates every sequenced part at 0.6, gaps scaled to length", () => {
    for (const v of explodeOffsets(plan, 0).values()) expect(v).toEqual([0, 0, 0]);
    const o = explodeOffsets(plan, 0.6);
    const at = (id: string) => {
      const it = RV.find((x) => x.id === id)!;
      return { lo: it.lo + o.get(id)![0], hi: it.hi + o.get(id)![0] };
    };
    const gaps: number[] = [];
    for (let i = 1; i < plan.order.length; i++) {
      const g = at(plan.order[i]!).lo - at(plan.order[i - 1]!).hi;
      expect(g, `${plan.order[i - 1]} | ${plan.order[i]}`).toBeGreaterThan(0.5 * D);
      gaps.push(g);
    }
    // Long neighbours get more room than two thin rings.
    const g = (a: string, b: string) => at(b).lo - at(a).hi;
    expect(g("airframe", "ebay")).toBeGreaterThan(g("ring_lower", "ring_upper"));
    // The assembly midpoint stays put; the nose moves fore and the motor aft.
    expect(o.get("nose")![0]).toBeLessThan(-0.1);
    expect(o.get("motor_casing")![0]).toBeGreaterThan(0.1);
    expect(o.get("fins")).toEqual(o.get("fin_can"));
    expect(o.get("lug")![1]).toBeGreaterThan(0.5 * D);
  });

  it("grows monotonically with the slider", () => {
    let prev = 0;
    for (const f of [0.1, 0.2, 0.3, 0.6, 1]) {
      const span = explodeOffsets(plan, f).get("motor_casing")![0] - explodeOffsets(plan, f).get("nose")![0];
      expect(span).toBeGreaterThan(prev);
      prev = span;
    }
  });

  it("tolerates missing parents and cycles", () => {
    const p = planExplode([item("a", "bulkhead", "b", 0, 0.01), item("b", "coupler", "a", 0, 0.1)]);
    expect([...p.order].sort()).toEqual(["a", "b"]);
    expect(planExplode([]).order).toEqual([]);
  });

  it("page 01's spacing keeps every neighbour clear on screen in Iso at 0.6, the far fore end with the most room", () => {
    const p = planExplode(RV, ASSEMBLY_SPACING);
    const sc = ASSEMBLY_SPACING.screen!;
    const o = explodeOffsets(p, sc.at);
    const at = (id: string) => {
      const it = RV.find((x) => x.id === id)!;
      return { lo: it.lo + o.get(id)![0], hi: it.hi + o.get(id)![0], r: it.diameter / 2, lo0: it.lo, hi0: it.hi };
    };
    // Mid-stack Iso angle from ISO_DIR (orthographic): the rule's cot is at least that (perspective adds at the fore end).
    const cosMid = ISO_DIR[0] / Math.hypot(...ISO_DIR);
    expect(sc.cot).toBeGreaterThanOrEqual(cosMid / Math.sqrt(1 - cosMid * cosMid));
    const gaps: number[] = [];
    for (let i = 1; i < p.order.length; i++) {
      const a = at(p.order[i - 1]!), b = at(p.order[i]!);
      const u = ((a.hi0 + b.lo0) / 2 - p.span[0]) / (p.span[1] - p.span[0]);
      const cot = sc.cot + sc.slope * (u - 0.5);
      const gap = b.lo - a.hi;
      // Background between the projected ends, in body diameters along the axis.
      expect(gap - (a.r + b.r) * cot, `${p.order[i - 1]} | ${p.order[i]}`).toBeGreaterThan(0.12 * D);
      gaps.push(gap);
    }
    expect(gaps[0]!).toBeGreaterThan(gaps[gaps.length - 1]!);
  });
});
