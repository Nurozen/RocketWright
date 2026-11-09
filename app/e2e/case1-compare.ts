/**
 * B1's post-quit assertions. Comparison (D23) is normalized: parts match by
 * type and mapped parent, never by id or name; `model_hash` is not compared
 * because a rebuilt project has different ids. Run scoring (D29) reads only
 * the run the app made and allows no simulation after quit: this file is
 * scanned for the CLI's flying arguments (see `__tests__/case1-scan.test.ts`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "smol-toml";
import type { CheckReport, EvalComponent, EvalConfig, EvalSim, EvaluatedModel, ModelGetOut, RunManifest, RunSummary } from "../packages/contracts/src/generated/index.ts";
import { REPO_ROOT } from "./bar/paths.ts";
import type { Case1Plan } from "./case1-plan.ts";
import { readEnv } from "./case1-plan.ts";
import { SCRIPT_ROWS, sourceFields, type SourceField, type TomlScalar } from "./case1-script.ts";

export interface Diff {
  part: string;
  field: string;
  expected: unknown;
  actual: unknown;
}

export interface Case1Actual {
  model: EvaluatedModel;
  check: CheckReport;
}

/** 0.01 mm, for lengths and positions (D23). */
const LENGTH_TOL_M = 1e-5;
/** 0.5%, for densities and dimensionless values (D23). */
const RATIO_TOL = 0.005;
/** Total dry mass, spec B1. */
const DRY_MASS_TOL_KG = 0.5e-3;
/** Absorbs float noise when a tolerance is hit exactly or the expected value is zero. */
const EPS = 1e-12;

const withinLength = (a: number, e: number) => Math.abs(a - e) <= LENGTH_TOL_M + EPS;
const withinRatio = (a: number, e: number) => Math.abs(a - e) <= RATIO_TOL * Math.abs(e) + EPS;

type Tolerance = "length" | "ratio" | "exact" | "material";

interface FieldRule {
  /** Path in the evaluated component. `alt` is used where the engine reports a derived form. */
  path: readonly string[];
  alt?: readonly string[];
  tol: Tolerance;
}

/** `c.<id>.<leaf>` to where the evaluated part reports it. `attach.*`, `name` and `type` are handled apart. */
const FIELD_RULES: Readonly<Record<string, FieldRule>> = {
  length: { path: ["shape", "length"], tol: "length" },
  od: { path: ["shape", "od"], tol: "length" },
  id: { path: ["shape", "id"], tol: "length" },
  // Tubes and lugs evaluate wall thickness to an inner diameter.
  thickness: { path: ["shape", "thickness"], alt: ["shape", "id"], tol: "length" },
  shape: { path: ["shape", "shape"], tol: "exact" },
  shape_param: { path: ["shape", "shape_param"], tol: "ratio" },
  "shoulder.length": { path: ["shape", "shoulder", "length"], tol: "length" },
  "shoulder.od": { path: ["shape", "shoulder", "od"], tol: "length" },
  "shoulder.thickness": { path: ["shape", "shoulder", "thickness"], tol: "length" },
  "shoulder.capped": { path: ["shape", "shoulder", "capped"], tol: "exact" },
  diameter: { path: ["shape", "diameter"], tol: "length" },
  cd: { path: ["shape", "cd"], tol: "ratio" },
  line_count: { path: ["shape", "line_count"], tol: "exact" },
  line_length: { path: ["shape", "line_length"], tol: "length" },
  line_material: { path: ["shape", "line_material"], tol: "material" },
  packed_length: { path: ["shape", "packed_length"], tol: "length" },
  packed_diameter: { path: ["shape", "packed_diameter"], tol: "length" },
  cord_length: { path: ["shape", "cord_length"], tol: "length" },
  mass: { path: ["shape", "mass"], tol: "ratio" },
  count: { path: ["shape", "count"], tol: "exact" },
  root_chord: { path: ["shape", "root_chord"], tol: "length" },
  tip_chord: { path: ["shape", "tip_chord"], tol: "length" },
  span: { path: ["shape", "span"], tol: "length" },
  sweep: { path: ["shape", "sweep"], tol: "length" },
  cross_section: { path: ["shape", "cross_section"], tol: "exact" },
  "tab.height": { path: ["shape", "tab", "height"], tol: "length" },
  "tab.length": { path: ["shape", "tab", "length"], tol: "length" },
  motor_mount: { path: ["shape", "motor_mount"], tol: "exact" },
  overhang: { path: ["shape", "overhang"], tol: "length" },
  material: { path: ["material"], tol: "material" },
  // A roughness of 60 um would pass a 0.01 mm band at 50 um, so it takes the ratio.
  "finish.roughness": { path: ["roughness"], tol: "ratio" },
};

