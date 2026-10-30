/**
 * RL3 GPU gate (`make test-gpu`; a logged-in GUI session): `rocketwright
 * render <tube> --view iso --json` spawns the real `bin/rocketwright-render`
 * and returns a PNG in < 5 s on WebGPU (never WebGL2 or a fallback adapter,
 * I11); every preset view renders; and the exported PNG agrees in colour with
 * the on-screen canvas (a CDP capture of the same window): sampled flat
 * patches within ΔE2000 ≤ 2, so the export is the final tone-mapped sRGB
 * output, not a linear render-target readback. M3.5: `--view section` of the
 * research vehicle shows a cut face (the check scheme's blue-violet cap hatch,
 * mask test), and `--view exploded` pulls the parts apart.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { deltaE } from "../../../e2e/bar/color.ts";
import { decodePng, type Image } from "../../../e2e/bar/png.ts";
import { isCapPixel } from "../../web/src/render/recipes.ts";

const repo = resolve(import.meta.dirname, "../../../..");
const renderer = join(repo, "bin/rocketwright-render");
const targetDir = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(repo, "target");
const rwBin = process.env.RW_BIN ? resolve(process.env.RW_BIN) : join(targetDir, "debug/rocketwright");

const TUBE_TOML = [
  'name = "Tube"',
  "[c.nose]",
  'type = "nose_cone"',
  'shape = "ogive"',
  'length = "160 mm"',
  'od = "54 mm"',
  "[c.body]",
  'type = "body_tube"',
  'attach = { to = "nose.base" }',
  'length = "600 mm"',
  'od = "54 mm"',
  'id = "50 mm"',
  "",
].join("\n");

function tubeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "rw-rl3-"));
  writeFileSync(join(dir, "rocketwright.toml"), 'format = 1\nname = "Tube"\n');
  writeFileSync(join(dir, "rocket.rw.toml"), TUBE_TOML);
  return dir;
}

interface RenderOut {
  path: string;
  png_sha256: string;
  width: number;
  height: number;
  backend: string;
  adapter?: string;
  camera: { orthographic: boolean };
}

function rwRender(project: string, args: string[], env: Record<string, string> = {}): { out: RenderOut; ms: number } {
  const t = performance.now();
  const r = spawnSync(rwBin, ["--project", project, "render", ...args, "--json"], {
    encoding: "utf8",
    env: { ...process.env, RW_RENDER: renderer, ...env },
    timeout: 60_000,
  });
  const ms = performance.now() - t;
  if (r.status !== 0) throw new Error(`rw render ${args.join(" ")} exited ${r.status}: ${r.stdout}\n${r.stderr.slice(-3000)}`);
  return { out: JSON.parse(r.stdout) as RenderOut, ms };
}

/** Mean sRGB colour and the largest per-channel spread of a `size`x`size` patch at (x, y). */
function patch(img: Image, x: number, y: number, size: number): { rgb: [number, number, number]; spread: number } {
  const sum = [0, 0, 0];
  const lo = [255, 255, 255];
  const hi = [0, 0, 0];
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const o = ((y + j) * img.width + (x + i)) * 4;
      for (let k = 0; k < 3; k++) {
        const v = img.data[o + k] ?? 0;
        sum[k]! += v;
        lo[k] = Math.min(lo[k]!, v);
        hi[k] = Math.max(hi[k]!, v);
      }
    }
  const n = size * size;
  return { rgb: [sum[0]! / n, sum[1]! / n, sum[2]! / n], spread: Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) };
}

