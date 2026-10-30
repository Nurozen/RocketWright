/**
 * Page 04 Results e2e (M1.51; live since M1.53b): the built web UI in the
 * desktop hidden window (1536x1024, DPR 1) on the live app server and sidecar
 * (`--project`) over a copy of the seeded research vehicle
 * (`fixtures/research-vehicle/seed.sh`, M1.55): Baseline and Higher altitude
 * Complete, Fin revision Outdated by the step-03 fin revision, Recovery test
 * Not run, and Rev 07 at step 04. No contract JSON: every number is the
 * seeded run's own `summary.json` / `series.csv`.
 * `page04.drive.ts` drives the page and reports; this file asserts.
 *
 * `pnpm --dir app e2e:desktop page04` (`make e2e`; builds @rw/web first,
 * `RW_E2E_SKIP_BUILD=1` skips that; `RW_SIDECAR_BIN` skips the sidecar build).
 * Needs a GUI session for Electron. Writes the capture and report to
 * `dist/e2e/page04/`.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seededCopy, sidecarBinary } from "./live.ts";

const APP = resolve(import.meta.dirname, "..");
const REPO = resolve(APP, "..");
const DESKTOP = join(APP, "apps/desktop");
const OUT = join(REPO, "dist/e2e/page04");

/** The drive report (loosely typed JSON). */
// oxlint-disable-next-line typescript/no-explicit-any -- untyped JSON report, read field by field
type Report = Record<string, any>;

type Summary = Record<"apogee_m" | "max_velocity_ms" | "flight_time_s" | "burnout_time_s" | "time_to_apogee_s", number>;

interface SeededRun {
  summary: Summary;
  /** The main chute's deployment (the last `deployment` in `events.json`): the Recovery line. */
  deployment: number;
  /** Data rows of `series.csv`. */
  rows: number;
}

let report: Report;
let project = "";
let bin = "";
const runs = new Map<string, SeededRun>();

function electron(): string {
  return createRequire(join(DESKTOP, "package.json"))("electron") as string;
}

/** The seeded Complete runs' summaries and series lengths (what the page must show). */
function readRuns(): void {
  const list = JSON.parse(execFileSync(bin, ["-C", project, "--json", "call", "run_list", "{}"], { encoding: "utf8", env: { ...process.env, RW_OFFLINE: "1" } })) as {
    runs: { sim: string; status: string; run_id?: string | null }[];
  };
  for (const r of list.runs) {
    if (r.status !== "complete" || !r.run_id) continue;
    const dir = join(project, "runs", r.sim, r.run_id);
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as Summary;
    const rows = readFileSync(join(dir, "series.csv"), "utf8").trim().split("\n").length - 1;
    const events = (JSON.parse(readFileSync(join(dir, "events.json"), "utf8")) as { events: { t: number; kind: string }[] }).events;
    const deployment = events.filter((e) => e.kind === "deployment").at(-1)?.t ?? Number.NaN;
    runs.set(r.sim, { summary, rows, deployment });
  }
}

function runElectron(query: string): Promise<{ code: number | null; err: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, RW_SIDECAR_BIN: bin };
  delete env["ELECTRON_RUN_AS_NODE"];
  delete env["RW_TEST_HOOKS"];
  const args = [
    join(DESKTOP, "src/main.ts"),
    "--project",
    project,
    "--render-out",
    join(OUT, "capture.png"),
    "--probe-out",
    join(OUT, "probe.json"),
    "--query",
    query,
    "--ready",
    "__rwShell",
    "--measure",
    join(APP, "e2e/page04.drive.ts"),
    "--web-root",
    join(APP, "apps/web/dist"),
    "--timeout-ms",
    "90000",
    "-ApplePersistenceIgnoreState",
    "YES",
  ];
  return new Promise((done, fail) => {
    const child = spawn(electron(), args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.on("error", fail);
    child.on("exit", (code) => {
      clearTimeout(timer);
      done({ code, err });
    });
  });
}

/**
 * Why the hidden run failed: every reason its probe gives (`apps/desktop/src/main.ts`; a measured page can still
 * fail on the agent pane's capture), then the page console and the tail of stderr.
 */
function failure(code: number | null, probe: Report | null, err: string): string {
  const reasons =
    probe === null
      ? ["no probe JSON (render failed before writing it; see stderr)"]
      : [
          probe.page?.status === "ready" ? undefined : `page: ${JSON.stringify(probe.page ?? null)}`,
          probe.driveError,
          probe.lecturnError === undefined ? undefined : `agent pane: ${String(probe.lecturnError)}`,
          probe.measureError,
          probe.measure === undefined ? "no measure report" : undefined,
        ].filter((r): r is string => typeof r === "string" && r !== "");
  return [`electron exit ${String(code)}`, ...reasons, `console: ${JSON.stringify(probe?.console ?? [])}`, `stderr:\n${err.slice(-3000)}`].join("\n");
}