const SKIPPED_LEAVES = new Set(["name", "type"]);

/** Every driven key: the default scope of a comparison. */
export function allRowKeys(): Set<string> {
  return new Set(SCRIPT_ROWS.map((r) => r.key));
}

function at(from: unknown, path: readonly string[]): unknown {
  let cur = from;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Expected part id to the actual part it matched. */
export type PartMapping = ReadonlyMap<string, EvalComponent>;

const keyOfPart = (key: string): string | null => /^c\.([^.]+)\./.exec(key)?.[1] ?? null;

function enabledParts(enabled: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const k of enabled) {
    const id = keyOfPart(k);
    if (id !== null) out.add(id);
  }
  return out;
}

const byFore = (a: EvalComponent, b: EvalComponent) => a.x_fore - b.x_fore || a.id.localeCompare(b.id);

/**
 * Pairs expected parts with actual ones by `shape.type` and mapped parent;
 * `x_fore` breaks ties between siblings (`ring_fore` and `ring_aft`, D23).
 * Parents go first, so a child can be matched through its parent's mapping.
 */
export function matchParts(plan: Case1Plan, actual: EvaluatedModel, enabled: ReadonlySet<string>): { mapping: Map<string, EvalComponent>; diffs: Diff[] } {
  const wanted = enabledParts(enabled);
  const expected = plan.model.components.filter((c) => wanted.has(c.id));
  const mapping = new Map<string, EvalComponent>();
  const used = new Set<string>();
  const diffs: Diff[] = [];
  const pending = [...expected].sort(byFore);
  const depth = (c: EvalComponent): number => {
    const parent = c.parent == null ? undefined : expected.find((p) => p.id === c.parent);
    return parent === undefined ? 0 : depth(parent) + 1;
  };
  pending.sort((a, b) => depth(a) - depth(b) || byFore(a, b));
  for (const part of pending) {
    const parentKnown = part.parent != null && wanted.has(part.parent);
    const mappedParent = parentKnown ? mapping.get(part.parent!) : undefined;
    const candidates = actual.components
      .filter((c) => !used.has(c.id) && c.shape.type === part.shape.type)
      .filter((c) => {
        if (part.parent == null) return c.parent == null;
        if (!parentKnown) return true;
        return mappedParent !== undefined && c.parent === mappedParent.id;
      })
      .sort(byFore);
    const hit = candidates[0];
    if (hit === undefined) {
      diffs.push({ part: part.id, field: "part", expected: `${part.shape.type} under ${part.parent ?? "the root"}`, actual: "missing" });
      continue;
    }
    used.add(hit.id);
    mapping.set(part.id, hit);
  }
  for (const c of actual.components) {
    if (!used.has(c.id)) diffs.push({ part: c.id, field: "part", expected: "no such part", actual: c.shape.type });
  }
  return { mapping, diffs };
}

function resolvedMaterial(model: EvaluatedModel, name: unknown): Record<string, number> | null {
  if (typeof name !== "string") return null;
  const m = (model.materials as Record<string, unknown>)[name];
  if (m === null || typeof m !== "object") return null;
  const out: Record<string, number> = {};
  for (const prop of ["density", "surface_density", "line_density"]) {
    const v = (m as Record<string, unknown>)[prop];
    if (typeof v === "number") out[prop] = v;
  }
  return out;
}

