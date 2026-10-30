/**
 * B2 parity triage (M1.42b): `node scripts/bar/triage.ts [--case 1] [--ours <dir>]
 * [--oracle <dir>] [--phys <triage.json>] [--scoreboard <scoreboard.json>] [--out <file>]`.
 * `make bar-parity` runs it after the scoreboard.
 *
 * Splits each case's flight delta into per-term rows, so a parity miss points at
 * a model term rather than at the apogee:
 *
 * | term | rows | ours | oracle |
 * |---|---|---|---|
 * | `mass/CG` | liftoff mass and CG; mass(t) and CG(t) worst over the burn | record `check`, series `mass`, `cg` | golden `static`, series `mass_kg`, `cg_m` |
 * | `CP/CNa` | CP, CNα, liftoff stability | record `check` | golden `static` |
 * | `CD(M)` | CD at the check Mach; coast CD at each sweep Mach; mean burn CD | record `aero.cd`, series `cd` vs `mach` | `case<n>.aero_sweep.json`, series `cd` |
 * | `thrust` | total impulse, burnout time, worst thrust(t) | series `thrust`, summary | series `thrust_n`, golden `events` |
 * | `integrator` | apogee, the golden's RK4 at 0.05 s vs the shipped DP5(4) | record `integrator` | (reference column: dp54) |
 *
 * Inputs: the golden `tests/oracle/case<n>-generic{,.series}.json` and
 * `case<n>.aero_sweep.json`; our run record `<ours>/case<n>-generic.json` with
 * its `series_csv` (both written by `cargo test -p rw-cli --test parity_case1`;
 * format in `tests/oracle/README.md`). When the rw-sim triage test has written
 * `target/parity/triage.json` (`{rows: TriageRow[]}`), its rows are appended
 * with their own `source`. A missing input yields no rows for that term, never
 * an error. The integrator is flagged when RK4 and DP5(4) apogees differ by
 * more than 0.5 % (plan M1.42b).
 *
 * Output: `triage-table.json` and `triage-table.md` beside the scoreboard (`--out` sets the
 * JSON path), and the report is embedded in the parity scoreboard as `triage`.
 * Report mode only: exits 0, or 2 on bad arguments or unreadable data.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { REPO_ROOT, stableStringify } from "../../app/e2e/bar/paths.ts";
import { DEFAULT_OURS_DIR, defaultOut, ORACLE_DIR, parseCases } from "./parity.ts";

export const TERMS = ["mass/CG", "CP/CNa", "CD(M)", "thrust", "integrator"] as const;
export type Term = (typeof TERMS)[number];
/** Plan M1.42b: RK4 vs DP5(4) apogee difference that flags the integrator. */
export const INTEGRATOR_FLAG_PCT = 0.5;
/** The rw-sim triage test's output (PHYS, `crates/rw-sim/tests/triage.rs`). */
export const PHYS_TRIAGE_PATH = join(REPO_ROOT, "target/parity/triage.json");

export interface TriageRow {
  case: number;
  term: Term;
  /** What is compared (`mass.liftoff`, `CD M=0.20 coast`). */
  key: string;
  /** Flight phase or condition (`static`, `burn`, `coast`, `M 0.3`). */
  phase: string;
  /** SI unit of `ours`, `ref`, and `delta` (`kg`, `m`, `N`, `N s`, `s`, `cal`, `""`). */
  unit: string;
  ours: number | null;
  /** The reference value: the oracle's, unless `ref_label` says otherwise. */
  ref: number | null;
  ref_label: string;
  delta: number | null;
  delta_pct: number | null;
  flag: boolean;
  note?: string;
  source: string;
}

export interface TriageReport {
  schema: "rw/1";
  cases: number[];
  rows: TriageRow[];
  /** Human-readable flags (the integrator term, missing inputs). */
  flags: string[];
  /** Per case and term, the row with the largest |delta %|. */
  largest: { case: number; term: Term; key: string; delta_pct: number }[];
}

/** A numeric table: column names and row-major values. */
export interface Table {
  columns: string[];
  rows: number[][];
}

/** The subset of our run record (`OurRun` plus the M1.42b fields) triage reads. */
export interface TriageOurs {
  case: number;
  summary: Record<string, number | null>;
  check: Record<string, number | null>;
  series_csv?: string;
  integrator?: {
    gate: { method: string; dt_s?: number | null; apogee_m: number };
    alt: { method: string; apogee_m: number };
    apogee_delta_pct?: number;
  };
}

