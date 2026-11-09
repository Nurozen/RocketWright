/** R2.5: the sheet's fields against the schema, and its patch against the real core (I4). */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EvaluatedModel, PatchOp, schema } from "@rw/contracts";
import { loadRwWasm } from "@rw/rw-wasm";
import { beforeAll, describe, expect, it } from "vitest";
import { newConfigOps, duplicateOps } from "../configurations/model.ts";
import { newSimOps } from "../../state/ops/sims.ts";
import { fromRwWasm, type PreviewCore } from "../../state/wasm.ts";
import { appliesToModel, conditionsOps, fieldKeyOfPath, fieldProblems, formFromSim, isFormDirty, nextSimName, SIM_FIELDS, validateForm, type SimForm } from "./simFields.ts";

const repo = new URL("../../../../../../", import.meta.url).pathname;

function files(rel: string): Record<string, string> {
  const root = join(repo, rel);
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`);
      else out[`${prefix}${name}`] = readFileSync(p, "utf8");
    }
  };
  walk(root, "");
  return out;
}

let core: Required<PreviewCore>;
let empty: Record<string, string>;

beforeAll(async () => {
  const rw = await loadRwWasm(readFileSync(new URL("../../../../../packages/rw-wasm/pkg/rw_wasm_bg.wasm", import.meta.url)));
  core = fromRwWasm(rw) as Required<PreviewCore>;
  empty = files("templates/empty");
});

const apply = (src: Record<string, string>, ops: readonly PatchOp[]) => core.applyAndCheck({ files: src, ops });
const evaluated = (src: Record<string, string>, ops: readonly PatchOp[]) => apply(src, ops).evaluated as EvaluatedModel;

/** A file set holding one new sim, as the sheet receives it. */
function withSim(body: string): Record<string, string> {
  return { ...empty, "sims/s.rw.toml": `name = "S"\nconfig = "default"\n${body}` };
}

const form = (src: Record<string, string>): SimForm => formFromSim(evaluated(src, []).sims["s"]!);
const set = (f: SimForm, edits: Record<string, string>): SimForm => ({ ...f, values: { ...f.values, ...edits } });

describe("the fields", () => {
  const schemaDoc = JSON.parse(readFileSync(join(repo, "schema/sim.json"), "utf8")) as { $defs: Record<string, { properties: Record<string, Record<string, unknown>> }> };
  const DEFS: Record<string, string> = { launch: "LaunchSpec", wind: "WindSpec", atmosphere: "AtmosphereSpec", integrator: "IntegratorSpec" };

  /** `x-unit-dimension`, found through the schema's nullable wrapper. */
  const dimOf = (prop: Record<string, unknown>): string | undefined => {
    const direct = prop["x-unit-dimension"] as string | undefined;
    if (direct !== undefined) return direct;
    for (const branch of (prop["anyOf"] ?? []) as Record<string, unknown>[]) {
      const found = dimOf(branch);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  it.each(SIM_FIELDS.map((f) => [f.key, f] as const))("%s exists in the sim schema with its dimension", (key, f) => {
    const [section, leaf] = key.split(".") as [string, string];
    const prop = schemaDoc.$defs[DEFS[section]!]!.properties[leaf];
    expect(prop, key).toBeDefined();
    if (f.kind === "number") expect(dimOf(prop!), key).toBe(f.dim.split(":")[0]);
  });

  it("names fields in the words the sheet shows", () => {
    expect(SIM_FIELDS.map((f) => f.label)).toEqual(["Rail length", "Rail angle", "Rail direction", "Latitude", "Longitude", "Elevation", "Speed", "Direction", "Turbulence", "Temperature", "Pressure", "Model", "Time step", "Max time", "Integrator"]);
  });
});

describe("saving a sim that writes no conditions", () => {
  it("writes rail, wind and atmosphere with defaults, but no solver", () => {
    const src = withSim("");
    const ops = conditionsOps(form(src), src["sims/s.rw.toml"]!);
    expect(ops).toEqual([
      { op: "add", path: "/sims/s/launch", value: { rail_length: "1 m" } },
      { op: "add", path: "/sims/s/wind", value: { speed: "0 m/s" } },
      { op: "add", path: "/sims/s/atmosphere", value: { model: "ussa1976" } },
    ]);
    expect(apply(src, ops).check.diagnostics.filter((d: schema.Diagnostic) => d.path?.startsWith("/sims/"))).toEqual([]);
  });

  it("works straight after the sim is created", () => {
    const { id, ops } = newSimOps("Simulation 1", "default", []);
    const evald = evaluated(empty, ops);
    const f = set(formFromSim(evald.sims[id]!), { "launch.rail_length": "2.5", "wind.speed": "4" });
    const all = [...ops, ...conditionsOps(f, `name = "Simulation 1"\nconfig = "default"\n`)];
    const after = evaluated(empty, all).sims[id]!.conditions;
    expect(after.rail_length_m).toBe(2.5);
    expect(after.wind_speed_ms).toBe(4);
    expect(after.atmosphere).toBe("ussa1976");
  });

  it("writes the solver with its required method only once it is edited", () => {
    const src = withSim("");
    const f = set(form(src), { "integrator.dt": "0.05" });
    const ops = conditionsOps(f, src["sims/s.rw.toml"]!);
    expect(ops.at(-1)).toEqual({ op: "add", path: "/sims/s/integrator", value: { method: "dp54", dt: "0.05 s" } });
    expect(evaluated(src, ops).sims["s"]!.conditions.time_step_s).toBe(0.05);
  });
});

describe("saving a sim that already has conditions", () => {
  const SRC = `[launch]
rail_length = "= 2 m + 0.5 m"
rod_angle = "5 deg"

[atmosphere]
model = "ussa1976"

[wind]
speed = "3 m/s"
direction = "270 deg"
`;

  it("leaves a field it was not asked to change, so an expression survives", () => {
    const src = withSim(SRC);
    expect(conditionsOps(form(src), src["sims/s.rw.toml"]!)).toEqual([]);
    const f = set(form(src), { "launch.rod_angle": "7" });
    expect(conditionsOps(f, src["sims/s.rw.toml"]!)).toEqual([{ op: "replace", path: "/sims/s/launch/rod_angle", value: "7 deg" }]);
  });

  it("adds a key the table lacks, and a blank optional field goes back to the default", () => {
    const src = withSim(SRC);
    const f = set(form(src), { "wind.turbulence": "10", "launch.rod_angle": "" });
    const ops = conditionsOps(f, src["sims/s.rw.toml"]!);
    expect(ops).toEqual([
      { op: "remove", path: "/sims/s/launch/rod_angle" },
      { op: "add", path: "/sims/s/wind/turbulence", value: 0.1 },
    ]);
    const after = evaluated(src, ops).sims["s"]!.conditions;
    expect(after.wind_turbulence).toBeCloseTo(0.1);
    expect(after.rod_angle_deg).toBe(0);
  });

  it("round-trips the units the sheet shows", () => {
    const src = withSim(SRC);
    const f = set(form(src), { "atmosphere.model": "isa_custom", "atmosphere.base_temperature": "20", "atmosphere.base_pressure": "1000", "launch.latitude": "61.2", "launch.altitude": "30" });
    const after = evaluated(src, conditionsOps(f, src["sims/s.rw.toml"]!)).sims["s"]!.conditions;
    expect(after.atmosphere).toBe("isa_custom");
    expect(after.base_temperature_k).toBeCloseTo(293.15);
    expect(after.base_pressure_pa).toBeCloseTo(100000);
    expect(after.latitude_deg).toBeCloseTo(61.2);
    expect(after.site_altitude_m).toBeCloseTo(30);
  });

  it("shows a turbulence fraction as a percentage", () => {
    const src = withSim(`${SRC.replace('direction = "270 deg"', 'direction = "270 deg"\nturbulence = 0.1')}`);
    expect(form(src).values["wind.turbulence"]).toBe("10");
  });

  it("moves a sim to another configuration", () => {
    const f: SimForm = { ...form(withSim(SRC)), config: "other" };
    expect(isFormDirty(f)).toBe(true);
    expect(conditionsOps(f, withSim(SRC)["sims/s.rw.toml"]!)).toEqual([{ op: "replace", path: "/sims/s/config", value: "other" }]);
  });
});

describe("what the engine refuses", () => {
  it("puts RW-E067 on the field it names", () => {
    const src = withSim("");
    const f = set(form(src), { "launch.rail_length": "0" });
    const diags = apply(src, conditionsOps(f, src["sims/s.rw.toml"]!)).check.diagnostics as schema.Diagnostic[];
    const code = diags.find((d) => d.path === "/sims/s/launch/rail_length");
    expect(code?.code).toBe("RW-E067");
    expect(fieldProblems("s", diags).fields["launch.rail_length"]).toMatch(/rail length must be positive/);
    expect(fieldKeyOfPath("s", "/sims/s/wind/speed")).toBe("wind.speed");
    expect(fieldKeyOfPath("s", "/sims/other/wind/speed")).toBeNull();
    expect(fieldKeyOfPath("s", "/sims/s/series_dt")).toBeNull();
  });

  it("sends what no field shows to the form, and skips warnings and other sims", () => {
    const d = (severity: string, path: string): schema.Diagnostic => ({ code: "RW-E067", severity, path, message: path }) as schema.Diagnostic;
    expect(fieldProblems("s", [d("warning", "/sims/s/wind/speed"), d("error", "/sims/t/wind/speed"), d("error", "/sims/s/series_dt")])).toEqual({ fields: {}, other: ["/sims/s/series_dt"] });
  });

  it("refuses what is not a number, and a blank required field", () => {
    const f = form(withSim(""));
    expect(validateForm(set(f, { "launch.rail_length": "abc", "wind.speed": "" }))).toEqual({ "launch.rail_length": "Rail length needs a number.", "wind.speed": "Speed needs a number." });
    expect(validateForm(set(f, { "launch.rod_angle": "" }))).toEqual({});
  });

  it("disables base temperature and pressure under USSA 1976 only", () => {
    expect(appliesToModel("atmosphere.base_pressure", "ussa1976")).toBe(false);
    expect(appliesToModel("atmosphere.base_pressure", "isa_custom")).toBe(true);
    expect(appliesToModel("launch.rail_length", "ussa1976")).toBe(true);
  });
});

describe("new sim names", () => {
  it("takes the next free number", () => {
    expect(nextSimName([])).toBe("Simulation 1");
    expect(nextSimName([{ name: "Baseline" }, { name: "Simulation 2" }])).toBe("Simulation 3");
  });
});

describe("new configurations never inherit a visual flow study (U51)", () => {
  const study = { id: "study", name: "Flow", kind: "visual_flow", config: "base" };
  const flight = { id: "flight", name: "Flight", kind: "flight", config: "base" };
  const model = (sims: Record<string, unknown>) => ({ configs: { base: { id: "base", name: "Base", motors: [] } }, sims, components: [] }) as never;

  it("skips the study for New", () => {
    const { ops } = newConfigOps(model({ study, flight }), [], "Next");
    expect(ops).toContainEqual({ op: "copy", from: "/sims/flight", path: "/sims/next" });
  });

  it("creates a blank sim rather than copying a study for New", () => {
    const { id, ops } = newConfigOps(model({ study }), [], "Next");
    expect(ops).toContainEqual({ op: "add", path: `/sims/${id}`, value: { name: "Next", config: id } });
  });

  it("skips the study for Duplicate", () => {
    const { id, ops } = duplicateOps(model({ study, flight }), "base", "Copy");
    expect(ops).toContainEqual({ op: "copy", from: "/sims/flight", path: `/sims/${id}` });
  });
});
