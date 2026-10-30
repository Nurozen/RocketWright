/**
 * The app-server child's Lecturn connection (plan B8; D2, D3, D13, D25).
 *
 * `connect()` from the vendored `@lecturn/embed/node` runs here, not in
 * Electron main: projects, the live MCP and the RPC all live in this child,
 * and web mode needs it here anyway (D2). Main reaches it over IF10
 * (`embed.target`, `embed.refreshToken`, `embed.setThreadAppData`, pushes
 * `embed.threads` and `lecturn.status`).
 *
 * - Options (`lecturnConnectOptions`): `lecturnHome` from `LECTURN_HOME`;
 *   the Lecturn sidecar runs `lecturn/dist/bin.mjs` in `RW_LECTURN_BASE_DIR`,
 *   else the base dir main passes (`<userData>/lecturn`), with `RW_NODE`,
 *   else this process's Node. Under Electron-as-Node the helper's default
 *   applies instead: `process.execPath` with `ELECTRON_RUN_AS_NODE=1` on the
 *   Lecturn server process only (D3). Without a base dir there is no
 *   connection (plain `node cli.ts`, the server tests).
 * - Workspaces (D13): each opened project is `ensureWorkspace(realpath(dir),
 *   name)`. Lecturn echoes the root verbatim, so every lookup goes through
 *   that realpath (`/tmp` is `/private/tmp` on macOS).
 * - Index: realpath → { RocketWright project, the current server's Lecturn
 *   project id }. Lecturn ids are never a key: on a live switch (the helper's
 *   `mode` event, D25) every entry takes its id from
 *   `projectIdsByWorkspaceRoot` (or is ensured again), and the switch goes
 *   out as a `lecturn.status` push with the new ids and the thread id map.
 *   A proxied call's project id from any server the connection used resolves
 *   through the helper's `workspaceRootOf`.
 * - Threads: one `subscribeThreads` per workspace; every change pushes the
 *   project's whole list (`embed.threads`). The helper moves each
 *   subscription to the new server on a live switch (a fresh snapshot in its
 *   ids, B12, D25); a workspace the switch did not map is ensured and
 *   subscribed again.
 * - Host context (B12): `updateHostContext` with the project target. The
 *   helper carries the last text per workspace to the new server; the link
 *   re-sends it only for a workspace it had to ensure again.
 * - Live tools (B9): `publishLiveTools({url, bearer})` leases the server's
 *   `/mcp/live` with `setLiveTools` once connected. The helper moves the
 *   lease on a live switch, so the endpoint and bearer stay, and clears it on
 *   close.
 * - Lifetime: `connect({signal})` returns a closable pending connection.
 *   `close()` aborts the signal and closes the pending connection, so a
 *   Lecturn sidecar that is still starting is stopped (and awaited) rather
 *   than left running. The helper hands the sidecar its parent pipe itself.
 */
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { ConnectionEvent, ConnectionMode, ConnectionStatus, ConnectOptions, HostContextTarget, LiveTools } from "@lecturn/embed/node";
import type { EmbedTarget, EmbedThread, LecturnStatus, ProjectInfo } from "@rw/contracts";
import { lecturnRpc, readServerOrigin, readSidecarAppSession } from "./appsRpc.ts";
import { rocketwrightRegistration } from "./registration.ts";

export type { ConnectionEvent, ConnectionMode, ConnectionStatus, HostContextTarget, LiveTools };

/** Lecturn's `ConnectedAppThreadsStreamEvent`. */
export type ThreadsStreamEvent =
  | { readonly type: "snapshot"; readonly threads: ReadonlyArray<EmbedThread> }
  | { readonly type: "upsert"; readonly thread: EmbedThread }
  | { readonly type: "remove"; readonly threadId: string };

