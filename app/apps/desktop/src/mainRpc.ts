/**
 * Electron main's own IF10 client (B6, D2), Electron-free so plain Node tests
 * it. Main reaches the app-server child only through its stdout lines and
 * this socket on `rpcUrl` (the URL carries the per-launch token; a socket
 * without a browser `Origin` is accepted with it).
 *
 * - `projects`: every project the child has open, seeded from `project.list`
 *   after `hello` (the CLI's `--project` dirs open before main connects) and
 *   kept current by the `project.opened` push; `onProjectOpened` fires once
 *   per project id, in that order.
 * - `call`: any IF10 method (`embed.target` for the chat pane, B8/B10).
 * - `lecturnStatus`: the child's last `lecturn.status` push (null before the
 *   first); `onLecturnStatus` fires on each one, so the pane follows a live
 *   switch (D25, B10).
 */
import { RPC_VERSION, type LecturnStatus, type ProjectInfo, type RpcError, type RpcMethod, type RpcParams, type RpcResult, type ServerFrame } from "@rw/contracts";

export interface MainRpcOptions {
  /** Called once per newly seen project (seeded ones included). */
  onProjectOpened?: (project: ProjectInfo) => void;
  /** Called on every `lecturn.status` push (the first arrives right after `hello`). */
  onLecturnStatus?: (status: LecturnStatus) => void;
  /** Called once when the socket closes or errors after connecting. */
  onClose?: () => void;
  /** Connect + hello + `project.list` deadline (default 30 s). */
  timeoutMs?: number;
  /** Per-request deadline (default 120 s). */
  requestTimeoutMs?: number;
}

export interface MainRpc {
  /** Open projects in the order they were first seen. */
  projects(): ProjectInfo[];
  /** The last `lecturn.status` push, or null before the first. */
  lecturnStatus(): LecturnStatus | null;
  call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>;
  close(): void;
}

/** An IF10 error response. */
export class MainRpcError extends Error {
  readonly code: RpcError["code"];
  constructor(method: string, error: RpcError) {
    super(`${method}: ${error.code}: ${error.message}`);
    this.code = error.code;
  }
}

/** Connects, checks `hello`, seeds the project list, and resolves once that is done. */
export async function connectMainRpc(rpcUrl: string, opts: MainRpcOptions = {}): Promise<MainRpc> {
  const ws = new WebSocket(rpcUrl);
  const seen = new Map<string, ProjectInfo>();
  const pending = new Map<number, { method: string; ok: (r: unknown) => void; fail: (e: Error) => void; timer: NodeJS.Timeout }>();
  let nextId = 1;
  let closed = false;
  let hello: (() => void) | null = null;
  let helloFail: ((e: Error) => void) | null = null;
  // Pushes that arrive before the seed list finishes are applied after it, so order stays push-consistent.
  let seeding: ProjectInfo[] | null = [];
  let status: LecturnStatus | null = null;

  const see = (p: ProjectInfo): void => {
    if (seen.has(p.projectId)) return;
    seen.set(p.projectId, { ...p });
    opts.onProjectOpened?.({ ...p });
  };

  const shut = (why: string): void => {
    if (closed) return;
    closed = true;
    for (const [id, r] of pending) {
      clearTimeout(r.timer);
      r.fail(new Error(`${r.method}: ${why}`));
      pending.delete(id);
    }
    helloFail?.(new Error(why));
    opts.onClose?.();
  };

  ws.addEventListener("message", (e) => {
    let f: ServerFrame;
    try {
      f = JSON.parse(String(e.data)) as ServerFrame;
    } catch {
      return;
    }
    if (f.kind === "hello") {
      if (f.rpc !== RPC_VERSION) {
        helloFail?.(new Error(`RPC version mismatch: server ${String(f.rpc)}, main ${RPC_VERSION}`));
        ws.close();
        return;
      }
      hello?.();
    } else if (f.kind === "response") {
      const r = pending.get(f.id);
      if (r === undefined) return;
      pending.delete(f.id);
      clearTimeout(r.timer);
      if (f.ok) r.ok(f.result);
      else r.fail(new MainRpcError(r.method, f.error));
    } else if (f.kind === "push" && f.topic === "project.opened") {
      const { project } = f.payload as { project: ProjectInfo };
      if (seeding !== null) seeding.push(project);
      else see(project);
    } else if (f.kind === "push" && f.topic === "lecturn.status") {
      status = f.payload as LecturnStatus;
      opts.onLecturnStatus?.(status);
    }
  });
  ws.addEventListener("close", () => shut("RPC socket closed"));
  ws.addEventListener("error", () => shut(`RPC socket error at ${redact(rpcUrl)}`));

  const call = <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> =>
    new Promise((ok, fail) => {
      if (closed) return fail(new Error(`${method}: RPC socket closed`));
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        fail(new Error(`${method}: no response within ${opts.requestTimeoutMs ?? 120_000} ms`));
      }, opts.requestTimeoutMs ?? 120_000);
      pending.set(id, { method, ok: ok as (r: unknown) => void, fail, timer });
      ws.send(JSON.stringify({ kind: "request", id, method, params }));
    });

  const timeoutMs = opts.timeoutMs ?? 30_000;
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise<void>((ok, fail) => {
        hello = ok;
        helloFail = fail;
      }),
      new Promise<never>((_ok, fail) => {
        deadline = setTimeout(() => fail(new Error(`RPC hello not received within ${timeoutMs} ms at ${redact(rpcUrl)}`)), timeoutMs);
      }),
    ]);
    helloFail = null;
    const { projects } = await call("project.list", {});
    const early = seeding;
    seeding = null;
    for (const p of projects) see(p);
    for (const p of early) see(p);
  } catch (e) {
    ws.close();
    shut("connect failed");
    throw e;
  } finally {
    clearTimeout(deadline);
  }

  return {
    projects: () => [...seen.values()].map((p) => ({ ...p })),
    lecturnStatus: () => status,
    call,
    close: () => {
      ws.close();
      shut("closed by main");
    },
  };
}

/** `rpcUrl` without its token, for messages. */
function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("token")) u.searchParams.set("token", "…");
    return u.toString();
  } catch {
    return "<rpc url>";
  }
}
