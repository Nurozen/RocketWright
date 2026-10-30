/**
 * B2 parity scoreboard (M1.16, D25): `make bar-parity [CASE=…] [KEYS=…] [GATE=1]`.
 *
 * Two matrices: `generic` (generic-curve goldens; the gate) and `original`
 * (unmodified examples, summary keys only; the import check, M2.5). For each
 * case and matrix it pairs the golden `tests/oracle/case<n>-<matrix>.json`
 * with our run record `<ours>/case<n>-<matrix>.json` (format: `OurRun`,
 * documented in `tests/oracle/README.md`) and writes one row per key:
 * `{matrix, case, key, golden_key, ours, golden, delta, delta_pct, tol, pass, status}`.
 *
 * Before any tolerance scoring, a geometry-sha256, conditions-hash, config-id,
 * sim-name, or motor-digest mismatch (or a golden whose own hashes do not
 * recompute) marks every row of that case `mismatch`; mismatched rows are never
 * scored. A missing golden or run marks every row `not-run`.
 *
 * Report mode (default) exits 0. `--gate` exits 1 unless every toleranced
 * generic-matrix row of the selected cases passes. Bad flags or data exit 2.
 * `--self-test` plants a matching pair and a digest mismatch and checks both.
 * `--refresh` first rewrites our run records for the selected cases that have a
 * producer (`PRODUCERS`; case 1: the M1.42b CLI parity test, `rw check` +
 * `rw sim` + `rw diff run --golden`). `make bar-parity` then runs
 * `scripts/bar/triage.ts` (per-term table, embedded in the scoreboard).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { REPO_ROOT, reviewsDir, stableStringify } from "../../app/e2e/bar/paths.ts";

export const ORACLE_DIR = join(REPO_ROOT, "tests/oracle");
export const KEYMAP_PATH = join(ORACLE_DIR, "keymap.json");
export const TOLERANCES_PATH = join(ORACLE_DIR, "tolerances.json");
/** Default directory of our run records (`case<n>-<matrix>.json`). */
export const DEFAULT_OURS_DIR = join(REPO_ROOT, "target/parity/ours");
export const MATRICES = ["generic", "original"] as const;
export type Matrix = (typeof MATRICES)[number];
export const ALL_CASES = [1, 2, 3, 4, 5, 6, 7] as const;

// ---- data types ---------------------------------------------------------------

export interface KeyMap {
  /** Oracle summary key → `RunSummary` key. */
  summary: Record<string, string>;
  /** Oracle static key → check-report metric path. */
  static: Record<string, string>;
}

export interface ToleranceGroup {
  cases: number[];
  note?: string;
  /** Our key → tolerance string (`3%`, `0.3 s`, `1 mm`, `0.1 cal`). */
  tol: Record<string, string>;
}

export interface Tolerances {
  gate_matrix: Matrix;
  groups: ToleranceGroup[];
}

/** The subset of `OracleGolden` (schema/oracle-golden.json) the scorer reads. */
export interface Golden {
  kind: "golden";
  case: number;
  matrix: Matrix;
  sim_name: string;
  config_id: string;
  geometry_sha256: string;
  conditions: Record<string, unknown>;
  conditions_hash: string;
  motor_digest: string;
  motors: { digest: string }[];
  summary: Record<string, number | null>;
  static?: Record<string, number> | null;
}

/**
 * Our side of one case: the identity fields in the golden's terms plus the
 * values in our key names. Written by the M1.42b CLI parity test
 * (`crates/rw-cli/tests/parity_case1.rs`) or assembled with `oursFromRun`.
 */
export interface OurRun {
  kind: "ours";
  case: number;
  matrix: Matrix;
  sim_name: string;
  /** The golden-side flight configuration id the fixture maps to. */
  config_id: string;
  /** sha256 hex of the `case<n>.geometry.json` the fixture was authored from. */
  geometry_sha256: string;
  conditions_hash: string;
  /** `motorDigest` over the curve sha256s actually flown. */
  motor_digest: string;
  /** `RunSummary` values. */
  summary: Record<string, number | null>;
  /** Check-report metric paths (`mass.cg`, `aero.cp`, `aero.cna`, `stability.liftoff`). */
  check: Record<string, number | null>;
}

export type Status = "pass" | "fail" | "report" | "missing" | "mismatch" | "not-run";

export interface Row {
  matrix: Matrix;
  case: number;
  /** Our key (RunSummary key or check metric path). */
  key: string;
  golden_key: string;
  ours: number | null;
  golden: number | null;
  delta: number | null;
  delta_pct: number | null;
  tol: string | null;
  /** `null` unless scored against a tolerance. */
  pass: boolean | null;
  status: Status;
  reason?: string;
}