/** The slice of `LecturnConnection` the child uses; the vendored helper's satisfies it. */
export interface LecturnConnectionLike {
  readonly mode: ConnectionMode;
  /** The current server's origin (the pinned helper's connection has it). */
  readonly origin?: string;
  /** `status` events (pairing) and `mode` events (a live switch, D36). */
  readonly status: ConnectionStatus;
  /** The workspace root of a project id from any server this connection used. */
  workspaceRootOf(projectId: string): string | null;
  ensureWorkspace(workspaceRoot: string, title: string): Promise<{ readonly projectId: string }>;
  embedTarget(projectId: string, threadId?: string): Promise<EmbedTarget>;
  refreshEmbedToken(projectId: string): Promise<EmbedTarget>;
  subscribeThreads(projectId: string, listener: (event: ThreadsStreamEvent) => void): () => void;
  setThreadAppData(threadId: string, appData: string | null, subtitle?: string | null): Promise<void>;
  /**
   * Lecturn `apps.updateHostContext` (A29): text prefixed to each turn of the
   * target's threads; the helper carries it across a live switch.
   */
  updateHostContext(target: HostContextTarget, text: string): Promise<void>;
  /** Leases the app's live MCP endpoint (heartbeat kept by the helper; moved on a switch). */
  setLiveTools(tools: LiveTools): Promise<void>;
  /**
   * Lecturn `apps.importThreads` with the app's credential, when the helper
   * exposes it (the pinned one does not; `LecturnLink.importThreads` then
   * calls it over the sidecar's app session, B13).
   */
  importThreads?(bundle: unknown): Promise<ImportResult>;
  /** Clears the live leases, and stops the Lecturn sidecar when this connection started it. */
  close(): Promise<void>;
}

/** `connect()`'s promise (the helper's `PendingLecturnConnection`): closable before it settles. */
export interface PendingConnectionLike extends Promise<LecturnConnectionLike> {
  /** Before ready, stops a starting sidecar and resolves once it exited; after ready, the connection's `close`. */
  close(): Promise<void>;
}

/** Starts `connect()` with the link's lifetime signal (aborted by `close()`). */
export type ConnectFn = (signal: AbortSignal) => PendingConnectionLike;

export interface LecturnLinkEvents {
  /** Every status change, live switches included (`lecturn.status`). */
  status(status: LecturnStatus): void;
  /** A project's whole thread list after any change (`embed.threads`). */
  threads(projectId: string, threads: EmbedThread[]): void;
  log?(line: string): void;
}

/** `apps.importThreads`'s answer. */
export interface ImportResult {
  readonly imported: number;
  readonly skipped: number;
}

export interface LecturnLinkOptions {
  /** The Lecturn sidecar's base dir: its app session file lets test hooks import bundles (B13). */
  baseDir?: string | null;
}

/** Lecturn is not usable (connect failed, closed, or the project is not open). */
export class LecturnUnavailable extends Error {
  override readonly name = "LecturnUnavailable";
}

