/**
 * Electron main's own IF10 client (B6, D2), Electron-free so plain Node tests
 * it. Main reaches the app-server child only through its stdout lines and
 * this socket on `rpcUrl` (the URL carries the per-launch token; a socket
 * without a browser `Origin` is accepted with it).
 *
 * - `projects`: every project the child has open, seeded from `project.list`
 *   after `hello` (the CLI's `--project` dirs open before main connects) and
 *   kept current by the `project.opened`, `project.updated` and
 *   `project.closed` pushes; `onProjectOpened` fires once per opening, in that
 *   order, so a project closed and opened again fires twice. Recents never
 *   hang off it: `rwDesktop.setActiveProject` feeds those.
 * - `call`: any IF10 method (`embed.target` for the chat pane, B8/B10).
 * - `lecturnStatus`: the child's last `lecturn.status` push (null before the
 *   first); `onLecturnStatus` fires on each one, so the pane follows a live
 *   switch (D25, B10).
 * - `mainToken` claims the host channel (D11) once seeding is done, and each
 *   `host.request` then goes to `onHostRequest`. Anything but a clear answer is
 *   a refusal, and a closing socket aborts the handler's `signal`.
 */
import { RPC_VERSION, type HostRequest, type HostResponse, type LecturnStatus, type ProjectInfo, type RpcError, type RpcMethod, type RpcParams, type RpcResult, type ServerFrame } from "@rw/contracts";

export interface MainRpcOptions {
  /** Called once per newly seen project (seeded ones included). */
  onProjectOpened?: (project: ProjectInfo) => void;
  /** Called on every `lecturn.status` push (the first arrives right after `hello`). */
  onLecturnStatus?: (status: LecturnStatus) => void;
  /** The server's `RW_MAIN_TOKEN`: claims the host channel. Without it this socket is an ordinary client. */
  mainToken?: string | null;
  /**
   * Answers a `host.request` (one consent dialog); the answer is sent as
   * `host.respond`. A throw, or no handler, sends a refusal. `signal` fires when
   * the socket closes, since nobody can receive the answer then.
   */
  onHostRequest?: (request: HostRequest, signal: AbortSignal) => HostAnswer | Promise<HostAnswer>;
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

/** What `onHostRequest` decides; the request id is filled in here. */
export type HostAnswer = Omit<HostResponse, "requestId">;

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
  let seeding: (() => void)[] | null = [];
  let status: LecturnStatus | null = null;
  const answering = new Set<AbortController>();

  const see = (p: ProjectInfo): void => {
    if (seen.has(p.projectId)) return;
    seen.set(p.projectId, { ...p });
    opts.onProjectOpened?.({ ...p });
  };

  const apply = (change: () => void): void => {
    if (seeding !== null) seeding.push(change);
    else change();
  };

  const shut = (why: string): void => {
    if (closed) return;
    closed = true;
    for (const [id, r] of pending) {
      clearTimeout(r.timer);
      r.fail(new Error(`${r.method}: ${why}`));
      pending.delete(id);
    }
    for (const a of answering) a.abort(new Error(why));
    answering.clear();
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
      apply(() => see(project));
    } else if (f.kind === "push" && f.topic === "project.closed") {
      const { projectId } = f.payload as { projectId: string };
      apply(() => seen.delete(projectId));
    } else if (f.kind === "push" && f.topic === "project.updated") {
      const { project } = f.payload as { project: ProjectInfo };
      apply(() => {
        if (seen.has(project.projectId)) seen.set(project.projectId, { ...project });
      });
    } else if (f.kind === "push" && f.topic === "lecturn.status") {
      status = f.payload as LecturnStatus;
      opts.onLecturnStatus?.(status);
    } else if (f.kind === "push" && f.topic === "host.request") {
      void answerHost(f.payload as HostRequest);
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

  const answerHost = async (request: HostRequest): Promise<void> => {
    const abort = new AbortController();
    answering.add(abort);
    let answer: HostAnswer = { accepted: false };
    try {
      if (opts.onHostRequest !== undefined) answer = await opts.onHostRequest(request, abort.signal);
    } catch {
      answer = { accepted: false };
    } finally {
      answering.delete(abort);
    }
    // A closed socket already failed the server's side of this request.
    if (!closed) await call("host.respond", { ...answer, requestId: request.requestId }).catch(() => undefined);
  };

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
    for (const change of early) change();
    if (opts.mainToken !== undefined && opts.mainToken !== null) await call("host.register", { token: opts.mainToken });
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