export interface Scoreboard {
  schema: "rw/1";
  gate_matrix: Matrix;
  rows: Row[];
  totals: Record<Matrix, Record<Status, number>>;
}

// ---- hashes (mirror rw_api::oracle) ------------------------------------------

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** RFC 8785 canonical JSON (keys sorted by UTF-16 units, ES number form). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

/** `sha256:<hex>` of the canonical `conditions` (`rw_api::oracle::conditions_hash`). */
export function conditionsHash(conditions: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(conditions))}`;
}

/** sha256 hex over the sorted curve digests joined by `\n` (`rw_api::oracle::motor_digest`). */
export function motorDigest(digests: string[]): string {
  return sha256Hex([...digests].sort().join("\n"));
}

// ---- tolerance parsing ----------------------------------------------------------

/** Absolute tolerance units → SI factor (our values are SI; `cal` is calibers). */
const UNIT_FACTORS: Record<string, number> = { "%": 0, s: 1, m: 1, mm: 1e-3, cal: 1, "m/s": 1, "m/s2": 1, "": 1 };

export type Tol = { kind: "rel"; frac: number } | { kind: "abs"; si: number };

export function parseTol(s: string): Tol {
  const m = /^\s*([0-9]*\.?[0-9]+(?:e[-+]?\d+)?)\s*(%|[a-z/0-9]*)\s*$/i.exec(s);
  const unit = m?.[2] ?? "";
  if (!m || !(unit in UNIT_FACTORS)) throw new Error(`bad tolerance ${JSON.stringify(s)}`);
  const n = Number(m[1]);
  return unit === "%" ? { kind: "rel", frac: n / 100 } : { kind: "abs", si: n * (UNIT_FACTORS[unit] ?? 1) };
}

export function tolFor(tols: Tolerances, caseN: number, key: string): string | null {
  for (const g of tols.groups) if (g.cases.includes(caseN) && key in g.tol) return g.tol[key] ?? null;
  return null;
}

/** Six significant figures, so the report is byte-stable (I8). */
function sig(x: number): number {
  return Number(x.toPrecision(6));
}

// ---- scoring --------------------------------------------------------------------

interface KeyPair {
  goldenKey: string;
  ourKey: string;
  block: "summary" | "static";
}

function keyPairs(keymap: KeyMap, matrix: Matrix, keys?: string[]): KeyPair[] {
  const pairs: KeyPair[] = Object.entries(keymap.summary).map(([g, o]) => ({ goldenKey: g, ourKey: o, block: "summary" }));
  // `original` goldens carry summary keys only (D25).
  if (matrix === "generic") {
    for (const [g, o] of Object.entries(keymap.static)) pairs.push({ goldenKey: g, ourKey: o, block: "static" });
  }
  return keys ? pairs.filter((p) => keys.includes(p.ourKey) || keys.includes(p.goldenKey)) : pairs;
}

/** Setup mismatches between our run and the golden; empty means scoreable. */
export function mismatches(ours: OurRun, golden: Golden, caseN: number, matrix: Matrix): string[] {
  const out: string[] = [];
  if (golden.kind !== "golden") out.push(`golden kind ${String(golden.kind)}`);
  if (golden.case !== caseN || golden.matrix !== matrix) out.push(`golden is case ${String(golden.case)} ${String(golden.matrix)}`);
  if (ours.case !== caseN || ours.matrix !== matrix) out.push(`run is case ${String(ours.case)} ${String(ours.matrix)}`);
  const recomputedConditions = conditionsHash(golden.conditions);
  if (recomputedConditions !== golden.conditions_hash) out.push("golden conditions_hash does not match its conditions");
  const recomputedMotors = motorDigest((golden.motors ?? []).map((m) => m.digest));
  if (recomputedMotors !== golden.motor_digest) out.push("golden motor_digest does not match its motors");
  const fields = ["geometry_sha256", "conditions_hash", "config_id", "sim_name", "motor_digest"] as const;
  for (const f of fields) {
    if (ours[f] !== golden[f]) out.push(`${f}: ours ${JSON.stringify(ours[f])} != golden ${JSON.stringify(golden[f])}`);
  }
  return out;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function scoreCase(
  caseN: number,
  matrix: Matrix,
  golden: Golden | undefined,
  ours: OurRun | undefined,
  keymap: KeyMap,
  tols: Tolerances,
  keys?: string[],
): Row[] {
  const pairs = keyPairs(keymap, matrix, keys);
  const base = (p: KeyPair): Row => ({
    matrix,
    case: caseN,
    key: p.ourKey,
    golden_key: p.goldenKey,
    ours: null,
    golden: null,
    delta: null,
    delta_pct: null,
    tol: tolFor(tols, caseN, p.ourKey),
    pass: null,
    status: "not-run",
  });
  if (!golden || !ours) {
    const reason = [!golden && "no golden", !ours && "no run"].filter(Boolean).join(", ");
    return pairs.map((p) => ({ ...base(p), reason }));
  }
  const bad = mismatches(ours, golden, caseN, matrix);
  if (bad.length > 0) {
    return pairs.map((p) => ({ ...base(p), status: "mismatch" as const, reason: bad.join("; ") }));
  }
  return pairs.map((p) => {
    const row = base(p);
    const g = p.block === "summary" ? num(golden.summary?.[p.goldenKey]) : num(golden.static?.[p.goldenKey]);
    const o = p.block === "summary" ? num(ours.summary?.[p.ourKey]) : num(ours.check?.[p.ourKey]);
    row.golden = g === null ? null : sig(g);
    row.ours = o === null ? null : sig(o);
    if (g === null || o === null) {
      return { ...row, status: "missing" as const, reason: [g === null && "golden", o === null && "ours"].filter(Boolean).join(", ") + " absent" };
    }
    const delta = o - g;
    row.delta = sig(delta);
    row.delta_pct = g === 0 ? null : sig((delta / Math.abs(g)) * 100);
    if (row.tol === null) return { ...row, status: "report" as const };
    const t = parseTol(row.tol);
    const pass = t.kind === "rel" ? Math.abs(delta) <= t.frac * Math.abs(g) : Math.abs(delta) <= t.si * (1 + 1e-12);
    return { ...row, pass, status: pass ? ("pass" as const) : ("fail" as const) };
  });
}

// ---- loading --------------------------------------------------------------------

function readJsonFile<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`, { cause: e });
  }
}

