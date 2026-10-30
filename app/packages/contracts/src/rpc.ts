/**
 * IF10: WebSocket RPC between the web UI (Electron or browser) and
 * `apps/server` (frozen at M1.5; changes need a `docs/dev/contract-changes.md`
 * line). Transport: one WebSocket per window at `ws://127.0.0.1:<port>/rpc`,
 * JSON text frames. Requests get exactly one response; pushes arrive on
 * subscriptions. The server owns no project files (I1): every model change
 * goes through the sidecar as an `rw_api::Command` (I2).
 */
import type {
  ApiError,
  CheckReport,
  CompareOut,
  EvaluatedModel,
  HistoryListOut,
  JobInfo,
  ModelGetOut,
  JsonObject,
  MutationOut,
  PatchOp,
  ProjectFiles,
  Revision,
  RunListOut,
  RwRef,
  SimulateOut,
} from "./types.ts";
import type { CfdDataset, CfdImportOut, EngineDesignOut, LibKind, LibrarySearchOut } from "./generated/types.ts";
import type { BrokerArgs, BrokerCapabilities, BrokerRequest, BrokerResponse, PageId, TestHookOp } from "./broker.ts";

export const RPC_VERSION = "rw-rpc/1" as const;
/** WebSocket path on the server. */
export const RPC_PATH = "/rpc" as const;
/**
 * Query parameter on the socket URL carrying the server's per-launch secret
 * (`ws://127.0.0.1:<port>/rpc?token=…`); the upgrade is refused without it.
 * A browser page gets it in its URL fragment (`#token=…`), the desktop through
 * the preload's `rpcUrl`.
 */
export const RPC_TOKEN_PARAM = "token" as const;
/** Run series are fetched over HTTP, never copied over RPC (G §4.2). */
export const SERIES_PATH = "/api/projects/:projectId/runs/:sim/:runId/series.csv" as const;
/** A run's flight events (`events.json`, `RunEvents`), beside its series. */
export const EVENTS_PATH = "/api/projects/:projectId/runs/:sim/:runId/events.json" as const;
/**
 * An engine run's record (`runs/engine.<id>/<run>/engine.json`: `provenance`,
 * the design, and every blowdown sample), beside its series (M4.8).
 */
export const ENGINE_RUN_PATH = "/api/projects/:projectId/runs/:sim/:runId/engine.json" as const;
/**
 * A visual flow study's timeline (`runs/<study>/<run>/visual.json`, `VisualRun`:
 * `provenance = "visual"`, the tank, the engine proportions, and every sample),
 * beside its manifest (M5.1). Never an engineering result (I13).
 */
export const VISUAL_RUN_PATH = "/api/projects/:projectId/runs/:sim/:runId/visual.json" as const;
/**
 * An imported CFD dataset's record (`runs/cfd.<id>/<run>/cfd.json`:
 * `provenance` `cfd`, units, and every step's columns; M5.4, R6.15).
 */
export const CFD_RUN_PATH = "/api/projects/:projectId/runs/:sim/:runId/cfd.json" as const;

// ---- shared shapes -------------------------------------------------------------

export interface ProjectInfo {
  projectId: string;
  dir: string;
  name: string;
}

export type SidecarState = "starting" | "ready" | "restarting" | "failed";

/** The read-only mirror the server keeps per project (refreshed on `resources/updated`). */
export interface ProjectSnapshot {
  project: ProjectInfo;
  sidecar: { state: SidecarState; version: string | null };
  /** `null` until the first successful eval (parse errors keep the last good model). */
  evaluated: EvaluatedModel | null;
  check: CheckReport | null;
  files: ProjectFiles;
  history: HistoryListOut;
  runs: RunListOut;
  jobs: JobInfo[];
}

/** Keys of the snapshot replaced wholesale by a patch push. */
export type SnapshotKey = Exclude<keyof ProjectSnapshot, "project">;
export type ProjectPatch = { projectId: string } & { [K in SnapshotKey]?: ProjectSnapshot[K] };

