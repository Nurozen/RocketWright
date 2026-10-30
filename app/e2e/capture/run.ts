/**
 * RL1 visual spike capture: `node app/e2e/capture/run.ts --url spikes/<x>[?query]`.
 *
 * Runs the desktop hidden-window capture path (`apps/desktop/src/main.ts
 * --render-out`, DPR 1, 1536x1024, real WebGPU) on `spikes/<x>.html` of the
 * built web bundle, waits for the page's `window.__rwSpike` probe, then checks
 * the captured PNG (the final tone-mapped sRGB output, never a linear
 * readback) and prints a go/no-go line. Writes `<out>/<name>.{png,json,report.json}`.
 *
 * Options: `--out <dir>` (default `<repo>/dist/spikes`), `--build` (rebuild the
 * web bundle first; also done when the page is missing), `--oidn-weights
 * <file.tza>` (stages the OIDN weights next to the page and adds
 * `oidn=` to the query), `--timeout-ms <n>`.
 *
 * Exit 0 = GO (every probe and image check passed), 1 = NO-GO, 2 = usage or run failure.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { countPixels, isOrange, isTeal, noiseMetric, strokeWidth, type Rect } from "../../apps/web/src/render/metrics.ts";
import { decodePng, type Image } from "../bar/png.ts";
import { REPO_ROOT } from "../bar/paths.ts";

const DESKTOP = join(REPO_ROOT, "app/apps/desktop");
const WEB_DIST = join(REPO_ROOT, "app/apps/web/dist");
export const WIDTH = 1536;
export const HEIGHT = 1024;

export interface RunArgs {
  spike: string;
  query: string;
  out: string;
  build: boolean;
  oidnWeights: string | null;
  timeoutMs: number;
}

export function parseArgs(argv: string[]): RunArgs {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = get("url");
  const m = url === undefined ? null : /^spikes\/([a-z0-9-]+)(?:\.html)?(?:\?(.*))?$/.exec(url);
  if (m === null) throw new Error("usage: run.ts --url spikes/<name>[?query] [--out dir] [--build] [--oidn-weights file.tza] [--timeout-ms n]");
  return {
    spike: m[1]!,
    query: m[2] ?? "",
    out: resolve(get("out") ?? join(REPO_ROOT, "dist/spikes")),
    build: argv.includes("--build"),
    oidnWeights: get("oidn-weights") ?? null,
    timeoutMs: Number(get("timeout-ms") ?? 180_000),
  };
}

/** Output file stem: the spike plus its query values, e.g. `transmission-glass-oit`. */
export function captureName(spike: string, query: string): string {
  const parts = [...new URLSearchParams(query)].filter(([k]) => k !== "oidn").map(([k, v]) => `${k}-${v}`.replace(/[^a-z0-9.-]+/gi, "_"));
  return [spike, ...parts].join("-");
}

export interface Check {
  value: number | string | boolean | null;
  pass: boolean;
  note?: string;
}

interface SpikeProbe {
  spike: string;
  variant: string;
  regions: Record<string, Rect>;
  checks: Record<string, Check>;
  timings: Record<string, number>;
  notes: string[];
}

const area = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
/** Shrinks a rect towards its centre to `f` of its width and height. */
const inner = (r: Rect, f: number): Rect => {
  const cx = (r[0] + r[2]) / 2;
  const cy = (r[1] + r[3]) / 2;
  const hw = ((r[2] - r[0]) * f) / 2;
  const hh = ((r[3] - r[1]) * f) / 2;
  return [cx - hw, cy - hh, cx + hw, cy + hh];
};

/** Checks on the captured PNG, per spike. */
export function imageChecks(spike: string, img: Image, regions: Record<string, Rect>, query: string): Record<string, Check> {
  const checks: Record<string, Check> = {
    size: { value: `${img.width}x${img.height}`, pass: img.width === WIDTH && img.height === HEIGHT },
  };
  const q = new URLSearchParams(query);
  if (spike === "transmission" || spike === "pathtrace") {
    const chute = regions["chute"];
    if (chute) {
      // The chute is only ever seen through the clear wall: orange in its screen box means the glass shows it.
      const core = inner(chute, 0.6);
      const frac = countPixels(img, isOrange, core) / Math.max(1, area(core));
      checks["chuteThroughGlass"] = { value: Number(frac.toFixed(3)), pass: frac >= 0.25, note: "orange fraction in the central 60% of the chute's screen box" };
    }
  }
  if (spike === "transmission") {
    const teal = countPixels(img, isTeal);
    checks["outlinePixels"] = { value: teal, pass: teal >= 1000, note: "teal outline pixels" };
    const w = strokeWidth(img, isTeal);
    checks["outlineWidthPx"] = { value: w, pass: w !== null && w >= 2 && w <= 3, note: "median min(h, v) teal run; a 2 px line reads 2..2.8" };
  }
  if (spike === "pathtrace") {
    const bay = regions["bay"];
    const n = noiseMetric(img, bay ? inner(bay, 0.9) : undefined);
    checks["noise"] = { value: Number(n.noise.toFixed(2)), pass: n.noise <= (q.has("oidn") ? 1.5 : 6), note: `mean |luma - 4-neighbour mean| over ${n.pixels} non-edge px in the bay box` };
  }
  return checks;
}