function loadOptional<T>(path: string): T | undefined {
  return existsSync(path) ? readJsonFile<T>(path) : undefined;
}

export function loadKeymap(path = KEYMAP_PATH): KeyMap {
  const k = readJsonFile<KeyMap>(path);
  if (!k.summary || !k.static) throw new Error(`${path}: needs "summary" and "static"`);
  return k;
}

export function loadTolerances(path = TOLERANCES_PATH): Tolerances {
  const t = readJsonFile<Tolerances>(path);
  if (!Array.isArray(t.groups)) throw new Error(`${path}: needs "groups"`);
  for (const g of t.groups) for (const s of Object.values(g.tol)) parseTol(s);
  return t;
}

export interface RunOptions {
  oracleDir?: string;
  oursDir?: string;
  cases?: readonly number[];
  keys?: string[];
  keymap?: KeyMap;
  tolerances?: Tolerances;
}

export function buildScoreboard(opts: RunOptions = {}): Scoreboard {
  const oracleDir = opts.oracleDir ?? ORACLE_DIR;
  const oursDir = opts.oursDir ?? DEFAULT_OURS_DIR;
  const keymap = opts.keymap ?? loadKeymap();
  const tols = opts.tolerances ?? loadTolerances();
  const rows: Row[] = [];
  for (const matrix of MATRICES) {
    for (const c of opts.cases ?? ALL_CASES) {
      const name = `case${String(c)}-${matrix}.json`;
      const golden = loadOptional<Golden>(join(oracleDir, name));
      const ours = loadOptional<OurRun>(join(oursDir, name));
      rows.push(...scoreCase(c, matrix, golden, ours, keymap, tols, opts.keys));
    }
  }
  const zero = (): Record<Status, number> => ({ pass: 0, fail: 0, report: 0, missing: 0, mismatch: 0, "not-run": 0 });
  const totals: Record<Matrix, Record<Status, number>> = { generic: zero(), original: zero() };
  for (const r of rows) totals[r.matrix][r.status] += 1;
  return { schema: "rw/1", gate_matrix: tols.gate_matrix ?? "generic", rows, totals };
}

/** Gate: every toleranced row of the gate matrix passes (none not-run/mismatch/missing). */
export function gateFailures(sb: Scoreboard): Row[] {
  return sb.rows.filter((r) => r.matrix === sb.gate_matrix && r.tol !== null && r.pass !== true);
}

