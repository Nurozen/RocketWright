/**
 * M5.4 page 06 Imported CFD units: the run record (`cfd.json`) parsing, its
 * URL, the scalar columns, the per-step range (Acc 9: the file's min and
 * max), the colormap ends, the undistorted projection, and the labels.
 */
import { describe, expect, it } from "vitest";
import { cfdRunUrl, colormap, formatValue, normalize, parseCfdRecord, projectStep, scalarColumns, scalarLabel, stepRange, timeLabel, VIRIDIS, type CfdRecord } from "./cfdModel.ts";
import { provenanceLabel } from "./model.ts";

const REC: CfdRecord = {
  id: "tank",
  run_id: "7ac466152fda",
  provenance: "cfd",
  frame: "body",
  columns: ["x", "y", "z", "vx", "vy", "vz", "p", "alpha"],
  units: { x: "m", y: "m", z: "m", vx: "m/s", vy: "m/s", vz: "m/s", p: "Pa", alpha: "1" },
  sources: [],
  dataset: {
    id: "tank",
    sim: "cfd.tank",
    run_id: "7ac466152fda",
    files: ["fixtures/cfd/tank_t0.0.csv", "fixtures/cfd/tank_t1.0.csv"],
    times: [0, 1],
    scalars: [],
    has_velocity: true,
    point_count: 6,
    provenance: "cfd",
  },
  steps: [
    { file: "fixtures/cfd/tank_t0.0.csv", time: 0, points: 3, values: [[0, 1, 2], [0, 0, 0], [0, 0.5, 1], [0, 0, 0], [0, 0, 0], [0, 0, 0], [4.5e6, 4.2e6, 3.9e6], [0, 0.5, 1]] },
    { file: "fixtures/cfd/tank_t1.0.csv", time: 1, points: 3, values: [[0, 1, 2], [0, 0, 0], [0, 0.5, 1], [0, 0, 0], [0, 0, 0], [0, 0, 0], [4e6, 4e6, 4e6], [0.2, 0.3, 0.4]] },
  ],
};

describe("cfd run record", () => {
  it("parses cfd.json and rejects anything else", () => {
    expect(parseCfdRecord(JSON.stringify(REC)).steps).toHaveLength(2);
    expect(() => parseCfdRecord("{}")).toThrow(/not a CFD run record/);
    expect(() => parseCfdRecord(JSON.stringify({ ...REC, columns: ["x", "y", "p"] }))).toThrow(/no z column/);
    const bad = { ...REC, steps: [{ ...REC.steps[0]!, values: [[0]] }] };
    expect(() => parseCfdRecord(JSON.stringify(bad))).toThrow(/do not match/);
  });

  it("builds the run URL", () => {
    expect(cfdRunUrl("http://127.0.0.1:9/", "p 1", "cfd.tank", "7ac466152fda")).toBe("http://127.0.0.1:9/api/projects/p%201/runs/cfd.tank/7ac466152fda/cfd.json");
  });

  it("lists scalars and takes each step's range from its own file (Acc 9)", () => {
    expect(scalarColumns(REC)).toEqual(["p", "alpha"]);
    expect(stepRange(REC, REC.steps[0]!, "p")).toEqual({ min: 3.9e6, max: 4.5e6 });
    expect(stepRange(REC, REC.steps[1]!, "alpha")).toEqual({ min: 0.2, max: 0.4 });
    expect(() => stepRange(REC, REC.steps[0]!, "T")).toThrow(/no column T/);
  });

  it("maps the range onto viridis end to end", () => {
    expect(colormap(0)).toEqual([0x44, 0x01, 0x54]);
    expect(colormap(1)).toEqual([0xfd, 0xe7, 0x25]);
    expect(colormap(-1)).toEqual(colormap(0));
    expect(colormap(Number.NaN)).toEqual(colormap(0));
    expect(VIRIDIS).toHaveLength(11);
    expect(normalize(4e6, 4e6, 4e6)).toBe(0.5);
    expect(normalize(4.2e6, 3.9e6, 4.5e6)).toBeCloseTo(0.5, 12);
  });

  it("projects with one scale for both axes over the dataset's bounds", () => {
    const p = projectStep(REC, REC.steps[0]!, "side", 220, 120, 10);
    // x spans 2 m, z 1 m: the scale is min(200/2, 100/1) = 100 px/m.
    expect([...p.px]).toEqual([10, 110, 210]);
    expect([...p.py]).toEqual([110, 60, 10]);
    expect(p.order).toHaveLength(3);
    const end = projectStep(REC, REC.steps[0]!, "end", 100, 100, 0);
    expect(end.order[2]).toBe(2); // the most aft point is nearest, drawn last
  });

  it("labels values, scalars, times, and provenance", () => {
    expect(formatValue(4506452.5)).toBe("4,506,453");
    expect(formatValue(3.2e10)).toBe("3.2e+10");
    expect(formatValue(277.2)).toBe("277.2");
    expect(formatValue(0)).toBe("0");
    expect(formatValue(0.00012)).toBe("1.2e-4");
    expect(scalarLabel(REC, "p")).toBe("p (Pa)");
    expect(scalarLabel(REC, "alpha")).toBe("alpha");
    expect(timeLabel(0.5)).toBe("t = 0.5 s");
    expect(provenanceLabel(REC.provenance)).toBe("Imported CFD result");
  });
});
