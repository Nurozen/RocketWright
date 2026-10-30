/**
 * M1.6b mock RPC server: serves IF10 (`src/rpc.ts`) from
 * `fixtures/contracts/` so web work proceeds without the sidecar (R6.1).
 *
 * - Every method answers with fixture payloads (copies with only the fields
 *   the server owns changed: hashes, ids, step numbers, job and run states).
 * - Scripted `resources/updated`: a mutation (UI patch, restore, script
 *   step) maps its sidecar resource URIs to snapshot keys and
 *   pushes one `project.patch` per subscription, as the real mirror does.
 * - Scripted jobs: `sim.run` goes queued → running → complete (or cancelled).
 * - A fake Lecturn connection (B8): `lecturn.status`, `embed.threads` (one
 *   seeded thread per project), `embed.*` answers, and a live switch
 *   (`lecturnSwitch`). The agent is Lecturn's: B17 removed the old chat's
 *   scripted turns (`thread.*`, `approval.*`).
 * - Broker (IF11): the registered host gets `broker.request` pushes; test
 *   hooks (`test.call`) are rejected unless `testHooks` (I12).
 * - Series CSV over HTTP at SERIES_PATH (G §4.2), events at EVENTS_PATH.
 *
 * Run: `pnpm --filter @rw/contracts mock [--port N] [--tick ms] [--script f.json] [--demo] [--test-hooks]`.
 * It prints `RW_RPC_URL=ws://127.0.0.1:<port>/rpc`. Port 0 (default) picks a free port.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { TEST_HOOK_OPS } from "../src/broker.ts";
import type { BrokerArgs, BrokerCapabilities, BrokerOp, BrokerRequest, BrokerResponse } from "../src/broker.ts";
import { RPC_METHODS, RPC_PATH, RPC_VERSION } from "../src/rpc.ts";
import type {
  EmbedTarget,
  EmbedThread,
  LecturnStatus,
  ProjectInfo,
  ProjectPatch,
  ProjectSnapshot,
  RpcError,
  RpcMethod,
  RpcParams,
  RpcResult,
  RpcTopic,
  RpcTopics,
  ServerFrame,
  SidecarState,
  SnapshotKey,
} from "../src/rpc.ts";
import { SCHEMA_VERSION } from "../src/types.ts";
import type {
  CheckReport,
  CompareOut,
  ModelGetOut,
  EvaluatedModel,
  HistoryListOut,
  HistoryStep,
  JobInfo,
  JsonObject,
  JsonValue,
  MutationOut,
  ProjectFiles,
  Revision,
  RunListOut,
  SimulateOut,
} from "../src/types.ts";
import type { CfdImportOut, EngineDesignOut, LibrarySearchOut, Origin, ThrustcurveFetchOut, ThrustcurveSearchOut } from "../src/generated/types.ts";
import { clone, DEFAULT_FIXTURES_DIR, type FixtureSet, loadFixtures } from "./fixtures.ts";
import { acceptUpgrade } from "./ws.ts";

/** One `rw://runs/index` entry. */
type RunListEntry = RunListOut["runs"][number];

// ---- options and scripts --------------------------------------------------------

/** Sidecar resource URIs whose `resources/updated` the server mirrors. */
export type ResourceUri =
  | "rw://project/model"
  | "rw://project/check"
  | "rw://project/files"
  | "rw://project/history"
  | "rw://runs/index"
  | `rw://runs/${string}/summary`
  | `rw://jobs/${string}`;

/** Snapshot keys a resource refreshes. */
export function snapshotKeysFor(uri: ResourceUri): SnapshotKey[] {
  if (uri === "rw://project/model") return ["evaluated"];
  if (uri === "rw://project/check") return ["check"];
  if (uri === "rw://project/files") return ["files"];
  if (uri === "rw://project/history") return ["history"];
  if (uri === "rw://runs/index" || uri.startsWith("rw://runs/")) return ["runs"];
  if (uri.startsWith("rw://jobs/")) return ["jobs"];
  throw new Error(`unknown resource ${uri}`);
}

/** The URIs a committed model change touches. */
export const COMMIT_URIS: ResourceUri[] = ["rw://project/model", "rw://project/check", "rw://project/files", "rw://project/history", "rw://runs/index"];

type SnapshotData = { [K in SnapshotKey]?: ProjectSnapshot[K] };

/**
 * One scripted event, played `afterMs` after the target project's first
 * `project.subscribe`. `commit` records an external edit (origin `watcher`)
 * and implies COMMIT_URIS; `set` replaces snapshot keys; `sidecar` changes the
 * sidecar state. Then `uris` (plus implied ones) are pushed as one patch.
 */
export interface ScriptStep {
  afterMs: number;
  projectId?: string;
  uris?: ResourceUri[];
  commit?: string;
  set?: SnapshotData;
  sidecar?: SidecarState;
}

/** `--demo`: an external edit, then a sidecar restart blip. */
export const DEMO_SCRIPT: ScriptStep[] = [
  { afterMs: 3000, commit: "Edit rocket.rw.toml" },
  { afterMs: 6000, sidecar: "restarting" },
  { afterMs: 6500, sidecar: "ready" },
];