function compareField(id: string, leaf: string, rule: FieldRule, expected: EvalComponent, actual: EvalComponent, plan: Case1Plan, model: EvaluatedModel, diffs: Diff[]): void {
  const pick = (c: EvalComponent): unknown => {
    const v = at(c, rule.path);
    return v === undefined && rule.alt !== undefined ? at(c, rule.alt) : v;
  };
  const e = pick(expected);
  const a = pick(actual);
  const fail = () => diffs.push({ part: id, field: leaf, expected: e, actual: a });
  if (rule.tol === "material") {
    const em = resolvedMaterial(plan.model, e);
    const am = resolvedMaterial(model, a);
    if (em === null || am === null) return void fail();
    for (const [prop, value] of Object.entries(em)) {
      const got = am[prop];
      if (got === undefined || !withinRatio(got, value)) diffs.push({ part: id, field: `${leaf}.${prop}`, expected: value, actual: got });
    }
    return;
  }
  if (rule.tol === "exact") {
    if (e !== a) fail();
    return;
  }
  if (typeof e !== "number" || typeof a !== "number") return void fail();
  if (!(rule.tol === "length" ? withinLength(a, e) : withinRatio(a, e))) fail();
}

/** A part's position is scored once it and its whole parent chain are fully driven. */
function positionEnabled(part: EvalComponent, plan: Case1Plan, enabled: ReadonlySet<string>, all: ReadonlySet<string>): boolean {
  const byId = new Map(plan.model.components.map((c) => [c.id, c]));
  let cur: EvalComponent | undefined = part;
  while (cur !== undefined) {
    const prefix = `c.${cur.id}.`;
    for (const k of all) if (k.startsWith(prefix) && !enabled.has(k)) return false;
    cur = cur.parent == null ? undefined : byId.get(cur.parent);
  }
  return true;
}

function comparePosition(id: string, e: EvalComponent, a: EvalComponent, diffs: Diff[]): void {
  for (const f of ["x_fore", "x_aft", "radial"] as const) {
    if (!withinLength(a[f], e[f])) diffs.push({ part: id, field: f, expected: e[f], actual: a[f] });
  }
  if (!withinRatio(a.roll, e.roll)) diffs.push({ part: id, field: "roll", expected: e.roll, actual: a.roll });
}

function compareMaterials(plan: Case1Plan, model: EvaluatedModel, enabled: ReadonlySet<string>, diffs: Diff[]): void {
  const actual = Object.keys(model.materials).map((name) => resolvedMaterial(model, name)).filter((m) => m !== null);
  for (const key of enabled) {
    const m = /^materials\.([^.]+)\.(.+)$/.exec(key);
    if (m === null) continue;
    const expected = resolvedMaterial(plan.model, m[1])?.[m[2]!];
    if (expected === undefined) {
      diffs.push({ part: m[1]!, field: m[2]!, expected: "a value in the plan", actual: "none" });
      continue;
    }
    if (!actual.some((a) => a[m[2]!] !== undefined && withinRatio(a[m[2]!]!, expected))) {
      diffs.push({ part: m[1]!, field: m[2]!, expected, actual: "no material with this value" });
    }
  }
}

function everyEnabled(enabled: ReadonlySet<string>, all: ReadonlySet<string>, prefixes: readonly string[]): boolean {
  for (const k of all) if (prefixes.some((p) => k.startsWith(p)) && !enabled.has(k)) return false;
  return true;
}

/**
 * D23's comparison, over the fields whose script rows are enabled. The whole
 * model is required before dry mass or the static numbers are scored.
 */
export function compareCase1(plan: Case1Plan, actual: Case1Actual, enabled: ReadonlySet<string> = allRowKeys(), oracle: Oracle = loadOracle()): Diff[] {
  const all = allRowKeys();
  const { mapping, diffs } = matchParts(plan, actual.model, enabled);
  for (const part of plan.model.components) {
    const a = mapping.get(part.id);
    if (a === undefined) continue;
    const prefix = `c.${part.id}.`;
    for (const key of enabled) {
      if (!key.startsWith(prefix)) continue;
      const leaf = key.slice(prefix.length);
      if (SKIPPED_LEAVES.has(leaf) || leaf.startsWith("attach.")) continue;
      const rule = FIELD_RULES[leaf];
      if (rule === undefined) {
        diffs.push({ part: part.id, field: leaf, expected: "a comparison rule", actual: "none" });
        continue;
      }
      compareField(part.id, leaf, rule, part, a, plan, actual.model, diffs);
    }
    if (positionEnabled(part, plan, enabled, all)) comparePosition(part.id, part, a, diffs);
  }
  compareMaterials(plan, actual.model, enabled, diffs);
  if (everyEnabled(enabled, all, ["c.", "materials."])) {
    if (Math.abs(actual.check.mass.dry - plan.dryMass) > DRY_MASS_TOL_KG + EPS) diffs.push({ part: "rocket", field: "dry mass", expected: plan.dryMass, actual: actual.check.mass.dry });
  }
  if (everyEnabled(enabled, all, ["c.", "materials.", "config."])) {
    for (const r of staticOracleRows(actual.check, oracle)) {
      if (!r.pass) diffs.push({ part: "rocket", field: r.key, expected: `${r.golden} within ${r.tolerance}`, actual: r.value });
    }
  }
  return diffs;
}

