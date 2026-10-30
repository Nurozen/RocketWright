/**
 * M1.9 GPU gate (R1.3, I11): the hidden Electron 44 window renders the rw-wasm
 * tube with three r186 on a real WebGPU adapter, and the CDP DPR-1 capture is
 * a 1536x1024 PNG (checked with `sips`). Needs `make wasm` and the web build;
 * `pnpm test:gpu` does both. Fails on WebGL2 fallback or a fallback adapter.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WIDTH = 1536;
const HEIGHT = 1024;
const here = import.meta.dirname;

interface RenderResult {
  page: {
    status: string;
    error?: string;
    probe?: {
      isWebGPUBackend: boolean;
      adapter: { vendor: string; architecture: string; isFallbackAdapter: boolean | null };
      rt: { nonZero: number; objectPixels: number };
      canvas: { width: number; height: number; devicePixelRatio: number };
    };
  };
  capture?: { path: string; width: number; height: number; foreground: number };
  console?: string[];
}

function runElectron(args: string[], timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
  const electron = createRequire(import.meta.url)("electron") as unknown as string;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // this shell exports it; Electron would run as Node
  return new Promise((done, fail) => {
    const child = spawn(electron, [resolve(here, "main.ts"), ...args, "-ApplePersistenceIgnoreState", "YES"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", fail);
    child.on("exit", (code) => {
      clearTimeout(timer);
      done({ code, out, err });
    });
  });
}

function sipsSize(png: string): { width: number; height: number } {
  const text = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", png], { encoding: "utf8" });
  const num = (key: string) => Number(new RegExp(`${key}:\\s*(\\d+)`).exec(text)?.[1]);
  return { width: num("pixelWidth"), height: num("pixelHeight") };
}

describe("hidden-window WebGPU render (M1.9)", () => {
  it("renders the rw-wasm tube on WebGPU and captures 1536x1024 at DPR 1", async () => {
    const outDir = process.env.RW_GPU_OUT_DIR ? resolve(process.env.RW_GPU_OUT_DIR) : mkdtempSync(join(tmpdir(), "rw-gpu-"));
    mkdirSync(outDir, { recursive: true });
    const png = join(outDir, "m1-9-tube.png");
    const probeJson = join(outDir, "m1-9-probe.json");
    const run = await runElectron(
      ["--render-out", png, "--probe-out", probeJson, "--width", String(WIDTH), "--height", String(HEIGHT)],
      90_000,
    );
    expect(run.code, `electron exited ${run.code}\n${run.err.slice(-2000)}`).toBe(0);

    const result = JSON.parse(readFileSync(probeJson, "utf8")) as RenderResult;
    expect(result.page.status, result.page.error ?? "").toBe("ready");
    const probe = result.page.probe;
    if (!probe) throw new Error("no probe");
    // I11: real WebGPU, never three's silent WebGL2 fallback or a software adapter.
    expect(probe.isWebGPUBackend).toBe(true);
    expect(probe.adapter.isFallbackAdapter).toBe(false);
    expect(probe.adapter.vendor).not.toMatch(/swiftshader|google/i);
    // Linear render-target readback is non-zero and the tube covers pixels.
    expect(probe.rt.nonZero).toBeGreaterThan(0);
    expect(probe.rt.objectPixels).toBeGreaterThan(100);
    expect(probe.canvas).toMatchObject({ width: WIDTH, height: HEIGHT, devicePixelRatio: 1 });

    expect(result.capture).toMatchObject({ width: WIDTH, height: HEIGHT });
    expect(result.capture?.foreground ?? 0).toBeGreaterThan(1000);
    expect(sipsSize(png)).toEqual({ width: WIDTH, height: HEIGHT });
    console.log(`m1.9 capture: ${png}`);
  });
});