beforeAll(async () => {
  if (process.env.RW_E2E_SKIP_BUILD !== "1" || !existsSync(join(APP, "apps/web/dist/index.html"))) {
    const b = spawnSync("pnpm", ["--filter", "@rw/web", "build"], { cwd: APP, stdio: "pipe", encoding: "utf8" });
    if (b.status !== 0) throw new Error(`web build failed:\n${b.stdout}\n${b.stderr}`);
  }
  mkdirSync(OUT, { recursive: true });
  bin = sidecarBinary();
  project = seededCopy(bin, "rw-page04-");
  readRuns();
  rmSync(join(OUT, "probe.json"), { force: true });
  const res = await runElectron("page=04");
  const probe = existsSync(join(OUT, "probe.json")) ? (JSON.parse(readFileSync(join(OUT, "probe.json"), "utf8")) as Report) : null;
  if (res.code !== 0 || !probe?.measure) throw new Error(failure(res.code, probe, res.err));
  report = probe.measure as Report;
}, 300_000);

afterAll(() => {
  if (project) rmSync(dirname(project), { recursive: true, force: true });
});

const baseline = () => runs.get("baseline")!;
const higher = () => runs.get("higher_altitude")!;
const fmt = (v: number) => Math.round(v).toLocaleString("en-US");

