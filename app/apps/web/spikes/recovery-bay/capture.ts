/**
 * RL5 spike capture: renders the recovery-bay scene live (hidden Electron
 * window, WebGPU, DPR 1; `apps/desktop/src/main.ts --render-out`) in the
 * page-01 framing (viewport-sized, 892x733) and the `01-focus` close-up,
 * then composes them beside exemplar 01:
 *
 *   dist/spikes/recovery-bay/
 *     01.png, 01-focus.png, *.probe.json   raw captures and page probes
 *     full-side-by-side.png                exemplar viewport region | capture
 *     bay-side-by-side.png                 exemplar bay crop | capture bay crop
 *                                          exemplar inspector thumbnail | close-up
 *     ebay-side-by-side.png                exemplar electronics bay | capture
 *     report.json                          gate checks + probes
 *
 * Run `pnpm --filter @rw/web spike:recovery-bay` (builds rw-wasm-backed web
 * bundle first). Needs a GUI session (GPU). Exits 1 on any failed check.
 * Exemplars: `$RW_BAR_EXEMPLARS` or `artifacts/features/rocketwright/bar/visual`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { exemplarDir, REPO_ROOT } from "../../../../e2e/bar/paths.ts";
import { decodePng, encodePng, type Image } from "../../../../e2e/bar/png.ts";
import { crop, fit, frameRect, grid, resize, type Rect } from "./compose.ts";

/** Exemplar 01 regions (1536x1024 art). */
export const EXEMPLAR_01 = {
  viewport: { x: 262, y: 107, w: 892, h: 733 },
  bay: { x: 380, y: 240, w: 240, h: 180 },
  thumbnail: { x: 935, y: 162, w: 202, h: 107 },
  ebay: { x: 690, y: 520, w: 130, h: 100 },
} as const satisfies Record<string, Rect>;

const FRAMES = [
  { frame: "01", width: EXEMPLAR_01.viewport.w, height: EXEMPLAR_01.viewport.h },
  { frame: "01-focus", width: 960, height: 720 },
] as const;

interface Probe {
  backend: string;
  adapter: string;
  error: string | null;
  bayRect: Rect | null;
  ebayRect: Rect | null;
  labelsDisjoint: boolean;
  outlined: string[];
  detail: { id: string; builder: string; meshes: number; triangles: number }[];
  [k: string]: unknown;
}

function render(frame: string, width: number, height: number, out: string): Probe {
  const desktop = join(REPO_ROOT, "app/apps/desktop");
  const env = { ...process.env };
  delete env["ELECTRON_RUN_AS_NODE"];
  const probeOut = join(out, `${frame}.probe.json`);
  const r = spawnSync(
    join(desktop, "node_modules/.bin/electron"),
    ["src/main.ts", "-ApplePersistenceIgnoreState", "YES", "--render-out", join(out, `${frame}.png`), "--probe-out", probeOut, "--query", `mode=spike&spike=recovery-bay&frame=${frame}`, "--width", String(width), "--height", String(height)],
    { cwd: desktop, env, encoding: "utf8", timeout: 120_000 },
  );
  if (r.status !== 0) throw new Error(`render ${frame} failed (${r.status}): ${r.stderr.slice(-2000)}`);
  const res = JSON.parse(readFileSync(probeOut, "utf8")) as { page: { status: string; probe?: Probe; error?: string } };
  if (res.page.status !== "ready" || !res.page.probe) throw new Error(`render ${frame}: page ${res.page.status}: ${res.page.error ?? ""}`);
  return res.page.probe;
}

function main(): void {
  const out = resolve(process.env["RW_SPIKE_OUT"] ?? join(REPO_ROOT, "dist/spikes/recovery-bay"));
  mkdirSync(out, { recursive: true });
  const exemplar = decodePng(readFileSync(join(exemplarDir(), "01-assembly.png")));
  const probes: Record<string, Probe> = {};
  const shots: Record<string, Image> = {};
  for (const f of FRAMES) {
    probes[f.frame] = render(f.frame, f.width, f.height, out);
    shots[f.frame] = decodePng(readFileSync(join(out, `${f.frame}.png`)));
  }
  const full = shots["01"]!;
  const focus = shots["01-focus"]!;
  const p01 = probes["01"]!;
  const cell = { w: 960, h: 720 };

  writeFileSync(join(out, "full-side-by-side.png"), encodePng(grid([[crop(exemplar, EXEMPLAR_01.viewport), full]])));
  const bayOurs = p01.bayRect ? crop(full, frameRect(p01.bayRect, cell.w / cell.h, 0.35)) : full;
  writeFileSync(
    join(out, "bay-side-by-side.png"),
    encodePng(
      grid([
        [resize(crop(exemplar, EXEMPLAR_01.bay), cell.w, cell.h), fit(bayOurs, cell.w, cell.h)],
        [fit(crop(exemplar, EXEMPLAR_01.thumbnail), cell.w, cell.h), fit(focus, cell.w, cell.h)],
      ]),
    ),
  );
  const ebayOurs = p01.ebayRect ? crop(full, frameRect(p01.ebayRect, EXEMPLAR_01.ebay.w / EXEMPLAR_01.ebay.h, 0.35)) : full;
  writeFileSync(join(out, "ebay-side-by-side.png"), encodePng(grid([[fit(crop(exemplar, EXEMPLAR_01.ebay), 520, 400), fit(ebayOurs, 520, 400)]])));

  const checks = {
    webgpu: Object.values(probes).every((p) => p.backend === "webgpu" && p.error === null),
    labelsDisjoint: p01.labelsDisjoint,
    bayOutlined: p01.outlined.includes("recovery_bay"),
    bayDetailed: p01.detail.some((d) => d.id === "recovery_bay" && d.builder === "clear-bay"),
    chuteFolded: p01.detail.some((d) => d.builder === "folded-parachute"),
    electronics: p01.detail.some((d) => d.builder === "electronics-bay") && p01.detail.some((d) => d.builder === "flight-computer"),
  };
  const report = { out, checks, probes };
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(`${JSON.stringify({ out, checks }, null, 2)}\n`);
  if (!Object.values(checks).every(Boolean)) process.exit(1);
}

main();