export interface TriageGolden {
  summary: Record<string, number | null>;
  static?: Record<string, number> | null;
  conditions?: Record<string, unknown>;
  events?: { kind: string; t_s: number }[];
}

export interface AeroSweep {
  points: { mach: number; cd_total: number; cna?: number; cp_m?: number }[];
}

export interface CaseInputs {
  case: number;
  golden?: TriageGolden;
  goldenSeries?: Table;
  sweep?: AeroSweep;
  ours?: TriageOurs;
  oursSeries?: Table;
}

// ---- numerics ---------------------------------------------------------------------

/** Six significant figures, so the report is byte-stable (I8). */
function sig(x: number): number {
  return Number(x.toPrecision(6));
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Parses `series.csv` (header row, then numbers). */
export function parseCsv(text: string): Table {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const columns = (lines[0] ?? "").split(",").map((c) => c.trim());
  const rows = lines.slice(1).map((l) => l.split(",").map(Number));
  return { columns, rows };
}

export function column(t: Table, name: string): number[] | undefined {
  const i = t.columns.indexOf(name);
  return i < 0 ? undefined : t.rows.map((r) => r[i] ?? Number.NaN);
}

/** Linear interpolation of `ys(xs)` at `x`; `xs` ascending. NaN outside the range. */
export function interp(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = xs.length;
  if (n === 0 || x < (xs[0] ?? Infinity) || x > (xs[n - 1] ?? -Infinity)) return Number.NaN;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] ?? 0) <= x) lo = mid;
    else hi = mid;
  }
  const x0 = xs[lo] ?? 0;
  const x1 = xs[hi] ?? 0;
  const y0 = ys[lo] ?? Number.NaN;
  const y1 = ys[hi] ?? Number.NaN;
  return x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

/** Trapezoidal ∫ y dt. */
export function trapz(ts: readonly number[], ys: readonly number[]): number {
  let s = 0;
  for (let i = 1; i < ts.length; i++) s += 0.5 * ((ys[i] ?? 0) + (ys[i - 1] ?? 0)) * ((ts[i] ?? 0) - (ts[i - 1] ?? 0));
  return s;
}

// ---- rows -----------------------------------------------------------------------

function mkRow(
  c: number,
  term: Term,
  key: string,
  phase: string,
  unit: string,
  ours: number | null,
  ref: number | null,
  extra: { ref_label?: string; note?: string; flag?: boolean; source?: string } = {},
): TriageRow {
  const ok = ours !== null && ref !== null && Number.isFinite(ours) && Number.isFinite(ref);
  const delta = ok ? ours - ref : null;
  const row: TriageRow = {
    case: c,
    term,
    key,
    phase,
    unit,
    ours: ours === null || !Number.isFinite(ours) ? null : sig(ours),
    ref: ref === null || !Number.isFinite(ref) ? null : sig(ref),
    ref_label: extra.ref_label ?? "oracle",
    delta: delta === null ? null : sig(delta),
    delta_pct: delta === null || ref === 0 || ref === null ? null : sig((delta / Math.abs(ref)) * 100),
    flag: extra.flag ?? false,
    source: extra.source ?? "triage.ts",
  };
  if (extra.note) row.note = extra.note;
  return row;
}

/**
 * Worst |ours − ref| over `ts` (ref sampled there, ours interpolated): the row
 * reports both values at that instant.
 */
function worstOver(
  ts: readonly number[],
  ref: readonly number[],
  oursT: readonly number[],
  ours: readonly number[],
): { t: number; ours: number; ref: number } | undefined {
  let best: { t: number; ours: number; ref: number } | undefined;
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i] ?? Number.NaN;
    const r = ref[i] ?? Number.NaN;
    const o = interp(oursT, ours, t);
    if (!Number.isFinite(o) || !Number.isFinite(r)) continue;
    if (!best || Math.abs(o - r) > Math.abs(best.ours - best.ref)) best = { t, ours: o, ref: r };
  }
  return best;
}

function eventT(g: TriageGolden | undefined, kind: string): number | null {
  return num(g?.events?.find((e) => e.kind === kind)?.t_s);
}

