/** B1's comparator (D23) against the fixture itself and targeted mutations of it. */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CheckReport, EvalComponent, EvaluatedModel, ModelGetOut } from "../../packages/contracts/src/generated/index.ts";
import { allRowKeys, compareCase1, compareEvaluatedConditions, comparePersisted, matchParts, type Case1Actual } from "../case1-compare.ts";
import { loadCase1Plan, readEnv, type Case1Plan } from "../case1-plan.ts";
import { FIXTURE_DIR } from "../case1-script.ts";
import { SCRATCH, sidecarBinary } from "../live.ts";

let bin = "";
let plan: Case1Plan;
let identity: Case1Actual;
let tmp = "";

const part = (model: EvaluatedModel, id: string): EvalComponent => {
  const c = model.components.find((p) => p.id === id);
  if (c === undefined) throw new Error(`no part ${id}`);
  return c;
};
const mutated = (edit: (a: Case1Actual) => void): Case1Actual => {
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

  it("covers only the fields whose script rows are enabled", () => {
    const enabled = new Set(["c.nose.type", "c.nose.length", "c.nose.od", "c.body.type", "c.body.length", "c.body.od"]);
    const built = mutated(({ model, check }) => {
      model.components = model.components.filter((c) => c.id === "nose" || c.id === "body");
      (part(model, "nose").shape as { thickness: number }).thickness = 0.009; // not an enabled row
      part(model, "body").x_fore = 0.5; // position needs the whole part driven
      check.mass.dry = 1; // nor is mass scored on a subset
    });
    expect(compareCase1(plan, built, enabled)).toEqual([]);
    const wrong = mutated(({ model }) => {
      model.components = model.components.filter((c) => c.id === "nose" || c.id === "body");
      (part(model, "body").shape as { od: number }).od = 0.03;
    });
    expect(compareCase1(plan, wrong, enabled)).toContainEqual(expect.objectContaining({ part: "body", field: "od" }));
  });

  it("has a comparison rule for every part field the script drives", () => {
    expect(compareCase1(plan, identity).filter((d) => d.expected === "a comparison rule")).toEqual([]);
  });
});

describe("conditions", () => {
  const mappingOf = (model: EvaluatedModel) => matchParts(plan, model, allRowKeys()).mapping;

  it("passes on the fixture's own files and evaluated conditions", () => {
    const mapping = mappingOf(identity.model);
    expect(comparePersisted(FIXTURE_DIR, allRowKeys(), mapping)).toEqual([]);
    expect(compareEvaluatedConditions(plan, identity.model, allRowKeys(), mapping)).toEqual([]);
  });

  it("fails a default the sim file never wrote, though the engine evaluates it the same", () => {
    const dir = mkdtempSync(join(SCRATCH, "rw-case1-persist-"));
    try {
      const project = join(dir, "p");
      cpSync(FIXTURE_DIR, project, { recursive: true });
      const file = join(project, "sims/simulation_5.rw.toml");
      writeFileSync(file, readFileSync(file, "utf8").replace(/^rail_length = .*\n/m, ""));
      const mapping = mappingOf(identity.model);
      expect(comparePersisted(project, allRowKeys(), mapping)).toContainEqual(expect.objectContaining({ field: "sim.launch.rail_length", actual: "not written" }));
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
      const diffs = comparePersisted(project, allRowKeys(), mappingOf(identity.model));
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
    expect(comparePersisted(FIXTURE_DIR, allRowKeys(), mapping)).toContainEqual(expect.objectContaining({ field: "config.motors.mmt.motor", actual: "not written" }));
  });

  it("fails evaluated conditions that differ, and only for enabled rows", () => {
    const windy = structuredClone(identity.model);
    windy.sims["simulation_5"]!.conditions.rail_length_m = 2;
    const mapping = mappingOf(windy);
    expect(compareEvaluatedConditions(plan, windy, allRowKeys(), mapping)).toContainEqual(expect.objectContaining({ field: "sim.launch.rail_length" }));
    expect(compareEvaluatedConditions(plan, windy, new Set(["sim.wind.speed"]), mapping)).toEqual([]);
  });
});
