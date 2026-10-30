/**
 * A fake `LecturnConnectionLike` (B8 tests): a Lecturn server stand-in whose
 * ids carry the environment, so a live switch changes every one. It plays the
 * pinned helper's part in a switch (B7b): thread subscriptions and the host
 * context of every mapped workspace move to the new server, the live lease
 * stays, and `close()` clears the lease.
 */
import type { EmbedThread } from "@rw/contracts";
import type {
  ConnectFn,
  ConnectionEvent,
  ConnectionStatus,
  HostContextTarget,
  LecturnConnectionLike,
  LiveTools,
  PendingConnectionLike,
  ThreadsStreamEvent,
} from "../../src/lecturn/connection.ts";

type Pairing = "none" | "pending" | "denied";

/** A Lecturn server stand-in: ids carry the environment, so a switch changes every one. */
export class FakeConnection implements LecturnConnectionLike {
  mode: "sidecar" | "user-server" = "sidecar";
  pairing: Pairing = "none";
  env = "env-a";
  readonly ensured: [string, string][] = [];
  readonly appData: [string, string | null, string | null | undefined][] = [];
  readonly listeners = new Set<(e: ConnectionEvent) => void>();
  /** Current server's project id → the subscription's listener. */
  readonly threadListeners = new Map<string, (e: ThreadsStreamEvent) => void>();
  /** Every `setLiveTools` call and the clear on close, in order (null: a clear). */
  readonly liveTools: (LiveTools | null)[] = [];
  /** Every `updateHostContext` the server received (the helper's carry on a switch included), in order. */
  readonly hostContexts: [HostContextTarget, string][] = [];
  /** Project id (any environment) → workspace root, as the helper's `workspaceRootOf`. */
  private readonly roots = new Map<string, string>();
  /** Root → last project host context, carried on a switch. */
  private readonly projectContexts = new Map<string, string>();
  closed = false;
  readonly status: ConnectionStatus = ((conn: FakeConnection): ConnectionStatus => ({
    get current() {
      return conn.statusEvent();
    },
    subscribe: (listener) => {
      conn.listeners.add(listener);
      listener(conn.statusEvent());
      return () => conn.listeners.delete(listener);
    },
  }))(this);

  statusEvent() {
    return { type: "status" as const, mode: this.mode, pairing: this.pairing, app: null };
  }

  idFor(root: string): string {
    return `${this.env}:${root}`;
  }

  workspaceRootOf(projectId: string): string | null {
    return this.roots.get(projectId) ?? null;
  }

  async ensureWorkspace(root: string, title: string) {
    this.ensured.push([root, title]);
    const projectId = this.idFor(root);
    this.roots.set(projectId, root);
    return { projectId };
  }
  async embedTarget(projectId: string, threadId?: string) {
    return { url: `http://127.0.0.1:9/embed/${this.env}/${projectId}${threadId === undefined ? "" : `/${threadId}`}`, token: "t", expiresAt: "2026-10-25T00:00:00.000Z" };
  }
  async refreshEmbedToken(projectId: string) {
    return { url: `http://127.0.0.1:9/embed/${this.env}/${projectId}`, token: "t2", expiresAt: "2026-10-25T00:05:00.000Z" };
  }
  subscribeThreads(projectId: string, listener: (e: ThreadsStreamEvent) => void) {
    this.threadListeners.set(projectId, listener);
    listener({ type: "snapshot", threads: [] });
    return () => {
      for (const [id, l] of this.threadListeners) if (l === listener) this.threadListeners.delete(id);
    };
  }
  async setThreadAppData(threadId: string, appData: string | null, subtitle?: string | null) {
    this.appData.push([threadId, appData, subtitle]);
  }
  async updateHostContext(target: HostContextTarget, text: string) {
    if ("projectId" in target) {
      const root = this.roots.get(target.projectId);
      if (root !== undefined) this.projectContexts.set(root, text);
    }
    this.hostContexts.push([{ ...target }, text]);
  }
  async setLiveTools(tools: LiveTools) {
    this.liveTools.push({ url: tools.url, bearer: tools.bearer });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.liveTools.length > 0 && this.liveTools.at(-1) !== null) this.liveTools.push(null);
    this.threadListeners.clear();
    this.listeners.clear();
  }

  emit(e: ConnectionEvent): void {
    for (const l of [...this.listeners]) l(e);
  }

  /** A pairing change on the current server (`status` event). */
  setPairing(pairing: Pairing): void {
    this.pairing = pairing;
    this.emit(this.statusEvent());
  }

  /**
   * The helper's live switch: new environment and new ids for `roots` (the
   * workspaces it could ensure there). Their subscriptions move (a fresh
   * snapshot in the new ids) and their host context is carried; any other
   * subscription stays on the old server.
   */
  switchTo(env: string, roots: string[], threadIdMap: Record<string, string> = {}): void {
    const moving = [...this.threadListeners].flatMap(([id, l]) => {
      const root = this.roots.get(id);
      return root !== undefined && roots.includes(root) ? [[id, root, l] as const] : [];
    });
    this.env = env;
    this.mode = "user-server";
    for (const r of roots) this.roots.set(this.idFor(r), r);
    for (const [oldId, root, l] of moving) {
      this.threadListeners.delete(oldId);
      this.threadListeners.set(this.idFor(root), l);
      l({ type: "snapshot", threads: [] });
    }
    for (const [root, text] of this.projectContexts) if (roots.includes(root)) this.hostContexts.push([{ projectId: this.idFor(root) }, text]);
    this.emit({ type: "mode", mode: "user-server", environmentId: env, projectIdsByWorkspaceRoot: Object.fromEntries(roots.map((r) => [r, this.idFor(r)])), threadIdMap });
  }
}

/** `connect()` as the helper returns it: a closable promise of `conn` (or the failure). */
export function pendingOf(conn: LecturnConnectionLike | Error): PendingConnectionLike {
  const p: Promise<LecturnConnectionLike> = conn instanceof Error ? Promise.reject(conn) : Promise.resolve(conn);
  p.catch(() => undefined);
  return Object.assign(p, {
    close: async () => {
      if (!(conn instanceof Error)) await conn.close();
    },
  });
}

/** A `ConnectFn` that connects to `conn` at once. */
export function connectTo(conn: LecturnConnectionLike | Error): ConnectFn {
  return () => pendingOf(conn);
}

/**
 * A Lecturn sidecar that never becomes ready: `connect()` stays pending until
 * the signal aborts or the pending connection is closed, which "stops" the
 * process (`stopped`) and rejects with the abort reason.
 */
export class StartingSidecar {
  running = false;
  stopped = false;
  signal: AbortSignal | null = null;

  readonly connect: ConnectFn = (signal) => {
    this.signal = signal;
    this.running = true;
    let fail: (e: unknown) => void = () => undefined;
    const p = new Promise<LecturnConnectionLike>((_, reject) => {
      fail = reject;
    });
    p.catch(() => undefined);
    const stop = async () => {
      if (!this.running) return;
      await new Promise((r) => setTimeout(r, 5));
      this.running = false;
      this.stopped = true;
      fail(signal.reason ?? new Error("closed"));
    };
    signal.addEventListener("abort", () => void stop(), { once: true });
    return Object.assign(p, { close: stop });
  };
}

export function thread(projectId: string, workspaceRoot: string, threadId: string, updatedAt: string, extra: Partial<EmbedThread> = {}): EmbedThread {
  return { threadId, projectId, workspaceRoot, title: threadId, createdAt: updatedAt, updatedAt, historyRevision: 1, state: "idle", appData: null, subtitle: null, ...extra };
}
