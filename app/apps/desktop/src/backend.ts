/**
 * Desktop backend (M1.52, R6.1), Electron-free so plain Node runs and tests it:
 *
 * - `spawnServer`: the app server (`apps/server/src/rpc/cli.ts`) as a child
 *   started through `env -u ELECTRON_RUN_AS_NODE node …`, parsed for its
 *   `RW_SERVER_URL=` / `RW_RPC_URL=` (and optional `RW_LIVE_MCP_URL=`) lines;
 * - `startBackend`: that server plus the web bundle on http://127.0.0.1:<port 0>
 *   (`serve.ts`; never file://, which breaks the WASM fetch);
 * - `resolveDevProject`: what `make dev` opens (a copy of
 *   `fixtures/research-vehicle`, or an empty temp project until it lands);
 * - `buildPreload`: `preload.ts` with its types stripped, as the CommonJS
 *   script a sandboxed Electron preload must be;
 * - browser mode: `node src/backend.ts --browser [--project <dir> | --dev-project]
 *   [--open] [--smoke]` serves the app for an ordinary browser against the
 *   local server.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { serveStatic } from "./serve.ts";

const here = import.meta.dirname;
/** The rocketwright repo root (`app/apps/desktop/src` → four levels up). */
export const REPO_ROOT = resolve(here, "../../../..");
export const SERVER_CLI = resolve(REPO_ROOT, "app/apps/server/src/rpc/cli.ts");
export const WEB_DIST = resolve(REPO_ROOT, "app/apps/web/dist");
export const PRELOAD_SRC = resolve(here, "preload.ts");
/** Additional-argument prefix carrying the preload's JSON config. */
export const DESKTOP_ARG = "--rw-desktop=";

/** What `window.rwDesktop` exposes to the web bundle (see `preload.ts`). */
export interface DesktopConfig {
  rpcUrl: string | null;
  serverUrl: string | null;
}

/**
 * `process.env` as strings, minus `ELECTRON_RUN_AS_NODE` (it turns Electron
 * into plain Node). The app server gets this env, so neither it nor the
 * Lecturn sidecar it starts (B8, `apps/server/src/lecturn/connection.ts`)
 * inherits the variable: the helper sets `ELECTRON_RUN_AS_NODE=1` on the
 * Lecturn server process alone, and only when that process is Electron run
 * as Node (D3). `LECTURN_HOME`, `RW_LECTURN_BASE_DIR` and
 * `LECTURN_TEST_PROVIDERS` pass through.
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, ...extra };
}

/**
 * The run's Electron profile (CPW2B): `RW_USER_DATA_DIR` when set (every
 * harness launch sets a temp one, `app/e2e/lecturn-env.ts`), else undefined
 * (Electron's default `userData`). Hidden runs use a fresh temp profile
 * whatever this says.
 */
export function userDataOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = env.RW_USER_DATA_DIR;
  return dir === undefined || dir === "" ? undefined : resolve(dir);
}

/**
 * The Lecturn sidecar base dir main passes as `--lecturn-base-dir`:
 * `RW_LECTURN_BASE_DIR` when set (the server takes it too, so its args and
 * env agree), else `<userData>/lecturn`.
 */
export function lecturnBaseDirFor(userData: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.RW_LECTURN_BASE_DIR;
  return dir === undefined || dir === "" ? join(userData, "lecturn") : resolve(dir);
}

/** What the server announces on stdout. */
export interface ServerUrls {
  serverUrl: string;
  rpcUrl: string;
  /**
   * `RW_LIVE_MCP_URL=`: the window-tools-only live MCP endpoint main hands to
   * Lecturn (`setLiveTools`, D2/D20), or null when the server has none. The
   * line is optional; the server writes it before `RW_RPC_URL=` in the same
   * write, since parsing completes once the two required lines are in.
   */
  liveMcpUrl: string | null;
}

/** The server's announced URLs, once both required lines are complete (newline-terminated) in `text`. */
export function parseServerUrls(text: string): ServerUrls | null {
  const serverUrl = /^RW_SERVER_URL=(\S+)\r?\n/m.exec(text)?.[1];
  const rpcUrl = /^RW_RPC_URL=(\S+)\r?\n/m.exec(text)?.[1];
  const liveMcpUrl = /^RW_LIVE_MCP_URL=(\S+)\r?\n/m.exec(text)?.[1] ?? null;
  return serverUrl !== undefined && rpcUrl !== undefined ? { serverUrl, rpcUrl, liveMcpUrl } : null;
}

