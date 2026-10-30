/**
 * `rocketwright-render` (RL3): the Electron main of the headless 3D renderer.
 * `bin/rocketwright-render` runs it; `rw render --view iso|top|side|front|rear`
 * (`crates/rw-cli/src/render3d.rs`) spawns that with the IF8 `RenderRequest`
 * JSON on stdin and reads one reply line from stdout.
 *
 * It serves the built web bundle on http://127.0.0.1:<port 0> (never
 * file://, which breaks the WASM fetch), opens it in a hidden window at the
 * requested size and DPR 1 with `?mode=render&job=1`, and calls the page's
 * `window.__rwRunJob(request)` (`apps/web/src/render/job.ts`). The reply's
 * PNG is the final tone-mapped sRGB canvas output. Nothing is written to the
 * project: the Rust session writes `renders/` (I1).
 *
 * Flags: `--allow-software` accepts WebGL2 or a fallback adapter (I11; never
 * in gates). `--screen-out <png>` also writes a CDP screen capture of the
 * window after the job (the on-screen reference of the colour agreement
 * test). `--web-root <dir>` (default `apps/web/dist`, or `web/` in the packaged
 * kit app), `--timeout-ms <n>`.
 *
 * stdout carries exactly one JSON line; logs go to stderr. Exit 0 when the
 * reply is `ready`, 1 otherwise.
 */
import { app, BrowserWindow, systemPreferences } from "electron";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { capturePageDpr1, emulateDpr1 } from "./capture.ts";
import { parseRequest, type JobRequest } from "./render-request.ts";
import { serveStatic, type StaticServer } from "./serve.ts";

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  strict: false,
  options: {
    "allow-software": { type: "boolean" },
    "screen-out": { type: "string" },
    "web-root": { type: "string" },
    "timeout-ms": { type: "string" },
  },
});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
// Packaged (the B3 kit's electron-builder app, D20): the bundle ships as `web/` beside this file.
const defaultWebRoot = app.isPackaged ? join(app.getAppPath(), "web") : resolve(import.meta.dirname, "../../web/dist");
const webRoot = resolve(str(args["web-root"]) ?? defaultWebRoot);
const timeoutMs = Number(str(args["timeout-ms"]) ?? 45_000);
const allowSoftware = args["allow-software"] === true;
const screenOut = str(args["screen-out"]);

type Reply = { status: "ready" | "error"; error?: string; [k: string]: unknown };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(typeof c === "string" ? Buffer.from(c) : (c as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** Writes the reply line; resolves once flushed (stdout is an async pipe, and `app.exit` does not wait). */
function reply(r: Reply): Promise<void> {
  return new Promise((done) => process.stdout.write(JSON.stringify(r) + "\n", () => done()));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForJobHost(win: BrowserWindow, deadline: number): Promise<void> {
  for (;;) {
    if ((await win.webContents.executeJavaScript("typeof window.__rwRunJob === 'function'")) === true) return;
    if (Date.now() > deadline) throw new Error("the render page did not start (is the web bundle built?)");
    await sleep(20);
  }
}

async function render(request: JobRequest, server: StaticServer, t0: number): Promise<Reply> {
  const deadline = t0 + timeoutMs;
  const { width, height } = request;
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  const consoleLines: string[] = [];
  win.webContents.on("console-message", (e) => consoleLines.push(`[${e.level}] ${e.message}`));
  try {
    // CDP before the first navigation crashes Electron 44's main process, so emulate on about:blank (the override persists).
    await win.loadURL("about:blank");
    await emulateDpr1(win.webContents, width, height);
    await win.loadURL(`${server.origin}/?mode=render&job=1`);
    await waitForJobHost(win, deadline);
    const tPage = Date.now() - t0;
    const job = win.webContents.executeJavaScript(`window.__rwRunJob(${JSON.stringify(request)}, ${JSON.stringify({ allowSoftware })})`) as Promise<Reply>;
    const r = await Promise.race([job, sleep(Math.max(1, deadline - Date.now())).then((): Reply => ({ status: "error", error: `timed out after ${timeoutMs} ms` }))]);
    const timings = (r["timings_ms"] as Record<string, number> | undefined) ?? {};
    r["timings_ms"] = { ...timings, page_ready: tPage, total: Date.now() - t0 };
    if (r.status === "ready" && screenOut !== undefined) {
      // Two frames so the compositor shows the canvas frame the job read back.
      await win.webContents.executeJavaScript("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(0))))");
      const png = await capturePageDpr1(win.webContents, width, height);
      await mkdir(dirname(resolve(screenOut)), { recursive: true });
      await writeFile(resolve(screenOut), png);
      r["screen_out"] = resolve(screenOut);
    }
    if (r.status !== "ready") process.stderr.write(consoleLines.slice(-30).join("\n") + "\n");
    return r;
  } finally {
    win.destroy();
  }
}

async function main(): Promise<number> {
  const t0 = Date.now();
  let request: JobRequest;
  try {
    request = parseRequest(await readStdin());
  } catch (e) {
    await reply({ status: "error", error: e instanceof Error ? e.message : String(e) });
    return 1;
  }
  if (!existsSync(join(webRoot, "index.html"))) {
    await reply({ status: "error", error: `no web bundle at ${webRoot} (run make wasm and pnpm --dir app --filter @rw/web build)` });
    return 1;
  }
  // A killed run makes macOS ask (modally, before "ready") whether to reopen windows.
  if (process.platform === "darwin") systemPreferences.registerDefaults({ ApplePersistenceIgnoreState: "YES" });
  // Isolated profile: never share or lock the user's Electron profile.
  const profile = await mkdtemp(join(tmpdir(), "rw-render-"));
  app.setPath("userData", profile);
  process.once("exit", () => rmSync(profile, { recursive: true, force: true }));
  await app.whenReady();
  app.dock?.hide();
  const server = await serveStatic(webRoot);
  try {
    const r = await render(request, server, t0);
    await reply(r);
    return r.status === "ready" ? 0 : 1;
  } catch (e) {
    await reply({ status: "error", error: e instanceof Error ? e.message : String(e) });
    return 1;
  } finally {
    await server.close();
  }
}

// Electron would quit on the last window closing before the reply is out.
app.on("window-all-closed", () => undefined);
main().then(
  (code) => app.exit(code),
  (e: unknown) => {
    void reply({ status: "error", error: e instanceof Error ? (e.stack ?? e.message) : String(e) }).then(() => app.exit(1));
  },
);
