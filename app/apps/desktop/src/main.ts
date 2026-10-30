/**
 * Electron 44 main process (M1.52, R6.1). Serves the web bundle over
 * http://127.0.0.1 (never file://, which breaks the WASM fetch) and opens it.
 *
 * - `--project <dir>` (repeatable) or `--dev-project` (`make dev`: a copy of
 *   `fixtures/research-vehicle`, else an empty temp project) spawns the app
 *   server (`apps/server/src/rpc/cli.ts`, through `env -u
 *   ELECTRON_RUN_AS_NODE node`, `backend.ts`) and points the page at it: the
 *   query carries `rpc=`/`http=`, and the preload (`preload.ts`) exposes the
 *   same URLs as `window.rwDesktop` for navigations that drop the query.
 *   Main also holds its own RPC socket on the server (`mainRpc.ts`, D2): the
 *   open projects (`project.list`, then `project.opened` pushes) and, from B8,
 *   `embed.target` for the chat pane.
 * - `--render-out <png>`: the hidden render path (M1.9 spike;
 *   `rocketwright-render` grows from it): a `show:false` window at DPR 1, wait
 *   for the page's ready global, CDP capture, exit. Bar captures (`make
 *   bar-visual`, M1.19) reuse it with `--query page=01 --ready __rwShell
 *   --measure <module>`: the module's default export runs against the loaded
 *   page (a Playwright-style `evaluate`) before capture, and its result lands
 *   in the probe JSON as `measure`. With `--project` the capture runs against
 *   the live server. `--drive <module>` (M1.53 bar captures) runs first: its
 *   default export gets `{page, rpcUrl, serverUrl, guest}` and puts the page
 *   into a state (through the `app_*` broker hooks; `guest()` reads the
 *   mounted Lecturn pane, B13); its result lands as `drive`.
 * - `--page-path spikes/<x>.html`: load another HTML entry of the bundle
 *   instead of `index.html` (RL1 visual spikes, `app/e2e/capture/run.ts`).
 * - The agent pane (B10): when the page shows the Lecturn embed (its
 *   `EmbedPane` sends `mount` on `lecturn-embed:rw-host`), main mounts
 *   `@lecturn/embed/electron`'s view over the reported rect (`lecturn.ts`,
 *   `createPaneController`): the target comes from the child over main's
 *   RPC (`embed.target`, `embed.refreshToken`, D2), the theme from B11's
 *   `app/packages/ui/generated/lecturn-theme.json` (plus the host-only
 *   `lecturn-theme-host.json`), `switcher: false` (the rail lists threads),
 *   the page's composer placeholder and its `rw:` ref labels
 *   (`onDescribeRefs`, answered by the page). Overlays snapshot-and-hide it (D11); a
 *   `lecturn.status` live switch retargets it (D25). Hidden renders wait for
 *   the guest's `lecturn/ready` and composite it into the capture at its
 *   bounds (D15). The embed is the only agent pane (B17 removed the old
 *   chat and `RW_AGENT_PANE`). `--freeze-clock <epoch ms>` pins Date on
 *   both webContents before their `loadURL` (D15). The `--measure` module gets the embed's webContents as a
 *   second `PageLike` (`embed`, D31) once the guest is ready, and its
 *   `measureCapture` export runs on the composite PNG.
 * - `rocketwright://open?workspace=…&thread=…` (`protocol.ts`): packaged
 *   interactive runs (dev: `RW_REGISTER_PROTOCOL=1`) register the scheme and
 *   take the single-instance lock; a link opens the project (`project.open`)
 *   and then the thread in the pane. Hidden runs never do.
 * - `--hidden`: the same hidden window without a PNG (captures that only
 *   measure). `--smoke` (`make dev SMOKE=1`) = `--hidden --ready __rwShell
 *   --query page=01` plus a check that the header shows the opened project.
 *
 * Run with `env -u ELECTRON_RUN_AS_NODE electron src/main.ts [...]`; Electron
 * strips the types itself (Node 24 type stripping). No top-level await: it
 * deadlocks `app.whenReady()` in an ESM main.
 *
 * Packaged (`make package`, `packaged.ts`): this file is bundled to
 * `main.mjs` in place, the server runs bundled under Electron as Node with
 * the shipped `rocketwright`, and no `--project` opens a copy of the sample.
 */
