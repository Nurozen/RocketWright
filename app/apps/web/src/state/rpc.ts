/**
 * Typed WebSocket client for IF10 (`@rw/contracts` `rpc.ts`). The server
 * speaks first with a `hello` frame; the client refuses (closes) on an RPC or
 * JSON schema version mismatch (D19c). Requests get exactly one response;
 * pushes fan out to topic listeners.
 *
 * Sticky topics (`lecturn.status`, B10; `embed.threads`, B12): the server
 * sends them right after `hello`, often in the same read as `hello` itself,
 * before any caller could subscribe. The client keeps the last payload of
 * each sticky topic (per project for `embed.threads`) and hands it to every
 * new listener of that topic at once.
 */
import { RPC_VERSION, SCHEMA_VERSION } from "@rw/contracts";
import type { RpcError, RpcHelloFrame, RpcMethod, RpcParams, RpcResult, RpcTopic, RpcTopics, ServerFrame } from "@rw/contracts";

/** The subset of the WebSocket API the client needs (browser and Node 24 globals both fit). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error", fn: () => void): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
}

/** What the store needs from a connection (tests may substitute a fake). */
export interface RpcLike {
  readonly hello: RpcHelloFrame;
  call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>;
  on<T extends RpcTopic>(topic: T, fn: (payload: RpcTopics[T]) => void): () => void;
  onClose(fn: (reason: string) => void): () => void;
  close(): void;
}

/** A failed request; `code` is the IF10 error code (or `closed` / `version_mismatch` client-side). */
export class RpcCallError extends Error {
  readonly code: RpcError["code"] | "closed";
  readonly api: RpcError["api"];
  constructor(code: RpcError["code"] | "closed", message: string, api?: RpcError["api"]) {
    super(message);
    this.name = "RpcCallError";
    this.code = code;
    this.api = api;
  }
}

/** Throws unless the hello frame matches this client's RPC and schema versions (D19c). */
export function checkHello(hello: RpcHelloFrame): void {
  if (hello.rpc !== RPC_VERSION || hello.schema !== SCHEMA_VERSION) {
    throw new RpcCallError(
      "version_mismatch",
      `server speaks ${String(hello.rpc)} / ${String(hello.schema)}; this UI needs ${RPC_VERSION} / ${SCHEMA_VERSION}`,
    );
  }
}

type Pending = { resolve(v: unknown): void; reject(e: Error): void };

/** Topics whose last payload a new listener gets on subscribing. */
export const STICKY_TOPICS: ReadonlySet<RpcTopic> = new Set<RpcTopic>(["lecturn.status", "embed.threads"]);

/** Which payloads of a sticky topic are kept apart: one per project for `embed.threads`, else one. */
function stickyKey(topic: RpcTopic, payload: unknown): string {
  const projectId = topic === "embed.threads" ? (payload as { projectId?: unknown } | null)?.projectId : undefined;
  return typeof projectId === "string" ? `${topic}\u0000${projectId}` : topic;
}

export class RpcClient implements RpcLike {
  readonly hello: RpcHelloFrame;
  private readonly ws: SocketLike;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<RpcTopic, Set<(p: never) => void>>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  /** Sticky topic → `stickyKey` → last payload. */
  private readonly sticky = new Map<RpcTopic, Map<string, unknown>>();
  private closed: string | null = null;

  private constructor(ws: SocketLike, hello: RpcHelloFrame) {
    this.ws = ws;
    this.hello = hello;
  }

  /**
   * Opens `url` and resolves once a compatible `hello` arrives. Rejects with
   * `version_mismatch` (after closing the socket) when the versions differ.
   */
  static connect(url: string, opts: { WebSocket?: new (url: string) => SocketLike; timeoutMs?: number } = {}): Promise<RpcClient> {
    const Ctor = opts.WebSocket ?? (globalThis.WebSocket as unknown as new (url: string) => SocketLike);
    const ws = new Ctor(url);
    return new Promise((resolve, reject) => {
      let client: RpcClient | null = null;
      const early: ServerFrame[] = [];
      const timer = setTimeout(() => {
        ws.close();
        reject(new RpcCallError("closed", `no hello from ${url}`));
      }, opts.timeoutMs ?? 5000);
      ws.addEventListener("message", (e) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(String(e.data)) as ServerFrame;
        } catch {
          return;
        }
        if (client !== null) return client.onFrame(frame);
        if (frame.kind !== "hello") return void early.push(frame);
        clearTimeout(timer);
        try {
          checkHello(frame);
        } catch (err) {
          ws.close(4000, "version_mismatch");
          return reject(err as Error);
        }
        client = new RpcClient(ws, frame);
        for (const f of early) client.onFrame(f);
        resolve(client);
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        if (client === null) reject(new RpcCallError("closed", `connection to ${url} closed before hello`));
        else client.onClosed("socket closed");
      });
      ws.addEventListener("error", () => {
        if (client === null) {
          clearTimeout(timer);
          reject(new RpcCallError("closed", `cannot connect to ${url}`));
        }
      });
    });
  }

  call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    if (this.closed !== null) return Promise.reject(new RpcCallError("closed", `${method}: ${this.closed}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ kind: "request", id, method, params }));
    });
  }

  on<T extends RpcTopic>(topic: T, fn: (payload: RpcTopics[T]) => void): () => void {
    let set = this.listeners.get(topic);
    if (set === undefined) this.listeners.set(topic, (set = new Set()));
    set.add(fn as (p: never) => void);
    for (const payload of [...(this.sticky.get(topic)?.values() ?? [])]) fn(payload as RpcTopics[T]);
    return () => void set.delete(fn as (p: never) => void);
  }

  onClose(fn: (reason: string) => void): () => void {
    this.closeListeners.add(fn);
    return () => void this.closeListeners.delete(fn);
  }

  close(): void {
    this.ws.close();
    this.onClosed("closed by client");
  }

  private onFrame(frame: ServerFrame): void {
    if (frame.kind === "response") {
      const p = this.pending.get(frame.id);
      if (p === undefined) return;
      this.pending.delete(frame.id);
      if (frame.ok) p.resolve(frame.result);
      else p.reject(new RpcCallError(frame.error.code, frame.error.message, frame.error.api));
    } else if (frame.kind === "push") {
      if (STICKY_TOPICS.has(frame.topic)) {
        let kept = this.sticky.get(frame.topic);
        if (kept === undefined) this.sticky.set(frame.topic, (kept = new Map()));
        kept.set(stickyKey(frame.topic, frame.payload), frame.payload);
      }
      for (const fn of this.listeners.get(frame.topic) ?? []) (fn as (p: unknown) => void)(frame.payload);
    }
  }

  private onClosed(reason: string): void {
    if (this.closed !== null) return;
    this.closed = reason;
    for (const p of this.pending.values()) p.reject(new RpcCallError("closed", reason));
    this.pending.clear();
    for (const fn of this.closeListeners) fn(reason);
  }
}
