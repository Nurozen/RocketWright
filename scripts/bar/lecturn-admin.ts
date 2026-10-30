/**
 * W-B2's admin side (plan B16; D16, decisions 12, 13, 16, 19): the harness
 * plays the user's Lecturn client against the Lecturn sidecar and, for
 * W-B2.4, the user's own Lecturn server.
 *
 * - Session (D16): `lecturn auth session issue --base-dir <dir> --scope
 *   access:write --scope orchestration:read --scope orchestration:operate
 *   --token-only` (plus `access:read`, which `apps.list` needs), written
 *   offline into the sidecar's base dir (`RW_LECTURN_BASE_DIR`) or the temp
 *   user-server home (`LECTURN_HOME`). `LecturnAdminSession` extends B14's
 *   `LecturnAdmin` (`app/e2e/capture/scripted.ts`).
 * - Thread: `subscribeThread` streams `orchestration.subscribeThread`
 *   (Effect RPC chunks, acknowledged one by one); each chunk only says
 *   "something changed", and the harness re-reads the projection
 *   (`orchestration.getThreadProjection`), which `lecturn-transcript.ts`
 *   maps to the B4(b) driver's timeline events.
 * - Approvals: `answerApprovals` answers every pending `connectedAppTool`
 *   runtime request of a thread with `runtime-request.respond` (Lecturn D1)
 *   as `decide` says, logging each one (`ApprovalLogEntry`).
 * - Pairing (W-B2.4): `apps.list` shows RocketWright's pending pairing
 *   request on the user server; `apps.decidePairing` grants it.
 * - `UserServer`: `lecturn serve --base-dir <LECTURN_HOME>` (the server the
 *   helper watches for, decision 16), stopped by the pid it was spawned with.
 * - The copy ledger's pure checks (decisions 7, 13): `copiesOf`,
 *   `copyMark`, `copiesUnchanged`.
 *
 * Never reads `~/.lecturn`: every base dir is a temp dir the caller passes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readServerOrigin, socketUrl, websocketTicket, type SocketLike } from "../../app/apps/server/src/lecturn/appsRpc.ts";
import { issueAdminToken, LecturnAdmin, lecturnBin, SCRIPTED_SETTINGS } from "../../app/e2e/capture/scripted.ts";
import type { TranscriptProjection } from "../../app/e2e/lecturn-transcript.ts";
import type { EmbedThread } from "../../app/packages/contracts/src/rpc.ts";

/** RocketWright's Lecturn app id (`apps/server/src/lecturn/registration.ts` `RW_APP_ID`). */
export const RW_APP_ID = "dev.rocketwright.app";
/** Lecturn runtime modes: Supervised, Full access, Auto (decision 2). */
export type RuntimeMode = "approval-required" | "full-access" | "auto";
export const RUNTIME_MODE_LABEL: Record<RuntimeMode, string> = { "approval-required": "Supervised", "full-access": "Full access", auto: "Auto" };