// ---- conditions ----------------------------------------------------------------

const SI_FACTORS: Readonly<Record<string, number>> = { m: 1, mm: 1e-3, km: 1e3, s: 1, ms: 1e-3, "m/s": 1 };

/** A persisted number: bare or with a unit, in SI. Null for an expression or an unknown unit. */
function quantity(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const m = /^\s*([-+]?[0-9.]+(?:[eE][-+]?[0-9]+)?)\s*(\S+)?\s*$/.exec(v);
  if (m === null) return null;
  if (m[2] === undefined) return Number(m[1]);
  const factor = SI_FACTORS[m[2]];
  return factor === undefined ? null : Number(m[1]) * factor;
}

function sameValue(actual: unknown, expected: TomlScalar): boolean {
  if (typeof expected === "string") {
    const e = quantity(expected);
    if (e === null) return actual === expected;
    const a = quantity(actual);
    return a !== null && withinRatio(a, e);
  }
  if (typeof expected === "number") {
    const a = quantity(actual);
    return a !== null && withinRatio(a, expected);
  }
  return actual === expected;
}

function readTomlFiles(dir: string): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    if (f.endsWith(".rw.toml")) out.set(f.replace(/\.rw\.toml$/, ""), parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>);
  }
  return out;
}

/** The persisted key a source key names, with part ids mapped to the rebuilt project's. */
function persistedPath(key: string, mapping: PartMapping): string[] | null {
  const rest = key.split(".").slice(1);
  if (key.startsWith("sim.")) return rest;
  if (!key.startsWith("config.")) return null;
  if (rest.length < 2) return rest;
  const mapped = mapping.get(rest[1]!);
  return mapped === undefined ? null : [rest[0]!, mapped.id, ...rest.slice(2)];
}

/**
 * D23: rail, wind, atmosphere, motor, delay and deployment are written
 * explicitly. `rw eval` alone cannot show this: rail, wind and USSA read as
 * engine defaults even when no editor wrote them.
 */
export function comparePersisted(project: string, enabled: ReadonlySet<string>, mapping: PartMapping, fields: readonly SourceField[] = sourceFields()): Diff[] {
  const diffs: Diff[] = [];
  const keys = fields.filter((f) => enabled.has(f.key) && (f.key.startsWith("config.") || f.key.startsWith("sim.")));
  if (keys.length === 0) return diffs;
  const sims = readTomlFiles(join(project, "sims"));
  const configs = readTomlFiles(join(project, "configs"));
  const needsSim = keys.some((f) => f.key.startsWith("sim."));
  if (needsSim && sims.size !== 1) diffs.push({ part: "project", field: "sims", expected: "exactly one sim file", actual: sims.size });
  const sim = [...sims.values()][0];
  const configId = typeof sim?.["config"] === "string" ? sim["config"] : undefined;
  const config = configId !== undefined ? configs.get(configId) : configs.size === 1 ? [...configs.values()][0] : undefined;
  for (const f of keys) {
    const path = persistedPath(f.key, mapping);
    const table = f.key.startsWith("sim.") ? sim : config;
    const got = path === null || table === undefined ? undefined : at(table, path);
    if (got === undefined) diffs.push({ part: "persisted", field: f.key, expected: f.value, actual: "not written" });
    else if (!sameValue(got, f.value)) diffs.push({ part: "persisted", field: f.key, expected: f.value, actual: got });
  }
  return diffs;
}

function onlySim(model: EvaluatedModel): EvalSim | undefined {
  const sims = Object.values(model.sims).filter((s) => s !== undefined);
  return sims.length === 1 ? sims[0] : undefined;
}

function configOf(model: EvaluatedModel, sim: EvalSim | undefined): EvalConfig | undefined {
  const id = sim?.config ?? model.config;
  return id == null ? undefined : model.configs[id];
}