/**
 * `rocketwright` for the server: `$RW_SIDECAR_BIN`, else the workspace's plain
 * (no `doubles`) build at `<target>/rw-plain/rocketwright` (`make bin-plain`,
 * `make dev`), else PATH (undefined). Never `<target>/debug/rocketwright`: cargo
 * writes the `doubles` test build there too, and that one serves fixtures.
 */
export function defaultSidecarBin(env: NodeJS.ProcessEnv = process.env, repoRoot = REPO_ROOT): string | undefined {
  if (env.RW_SIDECAR_BIN) return env.RW_SIDECAR_BIN;
  const target = env.CARGO_TARGET_DIR ? resolve(repoRoot, env.CARGO_TARGET_DIR) : join(repoRoot, "target");
  const bin = join(target, "rw-plain", process.platform === "win32" ? "rocketwright.exe" : "rocketwright");
  return existsSync(bin) ? bin : undefined;
}

export interface ServerHandle extends ServerUrls {
  child: ChildProcess;
  /** SIGTERM (the server stops its sidecars), then SIGKILL after `graceMs`. */
  stop(graceMs?: number): Promise<void>;
}

export interface SpawnServerOptions {
  projects?: string[];
  /** Server entry (default `SERVER_CLI`). */
  cli?: string;
  /** Node binary (default `$RW_NODE`, else `node` on PATH; Electron's own binary only with `runAsNode`). */
  node?: string;
  /**
   * `node` is Electron (the packaged app, which has no `node` on PATH): run it
   * as Node with `ELECTRON_RUN_AS_NODE=1` instead of unsetting the variable.
   */
  runAsNode?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Rejects if the URLs are not announced in time (default 120 s: opening projects starts sidecars). */
  timeoutMs?: number;
  /** Where the server's stderr and post-announcement stdout go (default: our stderr). */
  log?: (chunk: string) => void;
  /**
   * The Lecturn sidecar's default base dir (main: `<userData>/lecturn`),
   * passed as `--lecturn-base-dir`; `RW_LECTURN_BASE_DIR` in the env wins in
   * the server. Without either the server runs without Lecturn.
   */
  lecturnBaseDir?: string;
}

/** Command and args that run `node <cli> …` with `ELECTRON_RUN_AS_NODE` unset (or, with `runAsNode`, set by the env instead). */
export function serverCommand(node: string, cli: string, projects: readonly string[], lecturnBaseDir?: string, runAsNode = false): { cmd: string; args: string[] } {
  const nodeArgs = [cli, ...projects.flatMap((p) => ["--project", resolve(p)]), ...(lecturnBaseDir === undefined ? [] : ["--lecturn-base-dir", resolve(lecturnBaseDir)])];
  if (process.platform === "win32" || runAsNode) return { cmd: node, args: nodeArgs };
  return { cmd: "env", args: ["-u", "ELECTRON_RUN_AS_NODE", node, ...nodeArgs] };
}