/**
 * Where a thread is bound (R6.9): a page, or an artifact that lives on one.
 * Stored as RocketWright's `appData` JSON on a Lecturn thread (W3.5).
 */
export type ThreadBinding = { page: PageId } | { artifact: RwRef };

/** A ref and its label: a mention in the embed's composer strip, or a run picked for a comparison. */
export interface Mention {
  ref: RwRef;
  label: string;
}

/**
 * Where a Lecturn embed view loads (Lecturn `AppEmbedTarget`): the guest URL
 * (`<origin>/embed/<env>/<project>[/<thread>]`), a short-lived token that is
 * never part of the URL, and its ISO 8601 expiry.
 */
export interface EmbedTarget {
  url: string;
  token: string;
  expiresAt: string;
}

/** A Lecturn thread's turn state as the rail shows it. */
export type EmbedThreadState = "idle" | "running" | "awaiting-approval";

/**
 * One Lecturn thread of a project's workspace, as Lecturn reports it
 * (`ConnectedAppThreadSummary`). `threadId` and `projectId` are Lecturn ids
 * on the server the child is attached to now: both change on a live switch
 * (D25), so key rail state by `workspaceRoot` plus the source thread
 * (`copiedFrom.sourceThreadId` for a copy), never by these ids.
 */
export interface EmbedThread {
  threadId: string;
  /** Lecturn's project id (not RocketWright's `ProjectInfo.projectId`). */
  projectId: string;
  /** The project's realpath, exactly as RocketWright registered it (D13). */
  workspaceRoot: string;
  title: string;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
  /** Moves only with thread history (messages, turn items, terminal turn events). */
  historyRevision: number;
  state: EmbedThreadState;
  /** RocketWright's own data for the thread (`{"page":…}` / `{"artifact":…}` JSON, ≤ 1 KB), or null. */
  appData: string | null;
  /** Idle-row subtitle (≤ 80 chars), or null. */
  subtitle: string | null;
  /** Present on a copy of a Lecturn-sidecar thread on the user's server. */
  copiedFrom?: { appId: string; sourceEnvironmentId: string; sourceThreadId: string; copiedAt: string; sourceHistoryRevision: number };
  /** Present on a sidecar thread that was copied to the user's server (shown read-only there). */
  continuedIn?: { environmentId: string; threadId: string; copiedAt: string };
}

/**
 * The child's Lecturn connection (B8, `apps/server/src/lecturn/connection.ts`).
 * - `state`: `connecting` until `connect()` settles, then `connected`;
 *   `unavailable` when it failed or Lecturn is not configured (`message`
 *   says why).
 * - `mode`: which Lecturn server the child is attached to (`sidecar`: its own
 *   bundled one; `user-server`: the user's), null until connected.
 * - `pairing`: the pairing request to the user's server (`pending` while the
 *   user has not answered, `denied` after a refusal).
 * - `switched`: set on the push that announces a live switch (D25, the
 *   helper's `mode` event): the new environment, every open RocketWright
 *   project's new Lecturn project id (by RocketWright `projectId`), and the
 *   old-to-new Lecturn thread id map. Main retargets its mounts with it.
 */
export interface LecturnStatus {
  state: "connecting" | "connected" | "unavailable";
  mode: "sidecar" | "user-server" | null;
  pairing: "none" | "pending" | "denied";
  message?: string;
  switched?: { environmentId: string; projects: Record<string, string>; threadIdMap: Record<string, string> };
}

// ---- methods -------------------------------------------------------------------

type P = { projectId: string };