export interface ModelSelection {
  instanceId: string;
  model: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- streaming RPC --------------------------------------------------------------

export interface LecturnStream {
  /** Settles when the stream ends: resolves on a successful Exit or `close()`, rejects on a failure. */
  readonly done: Promise<void>;
  close(): void;
}

/**
 * One streamed Lecturn RPC on its own socket (Effect RPC JSON: a `Request`
 * out; `Chunk {requestId, values}` back, each answered with `Ack`, until an
 * `Exit`). `onValues` gets every chunk's values.
 */
export async function lecturnStream(
  origin: string,
  bearer: string,
  tag: string,
  payload: unknown,
  onValues: (values: readonly unknown[]) => void,
  o: { fetch?: typeof globalThis.fetch; socket?: (url: string) => SocketLike } = {},
): Promise<LecturnStream> {
  const ticket = await websocketTicket(origin, bearer, o.fetch);
  const ws = o.socket?.(socketUrl(origin, ticket)) ?? (new WebSocket(socketUrl(origin, ticket)) as unknown as SocketLike);
  const id = "1";
  let settle: { ok: () => void; fail: (e: Error) => void } = { ok: () => undefined, fail: () => undefined };
  const done = new Promise<void>((ok, fail) => (settle = { ok, fail }));
  let finished = false;
  const finish = (err: Error | null): void => {
    if (finished) return;
    finished = true;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
    if (err === null) settle.ok();
    else settle.fail(err);
  };
  ws.onopen = () => ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
  ws.onerror = () => finish(new Error(`${tag}: the socket failed`));
  ws.onclose = () => finish(new Error(`${tag}: the socket closed before the stream ended`));
  ws.onmessage = (ev) => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8"));
    } catch {
      return;
    }
    for (const m of Array.isArray(decoded) ? decoded : [decoded]) {
      if (!isObject(m) || finished) continue;
      if (m["_tag"] === "Defect") return finish(new Error(`${tag}: defect ${JSON.stringify(m["defect"])}`));
      if (String(m["requestId"]) !== id) continue;
      if (m["_tag"] === "Chunk" && Array.isArray(m["values"])) {
        try {
          onValues(m["values"]);
        } finally {
          ws.send(JSON.stringify({ _tag: "Ack", requestId: id }));
        }
      } else if (m["_tag"] === "Exit") {
        const exit = m["exit"];
        return finish(isObject(exit) && exit["_tag"] === "Success" ? null : new Error(`${tag} failed: ${JSON.stringify(isObject(exit) ? exit["cause"] : exit)}`));
      }
    }
  };
  return {
    done,
    close: () => {
      if (finished) return;
      try {
        ws.send(JSON.stringify({ _tag: "Interrupt", requestId: id, interruptors: [] }));
      } catch {
        /* closing anyway */
      }
      finish(null);
    },
  };
}

// ---- the admin session ----------------------------------------------------------

/** The projection slice the harness reads (runs carry their ordinal). */
export type AdminProjection = TranscriptProjection & { runs: readonly { id: string; ordinal?: number; status: string }[] };

/** `apps.list` entries, as far as the harness reads them. */
export interface AppStatusLike {
  appId: string;
  pendingRequest?: { requestId: string } | null;
  live?: unknown;
}

/** The orchestration and Settings calls the harness makes as the user (D16). */
export class LecturnAdminSession extends LecturnAdmin {
  /** Issues a session against the Lecturn server running in `baseDir` (its `userdata/server-runtime.json`). */
  static override async open(baseDir: string, env: NodeJS.ProcessEnv = process.env): Promise<LecturnAdminSession> {
    const origin = readServerOrigin(baseDir);
    if (origin === null) throw new Error(`no Lecturn server runs in ${baseDir}`);
    return new LecturnAdminSession(origin, await issueAdminToken(baseDir, env));
  }

  /** The same bearer against another origin of the same base dir (a server restarted on a new port). */
  at(origin: string): LecturnAdminSession {
    return new LecturnAdminSession(origin, this.token);
  }

  /** Settled tool outputs fetched so far (`<thread>:<item>:<status>`). */
  private readonly outputs = new Map<string, unknown>();

  /**
   * The thread's projection as `lecturn-transcript.ts` reads it. The wire
   * projection compacts a `dynamic_tool` item's output to its summary and
   * card reference (`outputOmitted`, Lecturn `WireProjection.ts`), so each
   * settled tool's full result is read once with `orchestration.getTurnItem`.
   */
  async transcript(threadId: string): Promise<AdminProjection> {
    const p = (await this.projection(threadId)) as unknown as AdminProjection;
    const items = await Promise.all(
      p.turnItems.map(async (i) => {
        const omitted = (i as { outputOmitted?: boolean }).outputOmitted === true;
        if (i.type !== "dynamic_tool" || !omitted || (i.status !== "completed" && i.status !== "failed")) return i;
        const key = `${threadId}:${i.id}:${i.status}`;
        if (!this.outputs.has(key)) {
          const r = (await this.call("orchestration.getTurnItem", { threadId, itemId: i.id })) as { item?: { output?: unknown } | null };
          if (r.item === null || r.item === undefined) return i;
          this.outputs.set(key, r.item.output);
        }
        return { ...i, output: this.outputs.get(key) };
      }),
    );
    return { ...p, turnItems: items };
  }

