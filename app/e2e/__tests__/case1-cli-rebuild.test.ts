/**
 * Checkpoint B1-a (U12): case 1 rebuilt from an empty project through the CLI
 * alone, then held to B1's comparator and the oracle tolerances. Flying from
 * the CLI is right here: this proves the model can be built and flies true,
 * and B1's drive proves the app (D29). Writes `target/bar/usability/b1-cli.json`,
 * whether or not the checks pass, so a failure leaves its numbers behind.
 *
 * The values are read from the fixture (D14); the order and the ids are this
 * file's. Every part gets a new id, so a comparison that leaned on ids fails.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CheckReport, EvaluatedModel, ModelGetOut, SimulateOut } from "../../packages/contracts/src/generated/index.ts";
import { REPO_ROOT, round, stableStringify } from "../bar/paths.ts";
import { compareCase1, compareEvaluatedConditions, comparePersisted, flightOracleRows, loadOracle, matchParts, type Diff, type Oracle, type OracleRow, type RunSummaryRecord } from "../case1-compare.ts";
import { loadCase1Plan, readEnv, type Case1Plan } from "../case1-plan.ts";
import { FIXTURE_DIR, sourceFields, type TomlScalar } from "../case1-script.ts";
import { SCRATCH, sidecarBinary } from "../live.ts";

const REPORT = join(REPO_ROOT, "target/bar/usability/b1-cli.json");

/** The order `rw` accepts them in: materials first, then each part after its parent (findings, B1 add order). */
const MATERIALS = ["polystyrene", "cardboard", "ripstop_nylon", "elastic_cord"];
const PARTS = ["nose", "body", "chute", "cord", "wadding", "lug", "fins", "ring_fore", "ring_aft", "mmt", "block"];

const CONFIG = "default";
const SIM = "flight";
/** Total dry mass, spec B1. */
const DRY_MASS_TOL_G = 0.5;

const newId = (id: string): string => `b_${id}`;
const fixtureTable = (): Record<string, Record<string, Record<string, unknown>>> =>
  parse(readFileSync(join(FIXTURE_DIR, "rocket.rw.toml"), "utf8")) as Record<string, Record<string, Record<string, unknown>>>;

/** A fixture part under its new id, attached to its parent's new id. */
function rebuiltPart(table: Record<string, unknown>): Record<string, unknown> {
  const attach = table["attach"] as { to: string } | undefined;
  if (attach === undefined) return table;
  const [parent, ...anchor] = attach.to.split(".");
  return { ...table, attach: { ...attach, to: [newId(parent!), ...anchor].join(".") } };
}

interface Build {
  version: string;
  commands: string[];
  model: EvaluatedModel;
  check: CheckReport;
  plan: Case1Plan;
  oracle: Oracle;
  project: string;
  sim: SimulateOut;
  record: RunSummaryRecord;
  flight: OracleRow[];
}

let tmp = "";
let built: Build;