/** Assembles `OurRun` from a `RunManifest`, a `RunSummary`, and a `CheckReport`. */
export function oursFromRun(a: {
  case: number;
  matrix: Matrix;
  config_id: string;
  geometry_sha256: string;
  manifest: { sim_name: string; conditions_hash: string; motors: { sha256: string }[] };
  summary: Record<string, unknown>;
  check?: Record<string, unknown>;
  metricPaths: string[];
}): OurRun {
  const get = (o: unknown, path: string): number | null =>
    num(path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o));
  const summary: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(a.summary)) if (k !== "schema") summary[k] = num(v);
  const check: Record<string, number | null> = {};
  for (const p of a.metricPaths) check[p] = a.check ? get(a.check, p) : null;
  return {
    kind: "ours",
    case: a.case,
    matrix: a.matrix,
    sim_name: a.manifest.sim_name,
    config_id: a.config_id,
    geometry_sha256: a.geometry_sha256,
    conditions_hash: a.manifest.conditions_hash,
    motor_digest: motorDigest(a.manifest.motors.map((m) => m.sha256)),
    summary,
    check,
  };
}

// ---- refresh ----------------------------------------------------------------------

/**
 * Cargo invocations that write `<ours>/case<n>-generic.json` (honouring
 * `RW_PARITY_OURS`). Case 1: fixtures/case1 through the `rw` binary
 * (`rw check`, `rw sim`, `rw diff run --golden`; M1.42b), which also writes
 * the run's `case1-generic.series.csv` for triage.
 */
export const PRODUCERS: Readonly<Record<number, readonly string[]>> = {
  1: ["test", "-q", "-p", "rw-cli", "--test", "parity_case1"],
};

/** Runs the producers of `cases`; returns one message per failed producer. */
export function refreshOurs(cases: readonly number[], oursDir: string, cargo = process.env["CARGO"] ?? "cargo"): string[] {
  const errors: string[] = [];
  for (const c of cases) {
    const args = PRODUCERS[c];
    if (!args) continue;
    // Child stdout goes to our stderr so the table stays the only stdout.
    const r = spawnSync(cargo, args, { cwd: REPO_ROOT, stdio: ["ignore", 2, "inherit"], env: { ...process.env, RW_PARITY_OURS: oursDir } });
    if (r.status !== 0) {
      errors.push(`case ${String(c)}: ${cargo} ${args.join(" ")} ${r.error ? r.error.message : `exited ${String(r.status ?? r.signal)}`}`);
    }
  }
  return errors;
}

// ---- report ---------------------------------------------------------------------

export function formatTable(sb: Scoreboard): string {
  const fmt = (v: number | null): string => (v === null ? "-" : String(v));
  const lines = ["matrix   case key                      ours         golden       delta        tol      status"];
  for (const r of sb.rows) {
    lines.push(
      [
        r.matrix.padEnd(8),
        String(r.case).padEnd(4),
        r.key.padEnd(24),
        fmt(r.ours).padEnd(12),
        fmt(r.golden).padEnd(12),
        fmt(r.delta).padEnd(12),
        (r.tol ?? "-").padEnd(8),
        r.status + (r.status === "mismatch" || r.status === "not-run" ? ` (${r.reason ?? ""})` : ""),
      ].join(" "),
    );
  }
  for (const m of MATRICES) {
    const t = sb.totals[m];
    lines.push(`${m}: ${Object.entries(t).map(([k, v]) => `${k} ${String(v)}`).join(", ")}`);
  }
  return lines.join("\n");
}

// ---- self-test ------------------------------------------------------------------

