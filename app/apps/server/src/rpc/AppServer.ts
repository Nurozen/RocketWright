/**
 * The app server (R6.1): one HTTP listener on 127.0.0.1 (port 0 by default)
 * serving
 *
 * - `ws://…/rpc`: IF10 WebSocket RPC (`@rw/contracts` `rpc.ts`): a `hello`
 *   frame, then exactly one response per request, plus pushes on
 *   subscriptions;
 * - `/mcp/live`: the live tools Lecturn calls (B9, D20): the broker tools
 *   only, one static bearer leased with `setLiveTools`, each call routed by
 *   `realpath(_meta["lecturn/context"].workspaceRoot)` to the open project;
 * - `GET /api/projects/:projectId/runs/:sim/:runId/series.csv` (G §4.2) and
 *   `.../events.json` (the run's flight events, for the plots' event lines), and
  *   `.../engine.json` (an engine run's record: provenance, design, samples),
  *   `.../visual.json` (a visual flow study's timeline, provenance visual), and
  *   `.../cfd.json` (an imported CFD dataset's record: provenance, columns).
 *
 * The RPC socket needs the per-launch secret (`rpcToken`, a `token=` query
 * parameter on the upgrade; `rpcUrl` carries it). The desktop hands it to the
 * renderer through the preload, browser mode through the page URL's fragment
 * (`#token=`, never sent to a server). A browser `Origin`, when present, must
 * also be the app's own (`allowedOrigin`); a missing `Origin` (a local
 * non-browser client) is accepted only with the token.
 *
 * One `ProjectHost` (sidecar, mirror, jobs) per open project. The agent is
 * Lecturn's (B17 removed the old chat engine and its `thread.*` and
 * `approval.*` methods). Test hooks
 * (`test.call`) exist only with `RW_TEST_HOOKS=1` (I12).
 *
 * Lecturn (B8, `lecturn/connection.ts`): with a `lecturn` link, every opened
 * project is registered as a Lecturn workspace by realpath (D13), the
 * `embed.*` methods answer from it, and its status and thread lists go out as
 * `lecturn.status` / `embed.threads` pushes (also sent to each new socket
 * right after `hello`).
 */
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import {
  RPC_METHODS,
  RPC_PATH,
  RPC_VERSION,
  SCHEMA_VERSION,
  TEST_HOOK_OPS,
  type BrokerArgs,
  type BrokerCapabilities,
  type BrokerOp,
  type BrokerResponse,
  type JsonObject,
  type ProjectInfo,
  type RpcMethod,
  type RpcResult,
  type RpcTopic,
  type RpcTopics,
  type SeedBundleArgs,
  type ServerFrame,
} from "@rw/contracts";
import { acceptUpgrade } from "@rw/contracts/ws";
import { BundleError, bundleThreadIds, completeRunIds, instantiateBundle, linkThreadSteps, parseThreadBundle } from "../lecturn/bundle.ts";
import { workspaceRootOf, type LecturnLink, type LecturnLinkEvents } from "../lecturn/connection.ts";
import { RW_APP_ID } from "../lecturn/registration.ts";
import { BrokerArgsError, ViewportBroker } from "../broker/ViewportBroker.ts";
import { LIVE_MCP_PATH, createLiveMcpRequestHandler } from "../mcp/http.ts";
import { LiveToolsBearer } from "../mcp/session-registry.ts";
import { ProjectHost } from "../project/ProjectHost.ts";
import { ThumbCacheError } from "../project/ThumbCache.ts";
import { sidecarBinary, sidecarEnv } from "../sidecar/SidecarClient.ts";
import type { BackoffOptions, SidecarConnection } from "../sidecar/SidecarSupervisor.ts";
import { RpcFail, toRpcError } from "./errors.ts";
import { isObject, libraryQuery, optBool, optStr, patchOps, str, thrustcurveFetchQuery, thrustcurveSearchQuery } from "./params.ts";

/** Lecturn `apps.updateHostContext` caps the text at 4 KB. */
const HOST_CONTEXT_MAX_BYTES = 4096;