function electronBinary(): string {
  return createRequire(join(DESKTOP, "package.json"))("electron") as string;
}

function runElectron(args: string[], timeoutMs: number): Promise<{ code: number | null; err: string }> {
  const env = { ...process.env };
  delete env["ELECTRON_RUN_AS_NODE"]; // agent shells export it; Electron would run as Node
  return new Promise((done, fail) => {
    const child = spawn(electronBinary(), args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 30_000);
    child.on("error", fail);
    child.on("exit", (code) => {
      clearTimeout(timer);
      done({ code, err });
    });
  });
}

async function main(argv: string[]): Promise<number> {
  let a: RunArgs;
  try {
    a = parseArgs(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const page = `spikes/${a.spike}.html`;
  if (a.build || !existsSync(join(WEB_DIST, page))) {
    const b = spawnSync("pnpm", ["--filter", "@rw/web", "build"], { cwd: join(REPO_ROOT, "app"), stdio: "inherit" });
    if (b.status !== 0) return 2;
  }
  if (!existsSync(join(WEB_DIST, page))) {
    console.error(`no ${page} in ${WEB_DIST}`);
    return 2;
  }
  let query = a.query;
  if (a.oidnWeights !== null) {
    const dir = join(WEB_DIST, "spikes/oidn");
    mkdirSync(dir, { recursive: true });
    copyFileSync(a.oidnWeights, join(dir, basename(a.oidnWeights)));
    const q = new URLSearchParams(query);
    q.set("oidn", `oidn/${basename(a.oidnWeights)}`);
    query = q.toString();
  }
  const name = captureName(a.spike, query) + (a.oidnWeights ? "-oidn" : "");
  mkdirSync(a.out, { recursive: true });
  const png = join(a.out, `${name}.png`);
  const probePath = join(a.out, `${name}.json`);
  const t0 = Date.now();
  const run = await runElectron(
    [
      join(DESKTOP, "src/main.ts"),
      "--render-out",
      png,
      "--probe-out",
      probePath,
      "--page-path",
      page,
      "--query",
      query,
      "--ready",
      "__rwSpike",
      "--timeout-ms",
      String(a.timeoutMs),
      "--width",
      String(WIDTH),
      "--height",
      String(HEIGHT),
      "--web-root",
      WEB_DIST,
      "-ApplePersistenceIgnoreState",
      "YES",
    ],
    a.timeoutMs,
  );
  if (!existsSync(probePath)) {
    console.error(`${name}: no probe (electron exit ${String(run.code)})\n${run.err.slice(-3000)}`);
    return 2;
  }
  const result = JSON.parse(readFileSync(probePath, "utf8")) as { page: { status: string; error?: string; probe?: SpikeProbe }; console?: string[] };
  if (result.page.status !== "ready" || !result.page.probe) {
    console.error(`${name}: page ${result.page.status}: ${result.page.error ?? ""}\n${(result.console ?? []).join("\n")}`);
    return 1;
  }
  const probe = result.page.probe;
  const checks = { ...probe.checks, ...(existsSync(png) ? imageChecks(a.spike, decodePng(readFileSync(png)), probe.regions, query) : { capture: { value: null, pass: false } }) };
  const go = Object.values(checks).every((c) => c.pass);
  const report = { spike: a.spike, variant: probe.variant, verdict: go ? "GO" : "NO-GO", wallMs: Date.now() - t0, png, checks, timings: probe.timings, notes: probe.notes };
  writeFileSync(join(a.out, `${name}.report.json`), JSON.stringify(report, null, 2) + "\n");
  for (const [k, c] of Object.entries(checks)) console.log(`  ${c.pass ? "ok  " : "FAIL"} ${k} = ${JSON.stringify(c.value)}${c.note ? `  (${c.note})` : ""}`);
  console.log(`  timings ${JSON.stringify(probe.timings)}`);
  console.log(`${report.verdict} ${a.spike} [${probe.variant}] -> ${png}`);
  return go ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e: unknown) => {
      console.error(e);
      process.exitCode = 2;
    },
  );
}