/** Plants a matching pair (must score) and a motor-digest mismatch (must be `mismatch`). */
export function selfTest(): string[] {
  const errors: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "rw-parity-"));
  try {
    const oracleDir = join(dir, "oracle");
    const oursDir = join(dir, "ours");
    mkdirSync(oracleDir);
    mkdirSync(oursDir);
    const conditions = { rail_length_m: 1, time_step_s: 0.05, integrator: "rk4", base_pressure_pa: 101325 };
    const motors = [{ mount: "mmt", designation: "C6", digest: "a".repeat(64), delay_s: 5 }];
    const golden: Golden = {
      kind: "golden",
      case: 1,
      matrix: "generic",
      sim_name: "Planted sim",
      config_id: "cfg-1",
      geometry_sha256: "b".repeat(64),
      conditions,
      conditions_hash: conditionsHash(conditions),
      motor_digest: motorDigest(motors.map((m) => m.digest)),
      motors,
      summary: { max_altitude_m: 300, max_velocity_ms: 90, time_to_apogee_s: 8 },
      static: { cg_m: 0.26, cp_m: 0.33, cna: 10, stability_cal: 2.8 },
    };
    const ours: OurRun = {
      kind: "ours",
      case: 1,
      matrix: "generic",
      sim_name: golden.sim_name,
      config_id: golden.config_id,
      geometry_sha256: golden.geometry_sha256,
      conditions_hash: golden.conditions_hash,
      motor_digest: golden.motor_digest,
      summary: { apogee_m: 305, max_velocity_ms: 99, time_to_apogee_s: 8.1 },
      check: { "mass.cg": 0.2605, "aero.cp": 0.33, "aero.cna": 10.2, "stability.liftoff": 2.85 },
    };
    writeFileSync(join(oracleDir, "case1-generic.json"), JSON.stringify(golden));
    writeFileSync(join(oursDir, "case1-generic.json"), JSON.stringify(ours));
    const run = (): Row[] => buildScoreboard({ oracleDir, oursDir, cases: [1] }).rows.filter((r) => r.matrix === "generic");
    const status = (rows: Row[], key: string): Status | undefined => rows.find((r) => r.key === key)?.status;

    const ok = run();
    if (status(ok, "apogee_m") !== "pass") errors.push(`matching pair: apogee_m ${String(status(ok, "apogee_m"))}, want pass`);
    if (status(ok, "max_velocity_ms") !== "fail") errors.push("matching pair: max_velocity_ms 10% off should fail");
    if (status(ok, "aero.cna") !== "report") errors.push("matching pair: aero.cna (no tolerance) should be report");

    writeFileSync(join(oursDir, "case1-generic.json"), JSON.stringify({ ...ours, motor_digest: "c".repeat(64) }));
    const bad = run();
    if (!bad.every((r) => r.status === "mismatch" && r.pass === null && r.delta === null)) {
      errors.push("planted motor-digest mismatch: every row must be `mismatch` and unscored");
    }
    const notRun = buildScoreboard({ oracleDir, oursDir: join(dir, "none"), cases: [1] }).rows;
    if (!notRun.every((r) => r.status === "not-run")) errors.push("missing run: every row must be `not-run`");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return errors;
}

// ---- CLI ------------------------------------------------------------------------

/** `1`, `2..7`, `1,3,5` → case numbers. Empty → all. */
export function parseCases(s: string | undefined): number[] {
  if (!s) return [...ALL_CASES];
  const out = new Set<number>();
  for (const part of s.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\.\.(\d+))?$/.exec(part);
    if (!m) throw new Error(`bad CASE ${JSON.stringify(part)}`);
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (hi < lo) throw new Error(`bad CASE range ${part}`);
    for (let c = lo; c <= hi; c++) out.add(c);
  }
  return [...out].sort((a, b) => a - b);
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
}

export function defaultOut(): string {
  const reviews = reviewsDir();
  return reviews ? join(reviews, "parity/scoreboard.json") : join(REPO_ROOT, "target/parity/scoreboard.json");
}

function main(argv: string[]): number {
  try {
    if (argv.includes("--self-test")) {
      const errors = selfTest();
      for (const e of errors) console.error(`  - ${e}`);
      console.log(errors.length === 0 ? "bar-parity self-test ok (planted digest mismatch -> mismatch)" : "bar-parity self-test FAILED");
      return errors.length === 0 ? 0 : 1;
    }
    const keysArg = flag(argv, "--keys") ?? process.env["KEYS"];
    const keys = keysArg ? keysArg.split(",").map((k) => k.trim()).filter(Boolean) : undefined;
    const cases = parseCases(flag(argv, "--case") ?? process.env["CASE"]);
    const oursDir = resolve(flag(argv, "--ours") ?? process.env["RW_PARITY_OURS"] ?? DEFAULT_OURS_DIR);
    const refreshErrors = argv.includes("--refresh") ? refreshOurs(cases, oursDir) : [];
    for (const e of refreshErrors) console.error(`bar-parity: refresh failed: ${e}`);
    const sb = buildScoreboard({
      cases,
      oursDir,
      oracleDir: resolve(flag(argv, "--oracle") ?? ORACLE_DIR),
      ...(keys ? { keys } : {}),
    });
    const out = resolve(flag(argv, "--out") ?? defaultOut());
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, stableStringify(sb));
    console.log(formatTable(sb));
    console.log(`\nwrote ${out}`);
    if (argv.includes("--gate")) {
      const failing = gateFailures(sb);
      if (refreshErrors.length > 0) {
        console.error(`bar-parity gate FAILED: ${String(refreshErrors.length)} run record(s) not refreshed`);
        return 1;
      }
      if (failing.length > 0) {
        console.error(`bar-parity gate FAILED: ${String(failing.length)} ${sb.gate_matrix} row(s) not passing`);
        return 1;
      }
      console.log("bar-parity gate ok");
    }
    return 0;
  } catch (e) {
    console.error(`bar-parity: ${(e as Error).message}`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