import { mountEmbedView, captureEmbedView, type EmbedBridge, type EmbedTarget as HelperEmbedTarget } from "@lecturn/embed/electron";
import { embedThemeInput, PANE_MAIN_CHANNEL, type EmbedTarget, type LecturnHostThemeJson, type LecturnStatus, type LecturnThemeJson, type PaneMainMessage } from "@rw/contracts";
import { app, BrowserWindow, ipcMain, nativeImage, systemPreferences } from "electron";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { capturePageDpr1, countForeground, debuggerSessions, emulateDpr1, installFreezeClock, pngSize } from "./capture.ts";
import { waitGuestSized } from "./guestSize.ts";
import { captureComposite, createPaneController, droppedCapture, isGuestUrl, type EmbedBridgeLike, type MountArgs, type PaneController } from "./lecturn.ts";
import { connectMainRpc, type MainRpc } from "./mainRpc.ts";
import { buildPreload, desktopArg, lecturnBaseDirFor, parseDesktopArgs, REPO_ROOT, resolveDevProject, startBackend, userDataOverride, waitForHttp, type Backend, type DevProject } from "./backend.ts";
import { packagedLayout, packagedServerOptions, userArgv } from "./packaged.ts";
import { installProtocol, linkInArgv, linkQueue, openFromLink, parseOpenUrl } from "./protocol.ts";
import { once, shutdownOnQuit } from "./quit.ts";

const packaged = app.isPackaged ? packagedLayout(process.resourcesPath) : null;
const argv = userArgv(process.argv, process.defaultApp);
const { values: args } = parseArgs({
  args: argv,
  strict: false,
  options: {
    "web-root": { type: "string" },
    "render-out": { type: "string" },
    "probe-out": { type: "string" },
    width: { type: "string" },
    height: { type: "string" },
    "timeout-ms": { type: "string" },
    query: { type: "string" },
    ready: { type: "string" },
    measure: { type: "string" },
    drive: { type: "string" },
    "page-path": { type: "string" },
    "freeze-clock": { type: "string" },
  },
});

const desk = parseDesktopArgs(argv);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const webRoot = resolve(str(args["web-root"]) ?? resolve(import.meta.dirname, "../../web/dist"));
const width = Number(str(args.width) ?? 1536);
const height = Number(str(args.height) ?? 1024);
const timeoutMs = Number(str(args["timeout-ms"]) ?? 60_000);
const renderOut = str(args["render-out"]);
const probeOut = str(args["probe-out"]);
/** URL query of the hidden page (default: the viewport-only render mode). */
const query = str(args.query) ?? (desk.smoke ? `page=${desk.page ?? "01"}` : renderOut !== undefined || desk.hidden ? "mode=render" : desk.page !== undefined ? `page=${desk.page}` : "");
/** Window global the page publishes `{status}` on when ready. */
const readyGlobal = str(args.ready) ?? (desk.smoke ? "__rwShell" : "__rwProbe");
if (!/^[A-Za-z_$][\w$]*$/.test(readyGlobal)) throw new Error(`--ready: not an identifier: ${readyGlobal}`);
const measureModule = str(args.measure);
const driveModule = str(args.drive);
const pagePath = str(args["page-path"]);
const freezeClockArg = str(args["freeze-clock"]);
const freezeClock = freezeClockArg === undefined ? undefined : Number(freezeClockArg);
if (freezeClock !== undefined && !Number.isFinite(freezeClock)) throw new Error(`--freeze-clock: not an epoch ms: ${freezeClockArg}`);