/** The same conditions as the engine evaluated them, against the plan's. */
export function compareEvaluatedConditions(plan: Case1Plan, actual: EvaluatedModel, enabled: ReadonlySet<string>, mapping: PartMapping): Diff[] {
  const diffs: Diff[] = [];
  const num = (key: string, e: unknown, a: unknown) => {
    if (!enabled.has(key)) return;
    if (typeof e !== "number" || typeof a !== "number" || !withinRatio(a, e)) diffs.push({ part: "evaluated", field: key, expected: e, actual: a });
  };
  const same = (key: string, e: unknown, a: unknown) => {
    if (enabled.has(key) && e !== a) diffs.push({ part: "evaluated", field: key, expected: e, actual: a });
  };
  const planSim = onlySim(plan.model);
  const actualSim = onlySim(actual);
  if (["sim.launch.rail_length", "sim.wind.speed", "sim.atmosphere.model"].some((k) => enabled.has(k)) && actualSim === undefined) {
    diffs.push({ part: "evaluated", field: "sims", expected: "exactly one sim", actual: Object.keys(actual.sims).length });
  }
  num("sim.launch.rail_length", planSim?.conditions.rail_length_m, actualSim?.conditions.rail_length_m);
  num("sim.wind.speed", planSim?.conditions.wind_speed_ms, actualSim?.conditions.wind_speed_ms);
  same("sim.atmosphere.model", planSim?.conditions.atmosphere, actualSim?.conditions.atmosphere);
  const planConfig = configOf(plan.model, planSim);
  const actualConfig = configOf(actual, actualSim);
  const planMount = planConfig?.motors.find((m) => m.mount === "mmt");
  const actualMount = actualConfig?.motors.find((m) => m.mount === mapping.get("mmt")?.id);
  same("config.motors.mmt.motor", planMount?.motor, actualMount?.motor);
  num("config.motors.mmt.delay", planMount?.delay, actualMount?.delay);
  const planDeploy = planConfig?.deployments.find((d) => d.component === "chute");
  const actualDeploy = actualConfig?.deployments.find((d) => d.component === mapping.get("chute")?.id);
  same("config.deploy.chute.event", planDeploy?.event, actualDeploy?.event);
  num("config.deploy.chute.altitude", planDeploy?.altitude, actualDeploy?.altitude);
  return diffs;
}

// ---- oracle --------------------------------------------------------------------

export interface Oracle {
  tol: Readonly<Record<string, string>>;
  golden: {
    summary: { max_altitude_m: number; max_velocity_ms: number; time_to_apogee_s: number };
    static: { cg_m: number; cp_m: number; stability_cal: number };
  };
}

export function loadOracle(): Oracle {
  const tolerances = JSON.parse(readFileSync(join(REPO_ROOT, "tests/oracle/tolerances.json"), "utf8")) as { groups: { cases: number[]; tol: Record<string, string> }[] };
  const group = tolerances.groups.find((g) => g.cases.includes(1));
  if (group === undefined) throw new Error("tests/oracle/tolerances.json has no group for case 1");
  const golden = JSON.parse(readFileSync(join(REPO_ROOT, "tests/oracle/case1-generic.json"), "utf8")) as Oracle["golden"];
  return { tol: group.tol, golden };
}

export interface OracleRow {
  key: string;
  value: number;
  golden: number;
  tolerance: string;
  pass: boolean;
}

function withinTolerance(value: number, golden: number, tol: string): boolean {
  const m = /^\s*([0-9.]+)\s*(%|mm|m|s|cal)\s*$/.exec(tol);
  if (m === null) throw new Error(`unknown tolerance ${tol}`);
  const n = Number(m[1]);
  const band = m[2] === "%" ? (n / 100) * Math.abs(golden) : m[2] === "mm" ? n / 1000 : n;
  return Math.abs(value - golden) <= band + EPS;
}

function oracleRow(key: string, value: number, golden: number, oracle: Oracle): OracleRow {
  const tolerance = oracle.tol[key];
  if (tolerance === undefined) throw new Error(`tests/oracle/tolerances.json has no case 1 tolerance for ${key}`);
  return { key, value, golden, tolerance, pass: withinTolerance(value, golden, tolerance) };
}