/** Method name → params and result. */
export interface RpcMethods {
  "project.list": { params: Record<string, never>; result: { projects: ProjectInfo[] } };
  "project.open": { params: { dir: string }; result: { project: ProjectInfo } };
  "project.close": { params: P; result: Record<string, never> };
  /** Pushes `project.snapshot` once, then `project.patch` on every change. */
  "project.subscribe": { params: P; result: { subscriptionId: string; snapshot: ProjectSnapshot } };
  "project.unsubscribe": { params: { subscriptionId: string }; result: Record<string, never> };
  /** UI edits: origin `ui`, thread `ui`. `dry_run` previews the delta. */
  "model.patch": { params: P & { ops: PatchOp[]; dry_run?: boolean; label?: string }; result: MutationOut };
  /** The evaluated model at a version (`live`, `step:N`, `rev:NN`, `run:<id>`; Compare, M2.7). */
  "model.get": { params: P & { version?: string; config?: string }; result: ModelGetOut };
  "check.run": { params: P & { config?: string; strict?: boolean }; result: CheckReport };
  "sim.run": { params: P & { sim: string; force?: boolean }; result: SimulateOut };
  "job.cancel": { params: P & { jobId: string }; result: JobInfo };
  "history.compare": { params: P & { a: string; b: string }; result: CompareOut };
  "history.tag": { params: P & { name: string; version?: string }; result: Revision };
  "history.restore": { params: P & { version: string; dry_run?: boolean }; result: MutationOut };
  /** Project and built-in library (`rw lib search`: presets, components, materials, motors), read only. */
  "library.search": { params: P & { query?: string; kind?: LibKind; limit?: number }; result: LibrarySearchOut };
  /** M3.6: cached part thumbnails of one evaluated model (`.rw/cache/thumbs/<model_hash>/`): id -> PNG base64. */
  "thumb.get": { params: P & { model_hash: string }; result: { thumbs: Record<string, string> } };
  /** M3.6: stores one part thumbnail the window rendered (visual tier). */
  "thumb.put": { params: P & { model_hash: string; id: string; png_base64: string }; result: Record<string, never> };
  /** The sidecar's `engine_design` (read only): sizing, feed, tanks, missing inputs (page 05, M4.7). */
  "engine.design": { params: P & { engine: string }; result: EngineDesignOut };
  /** The sidecar's `engine_simulate`: the blowdown run of one engine (`runs/engine.<id>/<run>/`; page 06, M4.8). */
  "engine.simulate": { params: P & { engine: string; duration?: string }; result: SimulateOut };
  /** The sidecar's `cfd_import`: a CSV step or a directory of `<prefix>_t<s>.csv` steps into `runs/cfd.<id>/<run>/` (page 06 Imported CFD, M5.4). */
  "cfd.import": { params: P & { path: string; study?: string; dry_run?: boolean }; result: CfdImportOut };
  /** Imported CFD datasets on disk (`runs/cfd.<id>/<run>/dataset.json`, newest run per dataset), by id. */
  "cfd.list": { params: P; result: { datasets: CfdDataset[] } };
  /** The web window registers as the viewport host for broker ops (IF11). */
  "broker.hostRegister": { params: P & { hostId: string; capabilities: BrokerCapabilities }; result: Record<string, never> };
  "broker.respond": { params: BrokerResponse; result: Record<string, never> };
  /**
   * The Lecturn embed target for a project (and optionally a Lecturn thread),
   * fetched by Electron main to mount the chat pane (D2). Waits for the
   * project's workspace; `internal` when Lecturn is unavailable.
   */
  "embed.target": { params: P & { threadId?: string }; result: EmbedTarget };
  /** A fresh embed token for the project's pane (the guest's `lecturn/token.refresh`). */
  "embed.refreshToken": { params: P; result: EmbedTarget };
  /**
   * Writes RocketWright's `appData` (≤ 1 KB, null clears) and optionally the
   * idle-row subtitle (≤ 80 chars; omitted keeps it, null clears) of one of
   * the project's Lecturn threads. Never counts as thread history.
   */
  "embed.setThreadAppData": { params: P & { threadId: string; appData: string | null; subtitle?: string | null }; result: Record<string, never> };
  /**
   * The window's host context for the project's Lecturn agent (B12; Lecturn
   * `apps.updateHostContext`, project target): plain text (≤ 4 KB UTF-8, ""
   * clears) with the facts the old chat put in `<rw-context>` (current page,
   * selected parts and their key dimensions, active configuration and sim).
   * Lecturn prefixes it to each turn; the helper carries it across a live
   * switch (D25). `applied` is true once Lecturn took it (a failure is an
   * `internal` error).
   */
  "embed.setHostContext": { params: P & { text: string }; result: { applied: boolean } };
  /** Test hooks: rejected unless the server runs with `RW_TEST_HOOKS=1` (I12). */
  "test.call": { params: P & { op: TestHookOp; args: BrokerArgs[TestHookOp] }; result: JsonObject };
}

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M]["params"];
export type RpcResult<M extends RpcMethod> = RpcMethods[M]["result"];