/** `realpath`, or the resolved path when it does not exist (a project dir always does). */
export function workspaceRootOf(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

interface Workspace {
  readonly rwProjectId: string;
  readonly root: string;
  readonly title: string;
  /** The current server's Lecturn project id, once ensured. */
  lecturnProjectId: string | null;
  /** The ensure in flight (null when settled or reset by a switch). */
  ensuring: Promise<string> | null;
  threads: Map<string, EmbedThread> | null;
  unsubscribe: (() => void) | null;
  /** The window's last host context (B12), re-sent when the workspace is ensured again after a switch. */
  hostContext: string | null;
}

const CLOSE_TIMEOUT_MS = 8_000;

const byUpdatedDesc = (a: EmbedThread, b: EmbedThread): number => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.threadId < b.threadId ? -1 : 1);

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class LecturnLink {
  private readonly connectFn: ConnectFn;
  private readonly events: LecturnLinkEvents;
  private readonly baseDir: string | null;
  /** The link's lifetime: aborted by `close()`, which also stops a starting sidecar. */
  private readonly lifetime = new AbortController();
  /** `connect()`'s closable promise, once started. */
  private pending: PendingConnectionLike | null = null;
  private connecting: Promise<LecturnConnectionLike> | null = null;
  private conn: LecturnConnectionLike | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private closed = false;
  private current: LecturnStatus = { state: "connecting", mode: null, pairing: "none" };
  /** realpath → workspace (the only index; D13, D25). */
  private readonly byRoot = new Map<string, Workspace>();
  /** RocketWright project id → realpath. */
  private readonly rootOfProject = new Map<string, string>();

  constructor(connect: ConnectFn, events: LecturnLinkEvents, opts: LecturnLinkOptions = {}) {
    this.connectFn = connect;
    this.events = events;
    this.baseDir = opts.baseDir ?? null;
  }

  get status(): LecturnStatus {
    return structuredClone(this.current);
  }

  /** Starts `connect()` once; later calls return the same attempt. Never rejects. */
  start(): Promise<void> {
    if (this.connecting === null) {
      if (this.closed) return Promise.resolve();
      let pending: PendingConnectionLike;
      try {
        pending = this.connectFn(this.lifetime.signal);
      } catch (e) {
        pending = Object.assign(Promise.reject(e), { close: async () => undefined });
      }
      this.pending = pending;
      this.connecting = pending.then(
        (conn) => this.attach(conn),
        (e: unknown) => {
          if (this.closed) throw new LecturnUnavailable("the Lecturn connection was closed");
          this.setStatus({ state: "unavailable", mode: null, pairing: "none", message: `Lecturn did not start: ${message(e)}` });
          throw new LecturnUnavailable(this.current.message);
        },
      );
      this.connecting.catch(() => undefined);
    }
    return this.connecting.then(
      () => undefined,
      () => undefined,
    );
  }

  /** Registers an opened project's workspace (`ensureWorkspace(realpath(dir), name)`) and follows its threads. */
  async addProject(info: ProjectInfo): Promise<{ projectId: string }> {
    const root = workspaceRootOf(info.dir);
    const existing = this.byRoot.get(root);
    if (existing !== undefined && existing.rwProjectId !== info.projectId) {
      throw new LecturnUnavailable(`${root} is already open as ${existing.rwProjectId}`);
    }
    if (existing === undefined) {
      this.byRoot.set(root, { rwProjectId: info.projectId, root, title: info.name, lecturnProjectId: null, ensuring: null, threads: null, unsubscribe: null, hostContext: null });
      this.rootOfProject.set(info.projectId, root);
    }
    return { projectId: await this.lecturnProjectId(info.projectId) };
  }

  /** Stops following a closed project (Lecturn keeps the workspace and its threads). */
  removeProject(rwProjectId: string): void {
    const root = this.rootOfProject.get(rwProjectId);
    if (root === undefined) return;
    this.rootOfProject.delete(rwProjectId);
    const w = this.byRoot.get(root);
    this.byRoot.delete(root);
    w?.unsubscribe?.();
  }

  /** The RocketWright project whose workspace is `workspaceRoot` (any spelling of it; live routing, B9). */
  projectForWorkspaceRoot(workspaceRoot: string): string | undefined {
    return (this.byRoot.get(workspaceRoot) ?? this.byRoot.get(workspaceRootOf(workspaceRoot)))?.rwProjectId;
  }

  /**
   * The RocketWright project a proxied call's `_meta["lecturn/context"]`
   * names: by workspace root first, else by the Lecturn project id of any
   * server the connection used (the helper's `workspaceRootOf`: a turn still
   * draining on the sidecar after a switch keeps resolving).
   */
  resolveContext(context: { workspaceRoot?: string; projectId?: string }): string | undefined {
    if (context.workspaceRoot !== undefined) {
      const byRoot = this.projectForWorkspaceRoot(context.workspaceRoot);
      if (byRoot !== undefined) return byRoot;
    }
    if (context.projectId === undefined) return undefined;
    const root = this.conn?.workspaceRootOf(context.projectId) ?? null;
    return root === null ? undefined : this.projectForWorkspaceRoot(root);
  }

  /** The project's Lecturn threads as last pushed, newest first (undefined before the first snapshot). */
  threadsOf(rwProjectId: string): EmbedThread[] | undefined {
    const w = this.workspaceOf(rwProjectId, false);
    return w?.threads === null || w === undefined ? undefined : [...w.threads.values()].sort(byUpdatedDesc);
  }

  /** Every followed project with a thread list (for a socket that connects later). */
  threadLists(): { projectId: string; threads: EmbedThread[] }[] {
    const out: { projectId: string; threads: EmbedThread[] }[] = [];
    for (const w of this.byRoot.values()) {
      const threads = this.threadsOf(w.rwProjectId);
      if (threads !== undefined) out.push({ projectId: w.rwProjectId, threads });
    }
    return out;
  }

  /** The current server's Lecturn project id of a RocketWright project (ensured on first use and after a switch). */
  async lecturnProjectId(rwProjectId: string): Promise<string> {
    const w = this.workspaceOf(rwProjectId, true)!;
    if (w.lecturnProjectId !== null) return w.lecturnProjectId;
    return this.ensure(w);
  }

  async embedTarget(rwProjectId: string, threadId?: string): Promise<EmbedTarget> {
    const conn = await this.connection();
    const projectId = await this.lecturnProjectId(rwProjectId);
    return copyTarget(await (threadId === undefined ? conn.embedTarget(projectId) : conn.embedTarget(projectId, threadId)));
  }

  async refreshToken(rwProjectId: string): Promise<EmbedTarget> {
    const conn = await this.connection();
    return copyTarget(await conn.refreshEmbedToken(await this.lecturnProjectId(rwProjectId)));
  }

  /** Writes appData (and the subtitle unless omitted) of one of the project's Lecturn threads. */
  async setThreadAppData(rwProjectId: string, threadId: string, appData: string | null, subtitle?: string | null): Promise<void> {
    const conn = await this.connection();
    await this.lecturnProjectId(rwProjectId);
    const threads = this.workspaceOf(rwProjectId, true)!.threads;
    if (threads !== null && !threads.has(threadId)) throw new LecturnUnavailable(`no Lecturn thread ${threadId} in ${rwProjectId}`);
    await (subtitle === undefined ? conn.setThreadAppData(threadId, appData) : conn.setThreadAppData(threadId, appData, subtitle));
  }

  /**
   * Sets the project's host context (B12: the window's page, selection,
   * configuration and sim) on its Lecturn project; the helper carries it
   * across a live switch. A newer text sent meanwhile wins (this one is
   * skipped).
   */
  async updateHostContext(rwProjectId: string, text: string): Promise<void> {
    const w = this.workspaceOf(rwProjectId, true)!;
    w.hostContext = text;
    const conn = await this.connection();
    const projectId = await this.lecturnProjectId(rwProjectId);
    if (w.hostContext !== text) return;
    await conn.updateHostContext({ projectId }, text);
  }

  /** Leases the live endpoint (`setLiveTools`) once connected; rejects when Lecturn refuses it or is unavailable. */
  async publishLiveTools(tools: LiveTools): Promise<void> {
    const conn = await this.connection();
    await conn.setLiveTools({ url: tools.url, bearer: tools.bearer });
  }

  /**
   * Imports a thread bundle (`apps.importThreads`, B13 test hooks) after
   * ensuring the project's workspace, so its subscription sees the copies.
   * Through the helper when it exposes the call, else over the Lecturn
   * sidecar's app session (`<baseDir>/embed-app-session.json`): the app
   * credential is what the import takes, and the pinned helper keeps it
   * inside the connection. A user server's credential is not reachable that
   * way, so that mode refuses.
   */
  async importThreads(rwProjectId: string, bundle: unknown): Promise<ImportResult> {
    const conn = await this.connection();
    await this.lecturnProjectId(rwProjectId);
    if (conn.importThreads !== undefined) return conn.importThreads(bundle);
    if (conn.mode !== "sidecar" || this.baseDir === null) throw new LecturnUnavailable("importThreads needs the Lecturn sidecar (the app's user-server credential is not reachable here)");
    const session = readSidecarAppSession(this.baseDir);
    const origin = conn.origin ?? readServerOrigin(this.baseDir);
    if (session === null || origin === null) throw new LecturnUnavailable(`no Lecturn sidecar session in ${this.baseDir}`);
    const r = await lecturnRpc(origin, session.accessToken, "apps.importThreads", { bundle });
    const o = r as Partial<ImportResult> | null;
    if (typeof o?.imported !== "number" || typeof o.skipped !== "number") throw new LecturnUnavailable(`apps.importThreads answered ${JSON.stringify(r)}`);
    return { imported: o.imported, skipped: o.skipped };
  }

  /**
   * The project's Lecturn thread ids for `sourceIds` (an imported copy names
   * its source in `copiedFrom.sourceThreadId`), in order, once the thread
   * list shows them all; rejects after `timeoutMs`.
   */
  async waitForThreads(rwProjectId: string, sourceIds: readonly string[], timeoutMs = 30_000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const threads = this.threadsOf(rwProjectId) ?? [];
      const ids = sourceIds.map((src) => threads.find((t) => t.copiedFrom?.sourceThreadId === src || t.threadId === src)?.threadId);
      if (ids.every((id) => id !== undefined)) return ids as string[];
      if (this.closed) throw new LecturnUnavailable("the Lecturn connection was closed");
      if (Date.now() > deadline) throw new LecturnUnavailable(`threads ${sourceIds.filter((_, i) => ids[i] === undefined).join(", ")} never appeared in ${rwProjectId}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Unsubscribes and closes the connection: the helper clears the live lease
   * and stops the Lecturn sidecar this child started. Before `connect()`
   * settled, this aborts it, so a sidecar that is still starting is stopped
   * and awaited (no orphan when the window quits during startup).
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.byRoot.values()) w.unsubscribe?.();
    this.byRoot.clear();
    this.rootOfProject.clear();
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    this.lifetime.abort();
    const pending = this.pending;
    if (pending !== null) await Promise.race([pending.close().catch(() => undefined), timeout(CLOSE_TIMEOUT_MS)]);
    this.conn = null;
  }

  // ---- internals ----

  private attach(conn: LecturnConnectionLike): LecturnConnectionLike {
    // `close()` closes the pending connection, which closes this one.
    if (this.closed) throw new LecturnUnavailable("the Lecturn connection was closed");
    this.conn = conn;
    const { mode, pairing } = conn.status.current;
    this.setStatus({ state: "connected", mode, pairing });
    // Called at once with the current status (a no-op after the line above), then on every change.
    this.unsubscribeStatus = conn.status.subscribe((event) => this.onEvent(event));
    return conn;
  }

  private connection(): Promise<LecturnConnectionLike> {
    if (this.closed) return Promise.reject(new LecturnUnavailable("the Lecturn connection was closed"));
    if (this.conn !== null) return Promise.resolve(this.conn);
    void this.start();
    return this.connecting!;
  }

  private workspaceOf(rwProjectId: string, required: boolean): Workspace | undefined {
    const root = this.rootOfProject.get(rwProjectId);
    const w = root === undefined ? undefined : this.byRoot.get(root);
    if (w === undefined && required) throw new LecturnUnavailable(`project ${rwProjectId} has no Lecturn workspace`);
    return w;
  }

  /** `ensureWorkspace` for `w` on the current server; one in flight at a time, retried after a failure. */
  private ensure(w: Workspace): Promise<string> {
    if (w.ensuring !== null) return w.ensuring;
    const attempt = this.connection()
      .then((conn) => conn.ensureWorkspace(w.root, w.title))
      .then(({ projectId }) => {
        if (w.ensuring === attempt && this.byRoot.get(w.root) === w) {
          w.lecturnProjectId = projectId;
          this.follow(w, projectId);
        }
        return projectId;
      })
      .finally(() => {
        if (w.ensuring === attempt) w.ensuring = null;
      });
    w.ensuring = attempt;
    return attempt;
  }

  private follow(w: Workspace, lecturnProjectId: string): void {
    if (w.unsubscribe !== null || this.conn === null) return;
    w.unsubscribe = this.conn.subscribeThreads(lecturnProjectId, (event) => {
      if (this.byRoot.get(w.root) !== w) return;
      if (event.type === "snapshot") w.threads = new Map(event.threads.map((t) => [t.threadId, copyThread(t)]));
      else if (event.type === "upsert") (w.threads ??= new Map()).set(event.thread.threadId, copyThread(event.thread));
      else w.threads?.delete(event.threadId);
      this.events.threads(w.rwProjectId, this.threadsOf(w.rwProjectId) ?? []);
    });
  }

  private onEvent(event: ConnectionEvent): void {
    if (this.closed) return;
    if (event.type === "status") {
      this.setStatus({ state: "connected", mode: event.mode, pairing: event.pairing });
      return;
    }
    void this.onSwitch(event);
  }

  /**
   * D25: re-index every open project from the new server's ids, then announce
   * the switch. The helper already moved the thread subscriptions, the live
   * lease and the host context of every mapped workspace; one the switch did
   * not map is ensured, subscribed and given its host context again here.
   */
  private async onSwitch(event: Extract<ConnectionEvent, { type: "mode" }>): Promise<void> {
    const projects: Record<string, string> = {};
    const missing: Workspace[] = [];
    for (const w of this.byRoot.values()) {
      w.ensuring = null;
      const id = event.projectIdsByWorkspaceRoot[w.root];
      w.lecturnProjectId = id ?? null;
      if (id !== undefined) {
        projects[w.rwProjectId] = id;
        // Already followed: the helper moved it. An ensure cut short by the switch follows it here.
        this.follow(w, id);
        continue;
      }
      // The helper left this subscription on the old server: follow it on the new one once ensured.
      w.unsubscribe?.();
      w.unsubscribe = null;
      missing.push(w);
    }
    await Promise.all(
      missing.map((w) =>
        this.ensure(w).then(
          (id) => {
            projects[w.rwProjectId] = id;
            this.resendHostContext(w);
          },
          (e: unknown) => this.events.log?.(`lecturn: ensureWorkspace ${w.root} after the switch: ${message(e)}`),
        ),
      ),
    );
    if (this.closed) return;
    this.current = { state: "connected", mode: event.mode, pairing: this.current.pairing };
    this.events.status({ ...this.status, switched: { environmentId: event.environmentId, projects, threadIdMap: { ...event.threadIdMap } } });
  }

  private resendHostContext(w: Workspace): void {
    const conn = this.conn;
    const text = w.hostContext;
    if (conn === null || text === null || w.lecturnProjectId === null) return;
    conn.updateHostContext({ projectId: w.lecturnProjectId }, text).catch((e: unknown) => this.events.log?.(`lecturn: updateHostContext ${w.root} after the switch: ${message(e)}`));
  }

  private setStatus(next: LecturnStatus): void {
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    this.events.status(this.status);
  }
}

function copyTarget(t: EmbedTarget): EmbedTarget {
  return { url: t.url, token: t.token, expiresAt: t.expiresAt };
}

/** Plain JSON of a Lecturn thread summary (drops anything outside `EmbedThread`). */
function copyThread(t: EmbedThread): EmbedThread {
  const out: EmbedThread = {
    threadId: t.threadId,
    projectId: t.projectId,
    workspaceRoot: t.workspaceRoot,
    title: t.title,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    historyRevision: t.historyRevision,
    state: t.state,
    appData: t.appData,
    subtitle: t.subtitle,
  };
  if (t.copiedFrom !== undefined) {
    const c = t.copiedFrom;
    out.copiedFrom = { appId: c.appId, sourceEnvironmentId: c.sourceEnvironmentId, sourceThreadId: c.sourceThreadId, copiedAt: c.copiedAt, sourceHistoryRevision: c.sourceHistoryRevision };
  }
  if (t.continuedIn !== undefined) out.continuedIn = { environmentId: t.continuedIn.environmentId, threadId: t.continuedIn.threadId, copiedAt: t.continuedIn.copiedAt };
  return out;
}

function timeout(ms: number): Promise<undefined> {
  return new Promise((r) => setTimeout(() => r(undefined), ms).unref());
}

/** `lecturn/dist/bin.mjs` from the vendored install (`app/package.json`). */
export function lecturnServerEntry(): string {
  return createRequire(import.meta.url).resolve("lecturn/dist/bin.mjs");
}

export interface LecturnConnectOptionsInput {
  env?: NodeJS.ProcessEnv;
  /** Main's default (`<userData>/lecturn`); `RW_LECTURN_BASE_DIR` wins. */
  baseDir?: string | undefined;
  /** Absolute `rocketwright` for `headlessTools` (default: the app's sidecar binary). */
  bin?: string | undefined;
}

/** The sidecar base dir (`RW_LECTURN_BASE_DIR`, else main's), or null: then the child does not connect. */
export function lecturnBaseDir(input: LecturnConnectOptionsInput): string | null {
  const dir = input.env?.RW_LECTURN_BASE_DIR || input.baseDir;
  return dir === undefined || dir === "" ? null : resolve(dir);
}

/** `connect()`'s options, or null without a base dir. */
export function lecturnConnectOptions(input: LecturnConnectOptionsInput = {}): ConnectOptions | null {
  const env = input.env ?? process.env;
  const baseDir = lecturnBaseDir({ ...input, env });
  if (baseDir === null) return null;
  // Under Electron-as-Node, leave nodePath unset: the helper then runs this
  // binary with ELECTRON_RUN_AS_NODE=1 on the Lecturn server process only (D3).
  const nodePath = env.RW_NODE || (process.versions.electron === undefined ? process.execPath : undefined);
  return {
    registration: rocketwrightRegistration(input.bin === undefined ? {} : { bin: input.bin }),
    ...(env.LECTURN_HOME ? { lecturnHome: env.LECTURN_HOME } : {}),
    sidecar: { serverEntry: lecturnServerEntry(), baseDir, ...(nodePath === undefined ? {} : { nodePath }) },
  };
}

/** The child's link (`connect()` from `@lecturn/embed/node`), or null when no base dir is configured. */
export function createLecturnLink(input: LecturnConnectOptionsInput, events: LecturnLinkEvents): LecturnLink | null {
  const env = input.env ?? process.env;
  const baseDir = lecturnBaseDir({ ...input, env });
  if (baseDir === null) return null;
  return new LecturnLink((signal) => {
    const options = lecturnConnectOptions({ ...input, env })!;
    // The helper is imported lazily (plain `node cli.ts` without a base dir
    // never loads it). A `close()` before the import settles has aborted
    // `signal` already, so `connect` stops what it starts at once.
    const started = import("@lecturn/embed/node").then(({ connect }): PendingConnectionLike => connect({ ...options, signal }));
    const connected: Promise<LecturnConnectionLike> = started.then((pending) => pending);
    return Object.assign(connected, { close: () => started.then((pending) => pending.close()) });
  }, events, { baseDir });
}