export function spawnServer(opts: SpawnServerOptions = {}): Promise<ServerHandle> {
  const log = opts.log ?? ((c: string) => process.stderr.write(c));
  const env = opts.env ?? process.env;
  const extra: Record<string, string> = {};
  const bin = defaultSidecarBin(env);
  if (bin !== undefined) extra.RW_SIDECAR_BIN = bin;
  if (opts.runAsNode === true) extra.ELECTRON_RUN_AS_NODE = "1";
  const { cmd, args } = serverCommand(opts.node ?? (env.RW_NODE || "node"), opts.cli ?? SERVER_CLI, opts.projects ?? [], opts.lecturnBaseDir, opts.runAsNode);
  const child = spawn(cmd, args, { env: childEnv(env, extra), stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const stop = async (graceMs = 10_000): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
    await exited;
    clearTimeout(timer);
  };
  return new Promise((ok, fail) => {
    let out = "";
    let err = "";
    let announced = false;
    const timer = setTimeout(() => {
      void stop(1000);
      fail(new Error(`server did not announce its URLs within ${opts.timeoutMs ?? 120_000} ms\n${err.slice(-2000)}`));
    }, opts.timeoutMs ?? 120_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => {
      if (!announced) err += c;
      log(c);
    });
    child.stdout?.on("data", (c: string) => {
      if (announced) return log(c);
      out += c;
      const urls = parseServerUrls(out);
      if (urls === null) return;
      announced = true;
      clearTimeout(timer);
      ok({ ...urls, child, stop });
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (!announced) fail(new Error(`server exited (${signal ?? code}) before announcing its URLs\n${err.slice(-2000)}`));
    });
  });
}

/**
 * The app page URL: `index.html?…&rpc=…&http=…#token=…` (the query wins over the preload's config in the web entry).
 * The RPC token moves from the socket URL into the fragment, which the browser never sends to a server.
 * `page` is another HTML entry of the bundle (`spikes/<x>.html`, RL1); it must stay relative and inside the root.
 */
export function appUrl(origin: string, urls: { rpcUrl: string; serverUrl: string } | null, query = "", page = "index.html"): string {
  if (!/^[\w-]+(\/[\w-]+)*\.html$/.test(page)) throw new Error(`appUrl: not a relative .html page: ${page}`);
  const params = new URLSearchParams(query);
  let token: string | null = null;
  if (urls !== null) {
    const rpc = new URL(urls.rpcUrl);
    token = rpc.searchParams.get("token");
    rpc.searchParams.delete("token");
    params.set("rpc", rpc.toString());
    params.set("http", urls.serverUrl);
  }
  const q = params.toString();
  return `${origin}/${page}${q === "" ? "" : `?${q}`}${token === null || token === "" ? "" : `#token=${encodeURIComponent(token)}`}`;
}

/** The Electron additional argument carrying the preload config. */
export function desktopArg(config: DesktopConfig): string {
  return DESKTOP_ARG + encodeURIComponent(JSON.stringify(config));
}

/** `preload.ts` as a CommonJS script (sandboxed preloads cannot be ESM or TypeScript). */
export function buildPreload(src = PRELOAD_SRC): string {
  return stripTypeScriptTypes(readFileSync(src, "utf8"), { mode: "strip" });
}

export interface DevProject {
  dir: string;
  /** Where it came from: a fixture copy, or an empty temp project. */
  source: "fixture" | "empty";
  /** True if `dir` is a temp directory this call created. */
  temp: boolean;
}

/** A directory holds a project if it has a `*.toml` at its top level. */
export function isProjectDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).some((f) => f.endsWith(".toml"));
  } catch {
    return false;
  }
}

/**
 * The `make dev` project: a fresh copy of `fixtures/research-vehicle` (so dev
 * edits never touch the committed fixture), or an empty temp project if the
 * fixture is not there yet. Temp dirs live under `/tmp`: the sidecar's Unix
 * socket path (`<dir>/.rw/sidecar.sock`) is limited to ~104 bytes on macOS.
 */
export function resolveDevProject(repoRoot = REPO_ROOT, tmpRoot = "/tmp"): DevProject {
  const fixture = join(repoRoot, "fixtures/research-vehicle");
  const dir = mkdtempSync(join(tmpRoot, "rw-dev-"));
  if (!isProjectDir(fixture)) return { dir, source: "empty", temp: true };
  // Never copy runtime state (`.rw/`: socket, lock, threads) from a fixture someone opened in place.
  cpSync(fixture, dir, { recursive: true, filter: (src) => !src.split(/[\\/]/).includes(".rw") });
  return { dir, source: "fixture", temp: true };
}

export interface Backend {
  /** Static web origin, http://127.0.0.1:<port>. */
  origin: string;
  server: ServerHandle | null;
  url: string;
  close(): Promise<void>;
}

/** The app server (when `projects` is non-null) plus the static web bundle. */
export async function startBackend(
  opts: { projects: string[] | null; webRoot?: string; query?: string; page?: string | undefined } & Omit<SpawnServerOptions, "projects">,
): Promise<Backend> {
  const { projects, webRoot, query, page, ...spawnOpts } = opts;
  const server = projects === null ? null : await spawnServer({ ...spawnOpts, projects });
  let web;
  try {
    web = await serveStatic(webRoot ?? WEB_DIST);
  } catch (e) {
    await server?.stop();
    throw e;
  }
  return {
    origin: web.origin,
    server,
    url: appUrl(web.origin, server, query, page),
    close: async () => {
      await Promise.all([web.close(), server?.stop()]);
    },
  };
}

