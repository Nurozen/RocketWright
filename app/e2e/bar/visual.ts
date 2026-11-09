/**
 * `make bar-visual PAGES=01[,02,03,04,05,06,06-engineering] [ROWS=shell|all]` (M1.19 shell rows; M1.53
 * live capture states and critic packets).
 *
 * For each page, one command does the whole B1 round:
 * - A page with a capture script (`app/e2e/capture/pages/<id>.ts`: 01-06)
 *   runs the real app on the live sidecar: a fresh seeded research vehicle
 *   (`fixtures/research-vehicle/seed.sh`, M1.55: real history steps 01-04,
 *   Rev 07, and runs; as `/tmp/<x>/Research vehicle`), the desktop
 *   hidden window with `--project` and `RW_TEST_HOOKS=1`, and the script as
 *   the `--drive` module, which puts the page into the concept state through
 *   the `app_*` broker hooks. Other pages capture the static shell (M1.19).
 * - Each page runs with its own temp `LECTURN_HOME` and `RW_LECTURN_BASE_DIR`
 *   (`../lecturn-env.ts`) and Lecturn's scripted test provider on, so the
 *   01 and 06 scripts can import the page's thread bundle and stage the
 *   embedded pane's live state (B13; `capture/embed.ts`).
 * - At 1536x1024 DPR 1 the DOM token script (`measure-dom.ts`: computed
 *   colours vs tests/bar/tokens.json at ΔE00 <= 3, region boxes vs
 *   tests/bar/regions.json at ±5%) runs, then the PNG capture.
 * - Writes `<out>/<page>/{capture.png,probe.json,drive.json,tokens.json,regions.json,report.txt}`
 *   and the critic packet in `<out>/<page>/packet/` (`packet.ts`). A capture
 *   script may also write a motion clip into its output directory
 *   (`RW_BAR_CAPTURE_DIR`, e.g. 06's playback contact sheet) and name it as
 *   `drive.clip`; the packet then carries it as `motion.<ext>`.
 *
 * Packet scope (`packetScope`): `--fidelity` (`FIDELITY=1`) asks critics for
 * the fidelity verdicts and scopes the packet to the page's fidelity
 * milestone (01-04 M3, 05 M4, 06 M5); `--bc BC5` (`BC=BC5`) scopes it to
 * that checkpoint's milestone, with fidelity on from BC5; `--milestone`
 * (`MILESTONE=`) overrides the milestone. Default: M1, fidelity off.
 *
 * `make bar-visual SURFACES=s-welcome[,…]` captures B3's surfaces instead
 * (`tests/bar/surfaces.json`, scripts in `app/e2e/capture/surfaces/`): real
 * app boots (no project, the sample open, or a surface's seeded project) on a
 * seeded profile with a frozen clock and no test hooks, driven to the surface
 * by DOM clicks. A surface without a script is
 * reported as not built, and nothing is captured for it. Output goes to
 * `<out>/<surface>/` with a critic packet (`buildSurfacePacket`).
 *
 * The Makefile builds the web bundle and the sidecar (`RW_SIDECAR_BIN`) first.
 * Exit 1 when any gated row fails or a capture script fails; exit 3 when the
 * only shortfall is a surface that is not built yet.
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { TokenReport } from "../visual-tokens.ts";
import { buildPacket, buildSurfacePacket } from "./packet.ts";
import { isPageId, isSurfaceId, REPO_ROOT, stableStringify, SURFACES, type PageId, type SurfaceId } from "./paths.ts";
import { gateReport, type RowsMode } from "./shell-rows.ts";
import { MILESTONES, type Milestone } from "./spec.ts";
import { surfaceFailures, surfaceSpec, type SurfaceBoot, type SurfaceMeasure, type SurfacePane, type SurfaceSeed, type SurfaceSpec } from "./surfaces.ts";
import { lecturnEnv } from "../lecturn-env.ts";
import { PROJECT_NAME, SCRATCH, seedTemp } from "../live.ts";

const DESKTOP = join(REPO_ROOT, "app/apps/desktop");
const MEASURE = join(REPO_ROOT, "app/e2e/bar/measure-dom.ts");
export const CAPTURE_DIR = join(REPO_ROOT, "app/e2e/capture/pages");
export const SEED_FIXTURE = join(REPO_ROOT, "fixtures/research-vehicle");
export { PROJECT_NAME };

export interface Probe {
  page: { status: string; error?: string };
  drive?: Record<string, unknown> | null;
  driveError?: string;
  /** Why the embedded pane's guest was not measured or captured (`apps/desktop/src/main.ts`). */
  lecturnError?: string;
  measure?: TokenReport;
  measureError?: string;
  capture?: { path: string; width: number; height: number };
  console?: string[];
}