  setRuntimeMode(threadId: string, runtimeMode: RuntimeMode): Promise<unknown> {
    return this.dispatch({ type: "thread.runtime-mode.set", threadId, runtimeMode });
  }

  /** A user message, as the composer sends it (a scripted turn's script travels in it as a ```scripted block). */
  sendMessage(threadId: string, text: string, modelSelection?: ModelSelection): Promise<unknown> {
    return this.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId: `rw-bar-${randomUUID()}`,
      text,
      attachments: [],
      ...(modelSelection === undefined ? {} : { modelSelection }),
      dispatchMode: { type: "start_immediately" },
    });
  }

  respond(threadId: string, requestId: string, decision: "accept" | "decline"): Promise<unknown> {
    return this.dispatch({ type: "runtime-request.respond", threadId, requestId, decision });
  }

  async appsList(): Promise<AppStatusLike[]> {
    return (await this.call("apps.list", {})) as AppStatusLike[];
  }

  async app(appId = RW_APP_ID): Promise<AppStatusLike | null> {
    return (await this.appsList()).find((a) => a.appId === appId) ?? null;
  }

  decidePairing(requestId: string, decision: "grant" | "deny"): Promise<unknown> {
    return this.call("apps.decidePairing", { requestId, decision });
  }

  /**
   * The shell snapshot the user's Lecturn client starts from
   * (`orchestration.subscribeShell`'s first `snapshot` item): projects with
   * their `appBinding`, and threads. What the Apps sidebar groups (`appThreads`).
   */
  async shell(timeoutMs = 20_000): Promise<ShellLike> {
    let stream: LecturnStream | null = null;
    let settled = false;
    try {
      return await new Promise<ShellLike>((resolve, reject) => {
        const timer = setTimeout(() => {
          settled = true;
          reject(new Error(`orchestration.subscribeShell sent no snapshot within ${timeoutMs} ms`));
        }, timeoutMs);
        const done = (f: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          f();
        };
        lecturnStream(this.origin, this.token, "orchestration.subscribeShell", {}, (values) => {
          for (const v of values) {
            if (isObject(v) && v["kind"] === "snapshot" && isObject(v["snapshot"])) done(() => resolve(v["snapshot"] as unknown as ShellLike));
          }
        }).then(
          (st) => {
            stream = st;
            if (settled) st.close();
            st.done.catch((e: unknown) => done(() => reject(e instanceof Error ? e : new Error(String(e)))));
          },
          (e: unknown) => done(() => reject(e instanceof Error ? e : new Error(String(e)))),
        );
      });
    } finally {
      (stream as LecturnStream | null)?.close();
    }
  }

  /** Streams `orchestration.subscribeThread`; `onChange` runs once per chunk. */
  subscribeThread(threadId: string, onChange: () => void): Promise<LecturnStream> {
    return lecturnStream(this.origin, this.token, "orchestration.subscribeThread", { threadId }, () => onChange());
  }
}

/** The shell snapshot, as far as the harness reads it (Lecturn `OrchestrationV2ShellSnapshot`). */
export interface ShellLike {
  projects: readonly { id: string; title: string; appBinding?: { appId: string; workspaceRoot: string } }[];
  threads: readonly { id: string; projectId: string; title: string; deletedAt?: string | null }[];
}

/** One app's workspace as the Apps sidebar lists it (Apps > <app> > the workspace's threads). */
export interface AppWorkspaceListing {
  projectId: string;
  projectTitle: string;
  threads: { id: string; title: string }[];
}

/**
 * The threads Lecturn lists under Apps > `appId` for `workspaceRoot`: the
 * projects bound to the app (`appBinding`, as Lecturn's `appGroups` groups
 * them) at that root, with their live threads. Null: no such project.
 */
export function appThreads(shell: ShellLike, appId: string, workspaceRoot: string): AppWorkspaceListing | null {
  const trim = (p: string): string => p.replace(/\/+$/, "");
  const project = shell.projects.find((p) => p.appBinding?.appId === appId && trim(p.appBinding.workspaceRoot) === trim(workspaceRoot));
  if (project === undefined) return null;
  const threads = shell.threads.filter((t) => t.projectId === project.id && (t.deletedAt ?? null) === null).map((t) => ({ id: t.id, title: t.title }));
  return { projectId: project.id, projectTitle: project.title, threads };
}