function rebuild(bin: string, project: string): Pick<Build, "commands" | "model" | "check" | "sim" | "record"> {
  const commands: string[] = [];
  const exec = (args: readonly string[]): string => {
    try {
      return execFileSync(bin, args, { encoding: "utf8", env: readEnv(), maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const { status, stdout, stderr } = e as { status: number | null; stdout: string; stderr: string };
      throw new Error(`rw ${args.join(" ")} exited ${String(status)}\n${stderr}\n${stdout.slice(0, 2000)}`, { cause: e });
    }
  };
  const rw = (args: readonly string[]): string => exec(["-C", project, ...args]);
  const json = <T>(args: readonly string[]): T => JSON.parse(rw(args)) as T;

  const add = (path: string, value: unknown): void => {
    commands.push(`call model_patch add ${path}`);
    rw(["call", "model_patch", JSON.stringify({ ops: [{ op: "add", path, value }] })]);
  };

  const fixture = fixtureTable();
  const fields = new Map<string, TomlScalar>(sourceFields().map((f) => [f.key, f.value]));
  const field = (key: string): TomlScalar => {
    const v = fields.get(key);
    if (v === undefined) throw new Error(`fixtures/case1 does not write ${key}`);
    return v;
  };

  commands.push("init --template empty");
  exec(["init", project, "--template", "empty", "--name", String(field("name")), "--json"]);

  for (const m of MATERIALS) add(`/materials/${m}`, fixture["materials"]![m]);
  for (const p of PARTS) add(`/c/${newId(p)}`, rebuiltPart(fixture["c"]![p]!));

  const mount = `configs.${CONFIG}.motors.${newId("mmt")}`;
  const deploy = `configs.${CONFIG}.deploy.${newId("chute")}`;
  const assignments = [
    `${mount}.motor=${String(field("config.motors.mmt.motor"))}`,
    `${mount}.delay=${String(field("config.motors.mmt.delay"))}`,
    `${deploy}.event=${String(field("config.deploy.chute.event"))}`,
    `${deploy}.altitude=${String(field("config.deploy.chute.altitude"))}`,
  ];
  // One step: `rw set` exits 1 unless its own strict check is clean, and a motor with no deployment is not.
  commands.push(`set ${assignments.join(" ")}`);
  rw(["set", ...assignments, "--json"]);

  add(`/sims/${SIM}`, {
    config: CONFIG,
    launch: { rail_length: field("sim.launch.rail_length") },
    wind: { speed: field("sim.wind.speed") },
    atmosphere: { model: field("sim.atmosphere.model") },
  });

  const out = json<ModelGetOut>(["eval", "--json"]);
  if (out.model == null) throw new Error("rw eval returned no model");
  const check = json<CheckReport>(["check", "--json"]);

  commands.push(`sim ${SIM}`);
  const sim = json<SimulateOut>(["sim", SIM, "--json"]);
  commands.push(`run summary ${SIM}/${sim.run_id}`);
  const record = json<RunSummaryRecord>(["run", "summary", `${sim.sim}/${sim.run_id}`, "--json"]);
  return { commands, model: out.model, check, sim, record };
}

interface Comparison {
  model: Diff[];
  conditions: Diff[];
}

function compare(b: Build): Comparison {
  const { mapping } = matchParts(b.plan, b.model);
  return {
    model: compareCase1(b.plan, { model: b.model, check: b.check }, b.oracle),
    conditions: [...compareEvaluatedConditions(b.plan, b.model, mapping), ...comparePersisted(b.project, mapping)],
  };
}

function writeReport(b: Build, c: Comparison): void {
  const { golden, tol } = b.oracle;
  const failed = new Set(c.model.map((d) => d.field));
  const staticRow = (key: string, value: number, g: number) => ({ key, value: round(value, 6), golden: round(g, 6), tolerance: tol[key], pass: !failed.has(key) });
  const flight = b.flight.map((r) => ({ ...r, value: round(r.value, 4), golden: round(r.golden, 4) }));
  const statics = [
    staticRow("mass.cg", b.check.mass.cg, golden.static.cg_m),
    staticRow("aero.cp", b.check.aero.cp, golden.static.cp_m),
    staticRow("stability.liftoff", b.check.stability.liftoff, golden.static.stability_cal),
  ];
  const dryMass = { value_g: round(b.check.mass.dry * 1000, 4), expected_g: round(b.plan.dryMass * 1000, 4), tolerance_g: DRY_MASS_TOL_G, pass: !failed.has("dry mass") };
  const pass = c.model.length === 0 && c.conditions.length === 0 && b.check.status === "clean" && b.flight.every((r) => r.pass);
  const report = {
    checkpoint: "B1-a",
    case: 1,
    status: pass ? "pass" : "fail",
    binary: b.version,
    parts: PARTS.length,
    materials: MATERIALS.length,
    commands: b.commands,
    check_status: b.check.status,
    dry_mass: dryMass,
    static: statics,
    flight,
    run: { sim: b.sim.sim, run_id: b.sim.run_id, status: b.sim.status },
    diffs: [...c.model, ...c.conditions],
  };
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, stableStringify(report));
}

let compared: Comparison;

beforeAll(() => {
  // RW_PLAIN_BIN wins when set. Doubles only answer when no project is open, so a doubles build flies this one for real.
  const pre = process.env["RW_PLAIN_BIN"];
  const bin = pre !== undefined && pre !== "" ? pre : sidecarBinary();
  tmp = mkdtempSync(join(SCRATCH, "rw-case1-cli-"));
  const project = join(tmp, "p");
  const plan = loadCase1Plan(bin);
  const oracle = loadOracle();
  const version = execFileSync(bin, ["--version"], { encoding: "utf8", env: readEnv() }).trim();
  const done = rebuild(bin, project);
  built = { ...done, version, plan, oracle, project, flight: flightOracleRows(done.record.summary, oracle) };
  compared = compare(built);
  writeReport(built, compared);
}, 600_000);

afterAll(() => {
  if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
});

describe("case 1 rebuilt with the CLI (B1-a)", () => {
  it("rebuilds every part and material the fixture has", () => {
    const fixture = fixtureTable();
    expect([...PARTS].sort()).toEqual(Object.keys(fixture["c"]!).sort());
    expect([...MATERIALS].sort()).toEqual(Object.keys(fixture["materials"]!).sort());
    expect(built.model.components.map((c) => c.id).sort()).toEqual(PARTS.map(newId).sort());
  });

  it("matches the fixture's parts, materials, dry mass and static numbers", () => {
    expect(compared.model).toEqual([]);
  });

  it("checks as cleanly as the fixture", () => {
    expect(built.check.diagnostics).toEqual([]);
    expect(built.check.status).toBe("clean");
  });

  it("evaluates and writes the fixture's motor, deployment and conditions", () => {
    expect(compared.conditions).toEqual([]);
  });

  it("flies within the oracle's tolerances", () => {
    expect(built.sim.status).toBe("complete");
    expect(built.sim.cached).toBe(false);
    expect(built.record.summary).toEqual(built.sim.summary);
    expect(built.flight.filter((r) => !r.pass)).toEqual([]);
  });

  it("reports the checkpoint", () => {
    const report = JSON.parse(readFileSync(REPORT, "utf8")) as { status: string; flight: unknown[]; static: unknown[] };
    expect(report.status).toBe("pass");
    expect(report.flight).toHaveLength(3);
    expect(report.static).toHaveLength(3);
  });
});