function staticOracleRows(check: CheckReport, oracle: Oracle): OracleRow[] {
  return [
    oracleRow("mass.cg", check.mass.cg, oracle.golden.static.cg_m, oracle),
    oracleRow("aero.cp", check.aero.cp, oracle.golden.static.cp_m, oracle),
    oracleRow("stability.liftoff", check.stability.liftoff, oracle.golden.static.stability_cal, oracle),
  ];
}

/** Flight numbers against the oracle: only from the app's run record (D29). */
export function flightOracleRows(summary: RunSummary, oracle: Oracle): OracleRow[] {
  return [
    oracleRow("apogee_m", summary.apogee_m, oracle.golden.summary.max_altitude_m, oracle),
    oracleRow("max_velocity_ms", summary.max_velocity_ms, oracle.golden.summary.max_velocity_ms, oracle),
    oracleRow("time_to_apogee_s", summary.time_to_apogee_s, oracle.golden.summary.time_to_apogee_s, oracle),
  ];
}

// ---- the post-quit reader ------------------------------------------------------

/** The output of `rw run summary <sim>/<run-id> --json`. */
export interface RunSummaryRecord {
  run: string;
  model_hash: string;
  summary: RunSummary;
}

export interface PostQuitReader {
  /** Every call made so far. */
  readonly calls: readonly (readonly string[])[];
  model(): EvaluatedModel;
  check(): CheckReport;
  runSummary(run: string): RunSummaryRecord;
}

/** Throws unless `args` is one of the three post-quit reads. */
export function assertPostQuitArgs(args: readonly string[]): void {
  const [first, second, third, fourth] = args;
  const read = (first === "eval" || first === "check") && second === "--json" && args.length === 2;
  const summary = first === "run" && second === "summary" && typeof third === "string" && !third.startsWith("-") && fourth === "--json" && args.length === 4;
  if (!read && !summary) throw new Error(`post-quit reader refuses \`rw ${args.join(" ")}\`: only eval, check and run summary may run after quit`);
}

/** Every post-quit `rw` goes through here. Run it after the sidecar has exited (`killOrphans`). */
export function createPostQuitReader(bin: string, project: string): PostQuitReader {
  const calls: string[][] = [];
  const run = <T>(args: string[]): T => {
    assertPostQuitArgs(args);
    calls.push(args);
    return JSON.parse(execFileSync(bin, ["-C", project, ...args], { encoding: "utf8", env: readEnv(), maxBuffer: 64 * 1024 * 1024 })) as T;
  };
  return {
    calls,
    model: () => {
      const out = run<ModelGetOut>(["eval", "--json"]);
      if (out.model == null) throw new Error("rw eval returned no model");
      return out.model;
    },
    check: () => run<CheckReport>(["check", "--json"]),
    runSummary: (id) => run<RunSummaryRecord>(["run", "summary", id, "--json"]),
  };
}

// ---- run scoring ---------------------------------------------------------------

/** One Results cell as read: the header text with its unit, and the shown string. */
export interface TableCell {
  header: string;
  shown: string;
}

/** The app's Results row, read from the screen. */
export interface TableRead {
  apogee: TableCell;
  maxSpeed: TableCell;
  flightTime: TableCell;
}

export interface RunManifestFile {
  path: string;
  manifest: RunManifest;
}

/** `runs/<sim>/<run-id>/manifest.json`, every one of them. */
export function listRunManifests(project: string): RunManifestFile[] {
  const runs = join(project, "runs");
  const out: RunManifestFile[] = [];
  if (!existsSync(runs)) return out;
  for (const sim of readdirSync(runs).sort()) {
    const simDir = join(runs, sim);
    if (!lstatSync(simDir).isDirectory()) continue;
    for (const id of readdirSync(simDir).sort()) {
      const path = join(simDir, id, "manifest.json");
      if (existsSync(path)) out.push({ path, manifest: JSON.parse(readFileSync(path, "utf8")) as RunManifest });
    }
  }
  return out;
}

