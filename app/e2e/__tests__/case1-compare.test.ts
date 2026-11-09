/** B1's comparator (D23) against the fixture itself and targeted mutations of it. */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CheckReport, EvalComponent, EvaluatedModel, ModelGetOut } from "../../packages/contracts/src/generated/index.ts";
import { compareCase1, compareEvaluatedConditions, comparePersisted, flightReport, matchParts, type Case1Actual } from "../case1-compare.ts";
import { loadCase1Plan, readEnv, type Case1Plan } from "../case1-plan.ts";
import { FIXTURE_DIR, sourceFields } from "../case1-script.ts";
import { SCRATCH, sidecarBinary } from "../live.ts";

let bin = "";
let plan: Case1Plan;
let identity: Required<Case1Actual>;
let tmp = "";

const part = (model: EvaluatedModel, id: string): EvalComponent => {
  const c = model.components.find((p) => p.id === id);
  if (c === undefined) throw new Error(`no part ${id}`);
  return c;
};
const mutated = (edit: (a: Required<Case1Actual>) => void): Required<Case1Actual> => {
  const copy = structuredClone(identity);
  edit(copy);
  return copy;
};

beforeAll(() => {
  bin = sidecarBinary();
  plan = loadCase1Plan(bin);
  tmp = mkdtempSync(join(SCRATCH, "rw-case1-cmp-"));
  const project = join(tmp, "p");
  cpSync(FIXTURE_DIR, project, { recursive: true });
  const out = (args: string[]) => JSON.parse(execFileSync(bin, ["-C", project, ...args], { encoding: "utf8", env: readEnv(), maxBuffer: 64 * 1024 * 1024 })) as unknown;
  identity = { model: (out(["eval", "--json"]) as ModelGetOut).model!, check: out(["check", "--json"]) as CheckReport };
}, 300_000);

afterAll(() => {
  if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
});