// ---- approvals ------------------------------------------------------------------

/** One app approval the harness answered. */
export interface ApprovalLogEntry {
  requestId: string;
  threadId: string;
  /** Lecturn's name (`rw_engine_simulate`). */
  toolName: string;
  reason: string | null;
  decision: "accept" | "decline";
  /** ms since `answerApprovals` started. */
  at_ms: number;
}

type RequestLike = TranscriptProjection["runtimeRequests"][number];

/** The thread's pending app approvals (`connectedAppTool` runtime requests) not in `answered`. */
export function pendingAppApprovals(p: Pick<TranscriptProjection, "runtimeRequests">, answered: ReadonlySet<string> = new Set()): RequestLike[] {
  return p.runtimeRequests.filter((r) => r.status === "pending" && r.connectedAppTool !== undefined && !answered.has(r.id));
}

/**
 * The provider's own approval kinds (Lecturn `ProviderRequestKind`): in
 * Supervised a provider may ask before a shell command or file edit. None
 * is part of a W-B2 scenario, so the harness declines them (logged) as the
 * user would, instead of leaving the turn blocked on the card.
 */
export const PROVIDER_APPROVAL_KINDS: readonly string[] = ["command", "file-read", "file-change", "permission", "mcp-elicitation"];

/** One provider request the harness declined. */
export interface ProviderRequestEntry {
  requestId: string;
  threadId: string;
  kind: string;
  decision: "decline";
  /** ms since the answerer started (or since the session's first decline). */
  at_ms: number;
}

/** The thread's pending provider approvals (not app approvals) not in `answered`. */
export function pendingProviderApprovals(p: Pick<TranscriptProjection, "runtimeRequests">, answered: ReadonlySet<string> = new Set()): RequestLike[] {
  return p.runtimeRequests.filter((r) => r.status === "pending" && r.connectedAppTool === undefined && PROVIDER_APPROVAL_KINDS.includes(r.kind ?? "") && !answered.has(r.id));
}

/** Declines each pending provider approval in `p` (logged into `into`). */
export async function declineProviderApprovals(o: {
  admin: Pick<LecturnAdminSession, "respond">;
  threadId: string;
  projection: Pick<TranscriptProjection, "runtimeRequests">;
  answered: Set<string>;
  into: ProviderRequestEntry[];
  t0: number;
  log?: (line: string) => void;
}): Promise<void> {
  for (const r of pendingProviderApprovals(o.projection, o.answered)) {
    o.answered.add(r.id);
    await o.admin.respond(o.threadId, r.id, "decline");
    o.into.push({ requestId: r.id, threadId: o.threadId, kind: r.kind ?? "?", decision: "decline", at_ms: Date.now() - o.t0 });
    o.log?.(`provider request ${r.kind ?? "?"}: decline`);
  }
}