describe("page 04 Results (live, seeded)", () => {
  it("answers the agent's plot_render with both runs drawn, and a structured error for an unknown run (CPW2A)", () => {
    const p = report.plotRender;
    expect(p.error).toBeUndefined();
    expect([p.width, p.height]).toEqual([1000, 600]);
    expect(p.reported).toEqual([1000, 600]);
    expect(p.runs).toEqual(["baseline", "higher_altitude"]);
    // Series A teal and B sand lines (2 px wide over most of the plot width), not a blank image.
    expect(p.teal).toBeGreaterThan(300);
    expect(p.sand).toBeGreaterThan(300);
    expect(p.unknown).toMatchObject({ code: "invalid_args" });
    expect(p.unknown.message).toContain("baseline/");
    // Drawn off-screen: the user's page does not change.
    expect(p.pageAfter).toBe(p.pageBefore);
  });

  it("shows the page title and toolbar on the Results tab", () => {
    const r = report.initial;
    expect(r.headerTab).toBe("Results");
    expect(r.title).toBe("Flight results");
    expect(r.titleFontPx).toBeGreaterThanOrEqual(22);
    expect(r.titleFontPx).toBeLessThanOrEqual(28);
    expect(r.toolbar).toEqual(["Run selected", "Plot", "Export CSV"]);
    // accent/teal-fill #134b4b on the primary button.
    expect(r.runSelectedBg).toEqual([0x13, 0x4b, 0x4b]);
  });

  it("lists the sims that have runs with computed status and the summary numbers of Complete runs only", () => {
    const r = report.initial;
    expect(r.columns.slice(2, 7)).toEqual(["Run", "Status", "Apogee (m)", "Max speed (m/s)", "Flight time (s)"]);
    const bySim = Object.fromEntries(r.rows.map((x: Report) => [x.sim, x]));
    // Never-run Recovery test stays in the Runs rail only (concept 04).
    expect(Object.keys(bySim).sort()).toEqual(["baseline", "fin_revision", "higher_altitude"]);
    expect(bySim.baseline.status).toBe("complete");
    expect(bySim.higher_altitude.status).toBe("complete");
    expect(bySim.fin_revision.status).toBe("outdated");
    expect(r.rail.find((x: Report) => x.sim === "recovery_test")?.text).toBe("Recovery test Not run");
    const b = baseline().summary;
    expect(bySim.baseline.cells.slice(2, 7)).toEqual(["Baseline", "Complete", fmt(b.apogee_m), fmt(b.max_velocity_ms), fmt(b.flight_time_s)]);
    expect(bySim.fin_revision.cells.slice(2, 7)).toEqual(["Fin revision", "Outdated", "—", "—", "—"]);
  });

  it("overlays two runs: A teal, B sand, with tinted, ticked rows", () => {
    const r = report.initial;
    const bySim = Object.fromEntries(r.rows.map((x: Report) => [x.sim, x]));
    expect([bySim.baseline.series, bySim.higher_altitude.series]).toEqual(["a", "b"]);
    expect(bySim.baseline.checked && bySim.higher_altitude.checked).toBe(true);
    expect(bySim.baseline.bg).toEqual([0x28, 0x3f, 0x41]);
    expect(bySim.higher_altitude.bg).toEqual([0x30, 0x2d, 0x28]);
    expect(r.legend.map((l: Report) => [l.sim, l.color])).toEqual([
      ["baseline", "#61b5ad"],
      ["higher_altitude", "#f1ae6e"],
    ]);
    expect(r.legend.map((l: Report) => l.text)).toEqual([`Baseline (${fmt(baseline().summary.apogee_m)} m)`, `Higher altitude (${fmt(higher().summary.apogee_m)} m)`]);
    expect(r.legend[0].points).toBe(baseline().rows);
    expect(r.pixels.teal).toBeGreaterThan(200);
    expect(r.pixels.sand).toBeGreaterThan(200);
  });

  it("plots Altitude against Time with the four tabs and Canvas2D event lines of the selected run", () => {
    const r = report.initial;
    expect(r.tabs).toEqual([
      { text: "Altitude", selected: true },
      { text: "Velocity", selected: false },
      { text: "Acceleration", selected: false },
      { text: "Stability", selected: false },
    ]);
    expect(r.axes).toEqual(["Altitude (m)", "Time (s)"]);
    // Burnout, Apogee, Recovery (chute deployment, not touchdown) of the selected run only (Baseline), at its
    // times, in its colour: never one run's Burnout beside another run's Apogee. The legend names the run.
    const s = baseline().summary;
    expect(r.events.map((e: Report) => [e.sim, e.label, e.t])).toEqual([
      ["baseline", "Burnout", s.burnout_time_s],
      ["baseline", "Apogee", s.time_to_apogee_s],
      ["baseline", "Recovery", baseline().deployment],
    ]);
    expect(baseline().deployment).toBeLessThan(s.flight_time_s - 1);
    expect(r.events.every((e: Report) => e.color === "#61b5ad")).toBe(true);
    expect(r.eventsKey).toEqual({ text: "Events: Baseline", color: "#61b5ad" });
    const xs = r.events.map((e: Report) => e.x);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    // The descent under the parachutes is longer than the ascent (no symmetric parabola).
    for (const run of [baseline(), higher()]) expect(run.summary.flight_time_s - run.summary.time_to_apogee_s).toBeGreaterThan(2 * run.summary.time_to_apogee_s);
    // Labels sit in the lane above the plot area: none covers a curve. Every event is labelled; no two labels overlap.
    for (const e of r.events) expect(e.labelled, e.label).toBe(true);
    for (const e of r.events) expect(e.labelTop + 16, e.label).toBeLessThanOrEqual(e.plotTop + 0.5);
    const boxes = r.eventLabels as { label: string; row: number; a: number; b: number }[];
    expect(boxes.length).toBe(3);
    for (const [i, p] of boxes.entries()) {
      for (const q of boxes.slice(i + 1)) if (p.row === q.row) expect(p.b <= q.a || q.b <= p.a, JSON.stringify([p, q])).toBe(true);
    }
    // A marker column carries a dashed line (lit pixels over part of the plot height); a tick a short solid mark.
    for (const c of r.pixels.eventColumns) expect(c.lit, `${c.label} ${c.mark}`).toBeGreaterThan(c.mark === "tick" ? 4 : 40);
  });

  it("switches tabs: Velocity shows speed with its own axis and legend figures", () => {
    const v = report.velocity;
    expect(v.tabs.find((t: Report) => t.selected).text).toBe("Velocity");
    expect(v.axes[0]).toBe("Velocity (m/s)");
    expect(v.legend[0].text).toBe(`Baseline (max ${fmt(baseline().summary.max_velocity_ms)} m/s)`);
  });

  it("shows the Outdated banner for the run on an older model revision", () => {
    expect(report.initial.banner).toBe("Fin revision uses an outdated model. Rebuild to run this simulation. Open design");
    expect(report.hidden.banner).toBe("");
    expect(report.hidden.rows.map((x: Report) => x.sim)).not.toContain("fin_revision");
    expect(report.afterOpenDesign).toBe("Design");
  });

  it("renders the trajectory over a flat ground grid with an axis gizmo and a legend", () => {
    const i = report.initial.inset;
    expect(i.title).toBe("Trajectory view");
    expect(i.error).toBeNull();
    expect(i.ready).toBe("true");
    expect(["webgpu", "webgl2"]).toContain(i.backend);
    expect(i.paths).toBe(2);
    expect(i.points).toBeGreaterThan(100);
    expect(i.ground).toBeGreaterThan(0);
    // The pad rocket glyph stands at the origin.
    expect(i.pad).toBeGreaterThan(0);
    expect(i.gizmo.sort()).toEqual(["X", "Y", "Z"]);
    expect(i.legend).toEqual(["Baseline", "Higher altitude"]);
  });

  it("keeps the details footer clear of the trajectory inset", () => {
    const r = report.initial;
    const inset = r.regions["trajectory-inset"] as number[];
    const footer = r.regions["run-details"] as number[];
    expect(footer[0]! + footer[2]!).toBeLessThanOrEqual(inset[0]! + 1);
    // Every field (View assumptions last) ends inside the footer, so none runs under the inset.
    for (const f of r.detailRects as number[][]) expect(f[0]! + f[2]!, JSON.stringify(f)).toBeLessThanOrEqual(footer[0]! + footer[2]! + 1);
  });

  it("shows run details and assumptions from the run's revision and conditions", () => {
    // The seeded sims fly in a 3 m/s wind from 270° at the standard 15 °C; `rw check` has three warnings: low T/W
    // (RW-W102) and the deliberately incomplete demo engine's missing fluid model and feed bc (RW-W210, RW-W211; M4.4).
    // Compact, so it fits at 1536 px without an ellipsis.
    expect(report.initial.details).toEqual(["Model Rev 07", "Environment: wind 3 m/s W, 15 °C", "Warnings: 3", "View assumptions"]);
    expect(report.initial.detailsClipped).toEqual([]);
    expect(report.assumptions[0]).toBe("Engineering result (tier 1 flight simulation)");
    expect(report.assumptions.some((a: string) => a.startsWith("Atmosphere: US Standard Atmosphere 1976"))).toBe(true);
  });

  it("lists runs in the rail with eye, status, and name, Baseline selected", () => {
    const r = report.initial;
    expect(r.railTitle).toBe("Runs");
    // `run_list` order (by sim id).
    expect(r.rail.map((x: Report) => x.text)).toEqual(["Baseline Complete", "Fin revision Outdated", "Higher altitude Complete", "Recovery test Not run"]);
    expect(r.rail.map((x: Report) => x.statusIcon)).toEqual(["check", "warning", "check", "circle"]);
    expect(r.rail.every((x: Report) => x.eye === "eye")).toBe(true);
    expect(r.rail.filter((x: Report) => x.selected).map((x: Report) => x.sim)).toEqual(["baseline"]);
  });

  it("shows run snapshot cards with the model revision under the history steps", () => {
    const r = report.initial;
    expect(r.snapshots.map((x: Report) => [x.sim, x.series])).toEqual([
      ["baseline", "a"],
      ["higher_altitude", "b"],
    ]);
    // The model revision's step (04 Flight runs, the seed's RW_CLOCK 2026-10-15T14:02:00Z), in local time.
    expect(r.snapshots[0].text).toMatch(/^Baseline run Model Rev 07 Oct 1[456], 2026, \d{1,2}:\d{2} (AM|PM)$/);
    const strip = r.regions["history-strip"];
    const snaps = r.regions["run-snapshots"];
    expect(snaps[1]).toBeGreaterThan(strip[1]);
    expect(snaps[1] + snaps[3]).toBe(strip[1] + strip[3]);
  });

  it("matches the page-04 region proportions it gates (regions.json, ±5%)", () => {
    const regions = JSON.parse(readFileSync(join(REPO, "tests/bar/regions.json"), "utf8")) as { pages: Record<string, { rects: Record<string, number[]>; check: Record<string, string[]> }> };
    const page = regions.pages["04"]!;
    const measured = report.initial.regions as Record<string, number[] | null>;
    for (const [name, dims] of Object.entries(page.check)) {
      const ours = measured[name];
      if (!ours) continue;
      for (const d of dims) {
        const k = d === "w" ? 2 : 3;
        const want = page.rects[name]![k]!;
        expect(Math.abs(ours[k]! - want) / want, `${name}.${d}: ${ours[k]} vs ${want}`).toBeLessThanOrEqual(0.05);
      }
    }
  });

  it("exports the plotted runs as CSV", () => {
    const c = report.csv;
    expect(c.fileName).toBe("results-baseline-higher_altitude.csv");
    expect(c.header).toBe("run,sim,run_id,t,altitude,x,y,vz,speed,accel,mach,aoa,stability,thrust,mass,cg,cp,cd");
    expect(c.runs).toEqual({ Baseline: baseline().rows, "Higher altitude": higher().rows });
  });

  it("sorts by a column and toggles the overlay", () => {
    expect(report.sortAsc).toEqual(["fin_revision", "baseline", "higher_altitude"]);
    expect(report.sortDesc.slice(0, 2)).toEqual(["higher_altitude", "baseline"]);
    expect(report.sortOff).toEqual(report.initial.rows.map((x: Report) => x.sim));
    expect(report.single.legend.map((l: Report) => l.sim)).toEqual(["baseline"]);
    expect(report.single.snapshots.map((x: Report) => x.sim)).toEqual(["baseline"]);
  });

  it("selects a never-run sim in the rail and runs it through the RPC (Not run → Complete, then in the table)", () => {
    expect(report.railSelected).toEqual(["recovery_test"]);
    const row = report.afterRun.rows.find((x: Report) => x.sim === "recovery_test");
    expect(row.status).toBe("complete");
    expect(row.cells[3]).toBe("Complete");
  });
});
