/**
 * Playwright global setup (plan M1.53b: the e2e run on the live sidecar over
 * the seeded research vehicle, never contract JSON):
 * - the `rocketwright` sidecar (`RW_SIDECAR_BIN`, inherited by the Electron
 *   specs and their app servers);
 * - one pristine seeded project (`fixtures/research-vehicle/seed.sh`) that
 *   specs copy (`RW_E2E_SEEDED`);
 * - the app server on a copy of it, port 0 (`RW_E2E_RPC_URL`, `RW_E2E_HTTP_URL`),
 *   and the built web bundle served by `vite preview` (`RW_E2E_WEB_URL`);
 * - Lecturn isolation (B8): `LECTURN_HOME` and `RW_LECTURN_BASE_DIR` (temp
 *   dirs unless `make e2e` already set them; never ~/.lecturn) and
 *   `LECTURN_TEST_PROVIDERS=1` (Lecturn's scripted provider), inherited by the
 *   app servers and Electron specs.
 * - The agent pane is the Lecturn embed (B10; B17 removed the old chat):
 *   the app server connects Lecturn's sidecar in the temp dirs above, and
 *   the pages mount the embed (an iframe in the plain-web specs).
 * Returns the teardown.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnServer } from "../apps/desktop/src/backend.ts";
import { SEEDED_ENV, seedTemp, seededCopy, sidecarBinary } from "./live.ts";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "../apps/web");
const vite = join(web, "node_modules/vite/bin/vite.js");

function waitForUrl(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((ok, fail) => {
    let out = "";
    const timer = setTimeout(() => fail(new Error(`vite preview: no URL after ${timeoutMs} ms\n${out}`)), timeoutMs);
    const on = (b: Buffer) => {
      out += b.toString();
      // oxlint-disable-next-line no-control-regex -- strips ANSI colour codes (ESC [ ... m)
      const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out.replace(/\x1b\[[0-9;]*m/g, ""));
      if (m) {
        clearTimeout(timer);
        ok(m[1]!);
      }
    };
    child.stdout?.on("data", on);
    child.stderr?.on("data", on);
    child.on("exit", (code) => fail(new Error(`vite preview exited ${code}\n${out}`)));
  });
}

/** Sets `name` to a fresh temp dir unless it is set; returns the dir to remove on teardown, if made here. */
function tempEnvDir(name: string, prefix: string): string | null {
  if (process.env[name]) return null;
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env[name] = dir;
  return dir;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const lecturnDirs = [tempEnvDir("LECTURN_HOME", "rw-e2e-lecturn-home-"), tempEnvDir("RW_LECTURN_BASE_DIR", "rw-e2e-lecturn-base-")].filter((d): d is string => d !== null);
  process.env["LECTURN_TEST_PROVIDERS"] = "1";
  const bin = sidecarBinary();
  process.env["RW_SIDECAR_BIN"] = bin;
  const pristine = seedTemp(bin, "rw-e2e-seed-");
  process.env[SEEDED_ENV] = pristine;
  const project = seededCopy(bin, "rw-e2e-web-project-");

  const outDir = mkdtempSync(join(tmpdir(), "rw-e2e-web-"));
  const build = spawnSync(process.execPath, [vite, "build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "warn"], { cwd: web, encoding: "utf8", env: process.env });
  if (build.status !== 0) throw new Error(`vite build failed\n${build.stdout}\n${build.stderr}`);
  const preview = spawn(process.execPath, [vite, "preview", "--outDir", outDir, "--port", "0", "--host", "127.0.0.1"], { cwd: web, stdio: ["ignore", "pipe", "pipe"] });
  const webUrl = await waitForUrl(preview, 30_000);
  const env = { ...process.env };
  delete env["RW_TEST_HOOKS"];
  const server = await spawnServer({ projects: [project], env, log: () => {} });
  process.env["RW_E2E_WEB_URL"] = webUrl;
  process.env["RW_E2E_RPC_URL"] = server.rpcUrl;
  process.env["RW_E2E_HTTP_URL"] = server.serverUrl;
  process.env["RW_E2E_PROJECT"] = project;
  return async () => {
    preview.kill();
    await server.stop();
    rmSync(outDir, { recursive: true, force: true });
    rmSync(dirname(project), { recursive: true, force: true });
    rmSync(dirname(pristine), { recursive: true, force: true });
    for (const d of lecturnDirs) rmSync(d, { recursive: true, force: true });
  };
}