export interface MockOptions {
  fixturesDir?: string;
  /** Accept `test.call` (default: `RW_TEST_HOOKS=1`). */
  testHooks?: boolean;
  /** Delay between scripted job and turn steps (default 150 ms). */
  tickMs?: number;
  script?: ScriptStep[];
  /** How long a broker request waits for `broker.respond` (default 10 s). */
  brokerTimeoutMs?: number;
  coreVersion?: string;
}

export const MOCK_CORE_VERSION = "0.0.0-mock";
export const SEED_PROJECT_ID = "research-vehicle";
/** Logical clock origin (2026-10-15T14:00:00Z); UI ordering only. */
const CLOCK0 = Date.UTC(2026, 9, 15, 14, 0, 0);

// ---- errors and helpers ---------------------------------------------------------

class RpcFail extends Error {
  readonly code: RpcError["code"];
  constructor(code: RpcError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

class Aborted extends Error {}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

function str(params: JsonObject, key: string, optional = false): string | undefined {
  const v = params[key];
  if (v === undefined && optional) return undefined;
  if (typeof v !== "string" || v === "") throw new RpcFail("invalid_params", `${key}: expected a non-empty string`);
  return v;
}

function bool(params: JsonObject, key: string): boolean {
  const v = params[key];
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw new RpcFail("invalid_params", `${key}: expected a boolean`);
  return v;
}

function isObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---- state ----------------------------------------------------------------------

interface Conn {
  id: number;
  send(frame: ServerFrame): void;
  subs: Set<string>;
}

type Sub = { conn: Conn; projectId: string; kind: "project" };

interface JobState {
  ctl: AbortController;
  /** The run entry before the job started (`null`: the sim had none). */
  prevRun: RunListEntry | null;
}

interface ProjectState {
  info: ProjectInfo;
  snap: ProjectSnapshot;
  /** Head step number. */
  seq: number;
  jobs: Map<string, JobState>;
  scripted: boolean;
  /** The project's Lecturn threads (`embed.threads`), newest first. */
  embedThreads: EmbedThread[];
}

interface Host {
  conn: Conn;
  hostId: string;
  capabilities: BrokerCapabilities;
}

/** A transport-free mock: feed it client frames, it calls `send` with server frames. */
export class MockRpc {
  readonly fixtures: FixtureSet;
  readonly testHooks: boolean;
  private readonly tickMs: number;
  private readonly brokerTimeoutMs: number;
  private readonly coreVersion: string;
  private readonly script: ScriptStep[];
  private readonly life = new AbortController();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly projects = new Map<string, ProjectState>();
  private readonly subs = new Map<string, Sub>();
  private readonly conns = new Set<Conn>();
  private readonly hosts = new Map<string, Host>();
  private readonly broker = new Map<string, (r: BrokerResponse) => void>();
  private counter = 0;
  /** M3.6 thumbnails: `<model_hash>/<id>` -> PNG base64. */
  private readonly thumbs = new Map<string, string>();
  private clock = 0;
  private jobSeq = 7;
  /** The fake Lecturn connection (B8): always connected, on the sidecar until `lecturnSwitch`. */
  private lecturn: LecturnStatus = { state: "connected", mode: "sidecar", pairing: "none" };
  /** The last `embed.setHostContext` text per project ("" cleared). */
  readonly hostContexts = new Map<string, string>();
  /** Bumped on each `lecturnSwitch`: Lecturn ids differ per server. */
  private lecturnEnv = 1;

  constructor(opts: MockOptions = {}) {
    this.fixtures = loadFixtures(opts.fixturesDir ?? DEFAULT_FIXTURES_DIR);
    this.testHooks = opts.testHooks ?? process.env.RW_TEST_HOOKS === "1";
    this.tickMs = opts.tickMs ?? 150;
    this.brokerTimeoutMs = opts.brokerTimeoutMs ?? 10_000;
    this.coreVersion = opts.coreVersion ?? MOCK_CORE_VERSION;
    this.script = opts.script ?? [];
    this.addProject(`/mock/${SEED_PROJECT_ID}`, SEED_PROJECT_ID);
  }

  // ---- public API (tests, CLI) ----

  /** Opens a client; the hello frame is sent at once. */
  connect(send: (frame: ServerFrame) => void): { receive(frame: string | object): void; close(): void } {
    const conn: Conn = { id: ++this.counter, send, subs: new Set() };
    this.conns.add(conn);
    send({ kind: "hello", rpc: RPC_VERSION, schema: SCHEMA_VERSION, coreVersion: this.coreVersion, testHooks: this.testHooks });
    // As the app server does: the Lecturn state, then each project's Lecturn threads.
    this.push(conn, "lecturn.status", this.lecturnStatus());
    for (const p of this.projects.values()) this.push(conn, "embed.threads", { projectId: p.info.projectId, threads: p.embedThreads });
    return {
      receive: (frame) => void this.receive(conn, frame),
      close: () => this.disconnect(conn),
    };
  }

  /**
   * Plays a Lecturn live switch (D25) to `mode`: every project's Lecturn ids
   * change, `lecturn.status` carries the maps, and each project's
   * `embed.threads` follows with the new ids.
   */
  lecturnSwitch(mode: "sidecar" | "user-server" = "user-server"): void {
    const env = ++this.lecturnEnv;
    const projects: Record<string, string> = {};
    const threadIdMap: Record<string, string> = {};
    for (const p of this.projects.values()) {
      projects[p.info.projectId] = `lp-${env}-${p.info.projectId}`;
      p.embedThreads = p.embedThreads.map((t) => {
        const threadId = `${t.threadId.replace(/^lt-\d+-/, "")}`;
        const next = `lt-${env}-${threadId}`;
        threadIdMap[t.threadId] = next;
        // The user server's copy names the sidecar thread it came from (D21); a copy of a copy keeps the first source.
        const copiedFrom = t.copiedFrom ?? { appId: "dev.rocketwright.app", sourceEnvironmentId: `mock-env-${env - 1}`, sourceThreadId: t.threadId, copiedAt: new Date(CLOCK0).toISOString(), sourceHistoryRevision: t.historyRevision };
        return { ...t, threadId: next, projectId: projects[p.info.projectId]!, copiedFrom };
      });
    }
    this.lecturn = { state: "connected", mode, pairing: "none" };
    this.broadcast("lecturn.status", { ...this.lecturnStatus(), switched: { environmentId: `mock-env-${env}`, projects, threadIdMap } });
    for (const p of this.projects.values()) this.broadcastEmbedThreads(p);
  }

  /** Replaces a project's Lecturn threads (as a guest-made thread or a turn would) and pushes `embed.threads`. */
  setEmbedThreads(projectId: string, threads: EmbedThread[]): void {
    const p = this.project(projectId);
    p.embedThreads = clone(threads);
    this.broadcastEmbedThreads(p);
  }

  /** The project's Lecturn threads now (a copy). */
  embedThreads(projectId: string = SEED_PROJECT_ID): EmbedThread[] {
    return clone(this.project(projectId).embedThreads);
  }

  /** The current mirror of a project (a copy). */
  snapshot(projectId: string = SEED_PROJECT_ID): ProjectSnapshot {
    return clone(this.project(projectId).snap);
  }

  /** Mirrors sidecar `resources/updated` for `uris`: one `project.patch` per subscription. */
  resourcesUpdated(projectId: string, uris: ResourceUri[]): void {
    const p = this.project(projectId);
    const keys = [...new Set(uris.flatMap(snapshotKeysFor))].sort();
    if (keys.length > 0) this.pushPatch(p, keys);
  }

  /** Plays one script step now. */
  playStep(step: ScriptStep): void {
    const p = this.project(step.projectId ?? SEED_PROJECT_ID);
    const uris = [...(step.uris ?? [])];
    if (step.commit !== undefined) {
      this.commit(p, { title: step.commit, origin: "watcher", thread: null, tool: null, toolCall: null, salt: "script" });
      uris.push(...COMMIT_URIS);
    }
    const keys = new Set(uris.flatMap(snapshotKeysFor));
    if (step.set !== undefined) {
      for (const [k, v] of Object.entries(step.set) as [SnapshotKey, JsonValue][]) {
        (p.snap as unknown as JsonObject)[k] = clone(v);
        keys.add(k);
      }
    }
    if (step.sidecar !== undefined) {
      p.snap.sidecar = { state: step.sidecar, version: step.sidecar === "ready" ? this.coreVersion : p.snap.sidecar.version };
      keys.add("sidecar");
    }
    if (keys.size > 0) this.pushPatch(p, [...keys].sort());
  }

  /** Sends an agent broker op to the project's viewport host (IF11). */
  requestBroker<O extends BrokerOp>(projectId: string, op: O, args: BrokerArgs[O], threadId: string | null): Promise<BrokerResponse<O>> {
    const requestId = `broker-${++this.counter}`;
    const host = this.hosts.get(projectId);
    if (host === undefined) {
      return Promise.resolve({ requestId, ok: false, error: { code: "no_host", message: "no viewport host registered" } });
    }
    return new Promise((resolve) => {
      const timer = this.after(this.brokerTimeoutMs, () => {
        this.broker.delete(requestId);
        resolve({ requestId, ok: false, error: { code: "timeout", message: `${op} timed out` } });
      });
      this.broker.set(requestId, (r) => {
        clearTimeout(timer);
        this.timers.delete(timer);
        this.broker.delete(requestId);
        resolve(r as BrokerResponse<O>);
      });
      const req: BrokerRequest = { requestId, projectId, threadId, op, args };
      this.push(host.conn, "broker.request", req);
    });
  }

  /** The series CSV of a run, or `null` if the run is unknown. */
  seriesCsv(projectId: string, sim: string, runId: string): string | null {
    const p = this.projects.get(projectId);
    if (p === undefined) return null;
    const run = p.snap.runs.runs.find((r) => r.sim === sim && r.run_id === runId);
    if (run === undefined) return null;
    const series = this.fixtures.payload<{ series: { columns: { name: string }[]; rows: number[][] } }>("sim-result").series;
    return [series.columns.map((c) => c.name).join(","), ...series.rows.map((r) => r.join(","))].join("\n") + "\n";
  }

  /** The events JSON (`RunEvents`) of a run, or `null` if the run is unknown. */
  eventsJson(projectId: string, sim: string, runId: string): string | null {
    if (this.seriesCsv(projectId, sim, runId) === null) return null;
    const events = this.fixtures.payload<{ events?: unknown[] }>("sim-result").events ?? [];
    return JSON.stringify({ schema: "rw/1", events });
  }

  /** Stops every timer, job, and turn. */
  dispose(): void {
    this.life.abort();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const c of [...this.conns]) this.disconnect(c);
  }

  // ---- frames ----

  private async receive(conn: Conn, raw: string | object): Promise<void> {
    let frame: unknown = raw;
    if (typeof raw === "string") {
      try {
        frame = JSON.parse(raw);
      } catch {
        return; // no id to answer
      }
    }
    if (!isObject(frame) || frame.kind !== "request" || typeof frame.id !== "number" || !Number.isInteger(frame.id)) return;
    const id = frame.id;
    const method = frame.method;
    const deferred: (() => void)[] = [];
    try {
      if (typeof method !== "string" || !(RPC_METHODS as readonly string[]).includes(method)) {
        throw new RpcFail("invalid_params", `unknown method ${String(method)}`);
      }
      const params = frame.params ?? {};
      if (!isObject(params)) throw new RpcFail("invalid_params", "params must be an object");
      const result = await this.dispatch(conn, method as RpcMethod, params, (fn) => deferred.push(fn));
      conn.send({ kind: "response", id, ok: true, result } as ServerFrame);
    } catch (e) {
      const error: RpcError =
        e instanceof RpcFail ? { code: e.code, message: e.message } : { code: "internal", message: e instanceof Error ? e.message : String(e) };
      conn.send({ kind: "response", id, ok: false, error });
      return;
    }
    for (const fn of deferred) fn();
  }

  private dispatch(conn: Conn, method: RpcMethod, params: JsonObject, after: (fn: () => void) => void): Promise<JsonValue> | JsonValue {
    const h = this.handlers[method] as (conn: Conn, params: JsonObject, after: (fn: () => void) => void) => Promise<JsonValue> | JsonValue;
    return h.call(this, conn, params, after);
  }

  private readonly handlers: { [M in RpcMethod]: (conn: Conn, params: RpcParams<M> & JsonObject, after: (fn: () => void) => void) => RpcResult<M> | Promise<RpcResult<M>> } = {
    "project.list": () => ({ projects: [...this.projects.values()].map((p) => clone(p.info)) }),

    "project.open": (_c, params, after) => {
      const dir = str(params, "dir")!;
      const existing = [...this.projects.values()].find((p) => p.info.dir === dir);
      const p = existing ?? this.addProject(dir);
      if (existing === undefined) {
        after(() => {
          this.broadcast("project.opened", { project: clone(p.info) });
          this.broadcastEmbedThreads(p);
        });
      }
      return { project: clone(p.info) };
    },

    "project.close": (conn, params) => {
      const p = this.project(str(params, "projectId")!);
      for (const id of [...conn.subs]) if (this.subs.get(id)?.projectId === p.info.projectId) this.dropSub(id);
      return {};
    },

    "project.subscribe": (conn, params, after) => {
      const p = this.project(str(params, "projectId")!);
      const subscriptionId = this.addSub({ conn, projectId: p.info.projectId, kind: "project" });
      after(() => {
        this.push(conn, "project.snapshot", { subscriptionId, snapshot: clone(p.snap) });
        this.startScript(p);
      });
      return { subscriptionId, snapshot: clone(p.snap) };
    },

    "project.unsubscribe": (conn, params) => {
      const id = str(params, "subscriptionId")!;
      if (!conn.subs.has(id)) throw new RpcFail("not_found", `no subscription ${id}`);
      this.dropSub(id);
      return {};
    },

    "model.patch": (_c, params, after) => {
      const p = this.project(str(params, "projectId")!);
      const ops = params.ops;
      if (!Array.isArray(ops) || ops.length === 0 || !ops.every((o) => isObject(o) && typeof o.op === "string" && typeof o.path === "string")) {
        throw new RpcFail("invalid_params", "ops: expected a non-empty array of patch ops");
      }
      const label = str(params, "label", true) ?? `Patch ${ops.map((o) => (o as JsonObject).path).join(", ")}`;
      const salt = JSON.stringify(ops);
      if (bool(params, "dry_run")) return this.dryRun(p, "tools/model_patch.output", salt);
      const out = this.commit(p, { title: label, origin: "ui", thread: "ui", tool: "model_patch", toolCall: null, salt });
      after(() => this.resourcesUpdated(p.info.projectId, COMMIT_URIS));
      return out;
    },

    "check.run": (_c, params) => {
      const p = this.project(str(params, "projectId")!);
      str(params, "config", true);
      bool(params, "strict");
      if (p.snap.check === null) throw new RpcFail("sidecar_unavailable", "no check report yet");
      return clone(p.snap.check);
    },

    "sim.run": (_c, params, after) => this.simRun(this.project(str(params, "projectId")!), str(params, "sim")!, bool(params, "force"), after),

    "job.cancel": (_c, params, after) => {
      const p = this.project(str(params, "projectId")!);
      const jobId = str(params, "jobId")!;
      const job = p.snap.jobs.find((j) => j.job_id === jobId);
      if (job === undefined) throw new RpcFail("not_found", `no job ${jobId}`);
      const st = p.jobs.get(jobId);
      if (st !== undefined && (job.state === "queued" || job.state === "running")) {
        st.ctl.abort();
        p.jobs.delete(jobId);
        job.state = "cancelled";
        this.restoreRun(p, String(job.sim), st.prevRun);
        after(() => this.resourcesUpdated(p.info.projectId, [`rw://jobs/${jobId}`, "rw://runs/index"]));
      }
      return clone(job);
    },

    "model.get": (_c, params) => {
      const p = this.project(str(params, "projectId")!);
      const version = str(params, "version");
      if (version !== undefined && version !== "live") this.resolveVersion(p, version);
      const model = this.fixtures.payload<EvaluatedModel>("evaluated-model");
      const out: ModelGetOut = { model_hash: model.model_hash, path: "", model };
      return out;
    },

    "history.compare": (_c, params) => {
      const p = this.project(str(params, "projectId")!);
      const a = str(params, "a")!;
      const b = str(params, "b")!;
      this.resolveVersion(p, a);
      this.resolveVersion(p, b);
      const out = this.fixtures.payload<CompareOut>("tools/history_compare.output");
      out.a = a;
      out.b = b;
      out.model.a = a;
      out.model.b = b;
      return out;
    },

    "history.tag": (_c, params, after) => {
      const p = this.project(str(params, "projectId")!);
      const name = str(params, "name")!;
      const version = str(params, "version", true);
      const seq = version === undefined ? p.seq : this.resolveVersion(p, version);
      const step = p.snap.history.steps.find((s) => s.seq === seq);
      const rev = this.fixtures.payload<Revision>("tools/history_tag.output");
      rev.number = Math.max(0, ...p.snap.history.revisions.map((r) => Number(r.number))) + 1;
      rev.name = name;
      rev.step = seq;
      rev.id = step === undefined ? sha1(`step:${seq}`) : String(step.id);
      p.snap.history.revisions.push(clone(rev));
      if (step !== undefined) step.rev = `rev:${String(rev.number).padStart(2, "0")}`;
      after(() => this.resourcesUpdated(p.info.projectId, ["rw://project/history"]));
      return rev;
    },

    "history.restore": (_c, params, after) => {
      const p = this.project(str(params, "projectId")!);
      const version = str(params, "version")!;
      this.resolveVersion(p, version);
      if (bool(params, "dry_run")) return this.dryRun(p, "tools/history_restore.output", `restore ${version}`);
      const out = this.commit(p, { title: `Restore ${version}`, origin: "ui", thread: "ui", tool: "history_restore", toolCall: null, salt: version, base: "tools/history_restore.output" });
      after(() => this.resourcesUpdated(p.info.projectId, COMMIT_URIS));
      return out;
    },

    "library.search": (_c, params) => {
      this.project(str(params, "projectId")!);
      return this.fixtures.payload<LibrarySearchOut>("tools/library_search.output");
    },

    // M3.6: the mock keeps thumbnails in memory per (model_hash, id).
    "thumb.get": (_c, params) => {
      this.project(str(params, "projectId")!);
      const hash = str(params, "model_hash")!;
      const thumbs: Record<string, string> = {};
      for (const [k, v] of this.thumbs) if (k.startsWith(`${hash}/`)) thumbs[k.slice(hash.length + 1)] = v;
      return { thumbs };
    },

    "thumb.put": (_c, params) => {
      this.project(str(params, "projectId")!);
      this.thumbs.set(`${str(params, "model_hash")!}/${str(params, "id")!}`, str(params, "png_base64")!);
      return {};
    },

    "engine.design": (_c, params) => {
      this.project(str(params, "projectId")!);
      return { ...this.fixtures.payload<EngineDesignOut>("tools/engine_design.output"), engine: str(params, "engine")! };
    },

    "engine.simulate": (_c, params) => {
      this.project(str(params, "projectId")!);
      str(params, "engine");
      return this.fixtures.payload<SimulateOut>("tools/engine_simulate.output");
    },

    "cfd.import": (_c, params) => {
      this.project(str(params, "projectId")!);
      str(params, "path");
      return this.fixtures.payload<CfdImportOut>("tools/cfd_import.output");
    },

    "cfd.list": (_c, params) => {
      this.project(str(params, "projectId")!);
      return { datasets: [this.fixtures.payload<CfdImportOut>("tools/cfd_import.output").dataset] };
    },

    "motor.thrustcurveSearch": (_c, params) => {
      this.project(str(params, "projectId")!);
      return this.fixtures.payload<ThrustcurveSearchOut>("tools/thrustcurve_search.output");
    },

    "motor.thrustcurveFetch": (_c, params) => {
      this.project(str(params, "projectId")!);
      str(params, "motor");
      return this.fixtures.payload<ThrustcurveFetchOut>("tools/thrustcurve_fetch.output");
    },

    "broker.hostRegister": (conn, params) => {
      const p = this.project(str(params, "projectId")!);
      const hostId = str(params, "hostId")!;
      const caps = params.capabilities;
      if (!isObject(caps) || !Array.isArray(caps.ops) || (caps.backend !== "webgpu" && caps.backend !== "webgl2")) {
        throw new RpcFail("invalid_params", "capabilities: expected {ops, backend}");
      }
      this.hosts.set(p.info.projectId, { conn, hostId, capabilities: caps as unknown as BrokerCapabilities });
      return {};
    },

    "broker.respond": (_c, params) => {
      const requestId = str(params, "requestId")!;
      const done = this.broker.get(requestId);
      if (done === undefined) throw new RpcFail("not_found", `no pending broker request ${requestId}`);
      if (typeof params.ok !== "boolean") throw new RpcFail("invalid_params", "ok: expected a boolean");
      done(params as unknown as BrokerResponse);
      return {};
    },

    // A fake target: nothing serves it.
    "embed.target": (_c, params) => this.embedTarget(this.project(str(params, "projectId")!), str(params, "threadId", true)),

    "embed.refreshToken": (_c, params) => this.embedTarget(this.project(str(params, "projectId")!), undefined),

    "embed.setThreadAppData": (_c, params, after) => {
      const p = this.project(str(params, "projectId")!);
      const threadId = str(params, "threadId")!;
      const t = p.embedThreads.find((x) => x.threadId === threadId);
      if (t === undefined) throw new RpcFail("not_found", `no Lecturn thread ${threadId}`);
      const appData = params.appData;
      if (appData !== null && typeof appData !== "string") throw new RpcFail("invalid_params", "appData: expected a string or null");
      if (typeof appData === "string" && Buffer.byteLength(appData) > 1024) throw new RpcFail("invalid_params", "appData: at most 1024 bytes");
      const subtitle = params.subtitle;
      if (subtitle !== undefined && subtitle !== null && (typeof subtitle !== "string" || subtitle.length > 80)) {
        throw new RpcFail("invalid_params", "subtitle: expected a string of at most 80 characters, or null");
      }
      t.appData = appData;
      if (subtitle !== undefined) t.subtitle = subtitle;
      after(() => this.broadcastEmbedThreads(p));
      return {};
    },

    "embed.setHostContext": (_c, params) => {
      const p = this.project(str(params, "projectId")!);
      const text = params.text;
      if (typeof text !== "string") throw new RpcFail("invalid_params", "text: expected a string");
      if (Buffer.byteLength(text) > 4096) throw new RpcFail("invalid_params", "text: at most 4096 bytes");
      this.hostContexts.set(p.info.projectId, text);
      return { applied: true };
    },

    "test.call": async (_c, params) => {
      if (!this.testHooks) throw new RpcFail("hooks_disabled", "test hooks need RW_TEST_HOOKS=1");
      const p = this.project(str(params, "projectId")!);
      const op = params.op;
      if (typeof op !== "string" || !(TEST_HOOK_OPS as readonly string[]).includes(op)) throw new RpcFail("invalid_params", `op: not a test hook`);
      if (!isObject(params.args)) throw new RpcFail("invalid_params", "args: expected an object");
      const r = await this.requestBroker(p.info.projectId, op as BrokerOp, params.args as never, null);
      if (!r.ok) throw new RpcFail(r.error.code === "no_host" ? "not_found" : "internal", `${r.error.code}: ${r.error.message}`);
      return r.result as JsonObject;
    },
  };

  // ---- projects, subscriptions, pushes ----

  private addProject(dir: string, id?: string): ProjectState {
    const base = id ?? (basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project");
    let projectId = base;
    for (let n = 2; this.projects.has(projectId); n++) projectId = `${base}-${n}`;
    const f = this.fixtures;
    const history = f.payload<HistoryListOut>("tools/history_list.output");
    const info: ProjectInfo = { projectId, dir, name: id === SEED_PROJECT_ID ? "Research vehicle" : basename(dir) };
    const snap: ProjectSnapshot = {
      project: info,
      sidecar: { state: "ready", version: this.coreVersion },
      evaluated: f.payload<EvaluatedModel>("evaluated-model"),
      check: f.payload<CheckReport>("check-report"),
      files: f.payload<ProjectFiles>("project-files"),
      history,
      runs: f.payload<RunListOut>("tools/run_list.output"),
      jobs: [],
    };
    const p: ProjectState = { info, snap, seq: Math.max(0, ...history.steps.map((s) => s.seq)), jobs: new Map(), scripted: false, embedThreads: [] };
    p.embedThreads = [this.seedEmbedThread(p)];
    this.projects.set(projectId, p);
    return p;
  }

  private project(projectId: string): ProjectState {
    const p = this.projects.get(projectId);
    if (p === undefined) throw new RpcFail("not_found", `no project ${projectId}`);
    return p;
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

  private disconnect(conn: Conn): void {
    if (!this.conns.delete(conn)) return;
    for (const id of [...conn.subs]) this.dropSub(id);
    for (const [pid, h] of this.hosts) if (h.conn === conn) this.hosts.delete(pid);
  }

  private push<T extends RpcTopic>(conn: Conn, topic: T, payload: RpcTopics[T]): void {
    if (this.conns.has(conn)) conn.send({ kind: "push", topic, payload: clone(payload) } as ServerFrame);
  }

  private pushPatch(p: ProjectState, keys: SnapshotKey[]): void {
    const patch: ProjectPatch = { projectId: p.info.projectId };
    for (const k of keys) (patch as unknown as JsonObject)[k] = p.snap[k] as unknown as JsonValue;
    for (const [subscriptionId, s] of this.subs) {
      if (s.kind === "project" && s.projectId === p.info.projectId) this.push(s.conn, "project.patch", { subscriptionId, patch });
    }
  }

  private broadcast<T extends RpcTopic>(topic: T, payload: RpcTopics[T]): void {
    for (const c of this.conns) this.push(c, topic, payload);
  }

  private lecturnStatus(): LecturnStatus {
    return clone(this.lecturn);
  }

  private embedTarget(p: ProjectState, threadId: string | undefined): EmbedTarget {
    const path = [`lp-${this.lecturnEnv}-${p.info.projectId}`, ...(threadId === undefined ? [] : [threadId])].map(encodeURIComponent).join("/");
    return { url: `http://127.0.0.1:1/embed/mock-env-${this.lecturnEnv}/${path}`, token: `mock-embed-token-${++this.counter}`, expiresAt: new Date(this.now() + 300_000).toISOString() };
  }

  /** One idle Lecturn thread bound to page 01, so the rail has a row. */
  private seedEmbedThread(p: ProjectState): EmbedThread {
    const at = new Date(CLOCK0).toISOString();
    return {
      threadId: `lt-${this.lecturnEnv}-${p.info.projectId}-1`,
      projectId: `lp-${this.lecturnEnv}-${p.info.projectId}`,
      workspaceRoot: p.info.dir,
      title: "Assembly review",
      createdAt: at,
      updatedAt: at,
      historyRevision: 8,
      state: "idle",
      appData: JSON.stringify({ page: "assembly" }),
      subtitle: null,
    };
  }

  private broadcastEmbedThreads(p: ProjectState): void {
    this.broadcast("embed.threads", { projectId: p.info.projectId, threads: p.embedThreads });
  }

  private startScript(p: ProjectState): void {
    if (p.scripted) return;
    p.scripted = true;
    for (const step of this.script) {
      if ((step.projectId ?? SEED_PROJECT_ID) === p.info.projectId) this.after(step.afterMs, () => this.playStep(step));
    }
  }

  // ---- model changes ----

  private resolveVersion(p: ProjectState, v: string): number {
    if (v === "HEAD") return p.seq;
    let m = /^step:(\d+)$/.exec(v);
    if (m !== null && Number(m[1]) >= 1 && Number(m[1]) <= p.seq) return Number(m[1]);
    m = /^rev:(\d+)$/.exec(v);
    const rev = p.snap.history.revisions.find((r) => (m !== null && Number(r.number) === Number(m[1])) || r.name === v || r.id === v);
    if (rev !== undefined) return Number(rev.step);
    const step = p.snap.history.steps.find((s) => s.id === v);
    if (step !== undefined) return step.seq;
    throw new RpcFail("not_found", `no version ${v}`);
  }

  private dryRun(p: ProjectState, base: string, salt: string): MutationOut {
    const out = this.fixtures.payload<MutationOut & { files: JsonValue[] }>(base);
    const hash = sha256(`${p.snap.files.model_hash}|dry|${salt}`);
    out.dry_run = true;
    out.model_hash = hash;
    out.files = [];
    delete out.step;
    out.delta.model_hash = hash;
    delete out.delta.step;
    return out;
  }

  /** Records a new step (the sidecar's write) and updates the mirror; the caller pushes COMMIT_URIS. */
  private commit(
    p: ProjectState,
    c: { title: string; origin: Origin; thread: string | null; tool: string | null; toolCall: string | null; salt: string; base?: string },
  ): MutationOut {
    const prev = p.snap.history.steps.find((s) => s.seq === p.seq);
    const seq = ++p.seq;
    const hash = sha256(`${p.snap.files.model_hash}|${seq}|${c.salt}`);
    const step = this.fixtures.payload<HistoryStep>("history-step");
    step.seq = seq;
    step.id = sha1(`${p.info.projectId}|${hash}`);
    if (prev !== undefined) step.prev = String(prev.id);
    else delete step.prev;
    step.ts = new Date(CLOCK0 + seq * 60_000).toISOString().replace(".000Z", "Z");
    step.origin = c.origin;
    step.title = c.title;
    step.model_hash = hash;
    for (const [k, v] of [["thread", c.thread], ["tool", c.tool], ["tool_call", c.toolCall]] as const) {
      if (v === null) delete step[k];
      else step[k] = v;
    }
    delete step.rev;
    p.snap.history.steps.push(step);

    if (p.snap.evaluated !== null) p.snap.evaluated.model_hash = hash;
    if (p.snap.check !== null) p.snap.check.model_hash = hash;
    p.snap.files.model_hash = hash;
    this.setRunsHash(p, hash);

    const out = this.fixtures.payload<MutationOut>(c.base ?? "tools/model_patch.output");
    out.dry_run = false;
    out.step = `step:${seq}`;
    out.model_hash = hash;
    out.files = [{ path: "rocket.rw.toml", status: "M" }];
    out.delta.model_hash = hash;
    out.delta.step = `step:${seq}`;
    return out;
  }

  /** Run status is computed from the model hash (I7). */
  private setRunsHash(p: ProjectState, hash: string): void {
    p.snap.runs.model_hash = hash;
    for (const r of p.snap.runs.runs) {
      if (r.status === "complete" || r.status === "outdated") r.status = r.model_hash === hash ? "complete" : "outdated";
    }
  }

  // ---- jobs ----

  private simRun(p: ProjectState, sim: string, force: boolean, after: (fn: () => void) => void): SimulateOut {
    const hash = p.snap.files.model_hash;
    const runs = p.snap.runs.runs;
    const idx = runs.findIndex((r) => r.sim === sim);
    const entry = runs[idx];
    const out = this.fixtures.payload<SimulateOut>("tools/simulate.output");
    out.sim = sim;
    if (entry !== undefined && entry.status === "complete" && entry.model_hash === hash && !force) {
      out.run_id = String(entry.run_id);
      out.status = "complete";
      out.cached = true;
      delete out.job_id;
      return out;
    }
    const jobId = `job-${String(++this.jobSeq).padStart(4, "0")}`;
    const runId = sha256(`${sim}|${hash}|${jobId}`).slice(0, 12);
    out.run_id = runId;
    out.status = "running";
    out.cached = false;
    out.job_id = jobId;

    const job = this.fixtures.payload<JobInfo>("job-info");
    Object.assign(job, { job_id: jobId, kind: "simulate", state: "queued", progress: 0, sim, run_id: runId });
    p.snap.jobs.push(job);
    const ctl = new AbortController();
    p.jobs.set(jobId, { ctl, prevRun: entry === undefined ? null : clone(entry) });
    const run: RunListEntry = entry ?? ({ ...clone(runs[0] ?? {}), sim, sim_name: sim } as RunListEntry);
    Object.assign(run, { status: "running", run_id: runId, model_hash: hash });
    if (entry === undefined) runs.push(run);
    const uris: ResourceUri[] = [`rw://jobs/${jobId}`, "rw://runs/index"];

    after(() => {
      this.resourcesUpdated(p.info.projectId, uris);
      void (async () => {
        try {
          await this.sleep(this.tickMs, ctl.signal);
          job.state = "running";
          job.progress = 0.5;
          this.resourcesUpdated(p.info.projectId, [`rw://jobs/${jobId}`]);
          await this.sleep(this.tickMs, ctl.signal);
          job.state = "complete";
          job.progress = 1;
          p.jobs.delete(jobId);
          const current = runs.find((r) => r.sim === sim);
          if (current !== undefined) {
            current.summary = this.fixtures.payload("run-summary");
            current.status = current.model_hash === p.snap.files.model_hash ? "complete" : "outdated";
          }
          this.resourcesUpdated(p.info.projectId, [...uris, `rw://runs/${runId}/summary`]);
        } catch (e) {
          if (!(e instanceof Aborted)) throw e;
        }
      })();
    });
    return out;
  }

  private restoreRun(p: ProjectState, sim: string, prev: RunListEntry | null): void {
    const runs = p.snap.runs.runs;
    const idx = runs.findIndex((r) => r.sim === sim);
    if (idx < 0) return;
    if (prev === null) runs.splice(idx, 1);
    else runs[idx] = prev;
    this.setRunsHash(p, p.snap.files.model_hash);
  }

  // ---- time ----

  private now(): number {
    return CLOCK0 + ++this.clock * 1000;
  }

  private after(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Aborted());
      const onAbort = (): void => {
        clearTimeout(t);
        this.timers.delete(t);
        reject(new Aborted());
      };
      const t = this.after(ms, () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

// ---- HTTP + WebSocket transport ---------------------------------------------------

export interface MockServer {
  /** `ws://127.0.0.1:<port>/rpc` */
  url: string;
  /** `http://127.0.0.1:<port>` (series CSV). */
  httpUrl: string;
  port: number;
  mock: MockRpc;
  close(): Promise<void>;
}

const SERIES_RE = /^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/([^/]+)\/series\.csv$/;
const EVENTS_RE = /^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/([^/]+)\/events\.json$/;

/** Starts the mock on 127.0.0.1 (`port` 0 = any free port). */
export async function startMockServer(opts: MockOptions & { port?: number; host?: string } = {}): Promise<MockServer> {
  const mock = new MockRpc(opts);
  const host = opts.host ?? "127.0.0.1";
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const m = SERIES_RE.exec(path);
    if (req.method === "GET" && m !== null) {
      const csv = mock.seriesCsv(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!), decodeURIComponent(m[3]!));
      if (csv !== null) {
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "access-control-allow-origin": "*" });
        res.end(csv);
        return;
      }
    }
    const e = EVENTS_RE.exec(path);
    if (req.method === "GET" && e !== null) {
      const json = mock.eventsJson(decodeURIComponent(e[1]!), decodeURIComponent(e[2]!), decodeURIComponent(e[3]!));
      if (json !== null) {
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        res.end(json);
        return;
      }
    }
    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok\n");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  });
  server.on("upgrade", (req, socket) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== RPC_PATH) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    acceptUpgrade(req, socket, (ws) => {
      const client = mock.connect((frame) => ws.send(JSON.stringify(frame)));
      return { message: (text) => client.receive(text), close: () => client.close() };
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `ws://${host}:${port}${RPC_PATH}`,
    httpUrl: `http://${host}:${port}`,
    port,
    mock,
    close: () =>
      new Promise<void>((resolve) => {
        mock.dispose();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ---- CLI ----------------------------------------------------------------------------

async function main(argv: string[]): Promise<void> {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const script: ScriptStep[] = [];
  if (argv.includes("--demo")) script.push(...DEMO_SCRIPT);
  const scriptFile = arg("--script");
  if (scriptFile !== undefined) script.push(...(JSON.parse(readFileSync(scriptFile, "utf8")) as ScriptStep[]));
  const tick = arg("--tick");
  const srv = await startMockServer({
    port: Number(arg("--port") ?? process.env.RW_MOCK_RPC_PORT ?? 0),
    script,
    ...(tick === undefined ? {} : { tickMs: Number(tick) }),
    ...(argv.includes("--test-hooks") ? { testHooks: true } : {}),
  });
  process.stdout.write(`RW_RPC_URL=${srv.url}\nRW_HTTP_URL=${srv.httpUrl}\n`);
  const stop = (): void => void srv.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2));
}
