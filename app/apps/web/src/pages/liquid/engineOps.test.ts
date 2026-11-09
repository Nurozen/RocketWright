/** U56: the engine editor's writes, on the real core and the research vehicle's demo engine (a patch that applies here is one the sidecar accepts, I4). */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PatchOp, schema } from "@rw/contracts";
import { loadRwWasm, THERMO_PAIRS } from "@rw/rw-wasm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fromRwWasm, type PreviewCore } from "../../state/wasm.ts";
import {
  addInjectorOps,
  cardFields,
  copyEngineName,
  designFor,
  designKey,
  displayNumber,
  engineSource,
  fieldOps,
  fieldValue,
  isExpression,
  isModified,
  mirrorAt,
  nextEngineName,
  nextPair,
  parseFieldText,
  propellantChoice,
  propellantLabels,
  propellantOps,
  tankFields,
  tankGroups,
  type DesignEntry,
  type EngineField,
  type MirrorStore,
} from "./engineOps.ts";
import { resultStats, type EngineDesignOut, type EvalEngine } from "./model.ts";

const repo = new URL("../../../../../../", import.meta.url).pathname;

function projectFiles(rel: string): Record<string, string> {
  const root = join(repo, rel);
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`);
      else if (name.endsWith(".toml")) out[`${prefix}${name}`] = readFileSync(p, "utf8");
    }
  };
  walk(root, "");
  return out;
}

const field = (card: Parameters<typeof cardFields>[0], key: string): EngineField => cardFields(card).find((f) => f.key === key)!;

let core: Required<PreviewCore>;
let files: Record<string, string>;
let demo: EvalEngine;
const source = () => engineSource(files["engines/demo.rw.toml"]);
const apply = (ops: readonly PatchOp[]) => core.applyAndCheck({ files, ops }).evaluated;
const engineOf = (ops: readonly PatchOp[], id = "demo") => apply(ops).engines![id] as EvalEngine;

beforeAll(async () => {
  const rw = await loadRwWasm(readFileSync(new URL("../../../../../packages/rw-wasm/pkg/rw_wasm_bg.wasm", import.meta.url)));
  core = fromRwWasm(rw) as Required<PreviewCore>;
  files = projectFiles("fixtures/research-vehicle");
  demo = core.applyAndCheck({ files, ops: [] }).evaluated.engines!["demo"] as EvalEngine;
});

describe("typed values", () => {
  const pressure = () => field("Chamber", "chamber_pressure");
  it("writes each dimension the unit the engine reads, never a bare number", () => {
    expect(parseFieldText(pressure(), "25", "mm")).toEqual({ value: "25 bar" });
    expect(parseFieldText(field("Chamber", "thrust"), "2", "mm")).toEqual({ value: "2 kN" });
    expect(parseFieldText(field("Chamber", "l_star"), "1.2", "mm")).toEqual({ value: "1.2 m" });
    expect(parseFieldText(tankFields("t")[0]!, "4", "mm")).toEqual({ value: "4 L" });
    expect(parseFieldText(field("Propellants", "mixture_ratio"), "4.2", "mm")).toEqual({ value: 4.2 });
  });
  it("keeps a formula and refuses what cannot be a value", () => {
    expect(parseFieldText(pressure(), "= base * 2", "mm")).toEqual({ value: "= base * 2" });
    expect(parseFieldText(pressure(), "", "mm").error).toMatch(/needs a value/);
    expect(parseFieldText(pressure(), "abc", "mm").error).toMatch(/number/);
    expect(parseFieldText(pressure(), "-3", "mm").error).toMatch(/greater than 0/);
  });
  it("clears an optional field when it is emptied", () => {
    expect(parseFieldText(field("Chamber", "l_star"), "  ", "mm")).toEqual({ value: null });
  });
  it("shows evaluated numbers in the display unit", () => {
    expect(displayNumber(pressure(), fieldValue(pressure(), demo, source()), "mm")).toBe("20");
    const thrust = field("Chamber", "thrust");
    expect(displayNumber(thrust, fieldValue(thrust, demo, source()), "mm")).toBe("1.5");
    const lstar = field("Chamber", "l_star");
    expect(displayNumber(lstar, fieldValue(lstar, demo, source()), "in")).toBe("1.5");
  });
  it("reads the injector drop as it is written, not the evaluated pressure", () => {
    expect(fieldValue(field("Injector", "injector.pressure_drop_fraction"), demo, source())).toBeCloseTo(0.2);
    expect(fieldValue(field("Injector", "injector.pressure_drop"), demo, source())).toBeNull();
  });
  it("flags a field held by a formula", () => {
    const text = engineSource('thrust = "= 2 * base"\nchamber_pressure = "20 bar"\n');
    expect(isExpression(field("Chamber", "thrust"), text)).toBe(true);
    expect(isExpression(field("Chamber", "chamber_pressure"), text)).toBe(false);
  });
});

describe("field writes", () => {
  it("replaces a written value, and the engine reads it", () => {
    const f = field("Chamber", "chamber_pressure");
    const ops = fieldOps("demo", f, "25 bar", source());
    expect(ops).toEqual([{ op: "replace", path: "/engines/demo/chamber_pressure", value: "25 bar" }]);
    expect(engineOf(ops).chamber_pressure).toBeCloseTo(25e5);
  });
  it("adds a value the file does not hold, and writing one nozzle input clears the other", () => {
    const f = field("Nozzle", "exit_pressure");
    const ops = fieldOps("demo", f, "1 bar", source());
    expect(ops).toEqual([
      { op: "add", path: "/engines/demo/exit_pressure", value: "1 bar" },
      { op: "remove", path: "/engines/demo/expansion_ratio" },
    ]);
    const e = engineOf(ops);
    expect(e.exit_pressure).toBeCloseTo(1e5);
    expect(e.expansion_ratio ?? null).toBeNull();
  });
  it("removes an optional value only when it is written", () => {
    const lstar = field("Chamber", "l_star");
    expect(fieldOps("demo", lstar, null, source())).toEqual([{ op: "remove", path: "/engines/demo/l_star" }]);
    expect(fieldOps("demo", field("Nozzle", "exit_pressure"), null, source())).toEqual([]);
    expect(engineOf(fieldOps("demo", lstar, null, source())).l_star ?? null).toBeNull();
  });
  it("writes a tank's inputs in place", () => {
    const [volume, pressure, pressurant] = tankFields("tank_a");
    const ops = [...fieldOps("demo", volume!, "4 L", source()), ...fieldOps("demo", pressure!, "40 bar", source()), ...fieldOps("demo", pressurant!, "he", source())];
    const node = engineOf(ops).nodes["tank_a"]!;
    expect(node.volume).toBeCloseTo(4e-3);
    expect(node.pressure).toBeCloseTo(40e5);
    expect(node.pressurant).toBe("he");
  });
  it("names each tank by its node and fluid", () => {
    expect(tankGroups(demo)).toEqual([
      { id: "tank_a", heading: "Tank A · N2O" },
      { id: "tank_b", heading: "Tank B · Ethanol" },
    ]);
  });
  it("adds the injector whole, with only its required member", () => {
    const text = engineSource(files["engines/demo.rw.toml"]);
    expect(text.hasTable("injector")).toBe(true);
    expect(engineSource('thrust = "1 kN"\n').hasTable("injector")).toBe(false);
    const ops: PatchOp[] = [{ op: "remove", path: "/engines/demo/injector" }, ...addInjectorOps("demo")];
    expect(engineOf(ops).injector?.kind).toBe("impinging");
  });
});

describe("propellants", () => {
  it("offers only the shipped pairs", () => {
    const n2o = propellantChoice("n2o", "ethanol");
    expect(n2o.oxidizers).toEqual(["lox", "n2o"]);
    expect(n2o.fuels).toEqual(["ethanol", "ipa"]);
    expect(propellantChoice("lox", "rp1").fuels).toEqual(["ethanol", "rp1", "ch4", "ipa"]);
    const offered = propellantChoice("lox", "rp1").oxidizers.flatMap((ox) => propellantChoice(ox, "ethanol").fuels.map((fuel) => `${ox}-${fuel}`));
    expect(offered.sort()).toEqual([...THERMO_PAIRS].sort());
  });
  it("keeps a pair outside the tables selectable and says so", () => {
    expect(propellantChoice("h2o2", "kerosene")).toEqual({ oxidizers: ["lox", "n2o", "h2o2"], fuels: ["kerosene"] });
    expect(propellantLabels(["lox", "kerosene"])).toEqual({ lox: "LOX", kerosene: "kerosene (not tabulated)" });
  });
  it("moves the fuel when the oxidizer has no table with it", () => {
    expect(nextPair({ oxidizer: "lox", fuel: "rp1" }, { oxidizer: "n2o" })).toEqual({ oxidizer: "n2o", fuel: "ethanol" });
    expect(nextPair({ oxidizer: "n2o", fuel: "ipa" }, { oxidizer: "lox" })).toEqual({ oxidizer: "lox", fuel: "ipa" });
  });
  it("moves the tanks with the pair, so the design still finds them", () => {
    const ops = propellantOps("demo", demo, source(), { oxidizer: "lox", fuel: "ipa" });
    expect(ops[0]).toEqual({ op: "replace", path: "/engines/demo/propellants", value: { oxidizer: "lox", fuel: "ipa" } });
    const e = engineOf(ops);
    expect([e.oxidizer, e.fuel]).toEqual(["lox", "ipa"]);
    expect(e.nodes["tank_a"]!.fluid).toBe("lox");
    expect(e.nodes["tank_b"]!.fluid).toBe("ipa");
    expect(ops.map((o) => o.path)).toContain("/engines/demo/feed/node/tank_a/tank/fill/propellant");
    const check = core.applyAndCheck({ files, ops }).check;
    expect(check.diagnostics.filter((d: schema.Diagnostic) => d.severity === "error" && (d.path ?? "").startsWith("/engines/demo/feed"))).toEqual([]);
  });
});

describe("names", () => {
  it("numbers new engines and copies past those taken", () => {
    expect(nextEngineName([])).toBe("Engine 1");
    expect(nextEngineName(["Demo engine"])).toBe("Engine 2");
    expect(nextEngineName(["Demo", "engine 2"])).toBe("Engine 3");
    expect(copyEngineName("Demo", ["Demo"])).toBe("Demo copy");
    expect(copyEngineName("Demo", ["Demo", "Demo copy"])).toBe("Demo copy 2");
  });
});

describe("the design's freshness", () => {
  const entry = (over: Partial<DesignEntry>): DesignEntry => ({ key: designKey("demo", demo), state: "ready", out: null, seq: 1, ...over });
  it("reads Modified only when the engine differs from what was computed", () => {
    const changed = { ...demo, thrust: 2000 };
    expect(isModified(entry({}), "demo", demo)).toBe(false);
    expect(isModified(entry({}), "demo", changed)).toBe(true);
  });
  it("says nothing before a result or while one is on its way", () => {
    expect(isModified(null, "demo", demo)).toBe(false);
    expect(isModified(entry({ key: "other", state: "loading" }), "demo", demo)).toBe(false);
  });

  it("gives a result only to the engine it was computed from", () => {
    const out = { engine: "demo", missing_inputs: [], diagnostics: [] } as unknown as EngineDesignOut;
    const changed = { ...demo, thrust: demo.thrust + 1 } as EvalEngine;
    expect(designFor(entry({ out }), "demo", demo)).toBe(out);
    expect(designFor(entry({ out, state: "loading" }), "demo", demo)).toBe(out);
    expect(designFor(entry({ out }), "demo", changed)).toBeNull();
    expect(designFor(entry({ out: null }), "demo", demo)).toBeNull();
    expect(designFor(null, "demo", demo)).toBeNull();
  });
  it("is the engine's content, not the rocket's: an edit elsewhere does not change the key", () => {
    const other = core.applyAndCheck({ files, ops: [{ op: "replace", path: "/c/nose/length", value: "200 mm" }] }).evaluated;
    expect(other.model_hash).not.toBe(core.applyAndCheck({ files, ops: [] }).evaluated.model_hash);
    expect(designKey("demo", other.engines!["demo"] as EvalEngine)).toBe(designKey("demo", demo));
  });
});

describe("the result strip", () => {
  const out = { engine: "demo", performance: { isp_sl: 201.4, throat_diameter: 0.031, chamber_diameter: 0.062, c_star: 1400, thrust: 1500, mdot: 0.7, mdot_ox: 0.5, mdot_fuel: 0.2, chamber_temperature: 2900, expansion_ratio: 4 }, missing_inputs: [], diagnostics: [] } as unknown as EngineDesignOut;
  it("shows Isp and the two diameters from the design", () => {
    expect(resultStats(out)).toEqual([
      { id: "isp", label: "Isp", value: "201.4", unit: "s" },
      { id: "chamber", label: "Chamber diameter", value: "62.00", unit: "mm" },
      { id: "throat", label: "Throat diameter", value: "31.00", unit: "mm" },
    ]);
  });
  it("is empty before a result", () => {
    expect(resultStats(null).map((s) => s.value)).toEqual([null, null, null]);
  });
});

describe("mirrorAt", () => {
  const stub = (hash: string) => {
    const listeners = new Set<() => void>();
    const store: MirrorStore & { set(h: string): void } = {
      getState: () => ({ project: { snapshot: { evaluated: { model_hash: hash } } } }),
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      set: (h) => {
        hash = h;
        listeners.forEach((l) => l());
      },
    };
    return store;
  };
  it("resolves at once when there is nothing to wait for", async () => {
    await expect(mirrorAt(stub("a"), null)).resolves.toBeUndefined();
    await expect(mirrorAt(stub("a"), "a")).resolves.toBeUndefined();
  });
  it("resolves when the mirror reaches the write", async () => {
    const store = stub("a");
    const wait = mirrorAt(store, "b");
    store.set("b");
    await expect(wait).resolves.toBeUndefined();
  });
  it("gives up after a short wait rather than hanging on a model that moved past it", async () => {
    vi.useFakeTimers();
    const store = stub("a");
    const wait = mirrorAt(store, "b", 100);
    vi.advanceTimersByTime(100);
    await expect(wait).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});