/**
 * The failure report of a probe without measurements (CPW2B: every reason
 * the probe gives, `lecturnError` included; it once printed only
 * "page 02: shell ready").
 */
export function probeFailure(page: string, probe: Omit<Probe, "measure">): string {
  const reasons = [
    probe.page.error,
    probe.lecturnError === undefined ? undefined : `agent pane: ${probe.lecturnError}`,
    probe.measureError,
  ].filter((r): r is string => r !== undefined && r !== "");
  return [`page ${page}: shell ${probe.page.status}${reasons.length === 0 ? " (no measurements)" : ""}`, ...reasons, ...(probe.console ?? [])].join("\n");
}

function electronBinary(): string {
  return createRequire(join(DESKTOP, "package.json"))("electron") as string;
}

/** The page's capture script (`<page>.ts`, or `<page>-<variant>.ts` for a variant state), when it has one. */
export function captureScript(page: PageId, dir = CAPTURE_DIR, variant: string | null = null): string | null {
  const p = join(dir, `${variant === null ? page : `${page}-${variant}`}.ts`);
  return existsSync(p) ? p : null;
}

/** One capture: a page, optionally in a named variant state (`06-engineering`: page 06's Engineering tier). */
export interface CaptureTarget {
  page: PageId;
  variant: string | null;
}

/** `05` or `06-engineering` → its page and variant, or null. */
export function parseTarget(s: string): CaptureTarget | null {
  const m = /^(\d\d)(?:-([a-z][a-z0-9-]*))?$/.exec(s);
  if (m === null || !isPageId(m[1]!)) return null;
  return { page: m[1] as PageId, variant: m[2] ?? null };
}

export const targetName = (t: CaptureTarget): string => (t.variant === null ? t.page : `${t.page}-${t.variant}`);

/** The hidden-window arguments every capture shares. */
function renderArgs(outDir: string, query: string): string[] {
  return [
    "--render-out",
    join(outDir, "capture.png"),
    "--probe-out",
    join(outDir, "probe.json"),
    "--query",
    query,
    "--ready",
    "__rwShell",
    "--measure",
    MEASURE,
    "--web-root",
    join(REPO_ROOT, "app/apps/web/dist"),
    "-ApplePersistenceIgnoreState",
    "YES",
  ];
}

/** Desktop arguments for one page (`project` set: the live app driven by `drive`). */
export function desktopArgs(page: PageId, outDir: string, live: { project: string; drive: string } | null): string[] {
  return [join(DESKTOP, "src/main.ts"), ...(live === null ? [] : ["--project", live.project, "--drive", live.drive, "--timeout-ms", "120000"]), ...renderArgs(outDir, `page=${page}`)];
}

/** Where `s-*` capture scripts live. A surface is built when its script exists. */
export const SURFACE_CAPTURE_DIR = join(REPO_ROOT, "app/e2e/capture/surfaces");

/** The instant every surface capture sees as "now", so Recents' ages read the same run to run. */
export const SURFACE_CLOCK_MS = Date.UTC(2026, 10, 8, 12);

export function surfaceScript(id: SurfaceId, dir = SURFACE_CAPTURE_DIR): string | null {
  const p = join(dir, `${id}.ts`);
  return existsSync(p) ? p : null;
}

/** Desktop arguments for one surface: a seeded profile, and either no project or the sample open (`project`). */
export function surfaceDesktopArgs(id: SurfaceId, outDir: string, drive: string, project: string | null): string[] {
  return [
    join(DESKTOP, "src/main.ts"),
    ...(project === null ? ["--zero-project"] : ["--project", project]),
    "--drive",
    drive,
    "--timeout-ms",
    "120000",
    "--freeze-clock",
    String(SURFACE_CLOCK_MS),
    ...renderArgs(outDir, `surface=${id}`),
  ];
}