/** The `page.evaluate` subset bar scripts use (`app/e2e/regions.ts` `PageLike`). */
interface PageLike {
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
}

function pageLike(win: BrowserWindow): PageLike {
  return {
    evaluate: async <R, A>(fn: (arg: A) => R | Promise<R>, arg: A) =>
      (await win.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(arg)})`, true)) as R,
  };
}

/**
 * The mounted pane's guest as a `PageLike` (D31: `measure-dom.ts`'s second
 * pass): Electron's own script execution in the guest's main frame, never a
 * second debugger. Null without a mounted, live guest.
 */
function embedPageLike(pane: PaneController | null): PageLike | null {
  const g = guestOf(pane);
  return g === null ? null : { evaluate: g.evaluate };
}

/**
 * Waits until the pane's guest is laid out at its bounds (CP-W1 r4, CPW2B;
 * `guestSize.ts`): a guest still laid out at an older rect is measured and
 * captured wrong, so the wait draws guest frames and re-applies the bounds
 * until its viewport matches, then fails naming both sizes. Null when it
 * matches; otherwise why not.
 */
function guestSized(pane: PaneController): Promise<string | null> {
  return waitGuestSized({
    bounds: () => pane.bounds,
    read: async () => {
      const g = guestOf(pane);
      return g === null ? null : g.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, doc: document.documentElement.scrollHeight }), null);
    },
    frame: async () => {
      await guestOf(pane)?.frame();
    },
    setBounds: (b) => {
      const m = pane.mounted;
      if (m !== null && !m.bridge.webContents.isDestroyed()) (m.bridge as unknown as EmbedBridge).setBounds(b);
    },
  });
}

/** A loaded `--measure` module: `run` (its default export) measures the page and the embed, `capture` (`measureCapture`) adds what needs the capture. */
interface MeasureModule {
  run: (page: PageLike, embed: PageLike | null) => Promise<unknown>;
  capture: ((report: unknown, png: Uint8Array) => unknown) | null;
}

/** Loads the `--measure` module (a computed specifier: it lives outside this package, in app/e2e). */
async function loadMeasure(path: string): Promise<MeasureModule> {
  const mod = (await import(pathToFileURL(resolve(path)).href)) as {
    default?: MeasureModule["run"];
    measureCapture?: (report: unknown, png: Uint8Array) => unknown;
  };
  if (typeof mod.default !== "function") throw new Error(`--measure ${path}: no default export function`);
  return { run: mod.default, capture: typeof mod.measureCapture === "function" ? mod.measureCapture : null };
}

/** The mounted pane's guest for a drive module (`app/e2e/capture/hooks.ts` `GuestLike`, B13). */
interface GuestLike {
  readonly generation: number;
  readonly ready: boolean;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  evaluateFrames<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R[]>;
  frame(): Promise<void>;
  reload(why: string): boolean;
}

/** What a `--drive` module gets: the page plus the live server's URLs (bar captures drive the `app_*` hooks over RPC), and the pane's guest. */
interface DriveContext {
  page: PageLike;
  rpcUrl: string | null;
  serverUrl: string | null;
  guest: () => GuestLike | null;
}

const callText = (fn: { toString(): string }, arg: unknown): string => `(${fn.toString()})(${JSON.stringify(arg)})`;

/**
 * The pane's guest, read with Electron's own script execution: the main
 * frame through its webContents, the MCP Apps card frames (sandboxed,
 * possibly out of process) through `mainFrame.framesInSubtree`. The guest's
 * one debugger stays the bridge's (D15).
 */
function guestOf(pane: PaneController | null): GuestLike | null {
  const m = pane?.mounted;
  if (m === null || m === undefined) return null;
  // The helper's bridge hands out the real guest webContents.
  const wc = m.bridge.webContents as unknown as Electron.WebContents;
  if (wc.isDestroyed()) return null;
  return {
    generation: m.bridge.generation,
    ready: m.ready,
    evaluate: async <R, A>(fn: (arg: A) => R | Promise<R>, arg: A) => (await wc.executeJavaScript(callText(fn, arg), true)) as R,
    evaluateFrames: async <R, A>(fn: (arg: A) => R | Promise<R>, arg: A) => {
      const out: R[] = [];
      for (const f of wc.mainFrame.framesInSubtree) {
        if (f === wc.mainFrame || f.detached) continue;
        try {
          out.push((await f.executeJavaScript(callText(fn, arg), true)) as R);
        } catch {
          /* a frame mid-navigation or gone */
        }
      }
      return out;
    },
    // The hidden window's view produces no frames on its own, so the guest's
    // requestAnimationFrame callbacks (Lecturn's timeline reveal) wait for one.
    // A capture draws one; a failed one (no surface yet) is the next poll's to retry.
    frame: async () => {
      await captureEmbedView(m.bridge as unknown as EmbedBridge).catch(() => undefined);
    },
    reload: (why) => pane?.reload(why) ?? false,
  };
}

/** Runs the `--drive` module's default export (puts the page into a state) before measure and capture. */
async function runDrive(path: string, win: BrowserWindow, backend: Backend, pane: PaneController | null): Promise<unknown> {
  const mod = (await import(pathToFileURL(resolve(path)).href)) as { default?: (ctx: DriveContext) => Promise<unknown> };
  if (typeof mod.default !== "function") throw new Error(`--drive ${path}: no default export function`);
  return mod.default({ page: pageLike(win), rpcUrl: backend.server?.rpcUrl ?? null, serverUrl: backend.server?.serverUrl ?? null, guest: () => guestOf(pane) });
}

type PageProbe = { status: "pending" } | { status: "ready"; probe: unknown } | { status: "error"; error: string };

async function waitForProbe(win: BrowserWindow): Promise<PageProbe> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = (await win.webContents.executeJavaScript(`window.${readyGlobal} ?? { status: 'pending' }`)) as PageProbe;
    if (p.status !== "pending") return p;
    if (Date.now() > deadline) return { status: "error", error: `timed out after ${timeoutMs} ms` };
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function writeOut(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

/** Polls the header until it names a live project (not "Opening…" / "No project"); null on timeout. */
async function waitForLiveProject(win: BrowserWindow, deadline: number): Promise<string | null> {
  for (;;) {
    const name = (await win.webContents.executeJavaScript(
      `document.querySelector('[data-testid="header.project-switcher"]')?.textContent?.trim() ?? ""`,
    )) as string;
    if (name !== "" && !/^(Opening…|No project)$/.test(name)) return name;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function webPreferences(preload: string | undefined, backend: Backend): Electron.WebPreferences {
  const prefs: Electron.WebPreferences = { backgroundThrottling: false, contextIsolation: true, sandbox: true };
  if (preload !== undefined) {
    prefs.preload = preload;
    const s = backend.server;
    prefs.additionalArguments = [desktopArg({ rpcUrl: s?.rpcUrl ?? null, serverUrl: s?.serverUrl ?? null })];
  }
  return prefs;
}

/** B11's generated theme (variables plus the `@font-face` data URLs) and its host-only variables, sent to the embed as is. */
const LECTURN_THEME_FILE = resolve(REPO_ROOT, "app/packages/ui/generated/lecturn-theme.json");
const LECTURN_HOST_THEME_FILE = resolve(REPO_ROOT, "app/packages/ui/generated/lecturn-theme-host.json");

function loadEmbedTheme(): ReturnType<typeof embedThemeInput> {
  const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
  return embedThemeInput(json<LecturnThemeJson>(LECTURN_THEME_FILE), json<LecturnHostThemeJson>(LECTURN_HOST_THEME_FILE));
}

/** `embed.target` (or `embed.refreshToken`) from the child, loopback only (D9). */
function checkedTarget(t: EmbedTarget): HelperEmbedTarget {
  if (!isGuestUrl(t.url)) throw new Error(`embed target is not a loopback URL: ${t.url}`);
  return t;
}

// The helper allows 1 s per guest capture attempt; a slow machine (a CI VM
// failed all three) needs longer. Only a failing capture waits the full time.
const GUEST_CAPTURE = { attempts: 4, attemptTimeoutMs: 5_000 } as const;

/**
 * The window's agent pane (B10): `mountEmbedView` with the child's targets
 * over main's RPC, keyed by each project's workspace root. Null without an
 * RPC client (no server: no pane).
 */
function startPane(win: BrowserWindow, rpc: MainRpc | null): PaneController | null {
  if (rpc === null) return null;
  const theme = loadEmbedTheme();
  const source = {
    embedTarget: async (projectId: string, threadId?: string) => checkedTarget(await rpc.call("embed.target", threadId === undefined ? { projectId } : { projectId, threadId })),
    refreshEmbedToken: async (projectId: string) => checkedTarget(await rpc.call("embed.refreshToken", { projectId })),
  };
  const mount = (a: MountArgs): EmbedBridgeLike =>
    mountEmbedView(win, {
      target: source,
      projectId: a.projectId,
      ...(a.threadId !== undefined ? { threadId: a.threadId } : {}),
      theme,
      bounds: a.bounds,
      switcher: false,
      ...(a.composerPlaceholder !== undefined ? { composerPlaceholder: a.composerPlaceholder } : {}),
      onDescribeRefs: a.onDescribeRefs,
      webPreferences: { backgroundThrottling: false },
      ...(freezeClock !== undefined ? { freezeClock } : {}),
    });
  return createPaneController({
    win,
    ipc: ipcMain,
    mount,
    workspaceRootOf: (projectId) => rpc.projects().find((p) => p.projectId === projectId)?.dir ?? null,
    // The bridge handed back is the helper's own object (`mount` above).
    capture: (b) => captureEmbedView(b as unknown as EmbedBridge, GUEST_CAPTURE),
    log: (line) => process.stderr.write(`${line}\n`),
  });
}

/** Attempts at opening the hidden window before giving up. */
const OPEN_ATTEMPTS = 4;

/**
 * Creates the hidden window at DPR 1 and loads the app, retrying with a fresh
 * window when a load fails. Under load, Electron 44 intermittently rejects the
 * very first navigation (`ERR_FAILED (-2) loading 'about:blank'`) before the
 * renderer is up; a new window then loads fine. The app origin is polled until
 * it answers before each attempt.
 */
async function openHiddenWindow(backend: Backend, preload: string | undefined, consoleLines: string[], deadline: number): Promise<BrowserWindow> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt++) {
    await waitForHttp(backend.url, deadline);
    const win = new BrowserWindow({ show: false, width, height, useContentSize: true, webPreferences: webPreferences(preload, backend) });
    win.webContents.on("console-message", (e) => consoleLines.push(`[${e.level}] ${e.message}`));
    win.webContents.on("preload-error", (_e, path, err) => consoleLines.push(`[preload-error] ${path}: ${err.message}`));
    try {
      // DPR 1 from the first frame, so the canvas renders at the capture size.
      // CDP commands before the first navigation crash Electron 44's main
      // process (SIGSEGV), so emulate on about:blank; the override persists.
      await win.loadURL("about:blank");
      await emulateDpr1(win.webContents, width, height);
      if (freezeClock !== undefined) await installFreezeClock(debuggerSessions.session(win.webContents), freezeClock);
      await win.loadURL(backend.url);
      return win;
    } catch (e) {
      lastError = e;
      process.stderr.write(`hidden window load failed (attempt ${attempt}/${OPEN_ATTEMPTS}): ${e instanceof Error ? e.message : String(e)}\n`);
      win.destroy();
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** The hidden window: load, wait for `readyGlobal`, optionally measure and capture (`out`), print the probe JSON. */
async function renderHidden(backend: Backend, preload: string | undefined, out: string | undefined, rpc: MainRpc | null, onPane: (pane: PaneController | null) => void): Promise<number> {
  app.dock?.hide();
  const deadline = Date.now() + timeoutMs;
  const consoleLines: string[] = [];
  const win = await openHiddenWindow(backend, preload, consoleLines, deadline);
  const pane = startPane(win, rpc);
  onPane(pane);
  const page = await waitForProbe(win);

  const result: Record<string, unknown> = {
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    url: win.webContents.getURL(),
    page,
  };
  if (backend.server !== null) result.server = { serverUrl: backend.server.serverUrl, rpcUrl: backend.server.rpcUrl };
  let code = page.status === "ready" ? 0 : 1;
  if (code === 0 && desk.smoke) {
    const project = await waitForLiveProject(win, deadline);
    // JSON drops `lecturn.onMessage`: a function cannot cross back from the page.
    result.desktop = await win.webContents.executeJavaScript("JSON.parse(JSON.stringify(window.rwDesktop ?? null))");
    result.project = project;
    if (project === null || backend.server === null) code = 1;
  }
  if (code === 0 && driveModule) {
    try {
      result.drive = (await runDrive(driveModule, win, backend, pane)) ?? null;
    } catch (e) {
      result.driveError = e instanceof Error ? (e.stack ?? e.message) : String(e);
      code = 1;
    }
  }
  // D15: a page that shows the embed is measured and captured only once its guest is ready.
  const wantsPane = page.status === "ready" && pane !== null && (out !== undefined || measureModule !== undefined) && ((await win.webContents.executeJavaScript(`document.querySelector('[data-testid="agent.embed"]') !== null`)) as boolean);
  if (wantsPane && pane !== null) {
    const ready = await pane.whenReady(Math.max(0, deadline - Date.now()));
    if (!ready) {
      result.lecturnError = "the agent pane's guest never sent lecturn/ready";
      code = 1;
    } else {
      // Bounded on its own (GUEST_SIZE_TIMEOUT_MS), not by what the drive left of the run's deadline.
      const unsized = await guestSized(pane);
      if (unsized !== null) {
        result.lecturnError = unsized;
        code = 1;
      }
    }
  }
  let measure: MeasureModule | null = null;
  if (code === 0 && measureModule) {
    try {
      measure = await loadMeasure(measureModule);
      // D31: the second pass reads the embed's webContents (null without a mounted pane).
      result.measure = await measure.run(pageLike(win), wantsPane ? embedPageLike(pane) : null);
    } catch (e) {
      result.measureError = e instanceof Error ? (e.stack ?? e.message) : String(e);
      code = 1;
    }
  }
  if (page.status === "ready" && out !== undefined && result.driveError === undefined) {
    let png = await capturePageDpr1(win.webContents, width, height);
    if (wantsPane && pane !== null && result.lecturnError === undefined) {
      // The guest at DPR 1 over the bridge's debuggerSession, blitted at its bounds (png.ts); dropped if its generation moved.
      const composite = await captureComposite(pane, () => capturePageDpr1(win.webContents, width, height));
      result.lecturn = composite.ok ? { bounds: composite.bounds, generation: pane.mounted?.bridge.generation ?? null } : { dropped: composite };
      if (composite.ok) png = Buffer.from(composite.png);
      else {
        result.lecturnError = droppedCapture(composite);
        code = 1;
      }
    }
    await writeOut(out, png);
    const bitmap = nativeImage.createFromBuffer(png).toBitmap();
    result.capture = { path: out, bytes: png.byteLength, ...pngSize(png), foreground: countForeground(bitmap) };
    // D31: the pane probes sample the composite.
    if (measure !== null && measure.capture !== null && result.measure !== undefined) {
      try {
        result.measure = measure.capture(result.measure, png);
      } catch (e) {
        result.measureError = e instanceof Error ? (e.stack ?? e.message) : String(e);
        code = 1;
      }
    }
  }
  if (code !== 0) result.console = consoleLines.slice(-50);
  const json = JSON.stringify(result, null, 2);
  if (probeOut) await writeOut(probeOut, json + "\n");
  process.stdout.write(json + "\n");
  pane?.destroy();
  win.destroy();
  return code;
}

async function main(): Promise<void> {
  const hidden = renderOut !== undefined || desk.hidden;
  // The profile is set first, before anything (the single-instance lock
  // included) touches userData (CPW2B).
  let tempUserData: string | undefined;
  if (hidden) {
    // A killed or crashed run makes macOS ask (modally, before "ready") whether
    // to reopen windows, which hangs a headless render. Spawners also pass
    // `-ApplePersistenceIgnoreState YES`; this covers direct launches.
    if (process.platform === "darwin") systemPreferences.registerDefaults({ ApplePersistenceIgnoreState: "YES" });
    // Isolated profile: never share or lock the user's Electron profile (removed on exit).
    tempUserData = await mkdtemp(join(tmpdir(), "rw-render-"));
    app.setPath("userData", tempUserData);
  } else {
    // Harness windows run on a temp profile (RW_USER_DATA_DIR, `app/e2e/lecturn-env.ts`):
    // nothing writes under the real Electron userData.
    const profile = userDataOverride();
    if (profile !== undefined) {
      mkdirSync(profile, { recursive: true });
      app.setPath("userData", profile);
    }
  }
  // rocketwright:// links (protocol.ts): a packaged interactive run (or a dev
  // run with RW_REGISTER_PROTOCOL=1) takes the single-instance lock, so a
  // second instance hands its link to this one and quits before starting a
  // server. Unpackaged dev and test runs register nothing, so no link can
  // reach them, and take no lock (parallel dev and e2e windows stay possible).
  const links = linkQueue();
  let focusWindow: (() => void) | null = null;
  if (!hidden && (app.isPackaged || process.env["RW_REGISTER_PROTOCOL"] === "1")) {
    const first = installProtocol({
      app,
      register: true,
      onOpen: (link) => links.push(link),
      focus: () => focusWindow?.(),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    if (!first) {
      process.stderr.write("RocketWright is already running; the link went to it\n");
      app.exit(0);
      return;
    }
    // Linux and Windows start a cold instance with the link in argv (macOS sends `open-url`).
    const cold = linkInArgv(process.argv);
    const link = cold === null ? null : parseOpenUrl(cold);
    if (link !== null) links.push(link);
  }
  // A packaged window with no --project opens the shipped sample, as `make dev` does.
  const sample = packaged !== null && !hidden;
  const dev: DevProject | null = desk.projects.length === 0 && (desk.devProject || sample) ? resolveDevProject(packaged?.samplesRoot) : null;
  if (dev !== null) process.stderr.write(`dev project (${dev.source}): ${dev.dir}\n`);
  const projects = dev !== null ? [dev.dir] : desk.projects;
  const live = projects.length > 0;
  // The preload only matters with a server; the spike render path stays preload-free.
  const scratch = live ? await mkdtemp(join(tmpdir(), "rw-desktop-")) : undefined;
  const preload = scratch !== undefined ? join(scratch, "preload.cjs") : undefined;
  if (preload !== undefined) await writeFile(preload, buildPreload());
  // Runs in the exit hook, so it must never throw: an uncaught error there
  // opens Electron's modal error box and the process never exits. Chromium
  // can still be writing the temp profile (ENOTEMPTY), hence the retries.
  const rmQuiet = (dir: string): void => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      process.stderr.write(`cleanup: ${dir}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  };
  const cleanupSync = (): void => {
    if (scratch !== undefined) rmQuiet(scratch);
    if (tempUserData !== undefined) rmQuiet(tempUserData);
    // Smoke runs own their temp project; interactive dev keeps it for inspection.
    if (dev !== null && hidden) rmQuiet(dev.dir);
  };

  await app.whenReady();
  // B8: the child connects to Lecturn with its sidecar in RW_LECTURN_BASE_DIR,
  // else <userData>/lecturn (hidden runs get a fresh temp userData above).
  // The arg names the dir the child really uses (CPW2B).
  const lecturnBaseDir = lecturnBaseDirFor(app.getPath("userData"));
  const backend = await startBackend({
    projects: live ? projects : null,
    webRoot,
    query,
    page: pagePath,
    lecturnBaseDir,
    log: (c) => process.stderr.write(c),
    ...(packaged !== null ? packagedServerOptions(packaged, process.execPath) : {}),
  });
  // Never orphan the server, even on a hard exit.
  process.once("exit", () => {
    backend.server?.child.kill("SIGKILL");
    cleanupSync();
  });
  // D2: main's own socket on the child; B8/B10 use it for `embed.target` and per-project mounts.
  let pane: PaneController | null = null;
  const mainRpc = await startMainRpc(backend, hidden, (status) => pane?.onStatus(status));
  const shutdown = once(async (code: number): Promise<void> => {
    pane?.destroy();
    mainRpc?.close();
    await backend.close();
    cleanupSync();
    app.exit(code);
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void shutdown(130));

  if (hidden) {
    let code = 1;
    try {
      code = await renderHidden(backend, preload, renderOut !== undefined ? resolve(renderOut) : undefined, mainRpc, (p) => (pane = p));
    } catch (e) {
      process.stderr.write(`render failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    }
    await shutdown(code);
    return;
  }
  backend.server?.child.once("exit", (c, sig) => process.stderr.write(`app server exited (${sig ?? c})\n`));
  const win = new BrowserWindow({ width, height, useContentSize: true, webPreferences: webPreferences(preload, backend) });
  pane = startPane(win, mainRpc);
  focusWindow = () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };
  if (freezeClock !== undefined) {
    await win.loadURL("about:blank");
    await installFreezeClock(debuggerSessions.session(win.webContents), freezeClock);
  }
  await win.loadURL(backend.url);
  app.on("window-all-closed", () => void shutdown(0));
  // app.quit() (Cmd+Q, Playwright's close) emits no window-all-closed: without this the exit hook SIGKILLs the server and orphans its sidecars (quit.ts).
  shutdownOnQuit(app, shutdown);
  const rpc = mainRpc;
  if (rpc !== null) {
    links.ready((link) => {
      void openFromLink(link, {
        openProject: async (dir) => (await rpc.call("project.open", { dir })).project,
        showProject: (projectId, threadId) => {
          const m: PaneMainMessage = threadId === undefined ? { type: "open-project", projectId } : { type: "open-project", projectId, threadId };
          if (!win.isDestroyed()) win.webContents.send(PANE_MAIN_CHANNEL, m);
        },
        openThread: (projectId, threadId) => pane?.openThread(projectId, threadId),
        log: (line) => process.stderr.write(`${line}\n`),
      });
    });
  }
}

/** Main's IF10 client on the child (null without a server, or if it cannot connect: the window still works). */
async function startMainRpc(backend: Backend, quiet: boolean, onLecturnStatus: (status: LecturnStatus) => void): Promise<MainRpc | null> {
  if (backend.server === null) return null;
  try {
    return await connectMainRpc(backend.server.rpcUrl, {
      onLecturnStatus,
      ...(quiet ? {} : { onProjectOpened: (p) => process.stderr.write(`project opened: ${p.projectId} (${p.dir})\n`) }),
    });
  } catch (e) {
    process.stderr.write(`main RPC client: ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  app.exit(1);
});
