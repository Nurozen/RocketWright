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
import { LecturnRpcError, type LecturnRpcOptions } from "../../src/lecturn/appsRpc.ts";

type Pairing = "none" | "pending" | "denied";

export interface FakeRpcCall {
  origin: string;
  token: string;
  tag: string;
  payload: Record<string, unknown>;
}

export interface FakeThreadRecord {
  modelSelection: Record<string, unknown>;
  runtimeMode: string;
  interactionMode: string;
  messages: string[];
}

/**
 * How one fake RPC ends: an `Error` rejects without acting, `reply-lost` acts
 * and then loses the answer, `never-arrived` loses the request after it was
 * sent, and `stall` answers nothing until the call's own limit fires.
 */
export type RpcOutcome = Error | "reply-lost" | "never-arrived" | "stall" | undefined;

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
  /** Every embed-token RPC, in order. */
  readonly rpcCalls: FakeRpcCall[] = [];
  /** Decides how each RPC ends; undefined acts and answers. */
  rpcOutcome: (call: FakeRpcCall) => RpcOutcome = () => undefined;
  /** The threads the fake RPC serves, by id. */
  readonly rpcThreads = new Map<string, FakeThreadRecord>();
  /** What `apps.createEmbedThread` gives a new thread (the project's defaults). */
  threadDefaults: Omit<FakeThreadRecord, "messages"> = { modelSelection: { instanceId: "default-instance", model: "default-model" }, runtimeMode: "full-access", interactionMode: "default" };
  /** Provider instances Lecturn refuses a launch on. */
  readonly disabledInstances = new Set<string>();
  /** `server.getConfig`'s `projectSettingsOverrides` (the embed token's own project only). */
  projectOverrides: Record<string, unknown> = {};
  /** Accepted launch commandIds (Lecturn's receipts). */
  readonly launchReceipts = new Set<string>();
  /** Project ids whose mint fails, or never answers. */
  readonly mintFailures = new Set<string>();
  readonly mintStalls = new Set<string>();
  /** Environment → the server origin its embed targets carry (default `http://127.0.0.1:9`). */
  readonly origins = new Map<string, string>();
  private nextThread = 1;
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
    if (this.mintStalls.has(projectId)) await new Promise(() => undefined);
    if (this.mintFailures.has(projectId)) throw new Error(`no token for ${projectId}`);
    const origin = this.origins.get(projectId.split(":")[0]!) ?? "http://127.0.0.1:9";
    return { url: `${origin}/embed/${this.env}/${projectId}${threadId === undefined ? "" : `/${threadId}`}`, token: "t", expiresAt: "2026-10-25T00:00:00.000Z" };
  }

  /** `LecturnLinkOptions.rpc`: the embed-token surface a thread start uses. */
  readonly rpc = async (origin: string, token: string, tag: string, payload: unknown, o: LecturnRpcOptions = {}): Promise<unknown> => {
    const call: FakeRpcCall = { origin, token, tag, payload: payload as Record<string, unknown> };
    this.rpcCalls.push(call);
    const outcome = this.rpcOutcome(call);
    if (outcome instanceof Error) throw outcome;
    if (outcome === "stall") {
      const signal = o.signal === undefined ? AbortSignal.timeout(o.timeoutMs ?? 60_000) : AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs ?? 60_000)]);
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new LecturnRpcError(`${tag}: no answer`, { ambiguous: true, aborted: true })), { once: true }));
    }
    if (outcome === "never-arrived") throw new LecturnRpcError(`${tag}: the socket closed before the answer`, { ambiguous: true });
    const value = this.answer(call);
    if (outcome === "reply-lost") throw new LecturnRpcError(`${tag}: the socket closed before the answer`, { ambiguous: true });
    return value;
  };

  private rpcThread(id: unknown): FakeThreadRecord {
    const thread = this.rpcThreads.get(id as string);
    if (thread === undefined) throw new LecturnRpcError(`no thread ${String(id)}`);
    return thread;
  }

  private answer({ tag, payload }: FakeRpcCall): unknown {
    switch (tag) {
      case "apps.createEmbedThread": {
        const threadId = `thread-${this.nextThread++}`;
        this.rpcThreads.set(threadId, { ...structuredClone(this.threadDefaults), messages: [] });
        return { threadId };
      }
      case "orchestration.getThreadProjection": {
        const t = this.rpcThread(payload.threadId);
        return { thread: { modelSelection: t.modelSelection, runtimeMode: t.runtimeMode, interactionMode: t.interactionMode }, messages: t.messages.map((text) => ({ text })), runs: t.messages.map(() => ({})) };
      }
      case "orchestration.dispatchCommand": {
        const t = this.rpcThread(payload.threadId);
        if (payload.type === "thread.runtime-mode.set") t.runtimeMode = payload.runtimeMode as string;
        if (payload.type === "thread.interaction-mode.set") t.interactionMode = payload.interactionMode as string;
        if (payload.type === "thread.model-selection.set") t.modelSelection = payload.modelSelection as Record<string, unknown>;
        return { sequence: 1 };
      }
      case "server.getConfig": {
        const instances = new Set(["caller-instance", "default-instance", ...this.disabledInstances]);
        const providerInstances = Object.fromEntries([...instances].map((id) => [id, { driver: "codex", enabled: !this.disabledInstances.has(id) }]));
        return { settings: { providerInstances, projectSettingsOverrides: this.projectOverrides } };
      }
      case "orchestration.launchThread": {
        const t = this.rpcThread(payload.threadId);
        const model = payload.modelSelection as Record<string, unknown>;
        if (this.disabledInstances.has(model.instanceId as string)) throw new LecturnRpcError(`orchestration.launchThread failed: {"message":"Provider instance \\"${String(model.instanceId)}\\" is disabled for project p."}`);
        if (!this.launchReceipts.has(payload.commandId as string)) {
          this.launchReceipts.add(payload.commandId as string);
          t.modelSelection = model;
          t.messages.push((payload.initialMessage as { text: string }).text);
        }
        return { threadId: payload.threadId, resumed: false };
      }
      default:
        throw new LecturnRpcError(`${tag}: unknown to the fake`);
    }
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