export interface SurfaceFixture {
  scratch: string;
  /** The Electron profile holding `recents.json`, exempt from the hidden run's temp-profile cleanup. */
  profile: string;
  /** The stand-in for the OS Documents folder. */
  documents: string;
  /** The open project's folder (`project` boot), else null. */
  project: string | null;
}

const DAY_MS = 86_400_000;
export const SEEDED_RECENTS = [
  { name: "weekend-flyer", ageMs: 2 * 3_600_000, exists: true },
  { name: "altitude-study", ageMs: 3 * DAY_MS, exists: true },
  { name: "old-prototype", ageMs: 18 * DAY_MS, exists: false },
] as const;

/**
 * A seeded profile (three Recents, one of them missing) under a fresh
 * `/tmp` scratch dir, plus the project for a `project` boot: `seeded` when the
 * surface has one, else the sample rocket. Recent omits what the window has
 * open, so none of these is that project: the same three rows show whichever
 * way the window boots.
 * `init` runs `rw init <dir> --name=<name> --template=<template>`.
 */
export function seedSurfaceFixture(
  boot: SurfaceBoot,
  clockMs: number,
  init: (dir: string, name: string, template: string) => void,
  seeded: { name: string; write: (dir: string) => void } | null = null,
): SurfaceFixture {
  const scratch = realpathSync(mkdtempSync(join(SCRATCH, "rw-bar-surface-")));
  const documents = join(scratch, "Documents");
  const profile = join(scratch, "profile");
  const location = join(documents, "RocketWright");
  mkdirSync(location, { recursive: true });
  mkdirSync(profile);
  const recents = SEEDED_RECENTS.map((r) => {
    const dir = join(location, r.name);
    if (r.exists) init(dir, r.name, "empty");
    return { dir, name: r.name, lastOpened: new Date(clockMs - r.ageMs).toISOString() };
  });
  writeFileSync(join(profile, "recents.json"), `${JSON.stringify({ version: 1, recents, lastActive: null }, null, 2)}\n`);
  let project: string | null = null;
  if (boot === "project") {
    project = join(location, seeded?.name ?? "Sample rocket");
    if (seeded === null) init(project, "Sample rocket", "sample");
    else seeded.write(project);
  }
  return { scratch, profile, documents, project };
}

/** Writes a surface's `seed` project: the fixture, minus its own seeding files, with the ops applied the way any model edit is (the session is the single writer). */
export function writeSurfaceSeed(seed: SurfaceSeed, dir: string, rw: string, fixtures = join(REPO_ROOT, "fixtures")): void {
  cpSync(join(fixtures, seed.fixture), dir, { recursive: true, filter: (src) => !/\/seed(\.sh|\.expected\.json)$/.test(src) });
  execFileSync(rw, ["-C", dir, "call", "--label", seed.label, "model_patch", JSON.stringify({ ops: seed.ops })], { stdio: ["ignore", "ignore", "pipe"] });
}

/** What the capture ends with: `not-built` is a surface no step has delivered yet (no script), never a fake capture. */
export type SurfaceOutcome = "ok" | "failed" | "not-built";

export const notBuiltLine = (id: SurfaceId): string => `surface ${id}: not built yet (no capture script app/e2e/capture/surfaces/${id}.ts); nothing captured`;

interface SurfaceProbe extends Omit<Probe, "measure"> {
  measure?: SurfaceMeasure;
  surfacePane?: SurfacePane;
}

/** Report lines and failures of a finished surface capture. */
export function surfaceReport(id: SurfaceId, spec: SurfaceSpec, probe: SurfaceProbe): { pass: boolean; lines: string[] } {
  const failures = surfaceFailures(id, spec, { measure: probe.measure, pane: probe.surfacePane });
  const lines = [
    `surface ${id} (${spec.title}): ${failures.length === 0 ? "reached" : "FAILED"}`,
    `  state ${JSON.stringify(probe.drive ?? null)}`,
    `  agent pane ${String(probe.surfacePane)}`,
    ...(probe.measure?.overlay ? [`  overlay ${probe.measure.overlay.selector}: ${probe.measure.overlay.present ? "shown" : "absent"}`] : []),
    ...failures.map((f) => `  ${f}`),
    `  capture ${probe.capture?.path ?? "(none)"}`,
  ];
  return { pass: failures.length === 0, lines };
}

