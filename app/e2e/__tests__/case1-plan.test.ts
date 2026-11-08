/** The B1 plan and script against the fixture they must cover (D14). */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadCase1Plan, type Case1Plan } from "../case1-plan.ts";
import { FIXTURE_DIR, NOT_DRIVEN, SCRIPT_ROWS, boundRows, sourceFields, typedValue, type BoundRow, type ScriptRow } from "../case1-script.ts";
import { STAGE_IDS } from "../case1-stages.ts";
import { sidecarBinary } from "../live.ts";

let plan: Case1Plan;

const badLabels = (rows: readonly ScriptRow[]): string[] => rows.filter((r) => r.label === r.key.split(".").at(-1) || r.label === r.key || r.label.includes("_")).map((r) => r.key);

beforeAll(() => {
  plan = loadCase1Plan(sidecarBinary());
}, 300_000);

describe("loadCase1Plan", () => {
  it("covers the 11 parts and four materials", () => {
    expect(plan.model.components.map((c) => c.id).sort()).toEqual(["block", "body", "chute", "cord", "fins", "lug", "mmt", "nose", "ring_aft", "ring_fore", "wadding"]);
    expect(Object.keys(plan.model.materials).sort()).toEqual(["cardboard", "elastic_cord", "polystyrene", "ripstop_nylon"]);
    expect(plan.dryMass).toBeGreaterThan(0.04);
    expect(plan.dryMass).toBeLessThan(0.06);
  });

  it("evaluates a copy and leaves the fixture alone", () => {
    expect(existsSync(join(FIXTURE_DIR, ".rw"))).toBe(false);
  });
});

describe("the script", () => {
  const fields = sourceFields();
  const keys = new Set(SCRIPT_ROWS.map((r) => r.key));

  it("has exactly one row for every source field the drive enters", () => {
    expect(SCRIPT_ROWS.map((r) => r.key).sort()).toEqual([...keys].sort());
    expect(fields.filter((f) => !keys.has(f.key) && NOT_DRIVEN[f.key] === undefined).map((f) => f.key)).toEqual([]);
  });

  it("lists D14's fields, not only the spec's minimum", () => {
    for (const k of [
      "c.chute.attach.offset",
      "c.nose.shape_param",
      "c.nose.shoulder.capped",
      "c.chute.cd",
      "c.chute.line_count",
      "c.chute.line_length",
      "c.chute.line_material",
      "c.chute.packed_length",
      "c.chute.packed_diameter",
      "c.cord.cord_length",
      "c.mmt.motor_mount",
      "c.mmt.overhang",
    ]) {
      expect(keys.has(k), k).toBe(true);
    }
  });

  it("has no row without a source field, and no exclusion that hides a row or a stale key", () => {
    const all = new Set(fields.map((f) => f.key));
    expect([...keys].filter((k) => !all.has(k))).toEqual([]);
    expect(Object.keys(NOT_DRIVEN).filter((k) => !all.has(k))).toEqual([]);
    expect(Object.keys(NOT_DRIVEN).filter((k) => keys.has(k))).toEqual([]);
    expect(Object.values(NOT_DRIVEN).filter((why) => why.trim() === "")).toEqual([]);
  });

  it("uses words a person sees: no source key and no underscore as a label", () => {
    expect(badLabels(SCRIPT_ROWS)).toEqual([]);
    expect(SCRIPT_ROWS.filter((r) => r.label.trim() === "").map((r) => r.key)).toEqual([]);
  });

  it("rejects a label that is its source key or holds an underscore", () => {
    const at = { stage: "nose", control: "number" } as const;
    expect(badLabels([{ ...at, key: "c.nose.od", label: "od" }, { ...at, key: "c.nose.shape_param", label: "Shape_param" }, { ...at, key: "c.nose.length", label: "Length" }])).toEqual(["c.nose.od", "c.nose.shape_param"]);
  });

  it("belongs every row to a known stage", () => {
    expect(SCRIPT_ROWS.filter((r) => !(STAGE_IDS as readonly string[]).includes(r.stage)).map((r) => r.key)).toEqual([]);
  });

  it("types each number in the unit the row says is shown", () => {
    const rows = boundRows(fields);
    const typed = (key: string) => typedValue(rows.find((r) => r.key === key)!);
    expect(typed("c.nose.length")).toBe("100");
    expect(typed("c.lug.attach.offset")).toBe("-17.5");
    expect(typed("c.lug.attach.spin")).toBe("19");
    expect(typed("c.nose.finish.roughness")).toBe("60");
    expect(typed("c.chute.cd")).toBe("0.8");
    expect(typed("c.fins.count")).toBe("3");
    expect(typed("materials.cardboard.density")).toBe("680");
    expect(typed("sim.wind.speed")).toBe("0");
    for (const r of rows) expect(() => typedValue(r), r.key).not.toThrow();
  });

  it("refuses a row whose unit the fixture does not write", () => {
    const row: BoundRow = { key: "c.nose.length", stage: "nose", control: "number", label: "Length", unit: "in", value: "100 mm" };
    expect(() => typedValue(row)).toThrow(/the fixture writes mm/);
  });

  it("fails on a row with no source field", () => {
    expect(() => boundRows([])).toThrow(/has no source field/);
  });

  it("finds every field of a mutated fixture missing a row (the coverage check is real)", () => {
    const extra = [...fields, { key: "c.nose.new_field", file: "rocket.rw.toml", value: 1 }];
    expect(extra.filter((f) => !keys.has(f.key) && NOT_DRIVEN[f.key] === undefined).map((f) => f.key)).toEqual(["c.nose.new_field"]);
  });
});