describe("compareCase1", () => {
  it("passes on the fixture compared with itself", () => {
    expect(compareCase1(plan, identity)).toEqual([]);
  });

  it("ignores ids and names, including the parent ids they rename", () => {
    const renamed = mutated(({ model }) => {
      for (const c of model.components) {
        c.name = `x ${c.name}`;
      }
      const ids = new Map(model.components.map((c, i) => [c.id, `part_${i}`]));
      for (const c of model.components) {
        c.id = ids.get(c.id)!;
        if (c.parent != null) c.parent = ids.get(c.parent)!;
      }
    });
    expect(compareCase1(plan, renamed)).toEqual([]);
  });

  it("fails a 0.02 mm shift of a length and of a position", () => {
    const longer = mutated(({ model }) => {
      const shape = part(model, "body").shape as { length: number };
      shape.length += 0.02e-3;
    });
    expect(compareCase1(plan, longer)).toContainEqual(expect.objectContaining({ part: "body", field: "length" }));
    const moved = mutated(({ model }) => {
      part(model, "mmt").x_fore += 0.02e-3;
    });
    expect(compareCase1(plan, moved)).toContainEqual(expect.objectContaining({ part: "mmt", field: "x_fore" }));
  });

  it("passes a shift inside 0.01 mm", () => {
    const close = mutated(({ model }) => {
      part(model, "mmt").x_fore += 0.009e-3;
    });
    expect(compareCase1(plan, close)).toEqual([]);
  });

  it("fails a swapped ring: rings pair by x_fore, so differing rings cannot trade places", () => {
    // Case 1's two rings are identical, so swapping them alone changes nothing. Make them differ first.
    const distinct = structuredClone(plan);
    (part(distinct.model, "ring_fore").shape as { id: number }).id = 0.0185;
    const swapped = mutated(({ model }) => {
      const fore = part(model, "ring_fore");
      const aft = part(model, "ring_aft");
      (fore.shape as { id: number }).id = 0.0185;
      [fore.x_fore, aft.x_fore] = [aft.x_fore, fore.x_fore];
      [fore.x_aft, aft.x_aft] = [aft.x_aft, fore.x_aft];
    });
    expect(compareCase1(distinct, swapped)).toContainEqual(expect.objectContaining({ part: "ring_fore", field: "id" }));
  });

  it("fails a ring under the wrong parent", () => {
    const moved = mutated(({ model }) => {
      part(model, "ring_aft").parent = "mmt";
    });
    expect(compareCase1(plan, moved)).toContainEqual(expect.objectContaining({ part: "ring_aft", field: "part" }));
  });

  it("fails a 1% density change", () => {
    const heavier = mutated(({ model }) => {
      (model.materials["cardboard"] as { density: number }).density *= 1.01;
    });
    const diffs = compareCase1(plan, heavier);
    expect(diffs).toContainEqual(expect.objectContaining({ part: "body", field: "material.density" }));
    expect(diffs).toContainEqual(expect.objectContaining({ part: "cardboard", field: "density" }));
  });

  it("passes a density change inside 0.5%", () => {
    const close = mutated(({ model, check }) => {
      (model.materials["cardboard"] as { density: number }).density *= 1.004;
      check.mass.dry += 0.1e-3;
    });
    expect(compareCase1(plan, close)).toEqual([]);
  });

  it("fails a missing part, an extra part and a changed enum", () => {
    const missing = mutated(({ model }) => {
      model.components = model.components.filter((c) => c.id !== "block");
    });
    expect(compareCase1(plan, missing)).toContainEqual(expect.objectContaining({ part: "block", field: "part" }));
    const extra = mutated(({ model }) => {
      model.components.push({ ...structuredClone(part(model, "lug")), id: "lug2" });
    });
    expect(compareCase1(plan, extra)).toContainEqual(expect.objectContaining({ part: "lug2", field: "part" }));
    const shape = mutated(({ model }) => {
      (part(model, "nose").shape as { shape: string }).shape = "conical";
    });
    expect(compareCase1(plan, shape)).toContainEqual(expect.objectContaining({ part: "nose", field: "shape" }));
  });

  it("fails dry mass off by more than 0.5 g and statics outside the oracle", () => {
    const heavy = mutated(({ check }) => {
      check.mass.dry += 0.6e-3;
    });
    expect(compareCase1(plan, heavy)).toContainEqual(expect.objectContaining({ field: "dry mass" }));
    const cg = mutated(({ check }) => {
      check.mass.cg += 2e-3;
    });
    expect(compareCase1(plan, cg)).toContainEqual(expect.objectContaining({ field: "mass.cg" }));
    const cp = mutated(({ check }) => {
      check.aero.cp += 4e-3;
    });
    expect(compareCase1(plan, cp)).toContainEqual(expect.objectContaining({ field: "aero.cp" }));
    const stability = mutated(({ check }) => {
      check.stability.liftoff += 0.2;
    });
    expect(compareCase1(plan, stability)).toContainEqual(expect.objectContaining({ field: "stability.liftoff" }));
  });

  it("scores every part, position, dry mass and the static numbers, always", () => {
    expect(compareCase1(plan, mutated(({ model }) => void (part(model, "body").x_fore += 0.5)))).toContainEqual(expect.objectContaining({ part: "body", field: "x_fore" }));
    expect(compareCase1(plan, mutated(({ check }) => void (check.mass.dry += 1)))).toContainEqual(expect.objectContaining({ field: "dry mass" }));
    expect(compareCase1(plan, mutated(({ model }) => void (model.components = model.components.filter((c) => c.id !== "fins"))))).toContainEqual(expect.objectContaining({ part: "fins", field: "part", actual: "missing" }));
  });

  it("has a comparison rule for every part field the script drives", () => {
    expect(compareCase1(plan, identity).filter((d) => d.expected === "a comparison rule")).toEqual([]);
  });
});

describe("matchParts", () => {
  it("fails a part the plan does not have, and a body left off the nose", () => {
    const extra = structuredClone(identity.model);
    extra.components.push({ ...structuredClone(part(identity.model, "fins")), id: "extra_fins" });
    expect(matchParts(plan, extra).diffs).toContainEqual(expect.objectContaining({ field: "part", expected: "no such part" }));
    const loose = structuredClone(identity.model);
    delete (part(loose, "body") as { parent?: unknown }).parent;
    expect(matchParts(plan, loose).diffs).toEqual(expect.arrayContaining([expect.objectContaining({ part: "body", field: "part", actual: "missing" })]));
  });
});