/** Path, size and mtime of everything under `runs/`, for proving the post-quit reads flew nothing. */
export function runsTree(project: string): string[] {
  const root = join(project, "runs");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = lstatSync(path);
      out.push(`${relative(root, path)}\t${st.size}\t${st.mtimeMs}`);
      if (st.isDirectory()) walk(path);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

const HEADER_UNIT_TO_SI: Readonly<Record<string, number>> = { m: 1, ft: 0.3048, km: 1000, "m/s": 1, "ft/s": 0.3048, s: 1, min: 60 };

/** Checks one shown cell against the record: same number in the header's unit, within half its last digit. */
export function checkCell(name: string, cell: TableCell, recordSi: number): string | null {
  const unit = /\(([^)]+)\)/.exec(cell.header)?.[1];
  const factor = unit === undefined ? undefined : HEADER_UNIT_TO_SI[unit];
  if (factor === undefined) return `${name}: header "${cell.header}" names no known unit`;
  const text = cell.shown.trim();
  const m = /^-?[0-9][0-9,]*(?:\.([0-9]+))?$/.exec(text);
  if (m === null) return `${name}: the table shows "${cell.shown}", not a number`;
  const shown = Number(text.replaceAll(",", ""));
  const halfDigit = 0.5 * 10 ** -(m[1]?.length ?? 0);
  const expected = recordSi / factor;
  if (Math.abs(shown - expected) > halfDigit + EPS) return `${name}: the table shows ${text} ${unit}, the run record says ${expected} ${unit}`;
  return null;
}

export interface RunScoreInput {
  project: string;
  reader: PostQuitReader;
  /** `Date.now()` taken before the Run click. */
  runClickedAtMs: number;
  /** `Date.now()` taken when quit began. */
  quitAtMs: number;
  /** The Results row as read in the `run` stage and, later, the `reopen` stage. */
  table: readonly TableRead[];
  oracle?: Oracle;
}

export interface RunScore {
  problems: string[];
  run?: RunManifest;
  summary?: RunSummary;
  oracle?: OracleRow[];
}

/**
 * D29: the flight numbers come from the one run the app made. A cached or
 * CLI-flown run gives the same numbers as a working Run button, so the
 * record's origin, timing and model are what is scored first.
 */
export function scoreRun(input: RunScoreInput): RunScore {
  const { project, reader } = input;
  const problems: string[] = [];
  if (reader.calls.length > 0) problems.push("a post-quit rw call ran before the run directories were listed");
  const flights = listRunManifests(project).filter((f) => f.manifest.kind === "flight");
  if (flights.length !== 1) return { problems: [...problems, `expected exactly one flight run in runs/, found ${flights.length}`] };
  const manifest = flights[0]!.manifest;
  const score: RunScore = { problems, run: manifest };
  if (manifest.thread !== "ui") problems.push(`the run was not flown by the app: manifest.thread is ${JSON.stringify(manifest.thread ?? null)}`);
  const started = manifest.started == null ? Number.NaN : Date.parse(manifest.started);
  // `started` has one-second resolution.
  if (!Number.isFinite(started) || started < Math.floor(input.runClickedAtMs / 1000) * 1000 || started > Math.ceil(input.quitAtMs / 1000) * 1000) {
    problems.push(`the run started at ${String(manifest.started)}, outside the Run click and the quit`);
  }
  const before = runsTree(project);
  const check = reader.check();
  if (manifest.model_hash !== check.model_hash) problems.push(`the run's model_hash ${manifest.model_hash} is not the final model ${check.model_hash}`);
  const record = reader.runSummary(`${manifest.sim}/${manifest.run_id}`);
  const after = runsTree(project);
  if (before.join("\n") !== after.join("\n")) problems.push("runs/ changed during the post-quit reads");
  score.summary = record.summary;
  if (input.table.length === 0) problems.push("the Results table was never read");
  const [first] = input.table;
  for (const read of input.table) {
    if (JSON.stringify(read) !== JSON.stringify(first)) problems.push("the Results table changed between the run and the reopen");
    for (const p of [
      checkCell("Apogee", read.apogee, record.summary.apogee_m),
      checkCell("Max speed", read.maxSpeed, record.summary.max_velocity_ms),
      checkCell("Flight time", read.flightTime, record.summary.flight_time_s),
    ]) {
      if (p !== null) problems.push(p);
    }
  }
  const rows = flightOracleRows(record.summary, input.oracle ?? loadOracle());
  score.oracle = rows;
  for (const r of rows) if (!r.pass) problems.push(`${r.key} ${r.value} is outside ${r.golden} within ${r.tolerance}`);
  return score;
}