beforeAll(() => {
  // The CLI under test (debug build; `RW_BIN` overrides).
  if (!process.env.RW_BIN) {
    const cargo = existsSync(join(homedir(), ".cargo/bin/cargo")) ? join(homedir(), ".cargo/bin/cargo") : "cargo";
    execFileSync(cargo, ["build", "-q", "-p", "rw-cli", "--bin", "rocketwright"], {
      cwd: repo,
      stdio: "inherit",
      env: { ...process.env, CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0" },
    });
  }
  expect(existsSync(rwBin), rwBin).toBe(true);
  expect(existsSync(join(repo, "app/apps/web/dist/index.html")), "web bundle (pnpm --filter @rw/web build)").toBe(true);
}, 600_000);

describe("rocketwright-render (RL3)", () => {
  it("renders a tube iso view to a PNG in under 5 s on WebGPU", () => {
    const project = tubeProject();
    // One warm-up launch: the 5 s budget is for a render, not the OS's first scan of a fresh Electron binary.
    rwRender(project, ["--view", "side", "--imgsize", "64x64"]);
    const { out, ms } = rwRender(project, ["--view", "iso"]);
    console.log(`rl3 iso render: ${ms.toFixed(0)} ms, ${out.adapter}`);
    expect(ms).toBeLessThan(5000);
    expect(out.backend).toBe("webgpu");
    expect(out.adapter ?? "").not.toMatch(/swiftshader|fallback/i);
    expect(out).toMatchObject({ path: "renders/default.iso.png", width: 1536, height: 1024 });
    const png = readFileSync(join(project, out.path));
    const img = decodePng(png);
    expect([img.width, img.height]).toEqual([1536, 1024]);
    // The tube covers a good part of the frame (not a blank or background-only canvas).
    const bg = patch(img, 0, 0, 4).rgb;
    let fg = 0;
    for (let i = 0; i < img.data.length; i += 4) if (deltaE([img.data[i]!, img.data[i + 1]!, img.data[i + 2]!], bg) > 5) fg++;
    expect(fg).toBeGreaterThan(20_000);
  });

  it("renders every preset view with flat check materials", () => {
    const project = tubeProject();
    const shas = new Set<string>();
    for (const view of ["iso", "top", "side", "front", "rear"]) {
      const { out } = rwRender(project, ["--view", view, "--imgsize", "480x320"]);
      expect(out.backend).toBe("webgpu");
      expect(out.camera.orthographic).toBe(true);
      expect(out).toMatchObject({ path: `renders/default.${view}.png`, width: 480, height: 320 });
      expect(decodePng(readFileSync(join(project, out.path))).width).toBe(480);
      shas.add(out.png_sha256);
    }
    // top and side of an axisymmetric tube may coincide; the rest differ.
    expect(shas.size).toBeGreaterThanOrEqual(4);
    const manifest = JSON.parse(readFileSync(join(project, "renders/manifest.json"), "utf8")) as { renders: Record<string, unknown> };
    expect(Object.keys(manifest.renders).sort()).toEqual(["front", "iso", "rear", "side", "top"].map((v) => `renders/default.${v}.png`));
  });

  it("renders the research vehicle cut open (section, mask test) and exploded (M3.5)", () => {
    const project = mkdtempSync(join(tmpdir(), "rw-m35-"));
    cpSync(join(repo, "fixtures/research-vehicle"), project, { recursive: true });
    const keep = join(repo, ".playwright/m3/headless");
    mkdirSync(keep, { recursive: true });
    const capCount = (img: Image) => {
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) if (isCapPixel(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!)) n++;
      return n;
    };
    const fgCount = (img: Image) => {
      const bg = patch(img, 0, 0, 4).rgb;
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) if (deltaE([img.data[i]!, img.data[i + 1]!, img.data[i + 2]!], bg) > 5) n++;
      return n;
    };
    const shots: Record<string, { img: Image; sha: string }> = {};
    for (const view of ["iso", "section", "exploded"]) {
      const { out, ms } = rwRender(project, ["--view", view, "--imgsize", "960x640"]);
      console.log(`m3.5 ${view}: ${ms.toFixed(0)} ms`);
      expect(out.backend).toBe("webgpu");
      expect(out.path).toMatch(new RegExp(`^renders/[^/]+\\.${view}\\.png$`));
      const png = readFileSync(join(project, out.path));
      writeFileSync(join(keep, `research-vehicle.${view}.png`), png);
      shots[view] = { img: decodePng(png), sha: out.png_sha256 };
    }
    const cut = capCount(shots["section"]!.img);
    console.log(`m3.5 cut-face pixels: section ${cut}, iso ${capCount(shots["iso"]!.img)}, exploded ${capCount(shots["exploded"]!.img)}`);
    // The section shows a cut face; the uncut views have none of the cap colour.
    expect(cut).toBeGreaterThan(1500);
    expect(capCount(shots["iso"]!.img)).toBeLessThan(50);
    expect(capCount(shots["exploded"]!.img)).toBeLessThan(50);
    // Exploded (default factor 1) differs from iso and, framed over a longer layout, draws each part smaller.
    expect(shots["exploded"]!.sha).not.toBe(shots["iso"]!.sha);
    expect(fgCount(shots["exploded"]!.img)).toBeLessThan(fgCount(shots["iso"]!.img));
    const manifest = JSON.parse(readFileSync(join(project, "renders/manifest.json"), "utf8")) as { renders: Record<string, { view: string }> };
    expect(Object.values(manifest.renders).map((r) => r.view).sort()).toEqual(["exploded", "iso", "section"]);
  });

  it("exported PNG agrees with the on-screen canvas (ΔE2000 <= 2)", () => {
    // fixtures/simple: flat fins and the tube give large flat patches.
    const project = mkdtempSync(join(tmpdir(), "rw-rl3-simple-"));
    cpSync(join(repo, "fixtures/simple"), project, { recursive: true });
    const out = mkdtempSync(join(tmpdir(), "rw-rl3-screen-"));
    const screen = join(out, "screen.png");
    // A renderer wrapper that also captures the window on screen after the job.
    const wrapper = join(out, "rocketwright-render");
    writeFileSync(wrapper, `#!/bin/sh\nexec "${renderer}" --screen-out "${screen}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    const { out: r } = rwRender(project, ["--view", "iso", "--imgsize", "960x640", "--scheme", "check"], { RW_RENDER: wrapper });
    const exported = decodePng(readFileSync(join(project, r.path)));
    const onScreen = decodePng(readFileSync(screen));
    expect([onScreen.width, onScreen.height]).toEqual([exported.width, exported.height]);

    const size = 6;
    const bg = patch(exported, 0, 0, size).rgb;
    let model = 0;
    let background = 0;
    let worst = 0;
    for (let y = 2; y + size < exported.height; y += 12)
      for (let x = 2; x + size < exported.width; x += 12) {
        const a = patch(exported, x, y, size);
        // Flat patches only: edges are antialiased and shift by a pixel between paths.
        if (a.spread > 6) continue;
        const b = patch(onScreen, x, y, size);
        worst = Math.max(worst, deltaE(a.rgb, b.rgb));
        if (deltaE(a.rgb, bg) > 5) model++;
        else background++;
      }
    console.log(`rl3 colour agreement: ${model} model + ${background} background patches, worst ΔE2000 ${worst.toFixed(3)}`);
    expect(model).toBeGreaterThan(40);
    expect(background).toBeGreaterThan(30);
    expect(worst).toBeLessThanOrEqual(2);
  });
});