export const RPC_METHODS = [
  "project.list",
  "project.open",
  "project.close",
  "project.subscribe",
  "project.unsubscribe",
  "model.patch",
  "model.get",
  "check.run",
  "sim.run",
  "job.cancel",
  "history.compare",
  "history.tag",
  "history.restore",
  "library.search",
  "thumb.get",
  "thumb.put",
  "engine.design",
  "engine.simulate",
  "cfd.import",
  "cfd.list",
  "broker.hostRegister",
  "broker.respond",
  "embed.target",
  "embed.refreshToken",
  "embed.setThreadAppData",
  "embed.setHostContext",
  "test.call",
] as const satisfies readonly RpcMethod[];

// ---- pushes --------------------------------------------------------------------

/** Push topic → payload. */
export interface RpcTopics {
  /**
   * Broadcast to every socket when the server opens a project (the CLI's
   * `--project` dirs and `project.open`; never for one already open). Electron
   * main listens for it to `ensureWorkspace` the project (D2); projects opened
   * before a socket connected come from `project.list`.
   */
  "project.opened": { project: ProjectInfo };
  "project.snapshot": { subscriptionId: string; snapshot: ProjectSnapshot };
  "project.patch": { subscriptionId: string; patch: ProjectPatch };
  "broker.request": BrokerRequest;
  /**
   * A project's Lecturn threads (the whole list) whenever one changes, keyed
   * by RocketWright `projectId`. Also sent to each new socket after `hello`
   * for every open project that has a list.
   */
  "embed.threads": { projectId: string; threads: EmbedThread[] };
  /** The child's Lecturn connection on every change; also sent to each new socket after `hello`. */
  "lecturn.status": LecturnStatus;
}

export type RpcTopic = keyof RpcTopics;

// ---- frames --------------------------------------------------------------------

export interface RpcError {
  code: "not_found" | "invalid_params" | "sidecar_unavailable" | "version_mismatch" | "hooks_disabled" | "api_error" | "internal";
  message: string;
  /** Present when the sidecar returned an `rw_api::ApiError`. */
  api?: ApiError;
}

export type RpcRequestFrame<M extends RpcMethod = RpcMethod> = { kind: "request"; id: number; method: M; params: RpcParams<M> };
export type RpcResponseFrame<M extends RpcMethod = RpcMethod> =
  | { kind: "response"; id: number; ok: true; result: RpcResult<M> }
  | { kind: "response"; id: number; ok: false; error: RpcError };
export type RpcPushFrame<T extends RpcTopic = RpcTopic> = { kind: "push"; topic: T; payload: RpcTopics[T] };
/** Sent by the server first; the client closes on a version mismatch (D19c). */
export type RpcHelloFrame = { kind: "hello"; rpc: typeof RPC_VERSION; schema: "rw/1"; coreVersion: string; testHooks: boolean };

export type ServerFrame = RpcHelloFrame | RpcResponseFrame | RpcPushFrame;
export type ClientFrame = RpcRequestFrame;
