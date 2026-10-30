/**
 * Keeps one `rocketwright mcp --project <dir> --app` sidecar alive per project
 * (R6.1). Spawns it, reports `starting | ready | restarting | failed`
 * (IF10 `SidecarState`), and restarts it with exponential backoff when it
 * exits without `stop()`. After `maxAttempts` consecutive failed starts it
 * gives up (`failed`); `restart()` tries again on demand.
 *
 * It is the `SidecarLike` the HTTP MCP proxy and the RPC layer call: calls
 * made while the sidecar is restarting wait (up to `callWaitMs`) for it.
 */
import type { SidecarState } from "@rw/contracts";
import { SidecarClient, type SidecarCallResult, type SidecarLike, type SidecarTool } from "./SidecarClient.ts";

/** What the supervisor needs from one sidecar connection (a `SidecarClient`, or a test fake). */
export interface SidecarConnection extends SidecarLike {
  start(opts: { projectDir: string; bin?: string; stderr?: "inherit" | "ignore" | "pipe" }): Promise<void>;
  stop(): Promise<void>;
  onClose(cb: () => void): () => void;
  onResourceUpdated(cb: (uri: string) => void): () => void;
  /** The relay front moved to a new project owner (B1b); optional for test doubles. */
  onUpstreamChanged?(cb: () => void): () => void;
  subscribe(uri: string): Promise<unknown>;
  unsubscribe(uri: string): Promise<unknown>;
  readJson(uri: string): Promise<unknown>;
  serverVersion(): { name: string; version: string } | undefined;
  pid(): number | null;
}

export interface BackoffOptions {
  /** First restart delay (default 250 ms). */
  initialMs?: number;
  /** Delay cap (default 8 s). */
  maxMs?: number;
  /** Multiplier per consecutive failure (default 2). */
  factor?: number;
  /** Consecutive failed starts before `failed` (default 6). */
  maxAttempts?: number;
}

export interface SupervisorOptions {
  projectDir: string;
  bin?: string;
  stderr?: "inherit" | "ignore" | "pipe";
  backoff?: BackoffOptions;
  /** How long a call waits for a restarting sidecar (default 15 s). */
  callWaitMs?: number;
  /** Connection factory (tests inject fakes). */
  connect?: () => SidecarConnection;
}

/** Delay before restart attempt `n` (0-based). */
export function backoffDelay(n: number, b: BackoffOptions = {}): number {
  const initial = b.initialMs ?? 250;
  const max = b.maxMs ?? 8000;
  const factor = b.factor ?? 2;
  return Math.min(max, initial * factor ** n);
}

export class SidecarUnavailable extends Error {}

type Listener<T> = (v: T) => void;

export class SidecarSupervisor implements SidecarLike {
  private readonly opts: SupervisorOptions;
  private conn: SidecarConnection | undefined;
  private st: SidecarState = "starting";
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private readyWaiters: { ok: () => void; fail: (e: Error) => void }[] = [];
  private readonly stateListeners = new Set<Listener<SidecarState>>();
  private readonly readyListeners = new Set<Listener<SidecarConnection>>();
  private readonly updateListeners = new Set<Listener<string>>();
  private readonly upstreamListeners = new Set<Listener<SidecarConnection>>();
  /** Every start, including restarts (tests and diagnostics). */
  starts = 0;

  constructor(opts: SupervisorOptions) {
    this.opts = opts;
  }

  get state(): SidecarState {
    return this.st;
  }

  /** `serverInfo.version` of the live sidecar, if any. */
  version(): string | null {
    return this.conn?.serverVersion()?.version ?? null;
  }

  pid(): number | null {
    return this.conn?.pid() ?? null;
  }

  onState(cb: Listener<SidecarState>): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  /** Called after every successful (re)start, before waiting calls resume. */
  onReady(cb: Listener<SidecarConnection>): () => void {
    this.readyListeners.add(cb);
    return () => this.readyListeners.delete(cb);
  }

  onResourceUpdated(cb: Listener<string>): () => void {
    this.updateListeners.add(cb);
    return () => this.updateListeners.delete(cb);
  }

  /** The live connection's relay reconnected or promoted (B1b): resync from it. */
  onUpstreamChanged(cb: Listener<SidecarConnection>): () => void {
    this.upstreamListeners.add(cb);
    return () => this.upstreamListeners.delete(cb);
  }