/** Per-term rows of one case. */
export function triageCase(inp: CaseInputs): { rows: TriageRow[]; flags: string[] } {
  const c = inp.case;
  const rows: TriageRow[] = [];
  const flags: string[] = [];
  const { golden: g, ours: o, goldenSeries: gs, oursSeries: os, sweep } = inp;
  if (!g || !o) {
    flags.push(`case ${String(c)}: ${[!g && "no golden", !o && "no run record"].filter(Boolean).join(", ")}; no triage`);
    return { rows, flags };
  }
  const st = g.static ?? {};
  const chk = o.check ?? {};
  const v = (rec: Record<string, number | null | undefined>, k: string): number | null => num(rec[k]);

  // mass/CG (static, then along the burn)
  rows.push(mkRow(c, "mass/CG", "mass.liftoff", "static", "kg", v(chk, "mass.liftoff"), v(st, "mass_kg")));
  rows.push(mkRow(c, "mass/CG", "mass.cg", "static", "m", v(chk, "mass.cg"), v(st, "cg_m")));
  const tBurn = num(o.summary["burnout_time_s"]) ?? eventT(g, "burnout");
  const gT = gs && column(gs, "time_s");
  const oT = os && column(os, "t");
  if (gs && os && gT && oT && tBurn !== null) {
    const burnIdx = gT.map((t, i) => [t, i] as const).filter(([t]) => t > 0 && t <= tBurn).map(([, i]) => i);
    const pick = (col: number[] | undefined): number[] => burnIdx.map((i) => col?.[i] ?? Number.NaN);
    const ts = pick(gT);
    for (const [ours, ref, key, unit] of [
      ["mass", "mass_kg", "mass(t)", "kg"],
      ["cg", "cg_m", "cg(t)", "m"],
    ] as const) {
      const oc = column(os, ours);
      const gc = column(gs, ref);
      const w = oc && gc ? worstOver(ts, pick(gc), oT, oc) : undefined;
      if (w) rows.push(mkRow(c, "mass/CG", `${key} worst`, `burn t=${w.t.toFixed(2)} s`, unit, w.ours, w.ref));
    }
  }

  // CP/CNa
  rows.push(mkRow(c, "CP/CNa", "aero.cp", "static", "m", v(chk, "aero.cp"), v(st, "cp_m")));
  rows.push(mkRow(c, "CP/CNa", "aero.cna", "static", "", v(chk, "aero.cna"), v(st, "cna")));
  rows.push(mkRow(c, "CP/CNa", "stability.liftoff", "static", "cal", v(chk, "stability.liftoff"), v(st, "stability_cal")));

  // CD(M)
  const pts = [...(sweep?.points ?? [])].sort((a, b) => a.mach - b.mach);
  const sweepM = pts.map((p) => p.mach);
  const sweepCd = pts.map((p) => p.cd_total);
  const mCheck = v(chk, "aero.mach");
  if (pts.length > 0 && mCheck !== null) {
    rows.push(
      mkRow(c, "CD(M)", "aero.cd", `M ${String(sig(mCheck))} static`, "", v(chk, "aero.cd"), interp(sweepM, sweepCd, mCheck), {
        note: "power-off, α 0",
      }),
    );
  }
  const tApo = num(o.summary["time_to_apogee_s"]);
  if (os && oT && tBurn !== null && tApo !== null && pts.length > 0) {
    const oM = column(os, "mach");
    const oCd = column(os, "cd");
    const oThr = column(os, "thrust");
    if (oM && oCd) {
      // Coast (burnout → apogee, no thrust): Mach falls monotonically, so CD(M)
      // is read off our series at each sweep Mach.
      const coast = oT
        .map((t, i) => ({ t, m: oM[i] ?? Number.NaN, cd: oCd[i] ?? Number.NaN, thr: oThr?.[i] ?? 0 }))
        .filter((r) => r.t > tBurn && r.t < tApo && r.thr === 0 && Number.isFinite(r.m) && Number.isFinite(r.cd))
        .sort((a, b) => a.m - b.m);
      const cm = coast.map((r) => r.m);
      const ccd = coast.map((r) => r.cd);
      for (const p of pts) {
        const ours = interp(cm, ccd, p.mach);
        if (Number.isFinite(ours)) {
          rows.push(mkRow(c, "CD(M)", `CD M=${p.mach.toFixed(2)}`, "coast", "", ours, p.cd_total, { note: "oracle: aero_sweep" }));
        }
      }
    }
    // Burn: mean of our CD at the golden's samples after rail exit.
    const gCd = gs && column(gs, "cd");
    const tRail = eventT(g, "launch_rod_clearance") ?? 0;
    if (gT && gCd && oCd) {
      let so = 0;
      let sg = 0;
      let n = 0;
      gT.forEach((t, i) => {
        const oc = interp(oT, oCd, t);
        const gc = gCd[i] ?? Number.NaN;
        if (t > tRail && t <= tBurn && Number.isFinite(oc) && Number.isFinite(gc)) {
          so += oc;
          sg += gc;
          n += 1;
        }
      });
      if (n > 0) rows.push(mkRow(c, "CD(M)", "CD mean", "burn", "", so / n, sg / n, { note: `${String(n)} oracle samples` }));
    }
  }

  // thrust
  const gThr = gs && column(gs, "thrust_n");
  const oThr = os && column(os, "thrust");
  if (gT && gThr && oT && oThr) {
    rows.push(mkRow(c, "thrust", "total impulse", "burn", "N s", trapz(oT, oThr), trapz(gT, gThr), { note: "trapezoid on each series grid" }));
    const w = worstOver(gT, gThr, oT, oThr);
    if (w) rows.push(mkRow(c, "thrust", "thrust(t) worst", `t=${w.t.toFixed(2)} s`, "N", w.ours, w.ref));
  }
  rows.push(mkRow(c, "thrust", "burnout_time_s", "event", "s", num(o.summary["burnout_time_s"]), eventT(g, "burnout")));

  // integrator
  const integ = o.integrator;
  if (integ) {
    const d = 100 * (integ.gate.apogee_m / integ.alt.apogee_m - 1);
    const flag = Math.abs(d) > INTEGRATOR_FLAG_PCT;
    const gateLabel = `${integ.gate.method}${integ.gate.dt_s ? ` ${String(integ.gate.dt_s)} s` : ""}`;
    rows.push(
      mkRow(c, "integrator", "apogee_m", `${gateLabel} vs ${integ.alt.method}`, "m", integ.gate.apogee_m, integ.alt.apogee_m, {
        ref_label: integ.alt.method,
        flag,
        note: `golden integrator ${String(g.conditions?.["integrator"] ?? "?")}`,
      }),
    );
    if (flag) flags.push(`case ${String(c)}: integrator flagged (${gateLabel} vs ${integ.alt.method} apogee ${d.toFixed(3)}% > ${String(INTEGRATOR_FLAG_PCT)}%)`);
  } else {
    flags.push(`case ${String(c)}: run record has no integrator block`);
  }
  if (!os) flags.push(`case ${String(c)}: no series_csv; burn/coast rows skipped`);
  return { rows, flags };
}

