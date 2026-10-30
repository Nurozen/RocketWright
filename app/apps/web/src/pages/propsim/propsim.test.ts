/**
 * M4.8 page 06 Engineering units: the engine run record (`engine.json`)
 * parsing, its URL, the three plots in display units, the run summary, the
 * provenance label bound to the record, and which engines can fly.
 */
import { describe, expect, it } from "vitest";
import { runnableEngines } from "./engineering.tsx";
import { engineeringPlots, engineRunUrl, parseEngineRun, provenanceLabel, runSummary, type EngineRunRecord } from "./model.ts";

const sample = (t: number, k: number) => ({
  t,
  chamber_pressure: 2e6 * k,
  ox_tank_pressure: 5e6 * k,
  fuel_tank_pressure: 3.5e6 * k,
  mdot_ox: 0.55 * k,
  mdot_fuel: 0.14 * k,
  mixture_ratio: 4 + (1 - k),
  thrust: 1500 * k,
  ox_liquid: 0.0036 * k,
  fuel_liquid: 0.0019 * k,
});

const RECORD: EngineRunRecord = {
  engine: "demo",
  run_id: "bde1db046d54",
  provenance: "engineering",
  design: {
    engine: "demo",
    thermo: "table:n2o-ethanol",
    assumptions: ["Single-phase liquid propellants at 20 °C (two-phase self-pressurizing N2O is not modelled)."],
    feed: [
      { tank: "tank_a", fluid: "n2o" },
      { tank: "tank_b", fluid: "ethanol" },
    ] as unknown as NonNullable<EngineRunRecord["design"]["feed"]>,
  },
  blowdown: { samples: [sample(0, 1), sample(4, 0.6), sample(8.5, 0.4)], end: "oxidizer_depleted", burn_time: 8.5, total_impulse: 6860.4, ox_used: 2.83, fuel_used: 0.65 },
};

describe("engine run record", () => {
  it("parses engine.json and rejects anything else", () => {
    expect(parseEngineRun(JSON.stringify(RECORD)).run_id).toBe("bde1db046d54");
    expect(() => parseEngineRun("{}")).toThrow(/not an engine run record/);
    expect(() => parseEngineRun(JSON.stringify({ ...RECORD, provenance: undefined }))).toThrow();
  });

  it("is served beside the run's series", () => {
    expect(engineRunUrl("http://127.0.0.1:5", "p 1", "engine.demo", "bde1db046d54")).toBe("http://127.0.0.1:5/api/projects/p%201/runs/engine.demo/bde1db046d54/engine.json");
    expect(engineRunUrl("", "p", "engine.demo", "r")).toBe("/api/projects/p/runs/engine.demo/r/engine.json");
  });

  it("labels the tier from the record's own provenance", () => {
    expect(provenanceLabel("engineering")).toBe("Engineering result");
    expect(provenanceLabel("visual")).toBe("Visual model · Not an engineering result");
    expect(provenanceLabel("cfd")).toBe("Imported CFD result");
  });
});

describe("engineering plots", () => {
  it("tank pressure (bar), mass flow (kg/s), and thrust (N) over time", () => {
    const plots = engineeringPlots(RECORD);
    expect(plots.map((p) => [p.id, p.lines.length])).toEqual([
      ["pressure", 3],
      ["mass_flow", 2],
      ["thrust", 1],
    ]);
    const [pressure, flow, thrust] = plots;
    expect(pressure!.lines.map((l) => l.label)).toEqual(["Tank A · N2O", "Tank B · Ethanol", "Chamber"]);
    expect(pressure!.lines[0]!.y).toEqual([50, 30, 20]);
    expect(pressure!.lines[2]!.y[0]).toBe(20);
    expect(flow!.lines.map((l) => l.label)).toEqual(["N2O", "Ethanol"]);
    expect(flow!.lines[1]!.y[0]).toBeCloseTo(0.14, 9);
    expect(thrust!.lines[0]!.t).toEqual([0, 4, 8.5]);
    expect(thrust!.lines[0]!.y).toEqual([1500, 900, 600]);
  });

  it("summarises the burn", () => {
    expect(runSummary(RECORD).map((r) => [r.key, r.value])).toEqual([
      ["burn_time", "8.50 s"],
      ["total_impulse", "6,860 N·s"],
      ["average_thrust", "807 N"],
      ["peak_thrust", "1,500 N"],
      ["mixture_ratio", "4.00 → 4.60"],
      ["end", "Oxidizer depleted"],
    ]);
  });

  it("flies only engines with no missing inputs", () => {
    const engines = { demo: {}, "demo-incomplete": {} };
    const diags = [
      { code: "RW-W210", path: "/engines/demo-incomplete/fluid_model" },
      { code: "RW-W102", path: "/c/motor_casing" },
    ];
    expect(runnableEngines(engines, diags)).toEqual(["demo"]);
    expect(runnableEngines(engines, null)).toEqual(["demo", "demo-incomplete"]);
    expect(runnableEngines(null, diags)).toEqual([]);
  });
});