export interface AppServerOptions {
  host?: string;
  /** 0 (default) picks a free port; the bound port is in `url`. */
  port?: number;
  /** Accept `test.call` (default: `RW_TEST_HOOKS=1`). */
  testHooks?: boolean;
  /** `hello.coreVersion`; default: `rocketwright --version` of the sidecar binary. */
  coreVersion?: string;
  bin?: string;
  stderr?: "inherit" | "ignore" | "pipe";
  backoff?: BackoffOptions;
  jobPollMs?: number;
  /** How long a broker op waits for `broker.respond` (default 10 s). */
  brokerTimeoutMs?: number;
  /** Sidecar connection factory (tests). */
  connect?: () => SidecarConnection;
  /** The RPC upgrade secret (default: 32 random bytes, base64url, per launch). */
  rpcToken?: string;
  /**
   * Builds the Lecturn link (B8; `createLecturnLink` in `cli.ts`). Null or
   * absent: no Lecturn, and the `embed.*` methods answer `internal`.
   */
  lecturn?: (events: LecturnLinkEvents) => LecturnLink | null;
  /** Diagnostics (default: stderr). */
  log?: (line: string) => void;
}

interface Conn {
  id: number;
  /** Passed the token (and Origin) check on the upgrade; only such sockets are ever in `conns`. */
  authed: boolean;
  send(frame: ServerFrame): void;
  close(): void;
  subs: Set<string>;
}

type Sub = { conn: Conn; projectId: string; kind: "project" };

type Handler<M extends RpcMethod> = (conn: Conn, params: JsonObject, after: (fn: () => void) => void) => RpcResult<M> | Promise<RpcResult<M>>;

/** `rocketwright --version` → `0.1.0`; `unknown` if it cannot run. */
export function probeCoreVersion(bin?: string): Promise<string> {
  return new Promise((ok) => {
    execFile(sidecarBinary(bin), ["--version"], { env: sidecarEnv(), timeout: 10_000 }, (err, stdout) => {
      const m = /(\d+\.\d+\.\d+\S*)/.exec(String(stdout));
      ok(err === null && m?.[1] !== undefined ? m[1] : "unknown");
    });
  });
}

/**
 * Whether a browser `Origin` is one of the app's own pages (localhost or
 * `app://`). A missing or empty Origin is not (it proves nothing); the RPC
 * upgrade accepts that case only with the token.
 */
export function allowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === "" || origin === "null") return false;
  if (origin.startsWith("app://")) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