function largestPerTerm(rows: TriageRow[]): TriageReport["largest"] {
  const best = new Map<string, TriageRow>();
  for (const r of rows) {
    if (r.delta_pct === null) continue;
    const k = `${String(r.case)}|${r.term}`;
    const cur = best.get(k);
    if (!cur || Math.abs(r.delta_pct) > Math.abs(cur.delta_pct ?? 0)) best.set(k, r);
  }
  return [...best.values()]
    .map((r) => ({ case: r.case, term: r.term, key: r.key, delta_pct: r.delta_pct ?? 0 }))
    .sort((a, b) => a.case - b.case || TERMS.indexOf(a.term) - TERMS.indexOf(b.term));
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

/** The oracle series JSON (`columns` + `rows`). */
function loadSeries(path: string): Table | undefined {
  const s = loadOptional<Table>(path);
  return s && Array.isArray(s.columns) && Array.isArray(s.rows) ? s : undefined;
}

export function loadCase(c: number, oracleDir: string, oursDir: string): CaseInputs {
  const n = String(c);
  const ours = loadOptional<TriageOurs>(join(oursDir, `case${n}-generic.json`));
  const csv = ours?.series_csv ? join(oursDir, ours.series_csv) : undefined;
  const inp: CaseInputs = { case: c };
  const golden = loadOptional<TriageGolden>(join(oracleDir, `case${n}-generic.json`));
  const goldenSeries = loadSeries(join(oracleDir, `case${n}-generic.series.json`));
  const sweep = loadOptional<AeroSweep>(join(oracleDir, `case${n}.aero_sweep.json`));
  if (golden) inp.golden = golden;
  if (goldenSeries) inp.goldenSeries = goldenSeries;
  if (sweep) inp.sweep = sweep;
  if (ours) inp.ours = ours;
  if (csv && existsSync(csv)) inp.oursSeries = parseCsv(readFileSync(csv, "utf8"));
  return inp;
}

/** Rows from the rw-sim triage test (`{rows: [...]}`), tagged with their source. */
export function physRows(path: string, cases: readonly number[]): TriageRow[] {
  const doc = loadOptional<{ rows?: Partial<TriageRow>[] }>(path);
  const out: TriageRow[] = [];
  for (const r of doc?.rows ?? []) {
    if (typeof r.case !== "number" || !cases.includes(r.case)) continue;
    if (!r.term || !(TERMS as readonly string[]).includes(r.term) || typeof r.key !== "string") continue;
    const row = mkRow(r.case, r.term, r.key, r.phase ?? "", r.unit ?? "", num(r.ours), num(r.ref), {
      ref_label: r.ref_label ?? "oracle",
      flag: r.flag === true,
      source: r.source ?? "rw-sim triage",
      ...(r.note ? { note: r.note } : {}),
    });
    out.push(row);
  }
  return out;
}

export interface TriageOptions {
  cases?: readonly number[];
  oracleDir?: string;
  oursDir?: string;
  physPath?: string;
}

export function buildTriage(opts: TriageOptions = {}): TriageReport {
  const cases = [...(opts.cases ?? [1])];
  const rows: TriageRow[] = [];
  const flags: string[] = [];
  for (const c of cases) {
    const r = triageCase(loadCase(c, opts.oracleDir ?? ORACLE_DIR, opts.oursDir ?? DEFAULT_OURS_DIR));
    rows.push(...r.rows);
    flags.push(...r.flags);
  }
  const phys = physRows(opts.physPath ?? PHYS_TRIAGE_PATH, cases);
  rows.push(...phys);
  for (const r of phys) if (r.flag) flags.push(`case ${String(r.case)}: ${r.source} flags ${r.term} ${r.key}`);
  return { schema: "rw/1", cases, rows, flags, largest: largestPerTerm(rows) };
}

// ---- report ---------------------------------------------------------------------

export function formatTriage(t: TriageReport): string {
  const f = (x: number | null): string => (x === null ? "-" : String(x));
  const lines = [
    "| case | term | key | phase | ours | ref | Δ | Δ % | unit | flag |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of t.rows) {
    const ref = r.ref_label === "oracle" ? f(r.ref) : `${f(r.ref)} (${r.ref_label})`;
    lines.push(
      `| ${String(r.case)} | ${r.term} | ${r.key} | ${r.phase} | ${f(r.ours)} | ${ref} | ${f(r.delta)} | ${f(r.delta_pct)} | ${r.unit} | ${r.flag ? "FLAG" : ""} |`,
    );
  }
  lines.push("", "Largest |Δ %| per term:");
  for (const l of t.largest) lines.push(`- case ${String(l.case)} ${l.term}: ${l.key} ${String(l.delta_pct)}%`);
  if (t.flags.length > 0) {
    lines.push("", "Flags:");
    for (const fl of t.flags) lines.push(`- ${fl}`);
  }
  return lines.join("\n");
}

/** Adds `triage` to an existing parity scoreboard JSON (no-op when it is absent). */
export function embedInScoreboard(path: string, t: TriageReport): boolean {
  if (!existsSync(path)) return false;
  const sb = readJsonFile<Record<string, unknown>>(path);
  writeFileSync(path, stableStringify({ ...sb, triage: t }));
  return true;
}

// ---- self-test --------------------------------------------------------------------

/**
 * Plants a golden whose series equals ours (every series term 0) and an
 * integrator split of 1 %, and checks the rows and the flag.
 */
export function selfTest(): string[] {
  const errors: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "rw-triage-"));
  try {
    const oracleDir = join(dir, "oracle");
    const oursDir = join(dir, "ours");
    mkdirSync(oracleDir);
    mkdirSync(oursDir);
    const ts = [0, 0.5, 1, 1.5, 2, 2.5, 3];
    const thrust = [0, 10, 10, 0, 0, 0, 0];
    const mass = [0.1, 0.095, 0.09, 0.09, 0.09, 0.09, 0.09];
    const mach = [0, 0.2, 0.3, 0.25, 0.2, 0.15, 0.1];
    const cd = mach.map((m) => 0.74 - 0.4 * m);
    writeFileSync(
      join(oracleDir, "case1-generic.json"),
      JSON.stringify({
        summary: {},
        static: { mass_kg: 0.1, cg_m: 0.26, cp_m: 0.33, cna: 15, stability_cal: 2.8 },
        conditions: { integrator: "rk4" },
        events: [{ kind: "burnout", t_s: 1.5 }],
      }),
    );
    writeFileSync(
      join(oracleDir, "case1-generic.series.json"),
      JSON.stringify({
        columns: ["time_s", "mass_kg", "cg_m", "thrust_n", "cd", "mach"],
        rows: ts.map((t, i) => [t, mass[i], 0.26, thrust[i], cd[i], mach[i]]),
      }),
    );
    writeFileSync(
      join(oracleDir, "case1.aero_sweep.json"),
      JSON.stringify({ points: [0.1, 0.2, 0.3].map((m) => ({ mach: m, cd_total: 0.74 - 0.4 * m })) }),
    );
    writeFileSync(
      join(oursDir, "case1-generic.json"),
      JSON.stringify({
        case: 1,
        summary: { burnout_time_s: 1.5, time_to_apogee_s: 3.5 },
        check: { "mass.liftoff": 0.1, "mass.cg": 0.261, "aero.cp": 0.33, "aero.cna": 15, "stability.liftoff": 2.76, "aero.cd": 0.62, "aero.mach": 0.3 },
        series_csv: "s.csv",
        integrator: { gate: { method: "rk4", dt_s: 0.05, apogee_m: 101 }, alt: { method: "dp54", apogee_m: 100 } },
      }),
    );
    writeFileSync(
      join(oursDir, "s.csv"),
      ["t,mass,cg,thrust,cd,mach", ...ts.map((t, i) => [t, mass[i], 0.26, thrust[i], cd[i], mach[i]].join(","))].join("\n"),
    );
    const t = buildTriage({ cases: [1], oracleDir, oursDir, physPath: join(dir, "none.json") });
    const row = (term: Term, key: string): TriageRow | undefined => t.rows.find((r) => r.term === term && r.key === key);
    for (const term of TERMS) if (!t.rows.some((r) => r.term === term)) errors.push(`no ${term} row`);
    if (row("thrust", "total impulse")?.delta !== 0) errors.push("identical thrust series: impulse delta must be 0");
    if (row("mass/CG", "mass(t) worst")?.delta !== 0) errors.push("identical mass series: delta must be 0");
    if (Math.abs((row("mass/CG", "mass.cg")?.delta ?? 0) - 0.001) > 1e-9) errors.push("mass.cg delta must be 1 mm");
    if (Math.abs(row("CD(M)", "CD M=0.20")?.delta ?? 1) > 1e-12) errors.push("coast CD at M 0.2 must equal the sweep");
    if (row("integrator", "apogee_m")?.flag !== true) errors.push("1% integrator split must flag");
    if (!t.flags.some((f) => f.includes("integrator flagged"))) errors.push("integrator flag missing from flags");
    const empty = buildTriage({ cases: [1], oracleDir, oursDir: join(dir, "none"), physPath: join(dir, "none.json") });
    if (empty.rows.length !== 0 || !empty.flags.some((f) => f.includes("no run record"))) errors.push("missing record: no rows plus a flag");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return errors;
}