async function captureSurface(id: SurfaceId, dir: string, packets: boolean): Promise<SurfaceOutcome> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const drive = surfaceScript(id);
  if (drive === null) {
    const line = notBuiltLine(id);
    writeFileSync(join(dir, "report.txt"), `${line}\n`);
    console.log(line);
    return "not-built";
  }
  const spec = surfaceSpec(id);
  const env = { ...process.env };
  delete env["ELECTRON_RUN_AS_NODE"];
  const lecturn = lecturnEnv(env, "rw-bar-lecturn-", { scripted: true });
  Object.assign(env, lecturn.env);
  const rw = env["RW_SIDECAR_BIN"] || "rocketwright";
  const fixture = seedSurfaceFixture(spec.boot, SURFACE_CLOCK_MS, (projectDir, name, template) => {
    execFileSync(rw, ["init", projectDir, `--name=${name}`, `--template=${template}`, "--json"], { stdio: "ignore" });
  }, spec.seed === undefined ? null : { name: spec.seed.name, write: (projectDir) => writeSurfaceSeed(spec.seed!, projectDir, rw) });
  env["RW_SEEDED_PROFILE"] = fixture.profile;
  env["RW_DOCUMENTS_DIR"] = fixture.documents;
  env["RW_BAR_CAPTURE_DIR"] = dir;
  try {
    const run = await runPage(surfaceDesktopArgs(id, dir, drive, fixture.project), env, 480_000);
    let probe: SurfaceProbe;
    try {
      probe = JSON.parse(readFileSync(join(dir, "probe.json"), "utf8")) as SurfaceProbe;
    } catch {
      console.error(`surface ${id}: no probe (electron exit ${String(run.code)})\n${run.err.slice(-2000)}`);
      return "failed";
    }
    if (probe.driveError !== undefined) {
      console.error(`surface ${id}: capture script failed\n${probe.driveError}\n${(probe.console ?? []).join("\n")}`);
      return "failed";
    }
    if (probe.page.status !== "ready" || probe.measureError !== undefined || probe.lecturnError !== undefined) {
      console.error(probeFailure(id, probe));
      return "failed";
    }
    if (probe.drive !== undefined) writeFileSync(join(dir, "drive.json"), stableStringify(probe.drive));
    const { pass, lines } = surfaceReport(id, spec, probe);
    if (packets && pass && probe.capture !== undefined) {
      const out = join(dir, "packet");
      buildSurfacePacket({ surface: id, capture: join(dir, "capture.png"), out });
      lines.push(`  packet ${out}`);
    }
    const text = lines.join("\n");
    writeFileSync(join(dir, "report.txt"), `${text}\n`);
    console.log(text);
    return pass ? "ok" : "failed";
  } finally {
    rmSync(fixture.scratch, { recursive: true, force: true });
    lecturn.cleanup();
  }
}

