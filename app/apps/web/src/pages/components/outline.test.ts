/**
 * R6.4 freeform fins: outline point operations, the local RW-E061 mirror
 * (the same cases as rw-model's freeform tests), source literals, the editor
 * frame, and the planform the profile and part preview draw (the outline,
 * never a zero-span ellipse).
 */
import type { schema } from "@rw/contracts";
import { describe, expect, it } from "vitest";
import { outlineLayout } from "./PartProfile.tsx";
import { finOutlines, finPlanform, fitFrame, modelExtents } from "./profile-geometry.ts";
import { canRemove, firstCrossing, fromPx, insertPoint, movePoint, outlineFrame, outlineProblem, outlineSource, polygonArea, removePoint, snapPoint, toPx, type Pt } from "./outline.ts";

const mm = (pts: [number, number][]): Pt[] => pts.map(([x, y]) => [x / 1000, y / 1000]);
const FIN = mm([
  [0, 0],
  [20, 50],
  [60, 50],
  [80, 0],
]);

describe("outline point operations", () => {
  it("adds on an edge, moves with the root ends pinned, and removes within limits", () => {
    const added = insertPoint(FIN, 1);
    expect(added).toHaveLength(5);
    expect(added[2]![0]).toBeCloseTo(0.04, 9);
    expect(added[2]![1]).toBeCloseTo(0.05, 9);
    expect(movePoint(FIN, 0, [0.005, 0.02])).toEqual([[0.005, 0], ...FIN.slice(1)]);
    expect(movePoint(FIN, 1, [0.01, -0.01])[1]).toEqual([0.01, 0]);
    expect(canRemove(FIN, 0)).toBe(false);
    expect(canRemove(FIN, 3)).toBe(false);
    expect(canRemove(FIN, 1)).toBe(true);
    expect(removePoint(FIN, 1)).toHaveLength(3);
    expect(canRemove(removePoint(FIN, 1), 1)).toBe(false);
  });

  it("writes source literals in display units", () => {
    expect(outlineSource(FIN.slice(0, 2), "mm")).toEqual([
      ["0 mm", "0 mm"],
      ["20 mm", "50 mm"],
    ]);
    expect(outlineSource([[0.0254, 0.0127]], "in")).toEqual([["1 in", "0.5 in"]]);
  });

  it("maps the editor frame both ways and snaps", () => {
    const f = outlineFrame(FIN, 360, 170);
    const [sx, sy] = toPx(f, FIN[2]!);
    const back = fromPx(f, sx, sy);
    expect(back[0]).toBeCloseTo(0.06, 9);
    expect(back[1]).toBeCloseTo(0.05, 9);
    expect(toPx(f, [0, 0])[1]).toBe(f.oy);
    expect(snapPoint([0.01234, 0.0496], "mm")).toEqual([0.0125, 0.0495]);
  });
});

describe("local RW-E061 outline rules", () => {
  it("accepts a valid convex or notched outline", () => {
    expect(outlineProblem(FIN)).toBeNull();
    // rw-model freeform_valid_concave_is_clean: repeated point and explicit closing point.
    expect(
      outlineProblem(
        mm([
          [0, 0],
          [20, 50],
          [20, 50],
          [50, 30],
          [80, 50],
          [100, 0],
          [0, 0],
        ]),
      ),
    ).toBeNull();
  });

  it("rejects a bow tie, a fold-back spike, off-root ends, too few points, and no area", () => {
    const bow = outlineProblem(
      mm([
        [0, 0],
        [40, 30],
        [40, 0],
        [0, 30],
        [20, 0],
      ]),
    );
    expect(bow?.message).toMatch(/crosses itself/);
    expect(bow?.edges.length).toBe(2);
    expect(
      firstCrossing(
        mm([
          [0, 0],
          [0, 30],
          [0, 10],
          [40, 0],
        ]),
      ),
    ).not.toBeNull();
    expect(
      outlineProblem(
        mm([
          [0, 0],
          [30, 20],
          [60, 10],
        ]),
      )?.message,
    ).toMatch(/end on the root/);
    expect(outlineProblem(FIN.slice(0, 2))?.message).toMatch(/at least 3/);
    expect(
      outlineProblem(
        mm([
          [0, 0],
          [30, 0],
          [60, 0],
        ]),
      )?.message,
    ).toMatch(/no area|crosses itself/);
    expect(polygonArea(FIN)).toBeLessThan(0);
  });
});

const freeform = (points: Pt[]): schema.EvalComponent =>
  ({
    id: "ff",
    name: "Freeform fins",
    children: [],
    containment: "surface",
    aero: true,
    cut: false,
    x_fore: 0.3,
    x_aft: 0.38,
    radial: 0,
    roll: 0,
    instances: [
      { index: 0, roll: Math.PI / 2, offset: [0, 0, 0] },
      { index: 1, roll: -Math.PI / 2, offset: [0, 0, 0] },
    ],
    anchors: [
      { name: "root_le", x: 0.3, r: 0.025 },
      { name: "root_te", x: 0.38, r: 0.025 },
    ],
    shape: { type: "freeform_fin_set", count: 2, thickness: 0.003, points: points.map((p) => [p[0], p[1]]) },
  }) as unknown as schema.EvalComponent;

describe("freeform planform", () => {
  it("draws the outline from the root LE, not a zero-span ellipse", () => {
    const plan = finPlanform(freeform(FIN))!;
    expect(plan).toHaveLength(4);
    expect(plan[1]![0]).toBeCloseTo(0.32, 9);
    expect(plan[1]![1]).toBeCloseTo(0.075, 9);
    const e = modelExtents([{ components: [freeform(FIN)] } as never]);
    expect(e.r).toBeCloseTo(0.075, 9);
  });

  it("keeps a notch in the facing outline (no convex hull)", () => {
    const notched = mm([
      [0, 0],
      [20, 50],
      [50, 20],
      [80, 50],
      [100, 0],
    ]);
    const c = freeform(notched);
    const frame = fitFrame({ x0: 0, x1: 0.5, r: 0.08 }, 800, 400, "side");
    const [up] = finOutlines(c, frame, "side");
    expect(up!.facing).toBe(true);
    expect(up!.points).toHaveLength(5);
  });

  it("dimensions the part preview with the root chord and span", () => {
    const L = outlineLayout(FIN);
    expect(L.root).toBeCloseTo(0.08, 9);
    expect(L.span).toBeCloseTo(0.05, 9);
    expect(L.pts).toHaveLength(4);
    expect(L.yTip).toBeLessThan(L.yRoot);
  });
});
