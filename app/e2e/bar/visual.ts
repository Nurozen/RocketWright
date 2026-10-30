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
 * The Makefile builds the web bundle and the sidecar (`RW_SIDECAR_BIN`) first.
 * Exit 1 when any gated row fails or a capture script fails.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { TokenReport } from "../visual-tokens.ts";
import { buildPacket } from "./packet.ts";
import { isPageId, REPO_ROOT, stableStringify, type PageId } from "./paths.ts";
import { gateReport, type RowsMode } from "./shell-rows.ts";
import { MILESTONES, type Milestone } from "./spec.ts";
import { lecturnEnv } from "../lecturn-env.ts";
import { PROJECT_NAME, seedTemp } from "../live.ts";

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
export function probeFailure(page: string, probe: Probe): string {
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

/** Desktop arguments for one page (`project` set: the live app driven by `drive`). */
export function desktopArgs(page: PageId, outDir: string, live: { project: string; drive: string } | null): string[] {
  return [
    join(DESKTOP, "src/main.ts"),
    ...(live === null ? [] : ["--project", live.project, "--drive", live.drive, "--timeout-ms", "120000"]),
    "--render-out",
    join(outDir, "capture.png"),
    "--probe-out",
    join(outDir, "probe.json"),
    "--query",
    `page=${page}`,
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

export function parseArgs(argv: string[]): { pages: CaptureTarget[]; rows: RowsMode; out: string; packets: boolean; scope: ScopeRequest } {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const pages = (arg("--pages") || "01").split(",").map((s) => s.trim()).filter(Boolean);
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
  return { pages: targets, rows, out: resolve(arg("--out") ?? join(REPO_ROOT, "dist/bar-visual")), packets: !argv.includes("--no-packet"), scope };
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
  const { pages, rows, out, packets, scope } = parseArgs(argv);
  let failed = 0;
  for (const t of pages) if (!(await capturePage(t, join(out, targetName(t)), rows, packets, scope))) failed++;
  return failed === 0 ? 0 : 1;
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