function runPage(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; err: string }> {
  return new Promise((done, fail) => {
    const child = spawn(electronBinary(), args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", fail);
    child.on("exit", (code) => {
      clearTimeout(timer);
      done({ code, err });
    });
  });
}

/** Milestone gate of each bar checkpoint (plan "Bar checkpoints"); BC5 onward gate render fidelity. */
export const CHECKPOINTS: Record<string, { milestone: Milestone; fidelity: boolean }> = {
  BC0: { milestone: "M1", fidelity: false },
  BC1: { milestone: "M1", fidelity: false },
  BC2: { milestone: "M1", fidelity: false },
  BC3: { milestone: "M1", fidelity: false },
  "BC3.5": { milestone: "M2", fidelity: false },
  BC4: { milestone: "M2", fidelity: false },
  BC5: { milestone: "M3", fidelity: true },
  BC6: { milestone: "M4", fidelity: true },
  BC7: { milestone: "M5", fidelity: true },
};

/** The milestone whose fidelity gate first judges a page's live render (01-04: M3 / BC5; 05: M4; 06: M5). */
export const FIDELITY_MILESTONE: Record<PageId, Milestone> = { "01": "M3", "02": "M3", "03": "M3", "04": "M3", "05": "M4", "06": "M5" };

export interface ScopeRequest {
  fidelity?: boolean;
  bc?: string | null;
  milestone?: string | null;
}

/** The critic packet's milestone in scope and fidelity flag for one page. Throws on an unknown checkpoint or milestone. */
export function packetScope(page: PageId, req: ScopeRequest = {}): { milestone: Milestone; fidelity: boolean } {
  let milestone: Milestone = "M1";
  let fidelity = req.fidelity === true;
  const bc = req.bc?.trim().toUpperCase();
  if (bc) {
    const cp = CHECKPOINTS[bc];
    if (!cp) throw new Error(`--bc: unknown checkpoint ${req.bc} (${Object.keys(CHECKPOINTS).join(", ")})`);
    milestone = cp.milestone;
    fidelity ||= cp.fidelity;
  } else if (fidelity) milestone = FIDELITY_MILESTONE[page];
  if (req.milestone) {
    const m = req.milestone.trim().toUpperCase();
    if (!(MILESTONES as readonly string[]).includes(m)) throw new Error(`--milestone: ${req.milestone} (${MILESTONES.join(", ")})`);
    milestone = m as Milestone;
  }
  return { milestone, fidelity };
}

export function parseArgs(argv: string[]): { pages: CaptureTarget[]; surfaces: SurfaceId[]; rows: RowsMode; out: string; packets: boolean; scope: ScopeRequest } {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const surfaces = (arg("--surfaces") ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    if (!isSurfaceId(s)) throw new Error(`--surfaces: unknown surface ${s} (${SURFACES.join(", ")})`);
    return s;
  });
  const pages = (arg("--pages") || (surfaces.length > 0 ? "" : "01")).split(",").map((s) => s.trim()).filter(Boolean);
  const targets = pages.map((p) => {
    const t = parseTarget(p);
    if (t === null) throw new Error(`--pages: unknown page ${p} (01..06, or <page>-<variant>)`);
    return t;
  });
  const rows = arg("--rows") || "shell";
  if (rows !== "shell" && rows !== "all") throw new Error(`--rows: shell or all, got ${rows}`);
  const scope: ScopeRequest = { fidelity: argv.includes("--fidelity"), bc: arg("--bc") || null, milestone: arg("--milestone") || null };
  // Fail early on a bad checkpoint or milestone (before any capture runs).
  for (const t of targets) packetScope(t.page, scope);
  return { pages: targets, surfaces, rows, out: resolve(arg("--out") ?? join(REPO_ROOT, "dist/bar-visual")), packets: !argv.includes("--no-packet"), scope };
}

/** The motion clip a capture script wrote (`drive.clip`, inside the page's output directory), if any. */
export function driveClip(drive: Record<string, unknown> | null | undefined, dir: string): string | null {
  const clip = drive?.["clip"];
  if (typeof clip !== "string" || clip === "") return null;
  const abs = resolve(dir, clip);
  return abs.startsWith(resolve(dir) + "/") && existsSync(abs) ? abs : null;
}

/** Report lines for the drive result: the reached state, plus anything the live app could not show yet. */
export function driveLines(drive: Record<string, unknown> | null | undefined): string[] {
  if (drive === undefined || drive === null) return ["  state static shell (no capture script)"];
  const lines = [`  state ${JSON.stringify(drive["state"] ?? { overlaid: drive["overlaid"] ?? [] })}`];
  // B13: the embedded pane passed its guest checks (a failure aborts the capture as a drive error).
  const pane = drive["pane"] as { scenario?: unknown; run?: { tools?: unknown[] }; pane?: { main?: { view?: { out?: string[] } | null } } } | undefined;
  if (pane !== undefined && pane !== null) {
    lines.push(`  pane ${String(pane.scenario)} checked (${pane.run?.tools?.length ?? 0} tool rows, one approval pending)`);
    // CPW1R3A: the live turn against the pane's timeline box (reported, not gated).
    const view = pane.pane?.main?.view;
    if (view !== undefined && view !== null) lines.push(view.out === undefined || view.out.length === 0 ? "  pane live turn in view" : `  pane out of view: ${view.out.join("; ")}`);
  }
  const pending = Array.isArray(drive["pending"]) ? (drive["pending"] as string[]) : [];
  if (pending.length > 0) {
    const notes = Array.isArray(drive["runs"]) ? (drive["runs"] as { sim: string; note?: string }[]).filter((r) => r.note !== undefined) : [];
    lines.push(`  pending runs ${pending.join(", ")}: ${notes.map((n) => `${n.sim}: ${n.note}`).join("; ") || "not Complete"}`);
  }
  return lines;
}

