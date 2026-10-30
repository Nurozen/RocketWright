import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, readJson } from "../bar/paths.ts";
import {
  buildTriage,
  column,
  embedInScoreboard,
  formatTriage,
  interp,
  parseCsv,
  physRows,
  selfTest,
  TERMS,
  trapz,
  triageCase,
  type AeroSweep,
  type Table,
  type TriageGolden,
  type TriageOurs,
} from "../../../scripts/bar/triage.ts";

const oracle = (name: string): unknown => readJson(join(REPO_ROOT, "tests/oracle", name));
const golden = oracle("case1-generic.json") as TriageGolden;
const goldenSeries = oracle("case1-generic.series.json") as Table;
const sweep = oracle("case1.aero_sweep.json") as AeroSweep;

/** Our series rebuilt from the golden's own columns: every series term must be 0. */
function mirrorSeries(): Table {
  const map: [string, string][] = [
    ["t", "time_s"],
    ["mass", "mass_kg"],
    ["cg", "cg_m"],
    ["thrust", "thrust_n"],
    ["cd", "cd"],
    ["mach", "mach"],
  ];
  const cols = map.map(([, g]) => column(goldenSeries, g) ?? []);
  const n = cols[0]?.length ?? 0;
  return { columns: map.map(([o]) => o), rows: Array.from({ length: n }, (_, i) => cols.map((c) => c[i] ?? Number.NaN)) };
}

const s = golden.static ?? {};
const ours: TriageOurs = {
  case: 1,
  summary: { burnout_time_s: 1.6, time_to_apogee_s: golden.summary["time_to_apogee_s"] ?? null },
  check: {
    "mass.liftoff": s["mass_kg"] ?? null,
    "mass.cg": (s["cg_m"] ?? 0) + 0.001,
    "aero.cp": s["cp_m"] ?? null,
    "aero.cna": s["cna"] ?? null,
    "stability.liftoff": s["stability_cal"] ?? null,
    "aero.cd": sweep.points.find((p) => p.mach === 0.3)?.cd_total ?? null,
    "aero.mach": 0.3,
  },
  integrator: { gate: { method: "rk4", dt_s: 0.05, apogee_m: 344.4 }, alt: { method: "dp54", apogee_m: 344.6 } },
};

describe("bar triage (M1.42b)", () => {
  it("passes its self-test", () => {
    expect(selfTest()).toEqual([]);
  });

  it("parses series CSV and interpolates", () => {
    const t = parseCsv("t,a\n0,1\n1,3\n");
    expect(t.columns).toEqual(["t", "a"]);
    expect(column(t, "a")).toEqual([1, 3]);
    expect(column(t, "b")).toBeUndefined();
    expect(interp([0, 1], [1, 3], 0.25)).toBe(1.5);
    expect(interp([0, 1], [1, 3], 2)).toBeNaN();
    expect(trapz([0, 1, 2], [0, 2, 2])).toBe(3);
  });

  it("gives zero series terms when our series mirrors the golden's", () => {
    const { rows, flags } = triageCase({ case: 1, golden, goldenSeries, sweep, ours, oursSeries: mirrorSeries() });
    for (const term of TERMS) expect(rows.some((r) => r.term === term)).toBe(true);
    const row = (key: string) => rows.find((r) => r.key === key);
    expect(row("total impulse")?.delta).toBe(0);
    expect(row("mass(t) worst")?.delta).toBe(0);
    expect(row("cg(t) worst")?.delta).toBe(0);
    expect(row("thrust(t) worst")?.delta).toBe(0);
    expect(Math.abs(row("CD mean")?.delta ?? 1)).toBeLessThan(1e-12);
    expect(row("mass.cg")?.delta).toBeCloseTo(0.001, 9);
    expect(row("aero.cd")?.delta).toBe(0);
    expect(row("burnout_time_s")?.delta).toBe(0);
    const integ = row("apogee_m");
    expect(integ?.ref_label).toBe("dp54");
    expect(integ?.flag).toBe(false);
    expect(flags).toEqual([]);
  });

  it("flags the integrator above 0.5 % and reports missing inputs", () => {
    const split = { ...ours, integrator: { gate: { method: "rk4", apogee_m: 100 }, alt: { method: "dp54", apogee_m: 99 } } };
    const { rows, flags } = triageCase({ case: 1, golden, sweep, ours: split });
    expect(rows.find((r) => r.term === "integrator")?.flag).toBe(true);
    expect(flags.some((f) => f.includes("integrator flagged"))).toBe(true);
    expect(flags.some((f) => f.includes("no series_csv"))).toBe(true);
    expect(triageCase({ case: 2 }).flags[0]).toContain("no golden, no run record");
  });

  it("appends rw-sim triage rows with their source and drops malformed ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-triage-test-"));
    const path = join(dir, "triage.json");
    writeFileSync(
      path,
      JSON.stringify({
        rows: [
          { case: 1, term: "CD(M)", key: "lug", phase: "M 0.3", ours: 0.068, ref: 0.039, flag: true },
          { case: 1, term: "bogus", key: "x" },
          { case: 3, term: "thrust", key: "other case" },
        ],
      }),
    );
    const rows = physRows(path, [1]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("rw-sim triage");
    expect(rows[0]?.delta).toBeCloseTo(0.029, 9);
    const t = buildTriage({ cases: [1], oursDir: join(dir, "none"), physPath: path });
    expect(t.rows).toHaveLength(1);
    expect(t.flags.some((f) => f.includes("rw-sim triage flags CD(M) lug"))).toBe(true);
  });

  it("renders a markdown table and embeds the report in the scoreboard", () => {
    const t = { schema: "rw/1" as const, cases: [1], flags: [], largest: [], rows: triageCase({ case: 1, golden, goldenSeries, sweep, ours, oursSeries: mirrorSeries() }).rows };
    const md = formatTriage(t);
    expect(md).toContain("| case | term | key |");
    expect(md).toContain("344.6 (dp54)");
    const dir = mkdtempSync(join(tmpdir(), "rw-triage-sb-"));
    const sb = join(dir, "scoreboard.json");
    expect(embedInScoreboard(sb, t)).toBe(false);
    writeFileSync(sb, JSON.stringify({ schema: "rw/1", rows: [] }));
    expect(embedInScoreboard(sb, t)).toBe(true);
    const back = JSON.parse(readFileSync(sb, "utf8")) as { rows: unknown[]; triage: { rows: unknown[] } };
    expect(back.rows).toEqual([]);
    expect(back.triage.rows.length).toBe(t.rows.length);
  });
});