/** Polls `url` until the server answers (any HTTP status), so the window never loads a dead origin. */
export async function waitForHttp(url: string, deadline: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  let last: unknown;
  for (;;) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
      await res.body?.cancel();
      return;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`${url}: not answering: ${last instanceof Error ? last.message : String(last)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Browser-mode smoke: the page is served, and the RPC socket says hello and
 * lists exactly the projects we opened. Returns the hello and the project ids.
 */
export async function smokeBrowser(b: Backend, timeoutMs = 30_000): Promise<{ hello: Record<string, unknown>; projects: string[] }> {
  const page = await fetch(b.url);
  if (page.status !== 200 || !(page.headers.get("content-type") ?? "").startsWith("text/html")) {
    throw new Error(`GET ${b.url}: ${page.status} ${page.headers.get("content-type") ?? ""}`);
  }
  if (b.server === null) throw new Error("no app server");
  const ws = new WebSocket(b.server.rpcUrl);
  const frames: Record<string, unknown>[] = [];
  const next = (pred: (f: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> =>
    new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`RPC smoke timed out; frames: ${JSON.stringify(frames).slice(0, 500)}`)), timeoutMs);
      const check = (): boolean => {
        const f = frames.find(pred);
        if (f === undefined) return false;
        clearTimeout(timer);
        ok(f);
        return true;
      };
      if (check()) return;
      ws.addEventListener("message", () => void check());
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        fail(new Error(`RPC socket error at ${b.server?.rpcUrl ?? ""}`));
      });
    });
  ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data)) as Record<string, unknown>));
  try {
    const hello = await next((f) => f.kind === "hello");
    ws.send(JSON.stringify({ kind: "request", id: 1, method: "project.list", params: {} }));
    const res = await next((f) => f.kind === "response" && f.id === 1);
    const result = res.result as { projects?: { projectId: string }[] } | undefined;
    if (res.ok !== true || result?.projects === undefined) throw new Error(`project.list failed: ${JSON.stringify(res)}`);
    return { hello, projects: result.projects.map((p) => p.projectId) };
  } finally {
    ws.close();
  }
}

/** Shared desktop / browser-mode CLI flags. */
export interface DesktopArgs {
  projects: string[];
  devProject: boolean;
  browser: boolean;
  open: boolean;
  smoke: boolean;
  hidden: boolean;
  page: string | undefined;
}

export function parseDesktopArgs(argv: string[]): DesktopArgs & { rest: Record<string, string | boolean | (string | boolean)[] | undefined> } {
  const { values } = parseArgs({
    args: argv,
    strict: false,
    options: {
      project: { type: "string", multiple: true },
      "dev-project": { type: "boolean" },
      browser: { type: "boolean" },
      open: { type: "boolean" },
      smoke: { type: "boolean" },
      hidden: { type: "boolean" },
      page: { type: "string" },
    },
  });
  const projects = (Array.isArray(values.project) ? values.project : []).filter((p): p is string => typeof p === "string");
  return {
    projects,
    devProject: values["dev-project"] === true,
    browser: values.browser === true,
    open: values.open === true,
    smoke: values.smoke === true,
    hidden: values.hidden === true || values.smoke === true,
    page: typeof values.page === "string" ? values.page : undefined,
    rest: values,
  };
}

/** Browser mode: serve, print `RW_APP_URL=…`, optionally open it; `--smoke` checks and exits. */
async function browserMain(argv: string[]): Promise<number> {
  const a = parseDesktopArgs(argv);
  const dev = a.projects.length === 0 && a.devProject ? resolveDevProject() : null;
  const projects = dev !== null ? [dev.dir] : a.projects;
  if (dev !== null) process.stderr.write(`dev project (${dev.source}): ${dev.dir}\n`);
  const b = await startBackend({ projects, query: a.page !== undefined ? `page=${a.page}` : "" });
  process.stdout.write(`RW_APP_URL=${b.url}\n`);
  const cleanup = async (): Promise<void> => {
    await b.close();
    if (dev !== null && a.smoke) rmSync(dev.dir, { recursive: true, force: true });
  };
  if (a.smoke) {
    try {
      const r = await smokeBrowser(b);
      const ok = r.projects.length === projects.length;
      process.stdout.write(`${JSON.stringify({ mode: "browser", ok, url: b.url, rpc: r.hello.rpc, coreVersion: r.hello.coreVersion, projects: r.projects })}\n`);
      return ok ? 0 : 1;
    } finally {
      await cleanup();
    }
  }
  if (a.open) spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [b.url], { stdio: "ignore", detached: true }).unref();
  await new Promise<void>((r) => {
    process.once("SIGINT", r);
    process.once("SIGTERM", r);
  });
  await cleanup();
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  browserMain(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exit(1);
    },
  );
}