// ---- CLI ------------------------------------------------------------------------

function flagArg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
}

function main(argv: string[]): number {
  try {
    if (argv.includes("--self-test")) {
      const errors = selfTest();
      for (const e of errors) console.error(`  - ${e}`);
      console.log(errors.length === 0 ? "bar-triage self-test ok" : "bar-triage self-test FAILED");
      return errors.length === 0 ? 0 : 1;
    }
    const caseArg = flagArg(argv, "--case") ?? process.env["CASE"];
    const cases = parseCases(caseArg || "1");
    const scoreboard = resolve(flagArg(argv, "--scoreboard") ?? defaultOut());
    const t = buildTriage({
      cases,
      oracleDir: resolve(flagArg(argv, "--oracle") ?? ORACLE_DIR),
      oursDir: resolve(flagArg(argv, "--ours") ?? process.env["RW_PARITY_OURS"] ?? DEFAULT_OURS_DIR),
      physPath: resolve(flagArg(argv, "--phys") ?? PHYS_TRIAGE_PATH),
    });
    const out = resolve(flagArg(argv, "--out") ?? join(dirname(scoreboard), "triage-table.json"));
    mkdirSync(dirname(out), { recursive: true });
    if (out === PHYS_TRIAGE_PATH) throw new Error(`--out would overwrite the rw-sim triage input ${out}`);
    writeFileSync(out, stableStringify(t));
    const md = formatTriage(t);
    writeFileSync(out.replace(/\.json$/, "") + ".md", md + "\n");
    const embedded = embedInScoreboard(scoreboard, t);
    console.log(md);
    console.log(`\nwrote ${out}${embedded ? ` (and triage in ${scoreboard})` : ""}`);
    return 0;
  } catch (e) {
    console.error(`bar-triage: ${(e as Error).message}`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