describe("flightReport", () => {
  it("prints the three numbers and how they were scored", () => {
    const oracle = [
      { key: "apogee_m", value: 348.1, golden: 345.78, tolerance: "3%", pass: true },
      { key: "max_velocity_ms", value: 105.2, golden: 103.77, tolerance: "3%", pass: true },
      { key: "time_to_apogee_s", value: 9, golden: 7.74, tolerance: "0.3s", pass: false },
    ];
    const lines = flightReport({ flight: { run: "simulation_1/abc", thread: "ui", oracle }, problems: [] });
    expect(lines[0]).toBe("B1 flight: run simulation_1/abc, thread ui");
    expect(lines.slice(1)).toEqual([
      "B1 flight: apogee_m 348.1 (oracle 345.78 within 3%): pass",
      "B1 flight: max_velocity_ms 105.2 (oracle 103.77 within 3%): pass",
      "B1 flight: time_to_apogee_s 9 (oracle 7.74 within 0.3s): FAIL",
    ]);
  });

  it("prints the thread the record names, not the one it should be", () => {
    expect(flightReport({ flight: { run: "s/a", thread: null, oracle: [] }, problems: [] })[0]).toBe("B1 flight: run s/a, thread none");
  });

  it("says why there are no numbers", () => {
    expect(flightReport({ problems: ["expected exactly one flight run in runs/, found 0"] })).toEqual(["B1 flight: no run of the app's to score: expected exactly one flight run in runs/, found 0"]);
  });
});

describe("conditions", () => {
  const mappingOf = (model: EvaluatedModel) => matchParts(plan, model).mapping;

  it("passes on the fixture's own files and evaluated conditions", () => {
    const mapping = mappingOf(identity.model);
    expect(comparePersisted(FIXTURE_DIR, mapping)).toEqual([]);
    expect(compareEvaluatedConditions(plan, identity.model, mapping)).toEqual([]);
  });

  it("fails a default the sim file never wrote, though the engine evaluates it the same", () => {
    const dir = mkdtempSync(join(SCRATCH, "rw-case1-persist-"));
    try {
      const project = join(dir, "p");
      cpSync(FIXTURE_DIR, project, { recursive: true });
      const file = join(project, "sims/simulation_5.rw.toml");
      writeFileSync(file, readFileSync(file, "utf8").replace(/^rail_length = .*\n/m, ""));
      const mapping = mappingOf(identity.model);
      expect(comparePersisted(project, mapping)).toContainEqual(expect.objectContaining({ field: "sim.launch.rail_length", actual: "not written" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails a wrong persisted motor, delay, event or altitude", () => {
    const dir = mkdtempSync(join(SCRATCH, "rw-case1-persist-"));
    try {
      const project = join(dir, "p");
      cpSync(FIXTURE_DIR, project, { recursive: true });
      const file = join(project, "configs/5d9a2765-395d-4d9c-9678-38eed0988c72.rw.toml");
      writeFileSync(file, readFileSync(file, "utf8").replace('delay = "7 s"', 'delay = "5 s"').replace('altitude = "200 m"', 'altitude = "300 m"').replace('event = "ejection"', 'event = "apogee"'));
      const diffs = comparePersisted(project, mappingOf(identity.model));
      for (const field of ["config.motors.mmt.delay", "config.deploy.chute.altitude", "config.deploy.chute.event"]) {
        expect(diffs).toContainEqual(expect.objectContaining({ field }));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps the persisted part ids through the part mapping", () => {
    const mapping = new Map(mappingOf(identity.model));
    mapping.set("mmt", { ...mapping.get("mmt")!, id: "not_the_mount" });
    expect(comparePersisted(FIXTURE_DIR, mapping)).toContainEqual(expect.objectContaining({ field: "config.motors.mmt.motor", actual: "not written" }));
  });

  it("gates only what the drive types: a fixture field with no row may differ", () => {
    const undriven = sourceFields().find((f) => f.key === "sim.launch.latitude");
    expect(undriven).toBeDefined();
    expect(comparePersisted(FIXTURE_DIR, mappingOf(identity.model), [{ ...undriven!, value: "12 deg" }])).toEqual([]);
  });

  it("fails evaluated conditions that differ", () => {
    const windy = structuredClone(identity.model);
    windy.sims["simulation_5"]!.conditions.rail_length_m = 2;
    const mapping = mappingOf(windy);
    expect(compareEvaluatedConditions(plan, windy, mapping)).toContainEqual(expect.objectContaining({ field: "sim.launch.rail_length" }));
  });
});