  /** First start; rejects if the sidecar cannot start at all (no backoff on the first try). */
  async start(): Promise<void> {
    this.setState("starting");
    try {
      await this.spawn();
    } catch (e) {
      this.setState("failed");
      this.flushWaiters(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  }

  /** Manual restart (e.g. after `failed`): resets the attempt counter. */
  restart(): void {
    if (this.stopped) return;
    this.attempts = 0;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const old = this.conn;
    this.conn = undefined;
    this.setState("restarting");
    void (async () => {
      if (old !== undefined) await old.stop().catch(() => undefined);
      this.schedule(0);
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const c = this.conn;
    this.conn = undefined;
    this.flushWaiters(new SidecarUnavailable("sidecar stopped"));
    if (c !== undefined) await c.stop();
  }

  /** The live connection, waiting for a restart if one is under way. */
  async ready(timeoutMs = this.opts.callWaitMs ?? 15_000): Promise<SidecarConnection> {
    if (this.conn !== undefined && this.st === "ready") return this.conn;
    if (this.stopped || this.st === "failed") throw new SidecarUnavailable(`sidecar ${this.stopped ? "stopped" : "failed"}`);
    await new Promise<void>((ok, fail) => {
      const w = {
        ok: () => {
          clearTimeout(t);
          ok();
        },
        fail: (e: Error) => {
          clearTimeout(t);
          fail(e);
        },
      };
      const t = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((x) => x !== w);
        fail(new SidecarUnavailable(`sidecar not ready after ${timeoutMs} ms (${this.st})`));
      }, timeoutMs);
      this.readyWaiters.push(w);
    });
    if (this.conn === undefined) throw new SidecarUnavailable("sidecar unavailable");
    return this.conn;
  }

  async listTools(): Promise<SidecarTool[]> {
    return (await this.ready()).listTools();
  }

  async callTool(name: string, args: Record<string, unknown>, meta: Record<string, unknown>): Promise<SidecarCallResult> {
    return (await this.ready()).callTool(name, args, meta);
  }

  // ---- internals ----

  private async spawn(): Promise<void> {
    const conn = (this.opts.connect ?? (() => new SidecarClient()))();
    this.starts++;
    conn.onResourceUpdated((uri) => {
      if (this.conn === conn) for (const l of this.updateListeners) l(uri);
    });
    conn.onUpstreamChanged?.(() => {
      if (this.conn === conn) for (const l of this.upstreamListeners) l(conn);
    });
    conn.onClose(() => this.lost(conn));
    const startOpts: { projectDir: string; bin?: string; stderr?: "inherit" | "ignore" | "pipe" } = { projectDir: this.opts.projectDir };
    if (this.opts.bin !== undefined) startOpts.bin = this.opts.bin;
    if (this.opts.stderr !== undefined) startOpts.stderr = this.opts.stderr;
    await conn.start(startOpts);
    if (this.stopped) {
      await conn.stop();
      return;
    }
    this.conn = conn;
    for (const l of this.readyListeners) {
      try {
        l(conn);
      } catch {
        // a listener failure must not take the sidecar down
      }
    }
    this.attempts = 0;
    this.setState("ready");
    this.flushWaiters();
  }

  private lost(conn: SidecarConnection): void {
    if (this.stopped || this.conn !== conn) return;
    this.conn = undefined;
    this.setState("restarting");
    this.schedule(backoffDelay(0, this.opts.backoff));
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.spawn().catch(() => {
        this.attempts++;
        if (this.attempts >= (this.opts.backoff?.maxAttempts ?? 6)) {
          this.setState("failed");
          this.flushWaiters(new SidecarUnavailable(`sidecar failed to restart after ${this.attempts} attempts`));
          return;
        }
        this.schedule(backoffDelay(this.attempts, this.opts.backoff));
      });
    }, delay);
  }

  private setState(s: SidecarState): void {
    if (this.st === s) return;
    this.st = s;
    for (const l of this.stateListeners) l(s);
  }

  private flushWaiters(err?: Error): void {
    const ws = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of ws) if (err === undefined) w.ok();
    else w.fail(err);
  }
}