export interface ApprovalAnswerer {
  readonly log: ApprovalLogEntry[];
  /** Provider approvals (shell commands, file edits) declined meanwhile; not app approvals. */
  readonly provider: ProviderRequestEntry[];
  readonly errors: string[];
  /** Re-reads now (the subscription also triggers it). */
  tick(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Answers `threadId`'s app approvals while it runs: on every change the
 * thread's subscription reports (and every `pollMs` besides), each new
 * pending `connectedAppTool` request gets `decide(request)`; `before`
 * runs first (the follow-up turn checks the card is on screen there).
 */
export async function answerApprovals(o: {
  admin: Pick<LecturnAdminSession, "transcript" | "respond"> & Partial<Pick<LecturnAdminSession, "subscribeThread">>;
  threadId: string;
  decide: (r: { toolName: string; reason: string | null }) => "accept" | "decline";
  before?: (r: RequestLike) => Promise<void>;
  log?: (line: string) => void;
  pollMs?: number;
}): Promise<ApprovalAnswerer> {
  const t0 = Date.now();
  const entries: ApprovalLogEntry[] = [];
  const provider: ProviderRequestEntry[] = [];
  const errors: string[] = [];
  const answered = new Set<string>();
  let running: Promise<void> | null = null;
  let again = false;
  const pass = async (): Promise<void> => {
    const p = await o.admin.transcript(o.threadId);
    for (const r of pendingAppApprovals(p, answered)) {
      const app = r.connectedAppTool!;
      answered.add(r.id);
      const decision = o.decide(app);
      try {
        await o.before?.(r);
      } catch (e) {
        errors.push(`before answering ${app.toolName}: ${e instanceof Error ? e.message : String(e)}`);
      }
      await o.admin.respond(o.threadId, r.id, decision);
      entries.push({ requestId: r.id, threadId: o.threadId, toolName: app.toolName, reason: app.reason, decision, at_ms: Date.now() - t0 });
      o.log?.(`approval ${app.toolName} (${app.reason ?? "no reason"}): ${decision}`);
    }
    await declineProviderApprovals({ admin: o.admin, threadId: o.threadId, projection: p, answered, into: provider, t0, ...(o.log === undefined ? {} : { log: o.log }) });
  };
  const tick = async (): Promise<void> => {
    if (running !== null) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await pass().catch((e: unknown) => void errors.push(`approvals: ${e instanceof Error ? e.message : String(e)}`));
      } while (again);
    })().finally(() => (running = null));
    return running;
  };
  let stream: LecturnStream | null = null;
  if (o.admin.subscribeThread !== undefined) {
    stream = await o.admin.subscribeThread(o.threadId, () => void tick()).catch((e: unknown) => {
      o.log?.(`thread subscription failed (polling only): ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    stream?.done.catch(() => undefined);
  }
  const timer = setInterval(() => void tick(), o.pollMs ?? 1000);
  await tick();
  return {
    log: entries,
    provider,
    errors,
    tick,
    stop: async () => {
      clearInterval(timer);
      stream?.close();
      await running;
    },
  };
}

// ---- the user's Lecturn server (W-B2.4) -------------------------------------------

/** The user server's env: no inherited `LECTURN_*` (they would point it at other state), no Electron node mode. */
export function userServerEnv(env: NodeJS.ProcessEnv, testProviders: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k.startsWith("LECTURN_") || k === "ELECTRON_RUN_AS_NODE" || k === "VITE_DEV_SERVER_URL") continue;
    out[k] = v;
  }
  if (testProviders) out["LECTURN_TEST_PROVIDERS"] = "1";
  return out;
}

/** `lecturn serve` on `baseDir` with no port (it picks one and records it in `userdata/server-runtime.json`). */
export function userServerArgs(bin: string, baseDir: string): string[] {
  return [bin, "serve", "--base-dir", baseDir, "--host", "127.0.0.1", "--no-browser"];
}

export interface UserServerRuntime {
  origin: string;
  environmentId: string;
  pid: number;
}

async function environmentIdAt(origin: string): Promise<string | undefined> {
  try {
    const res = await fetch(new URL("/.well-known/lecturn/environment", origin));
    if (!res.ok) return undefined;
    const body = (await res.json()) as { environmentId?: unknown };
    return typeof body.environmentId === "string" ? body.environmentId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The user's Lecturn server in the temp `LECTURN_HOME` (decision 16: the
 * helper watches it). It keeps its home across restarts, so it comes back
 * as the same environment and the stored app credential attaches without a
 * new pairing.
 */
export class UserServer {
  readonly baseDir: string;
  private readonly testProviders: boolean;
  private readonly log: (line: string) => void;
  private child: ChildProcess | null = null;
  private exited: Promise<void> = Promise.resolve();
  private runtime: UserServerRuntime | null = null;
  private out = "";

  constructor(baseDir: string, o: { testProviders?: boolean; log?: (line: string) => void } = {}) {
    this.baseDir = baseDir;
    this.testProviders = o.testProviders === true;
    this.log = o.log ?? (() => undefined);
  }

  get current(): UserServerRuntime {
    if (this.runtime === null) throw new Error("the user server is not running");
    return this.runtime;
  }

  get running(): boolean {
    return this.child !== null;
  }

  output(): string {
    return this.out;
  }

  async start(timeoutMs = 60_000): Promise<UserServerRuntime> {
    if (this.child !== null) throw new Error("the user server is already running");
    const settings = join(this.baseDir, "userdata", "settings.json");
    mkdirSync(join(this.baseDir, "userdata"), { recursive: true });
    if (this.testProviders) {
      let current: Record<string, unknown> = {};
      try {
        current = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
      } catch {
        /* none yet */
      }
      writeFileSync(settings, `${JSON.stringify({ ...current, ...SCRIPTED_SETTINGS }, null, 2)}\n`);
    }
    const child = spawn(process.execPath, userServerArgs(lecturnBin(), this.baseDir), { env: userServerEnv(process.env, this.testProviders), stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    this.exited = new Promise<void>((r) => child.once("exit", () => r()));
    const keep = (b: Buffer): void => {
      this.out = (this.out + b.toString()).slice(-200_000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const pid = child.pid;
    if (pid === undefined) throw new Error("the user server did not start");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (child.exitCode !== null) {
        this.child = null;
        throw new Error(`the user server exited (${child.exitCode}):\n${this.out.slice(-4000)}`);
      }
      const state = ((): { pid?: unknown; origin?: unknown } | null => {
        try {
          return JSON.parse(readFileSync(join(this.baseDir, "userdata", "server-runtime.json"), "utf8")) as { pid?: unknown; origin?: unknown };
        } catch {
          return null;
        }
      })();
      if (state !== null && state.pid === pid && typeof state.origin === "string") {
        const environmentId = await environmentIdAt(state.origin);
        if (environmentId !== undefined) {
          this.runtime = { origin: state.origin, environmentId, pid };
          this.log(`user server ${state.origin} (${environmentId}), pid ${pid}`);
          return this.runtime;
        }
      }
      if (Date.now() > deadline) {
        await this.stop();
        throw new Error(`the user server did not serve within ${timeoutMs} ms:\n${this.out.slice(-4000)}`);
      }
      await sleep(250);
    }
  }

  async stop(timeoutMs = 20_000): Promise<void> {
    const child = this.child;
    if (child === null) return;
    this.child = null;
    this.runtime = null;
    // The pid captured at spawn; nothing else is signalled.
    child.kill("SIGTERM");
    const quit = await Promise.race([this.exited.then(() => true), sleep(timeoutMs).then(() => false)]);
    if (!quit) {
      child.kill("SIGKILL");
      await this.exited;
    }
    this.log("user server stopped");
  }
}

/** Waits for RocketWright's pairing request on the user server and grants it (Settings → Apps). */
export async function grantPairing(admin: Pick<LecturnAdminSession, "app" | "decidePairing">, o: { timeoutMs?: number; log?: (line: string) => void } = {}): Promise<string> {
  const deadline = Date.now() + (o.timeoutMs ?? 60_000);
  for (;;) {
    const app = await admin.app().catch(() => null);
    const requestId = app?.pendingRequest?.requestId;
    if (typeof requestId === "string") {
      await admin.decidePairing(requestId, "grant");
      o.log?.(`granted pairing request ${requestId}`);
      return requestId;
    }
    if (Date.now() > deadline) throw new Error(`no RocketWright pairing request on the user server within ${o.timeoutMs ?? 60_000} ms`);
    await sleep(500);
  }
}

// ---- the copy ledger (decisions 7, 13) --------------------------------------------

type ThreadLike = Pick<EmbedThread, "threadId" | "historyRevision" | "copiedFrom" | "subtitle">;

/** Copies on the user server, by the sidecar thread they came from (only `sourceEnvironmentId`'s when given). */
export function copiesOf<T extends ThreadLike>(threads: readonly T[], sourceEnvironmentId?: string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const t of threads) {
    const from = t.copiedFrom;
    if (from === undefined || (sourceEnvironmentId !== undefined && from.sourceEnvironmentId !== sourceEnvironmentId)) continue;
    out.set(from.sourceThreadId, [...(out.get(from.sourceThreadId) ?? []), t]);
  }
  return out;
}

/** What a re-copy would change on a copy (`updatedAt` also moves on visits, so it is left out). */
export function copyMark(t: ThreadLike): { threadId: string; copiedAt: string | undefined; sourceHistoryRevision: number | undefined; historyRevision: number } {
  return { threadId: t.threadId, copiedAt: t.copiedFrom?.copiedAt, sourceHistoryRevision: t.copiedFrom?.sourceHistoryRevision, historyRevision: t.historyRevision };
}

/** Why the copies in `after` differ from `before` for each source thread of `before` (empty: unchanged). */
export function copiesUnchanged(before: ReadonlyMap<string, readonly ThreadLike[]>, after: ReadonlyMap<string, readonly ThreadLike[]>, label: string): string[] {
  const out: string[] = [];
  for (const [source, copies] of before) {
    const a = JSON.stringify((after.get(source) ?? []).map(copyMark));
    const b = JSON.stringify(copies.map(copyMark));
    if (a !== b) out.push(`${label}: the copy of ${source} changed (${b} -> ${a})`);
  }
  return out;
}

/** The one copy of `source`, or why there is not exactly one. */
export function onlyCopy<T extends ThreadLike>(copies: ReadonlyMap<string, readonly T[]>, source: string): T | string {
  const found = copies.get(source) ?? [];
  return found.length === 1 ? found[0]! : `${found.length} copies of ${source}, want exactly 1`;
}

/** A ```scripted block message (Lecturn's scripted provider reads its script from it, decision 19). */
export function scriptedMessage(lead: string, steps: readonly unknown[]): string {
  return `${lead}\n\`\`\`scripted\n${JSON.stringify(steps)}\n\`\`\``;
}

// ---- the app's own view of the switch (W-B2.4; D25) --------------------------------

/** An IF10 push as `RpcClient` keeps it. */
export interface PushLike {
  topic: string;
  payload: unknown;
}

export interface StatusLike {
  state: string;
  mode: string | null;
  switched?: { environmentId: string; projects: Record<string, string>; threadIdMap: Record<string, string> };
}

/** The first `lecturn.status` push at or after `from` that is connected in `mode`, with its index. */
export function modeAfter(pushes: readonly PushLike[], from: number, mode: "sidecar" | "user-server"): { index: number; status: StatusLike } | null {
  for (let i = Math.max(0, from); i < pushes.length; i++) {
    const p = pushes[i]!;
    const s = p.payload as StatusLike | null;
    if (p.topic === "lecturn.status" && s?.state === "connected" && s.mode === mode) return { index: i, status: s };
  }
  return null;
}

/**
 * The live switch's push after `from` (D25): connected to the user server
 * with `switched` set. A plain connected/user-server status can come first
 * (the connection helper reports the mode before RocketWright re-indexes
 * its projects and announces the switch).
 */
export function switchAfter(pushes: readonly PushLike[], from: number): { index: number; status: StatusLike } | null {
  for (let i = Math.max(0, from); i < pushes.length; i++) {
    const p = pushes[i]!;
    const s = p.payload as StatusLike | null;
    if (p.topic === "lecturn.status" && s?.state === "connected" && s.mode === "user-server" && s.switched !== undefined) return { index: i, status: s };
  }
  return null;
}

/** The project's thread list in the latest `embed.threads` push after `from` (RocketWright's project id), with its index. */
export function threadsAfter(pushes: readonly PushLike[], from: number, projectId: string): { index: number; threads: EmbedThread[] } | null {
  for (let i = pushes.length - 1; i >= Math.max(0, from); i--) {
    const p = pushes[i]!;
    const v = p.payload as { projectId?: unknown; threads?: unknown } | null;
    if (p.topic === "embed.threads" && v?.projectId === projectId && Array.isArray(v.threads)) return { index: i, threads: v.threads as EmbedThread[] };
  }
  return null;
}

/** The rail key of a thread (`apps/web/src/embed/threads.ts` `railKey`, D25): workspace root plus source thread. */
export const railKeyOf = (workspaceRoot: string, sourceThreadId: string): string => `${workspaceRoot}#${sourceThreadId}`;

/** The "Open in Lecturn" link of a sidecar thread continued on the user's server (Lecturn D33). */
export const continuedLink = (userEnvironmentId: string, copyThreadId: string, appId = RW_APP_ID): string => `lecturn://apps/${appId}/threads/${userEnvironmentId}/${copyThreadId}`;