async function capturePage(target: CaptureTarget, dir: string, rows: RowsMode, packets: boolean, scope: ScopeRequest): Promise<boolean> {
  const { page } = target;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const drive = captureScript(page, CAPTURE_DIR, target.variant);
  if (target.variant !== null && drive === null) {
    console.error(`page ${targetName(target)}: no capture script app/e2e/capture/pages/${targetName(target)}.ts`);
    return false;
  }
  const env = { ...process.env };
  delete env["ELECTRON_RUN_AS_NODE"]; // some agent shells export it; Electron would run as Node
  // Every page gets its own Lecturn home and sidecar base dir (never ~/.lecturn; B13), with the
  // scripted test provider on: pages 01 and 06 stage the embedded pane's live state with it.
  const lecturn = lecturnEnv(env, "rw-bar-lecturn-", { scripted: true });
  Object.assign(env, lecturn.env);
  let scratch: string | null = null;
  let live: { project: string; drive: string } | null = null;
  if (drive !== null) {
    const project = seedTemp(env["RW_SIDECAR_BIN"] || "rocketwright", "rw-bar-visual-");
    scratch = dirname(project);
    live = { project, drive };
    env["RW_TEST_HOOKS"] = "1";
    env["RW_BAR_CAPTURE_DIR"] = dir;
  }
  try {
    const run = await runPage(desktopArgs(page, dir, live), env, 480_000);
    let probe: Probe;
    try {
      probe = JSON.parse(readFileSync(join(dir, "probe.json"), "utf8")) as Probe;
    } catch {
      console.error(`page ${page}: no probe (electron exit ${String(run.code)})\n${run.err.slice(-2000)}`);
      return false;
    }
    if (probe.driveError !== undefined) {
      console.error(`page ${page}: capture script failed\n${probe.driveError}\n${(probe.console ?? []).join("\n")}`);
      return false;
    }
    if (!probe.measure) {
      console.error(probeFailure(page, probe));
      return false;
    }
    if (probe.drive !== undefined) writeFileSync(join(dir, "drive.json"), stableStringify(probe.drive));
    writeFileSync(join(dir, "tokens.json"), stableStringify(probe.measure));
    writeFileSync(
      join(dir, "regions.json"),
      stableStringify({ page, tolerance: probe.measure.tolerance.proportion, proportions: probe.measure.proportions }),
    );
    const gated = gateReport(probe.measure, rows);
    const clip = live === null ? null : driveClip(probe.drive, dir);
    const lines = [...gated.lines, ...driveLines(live === null ? undefined : probe.drive), `  capture ${probe.capture?.path ?? "(none)"}`, ...(clip ? [`  clip ${clip}`] : [])];
    if (packets && probe.capture !== undefined) {
      const out = join(dir, "packet");
      const { milestone, fidelity } = packetScope(page, scope);
      buildPacket({
        page,
        capture: join(dir, "capture.png"),
        tokensReport: join(dir, "tokens.json"),
        regionsReport: join(dir, "regions.json"),
        milestone,
        fidelity,
        out,
        ...(clip ? { clip } : {}),
      });
      lines.push(`  packet ${out} (milestone ${milestone}, fidelity ${fidelity ? "on" : "off"})`);
    }
    const text = lines.join("\n");
    writeFileSync(join(dir, "report.txt"), text + "\n");
    console.log(text);
    return gated.pass;
  } finally {
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
    lecturn.cleanup();
  }
}

async function main(argv: string[]): Promise<number> {
  const { pages, surfaces, rows, out, packets, scope } = parseArgs(argv);
  let failed = 0;
  let notBuilt = 0;
  for (const t of pages) if (!(await capturePage(t, join(out, targetName(t)), rows, packets, scope))) failed++;
  for (const id of surfaces) {
    const outcome = await captureSurface(id, join(out, id), packets);
    if (outcome === "failed") failed++;
    else if (outcome === "not-built") notBuilt++;
  }
  // A request for an undelivered surface did not produce what was asked, so it is never exit 0; 3 tells it apart from a failed capture.
  if (failed > 0) return 1;
  return notBuilt > 0 ? 3 : 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 2;
    },
  );
}