const RUN_FILE_RE = /^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/([^/]+)\/(series\.csv|events\.json|engine\.json|visual\.json|cfd\.json)$/;
const RUN_FILE_TYPE: Record<string, string> = { "series.csv": "text/csv; charset=utf-8", "events.json": "application/json", "engine.json": "application/json", "visual.json": "application/json", "cfd.json": "application/json" };
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** `realpath`, or `path` itself when it cannot be resolved. */
function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Constant-time comparison of a presented RPC token with the expected one. */
export function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null || presented === "") return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class AppServer {
  readonly testHooks: boolean;
  readonly coreVersion: string;
  /** The per-launch RPC upgrade secret (see the module doc). */
  readonly rpcToken: string;
  /** Agent viewport tools and test hooks, forwarded to the web host over `broker.*`. */
  readonly broker: ViewportBroker;
  /** The live route's static bearer (B9), leased to Lecturn with the URL. */
  readonly liveBearer = new LiveToolsBearer();
  private readonly opts: AppServerOptions;
  private readonly http: Server;
  private readonly projects = new Map<string, ProjectHost>();
  private readonly opening = new Map<string, Promise<ProjectHost>>();
  /** Project ids of projects still starting. */
  private readonly reserved = new Set<string>();
  private readonly conns = new Set<Conn>();
  private readonly subs = new Map<string, Sub>();
  private port = 0;
  private counter = 0;
  /** The Lecturn link (null without one). */
  readonly lecturn: LecturnLink | null;
  private readonly log: (line: string) => void;
  private readonly liveHandler: (req: IncomingMessage, res: ServerResponse) => void;

  private constructor(opts: AppServerOptions, coreVersion: string) {
    this.opts = opts;
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.lecturn =
      opts.lecturn?.({
        status: (status) => this.broadcast("lecturn.status", status),
        threads: (projectId, threads) => this.broadcast("embed.threads", { projectId, threads }),
        log: this.log,
      }) ?? null;
    this.testHooks = opts.testHooks ?? process.env.RW_TEST_HOOKS === "1";
    this.broker = new ViewportBroker({ testHooks: this.testHooks, log: this.log, ...(opts.brokerTimeoutMs === undefined ? {} : { timeoutMs: opts.brokerTimeoutMs }) });
    this.coreVersion = coreVersion;
    this.rpcToken = opts.rpcToken ?? randomBytes(32).toString("base64url");
    this.liveHandler = createLiveMcpRequestHandler({ broker: this.broker, bearer: this.liveBearer, projectOf: (root) => this.projectForWorkspaceRoot(root) });
    this.http = createServer((req, res) => this.request(req, res));
    this.http.on("upgrade", (req: IncomingMessage, socket: Duplex) => this.upgrade(req, socket));
  }

  static async start(opts: AppServerOptions = {}): Promise<AppServer> {
    const s = new AppServer(opts, opts.coreVersion ?? (await probeCoreVersion(opts.bin)));
    await new Promise<void>((ok, fail) => {
      s.http.once("error", fail);
      s.http.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => ok());
    });
    s.port = (s.http.address() as AddressInfo).port;
    // Connects in the background; `embed.*` calls wait for it. The live tools
    // are leased once connected (B9); the helper keeps the lease beating.
    void s.lecturn?.start();
    s.lecturn?.publishLiveTools({ url: s.liveMcpUrl, bearer: s.liveBearer.token }).catch((e: unknown) => s.log(`lecturn: setLiveTools: ${e instanceof Error ? e.message : String(e)}`));
    return s;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The RPC socket URL with the token (`?token=`); hand it only to the app's own windows and drivers. */
  get rpcUrl(): string {
    return `ws://127.0.0.1:${this.port}${RPC_PATH}?token=${encodeURIComponent(this.rpcToken)}`;
  }

  /** `http://127.0.0.1:<port>/mcp/live` (B9). */
  get liveMcpUrl(): string {
    return `${this.url}${LIVE_MCP_PATH}`;
  }

  /** The open project whose directory's realpath is `workspaceRoot` (live routing, B9; D13). */
  projectForWorkspaceRoot(workspaceRoot: string): string | undefined {
    for (const p of this.projects.values()) if (realpathOr(p.info.dir) === workspaceRoot) return p.info.projectId;
    return undefined;
  }

  /** An open project's host. */
  project(projectId: string): ProjectHost {
    const p = this.projects.get(projectId);
    if (p === undefined) throw new RpcFail("not_found", `no project ${projectId}`);
    return p;
  }

  listProjects(): ProjectInfo[] {
    return [...this.projects.values()].map((p) => ({ ...p.info }));
  }

  /** Opens (or returns) the project at `dir` (any spelling of it: compared by realpath, D13), spawning its sidecar. */
  async openProject(dir: string): Promise<ProjectInfo> {
    const abs = resolve(dir);
    const real = realpathOr(abs);
    for (const p of this.projects.values()) if (p.info.dir === abs || realpathOr(p.info.dir) === real) return { ...p.info };
    let pending = this.opening.get(abs);
    if (pending === undefined) {
      pending = this.spawnProject(abs);
      this.opening.set(abs, pending);
      pending.then(
        () => this.opening.delete(abs),
        () => this.opening.delete(abs),
      );
    }
    return { ...(await pending).info };
  }

  async closeProject(projectId: string): Promise<void> {
    const p = this.project(projectId);
    this.projects.delete(projectId);
    this.lecturn?.removeProject(projectId);
    for (const [id, s] of [...this.subs]) if (s.projectId === projectId) this.dropSub(id);
    this.broker.dropProject(projectId);
    await p.close();
  }

  /** Sends a broker op to the project's registered viewport host (IF11). */
  requestBroker<O extends BrokerOp>(projectId: string, op: O, args: BrokerArgs[O], threadId: string | null): Promise<BrokerResponse<O>> {
    return this.broker.request(projectId, op, args, threadId);
  }

  async close(): Promise<void> {
    for (const c of [...this.conns]) c.close();
    await Promise.all([...this.projects.keys()].map((id) => this.closeProject(id).catch(() => undefined)));
    await Promise.all([...this.opening.values()].map((p) => p.then((h) => h.close()).catch(() => undefined)));
    await this.lecturn?.close().catch(() => undefined);
    await new Promise<void>((ok) => {
      this.http.closeAllConnections();
      this.http.close(() => ok());
    });
  }

  // ---- projects ----

  private async spawnProject(dir: string): Promise<ProjectHost> {
    let st;
    try {
      st = statSync(dir);
    } catch {
      throw new RpcFail("not_found", `no such directory ${dir}`);
    }
    if (!st.isDirectory()) throw new RpcFail("invalid_params", `${dir} is not a directory`);
    const base = basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
    let projectId = base;
    for (let n = 2; this.projects.has(projectId) || this.reserved.has(projectId); n++) projectId = `${base}-${n}`;
    this.reserved.add(projectId);
    const info: ProjectInfo = { projectId, dir, name: basename(dir) };
    const host = new ProjectHost(
      {
        info,
        ...(this.opts.bin === undefined ? {} : { bin: this.opts.bin }),
        ...(this.opts.stderr === undefined ? {} : { stderr: this.opts.stderr }),
        ...(this.opts.backoff === undefined ? {} : { backoff: this.opts.backoff }),
        ...(this.opts.jobPollMs === undefined ? {} : { jobPollMs: this.opts.jobPollMs }),
        ...(this.opts.connect === undefined ? {} : { connect: this.opts.connect }),
        broker: this.broker,
        ...(this.testHooks && this.lecturn !== null ? { seedBundle: (args: SeedBundleArgs) => this.seedLecturnBundle(info, args) } : {}),
      },
      {
        patch: (patch) => {
          for (const [subscriptionId, s] of this.subs) {
            if (s.kind === "project" && s.projectId === projectId) this.push(s.conn, "project.patch", { subscriptionId, patch });
          }
        },
      },
    );
    try {
      await host.start();
    } catch (e) {
      await host.close().catch(() => undefined);
      throw new RpcFail("sidecar_unavailable", `sidecar failed to start for ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.reserved.delete(projectId);
    }
    this.projects.set(projectId, host);
    // Electron main's socket (D2) learns every opened project from this push.
    this.broadcast("project.opened", { project: { ...info } });
    // D13: its Lecturn workspace is the realpath; `embed.*` calls wait for it.
    this.lecturn?.addProject(info).catch((e: unknown) => this.log(`lecturn: ensureWorkspace for ${dir}: ${e instanceof Error ? e.message : String(e)}`));
    return host;
  }

  // ---- HTTP ----

  private request(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === LIVE_MCP_PATH) return this.liveHandler(req, res);
    const m = RUN_FILE_RE.exec(path);
    if (m !== null && req.method === "GET") return this.runFile(req, res, m[1]!, m[2]!, m[3]!, m[4]!);
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }

  /**
   * Run series and events for the plots. The web bundle is served from another
   * local origin (the desktop's static server, `vite preview`), so the app's own
   * origins (`allowedOrigin`) get a CORS grant; any other page gets none.
   */
  private runFile(req: IncomingMessage, res: ServerResponse, projectId: string, sim: string, runId: string, name: string): void {
    const p = this.projects.get(decodeURIComponent(projectId));
    const segs = [decodeURIComponent(sim), decodeURIComponent(runId)];
    if (p === undefined || !segs.every((s) => SAFE_SEGMENT.test(s) && s !== "." && s !== "..")) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const file = join(p.info.dir, "runs", segs[0]!, segs[1]!, name);
    if (!existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const origin = req.headers.origin;
    const cors: Record<string, string> = origin !== undefined && origin !== "" && allowedOrigin(origin) ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
    res.writeHead(200, { "content-type": RUN_FILE_TYPE[name]!, "cache-control": "no-store", ...cors });
    createReadStream(file).pipe(res);
  }

  // ---- WebSocket RPC ----

  private upgrade(req: IncomingMessage, socket: Duplex): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (url.pathname !== RPC_PATH || !["127.0.0.1", "localhost", "[::1]"].includes(host)) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!tokenMatches(url.searchParams.get("token"), this.rpcToken)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    // A browser page (it always sends Origin) must be the app's own, even with the token.
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigin(origin)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const conn: Conn = { id: ++this.counter, authed: true, send: () => undefined, close: () => undefined, subs: new Set() };
    const ws = acceptUpgrade(req, socket, () => ({
      message: (text) => void this.receive(conn, text),
      close: () => this.disconnect(conn),
    }));
    if (ws === null) return;
    conn.send = (f) => ws.send(JSON.stringify(f));
    conn.close = () => ws.close(1001, "server closing");
    this.conns.add(conn);
    conn.send({ kind: "hello", rpc: RPC_VERSION, schema: SCHEMA_VERSION, coreVersion: this.coreVersion, testHooks: this.testHooks });
    if (this.lecturn !== null) {
      this.push(conn, "lecturn.status", this.lecturn.status);
      for (const list of this.lecturn.threadLists()) this.push(conn, "embed.threads", list);
    }
  }

  /**
   * `app_seed_thread` with a Lecturn bundle (B13, RW_TEST_HOOKS only): the
   * bundle for this project (its realpath and name, timestamps at `now`,
   * `{runId:<sim>}` as the sim's complete run, B14, and each thread's step
   * links in its appData for the pane strip's thread history),
   * imported through the link; resolves with the imported threads' ids in
   * bundle order once the project's thread list shows them.
   */
  private async seedLecturnBundle(info: ProjectInfo, args: SeedBundleArgs): Promise<string[]> {
    const link = this.lecturnFor("app_seed_thread");
    let bundle;
    try {
      const runIds = completeRunIds(this.projects.get(info.projectId)?.snapshot().runs.runs ?? []);
      bundle = linkThreadSteps(instantiateBundle(parseThreadBundle(args.bundle), { workspaceRoot: workspaceRootOf(info.dir), projectName: info.name, runIds, ...(args.now === undefined ? {} : { now: args.now }) }));
    } catch (e) {
      if (e instanceof BundleError) throw new BrokerArgsError(`app_seed_thread: ${e.message}`);
      throw e;
    }
    if (bundle.appId !== RW_APP_ID) throw new BrokerArgsError(`app_seed_thread: the bundle belongs to ${bundle.appId}, not ${RW_APP_ID}`);
    if (bundle.projects.length !== 1) throw new BrokerArgsError("app_seed_thread: a fixture bundle holds exactly one project");
    await link.importThreads(info.projectId, bundle);
    return link.waitForThreads(info.projectId, bundleThreadIds(bundle));
  }

  /** The Lecturn link, or `internal` when there is none. */
  private lecturnFor(method: string): LecturnLink {
    if (this.lecturn === null) throw new RpcFail("internal", `${method}: Lecturn is not configured`);
    return this.lecturn;
  }

  /** Runs a Lecturn call, reporting its failure as `internal`. */
  private async viaLecturn<T>(method: string, fn: (link: LecturnLink) => Promise<T>): Promise<T> {
    const link = this.lecturnFor(method);
    try {
      return await fn(link);
    } catch (e) {
      if (e instanceof RpcFail) throw e;
      throw new RpcFail("internal", `${method}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private disconnect(conn: Conn): void {
    if (!this.conns.delete(conn)) return;
    for (const id of [...conn.subs]) this.dropSub(id);
    this.broker.dropOwner(conn);
  }

  private async receive(conn: Conn, raw: string): Promise<void> {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return; // no id to answer
    }
    if (!isObject(frame) || frame.kind !== "request" || typeof frame.id !== "number" || !Number.isInteger(frame.id)) return;
    const id = frame.id;
    const deferred: (() => void)[] = [];
    try {
      const method = frame.method;
      if (typeof method !== "string" || !(RPC_METHODS as readonly string[]).includes(method)) {
        throw new RpcFail("invalid_params", `unknown method ${String(method)}`);
      }
      const params = frame.params ?? {};
      if (!isObject(params)) throw new RpcFail("invalid_params", "params must be an object");
      const h = this.handlers[method as RpcMethod] as Handler<RpcMethod>;
      const result = await h(conn, params, (fn) => deferred.push(fn));
      conn.send({ kind: "response", id, ok: true, result } as ServerFrame);
    } catch (e) {
      conn.send({ kind: "response", id, ok: false, error: toRpcError(e) });
      return;
    }
    for (const fn of deferred) fn();
  }

  private push<T extends RpcTopic>(conn: Conn, topic: T, payload: RpcTopics[T]): void {
    if (this.conns.has(conn)) conn.send({ kind: "push", topic, payload } as ServerFrame);
  }

  private broadcast<T extends RpcTopic>(topic: T, payload: RpcTopics[T], to: (c: Conn) => boolean = () => true): void {
    for (const c of this.conns) if (to(c)) this.push(c, topic, payload);
  }

  private addSub(sub: Sub): string {
    const id = `sub-${++this.counter}`;
    this.subs.set(id, sub);
    sub.conn.subs.add(id);
    return id;
  }

  private dropSub(id: string): void {
    this.subs.get(id)?.conn.subs.delete(id);
    this.subs.delete(id);
  }

  private hostOf(params: JsonObject): ProjectHost {
    return this.project(str(params, "projectId"));
  }

  private readonly handlers: { [M in RpcMethod]: Handler<M> } = {
    "project.list": () => ({ projects: this.listProjects() }),

    "project.open": async (_c, params) => ({ project: await this.openProject(str(params, "dir")) }),

    "project.close": async (conn, params) => {
      const p = this.hostOf(params);
      for (const id of [...conn.subs]) if (this.subs.get(id)?.projectId === p.info.projectId) this.dropSub(id);
      // The sidecar stops once no window holds a subscription on the project.
      if (![...this.subs.values()].some((s) => s.projectId === p.info.projectId)) await this.closeProject(p.info.projectId);
      return {};
    },

    "project.subscribe": (conn, params, after) => {
      const p = this.hostOf(params);
      const subscriptionId = this.addSub({ conn, projectId: p.info.projectId, kind: "project" });
      after(() => this.push(conn, "project.snapshot", { subscriptionId, snapshot: p.snapshot() }));
      return { subscriptionId, snapshot: p.snapshot() };
    },

    "project.unsubscribe": (conn, params) => {
      const id = str(params, "subscriptionId");
      if (!conn.subs.has(id)) throw new RpcFail("not_found", `no subscription ${id}`);
      this.dropSub(id);
      return {};
    },

    "model.patch": (_c, params) => this.hostOf(params).patchModel(patchOps(params), optBool(params, "dry_run") ?? false, optStr(params, "label")),

    "model.get": (_c, params) => this.hostOf(params).modelAt(optStr(params, "version"), optStr(params, "config")),

    "check.run": (_c, params) => this.hostOf(params).runCheck(optStr(params, "config"), optBool(params, "strict")),

    "sim.run": (_c, params) => this.hostOf(params).runSim(str(params, "sim"), optBool(params, "force")),

    "job.cancel": (_c, params) => this.hostOf(params).cancelJob(str(params, "jobId")),

    "history.compare": (_c, params) => this.hostOf(params).compare(str(params, "a"), str(params, "b")),

    "history.tag": (_c, params) => this.hostOf(params).tag(str(params, "name"), optStr(params, "version")),

    "history.restore": (_c, params) => this.hostOf(params).restore(str(params, "version"), optBool(params, "dry_run") ?? false),

    "library.search": (_c, params) => this.hostOf(params).librarySearch(libraryQuery(params)),

    "thumb.get": (_c, params) => {
      try {
        return { thumbs: this.hostOf(params).thumbs.get(str(params, "model_hash")) };
      } catch (e) {
        if (e instanceof ThumbCacheError) throw new RpcFail("invalid_params", e.message);
        throw e;
      }
    },

    "thumb.put": (_c, params) => {
      try {
        this.hostOf(params).thumbs.put(str(params, "model_hash"), str(params, "id"), str(params, "png_base64"));
        return {};
      } catch (e) {
        if (e instanceof ThumbCacheError) throw new RpcFail("invalid_params", e.message);
        throw e;
      }
    },

    "engine.design": (_c, params) => this.hostOf(params).engineDesign(str(params, "engine")),

    "engine.simulate": (_c, params) => this.hostOf(params).engineSimulate(str(params, "engine"), optStr(params, "duration")),

    "cfd.import": (_c, params) => {
      const study = optStr(params, "study");
      if (params.dry_run !== undefined && typeof params.dry_run !== "boolean") throw new RpcFail("invalid_params", "dry_run: expected a boolean");
      return this.hostOf(params).cfdImport({ path: str(params, "path"), ...(study === undefined ? {} : { study }), ...(params.dry_run === true ? { dry_run: true } : {}) });
    },

    "cfd.list": (_c, params) => this.hostOf(params).cfdList(),

    "motor.thrustcurveSearch": (_c, params) => this.hostOf(params).thrustcurveSearch(thrustcurveSearchQuery(params)),

    "motor.thrustcurveFetch": (_c, params) => this.hostOf(params).thrustcurveFetch(thrustcurveFetchQuery(params)),

    "broker.hostRegister": (conn, params) => {
      const p = this.hostOf(params);
      const hostId = str(params, "hostId");
      const caps = params.capabilities;
      if (!isObject(caps) || !Array.isArray(caps.ops) || (caps.backend !== "webgpu" && caps.backend !== "webgl2")) {
        throw new RpcFail("invalid_params", "capabilities: expected {ops, backend}");
      }
      this.broker.register(p.info.projectId, {
        owner: conn,
        hostId,
        capabilities: caps as unknown as BrokerCapabilities,
        send: (req) => this.push(conn, "broker.request", req),
      });
      return {};
    },

    "broker.respond": (conn, params) => {
      const requestId = str(params, "requestId");
      if (typeof params.ok !== "boolean") throw new RpcFail("invalid_params", "ok: expected a boolean");
      if (!this.broker.respond(conn, params as unknown as BrokerResponse)) throw new RpcFail("not_found", `no pending broker request ${requestId}`);
      return {};
    },

    "embed.target": (_c, params) => {
      const p = this.hostOf(params);
      const threadId = optStr(params, "threadId");
      return this.viaLecturn("embed.target", (l) => l.embedTarget(p.info.projectId, threadId));
    },

    "embed.refreshToken": (_c, params) => {
      const p = this.hostOf(params);
      return this.viaLecturn("embed.refreshToken", (l) => l.refreshToken(p.info.projectId));
    },

    "embed.setThreadAppData": async (_c, params) => {
      const p = this.hostOf(params);
      const threadId = str(params, "threadId");
      const { appData, subtitle } = params;
      if (appData !== null && typeof appData !== "string") throw new RpcFail("invalid_params", "appData: expected a string or null");
      if (typeof appData === "string" && Buffer.byteLength(appData) > 1024) throw new RpcFail("invalid_params", "appData: at most 1024 bytes");
      if (subtitle !== undefined && subtitle !== null && (typeof subtitle !== "string" || subtitle.length > 80)) {
        throw new RpcFail("invalid_params", "subtitle: expected a string of at most 80 characters, or null");
      }
      await this.viaLecturn("embed.setThreadAppData", (l) => (subtitle === undefined ? l.setThreadAppData(p.info.projectId, threadId, appData) : l.setThreadAppData(p.info.projectId, threadId, appData, subtitle)));
      return {};
    },

    "embed.setHostContext": async (_c, params) => {
      const p = this.hostOf(params);
      const { text } = params;
      if (typeof text !== "string") throw new RpcFail("invalid_params", "text: expected a string");
      if (Buffer.byteLength(text) > HOST_CONTEXT_MAX_BYTES) throw new RpcFail("invalid_params", `text: at most ${HOST_CONTEXT_MAX_BYTES} bytes`);
      await this.viaLecturn("embed.setHostContext", (l) => l.updateHostContext(p.info.projectId, text));
      return { applied: true };
    },

    "test.call": async (_c, params) => {
      if (!this.testHooks) throw new RpcFail("hooks_disabled", "test hooks need RW_TEST_HOOKS=1");
      const p = this.hostOf(params);
      const op = params.op;
      if (typeof op !== "string" || !(TEST_HOOK_OPS as readonly string[]).includes(op)) throw new RpcFail("invalid_params", "op: not a test hook");
      if (!isObject(params.args)) throw new RpcFail("invalid_params", "args: expected an object");
      const r = await this.requestBroker(p.info.projectId, op as BrokerOp, params.args as never, null);
      if (!r.ok) throw new RpcFail(r.error.code === "no_host" ? "not_found" : "internal", `${r.error.code}: ${r.error.message}`);
      return r.result as JsonObject;
    },
  };
}
