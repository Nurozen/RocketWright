/**
 * One open project (R6.1): its sidecar (supervised, restarted with backoff),
 * the read-only mirror `ProjectSnapshot` refreshed on
 * `notifications/resources/updated`, job tracking (`job_status` polling plus
 * the `rw://jobs/<id>` subscription, never progress notifications), and the
 * project's server-side broker ops (the `app_seed_thread` test hook, window
 * render storage). The agent runs in Lecturn (B17 removed the old chat
 * engine, its threads and approvals); its window tools reach the project
 * through the app server's `/mcp/live`.
 *
 * The host never writes project files (I1): every change is a sidecar tool
 * call (I2) made with origin `ui`, thread `ui`.
 */
import type {
  CheckReport,
  CompareOut,
  JobInfo,
  ModelGetOut,
  MutationOut,
  PatchOp,
  ProjectInfo,
  ProjectPatch,
  ProjectSnapshot,
  Revision,
  SeedBundleArgs,
  SidecarState,
  SimulateOut,
  SnapshotKey,
} from "@rw/contracts";
import type { ApiError, schema } from "@rw/contracts";
import { BrokerArgsError, type ViewportBroker } from "../broker/ViewportBroker.ts";
import { RpcFail } from "../rpc/errors.ts";
import { META_LABEL, META_THREAD } from "../sidecar/SidecarClient.ts";
import { SidecarSupervisor, type BackoffOptions, type SidecarConnection } from "../sidecar/SidecarSupervisor.ts";
import { ThumbCache } from "./ThumbCache.ts";
import { listCfdDatasets } from "./cfdRuns.ts";
import { isTerminal, jobIdOf, jobUri, MIRROR_KEYS, MIRROR_RESOURCES, mirrorKeysFor, type MirrorKey } from "./mirror.ts";

/** `_meta` key the sidecar reads as the call origin. */
export const META_ORIGIN = "rw/origin";
/** The thread id of UI edits (IF10 `model.patch`). */
export const UI_THREAD = "ui";
/** Terminal jobs kept in the snapshot (newest). */
const KEEP_FINISHED_JOBS = 20;

export interface ProjectHostOptions {
  info: ProjectInfo;
  bin?: string;
  stderr?: "inherit" | "ignore" | "pipe";
  backoff?: BackoffOptions;
  /** Window in which `resources/updated` notifications merge into one patch (default 15 ms). */
  coalesceMs?: number;
  /** `job_status` poll interval while a job runs (default 500 ms). */
  jobPollMs?: number;
  connect?: () => SidecarConnection;
  /** The viewport broker: the `app_seed_thread` hook and window render storage (absent: neither). */
  broker?: ViewportBroker;
  /**
   * `app_seed_thread` with a Lecturn bundle (B13): imports it for this
   * project and resolves with the imported threads' Lecturn ids in bundle
   * order (the app server's Lecturn link). Absent: bundles are refused.
   */
  seedBundle?: (args: SeedBundleArgs) => Promise<string[]>;
}

export interface ProjectHostEvents {
  patch(patch: ProjectPatch): void;
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class ProjectHost {
  readonly info: ProjectInfo;
  readonly sidecar: SidecarSupervisor;
  /** M3.6 part thumbnails (`.rw/cache/thumbs/`), rendered by the window. */
  readonly thumbs: ThumbCache;
  private readonly opts: ProjectHostOptions;
  private readonly events: ProjectHostEvents;
  private snap: ProjectSnapshot;
  private pending = new Set<SnapshotKey>();
  private flushScheduled = false;
  private flushing: Promise<void> = Promise.resolve();
  private resyncing: Promise<void> = Promise.resolve();
  private readonly jobs = new Map<string, { timer: ReturnType<typeof setTimeout> | undefined; inFlight: boolean; again: boolean }>();
  private closed = false;

  constructor(opts: ProjectHostOptions, events: ProjectHostEvents) {
    this.opts = opts;
    this.info = opts.info;
    this.events = events;
    this.thumbs = new ThumbCache(opts.info.dir);
    this.snap = {
      project: { ...opts.info },
      sidecar: { state: "starting", version: null },
      evaluated: null,
      check: null,
      files: { model_hash: "", files: {} },
      history: { steps: [], revisions: [] },
      runs: { model_hash: "", runs: [] },
      jobs: [],
    };
    this.sidecar = new SidecarSupervisor({
      projectDir: opts.info.dir,
      ...(opts.bin === undefined ? {} : { bin: opts.bin }),
      ...(opts.stderr === undefined ? {} : { stderr: opts.stderr }),
      ...(opts.backoff === undefined ? {} : { backoff: opts.backoff }),
      ...(opts.connect === undefined ? {} : { connect: opts.connect }),
    });
    this.sidecar.onState((s) => this.sidecarState(s));
    this.sidecar.onReady((conn) => {
      this.resyncing = this.resync(conn);
    });
    // The relay front reconnected to a new owner or promoted itself (D4,
    // B1b): the child is the same, but the mirror may be stale.
    this.sidecar.onUpstreamChanged((conn) => {
      this.resyncing = this.resyncing.then(() => this.resync(conn));
    });
    this.sidecar.onResourceUpdated((uri) => this.resourceUpdated(uri));
    if (opts.broker?.testHooks === true) this.serveSeedThread(opts.broker);
    opts.broker?.storePictures(opts.info.projectId, (kind, png) => this.storePicture(kind, png));
  }

  /**
   * A window render's PNG stored under `renders/window/` by the sidecar's
   * internal `render_store` (the session writes it, I1); its path, which the
   * render card reads through `render_picture` (CPW2B).
   */
  private async storePicture(kind: string, pngBase64: string): Promise<string> {
    const r = await this.sidecar.callTool("render_store", { kind, png_base64: pngBase64 }, {});
    const path = (r.structuredContent as { path?: unknown } | undefined)?.path;
    if (r.isError === true || typeof path !== "string" || !path.startsWith("renders/")) {
      const text = r.content?.find((c) => c.type === "text") as { text?: string } | undefined;
      throw new Error(`render_store: ${text?.text ?? "no path"}`);
    }
    return path;
  }

  /**
   * `app_seed_thread` (I12, B13): a Lecturn bundle is imported through the
   * app server's Lecturn link, then the window opens its last thread.
   */
  private serveSeedThread(broker: ViewportBroker): void {
    const projectId = this.info.projectId;
    broker.handleLocally(projectId, "app_seed_thread", async (raw, threadId) => {
      if (!("bundle" in raw) || typeof raw.bundle !== "object" || raw.bundle === null || Array.isArray(raw.bundle)) throw new BrokerArgsError("app_seed_thread: expected {bundle, now?} (a Lecturn thread bundle)");
      if (raw.now !== undefined && !Number.isFinite(raw.now)) throw new BrokerArgsError("app_seed_thread: now must be epoch ms");
      if (this.opts.seedBundle === undefined) throw new BrokerArgsError("app_seed_thread: bundles need the Lecturn connection");
      const threadIds = await this.opts.seedBundle(raw);
      const last = threadIds.at(-1);
      if (last === undefined) throw new BrokerArgsError("app_seed_thread: the bundle holds no thread");
      if (broker.hasHost(projectId)) {
        const r = await broker.forward(projectId, "app_seed_thread", { thread: last }, threadId);
        if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
      }
      return { threadId: last, threadIds };
    });
  }

  /** Spawns the sidecar and loads the first full snapshot. */
  async start(): Promise<void> {
    await this.sidecar.start();
    await this.settled();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const j of this.jobs.values()) if (j.timer !== undefined) clearTimeout(j.timer);
    this.jobs.clear();
    await this.sidecar.stop();
  }

  /** The current mirror (a copy). */
  snapshot(): ProjectSnapshot {
    return structuredClone(this.snap);
  }

  /** Resolves when queued mirror refreshes have landed (tests, `start`). */
  async settled(): Promise<void> {
    await this.resyncing;
    while (this.flushScheduled || this.pending.size > 0) await new Promise((r) => setTimeout(r, 5));
    await this.flushing;
  }

  // ---- RPC operations ----

  async patchModel(ops: PatchOp[], dryRun: boolean, label: string | undefined): Promise<MutationOut> {
    const args: Record<string, unknown> = { ops, dry_run: dryRun };
    if (label !== undefined) args.label = label;
    return this.tool<MutationOut>("model_patch", args, label);
  }

  runCheck(config: string | undefined, strict: boolean | undefined): Promise<CheckReport> {
    const args: Record<string, unknown> = {};
    if (config !== undefined) args.config = config;
    if (strict !== undefined) args.strict = strict;
    return this.tool<CheckReport>("design_check", args);
  }

  async runSim(sim: string, force: boolean | undefined): Promise<SimulateOut> {
    const args: Record<string, unknown> = { sim };
    if (force !== undefined) args.force = force;
    const out = await this.tool<SimulateOut>("simulate", args);
    if (typeof out.job_id === "string" && out.job_id !== "" && (out.status === "running" || out.status === "not_run")) {
      this.trackJob({
        job_id: out.job_id,
        kind: "simulate",
        state: out.status === "running" ? "running" : "queued",
        progress: 0,
        sim: out.sim,
        run_id: out.run_id,
      });
    }
    return out;
  }

  async cancelJob(jobId: string): Promise<JobInfo> {
    const info = await this.tool<JobInfo>("job_cancel", { job_id: jobId });
    this.upsertJob(info);
    if (isTerminal(info)) this.untrackJob(jobId, true);
    return info;
  }

  /** The evaluated model at `version` (default live) through `model_get` (Compare, M2.7). */
  modelAt(version: string | undefined, config: string | undefined): Promise<ModelGetOut> {
    return this.tool<ModelGetOut>("model_get", { ...(version !== undefined ? { version } : {}), ...(config !== undefined ? { config } : {}) });
  }

  compare(a: string, b: string): Promise<CompareOut> {
    return this.tool<CompareOut>("history_compare", { a, b });
  }

  async tag(name: string, version: string | undefined): Promise<Revision> {
    const rev = await this.tool<Revision>("history_tag", version === undefined ? { name } : { name, version });
    // Tagging is not a model mutation (no `resources/updated`), but it changes the history.
    this.invalidate(["history"]);
    return rev;
  }

  restore(version: string, dryRun: boolean): Promise<MutationOut> {
    return this.tool<MutationOut>("history_restore", { version, dry_run: dryRun });
  }

  /** `library_search` (read only): presets, components, materials, and motors. */
  librarySearch(q: { query?: string; kind?: string; limit?: number }): Promise<schema.LibrarySearchOut> {
    return this.tool<schema.LibrarySearchOut>("library_search", q);
  }

  /** `engine_design` (read only): the engine's sizing, feed budget, tanks, and missing inputs (page 05). */
  engineDesign(engine: string): Promise<schema.EngineDesignOut> {
    return this.tool<schema.EngineDesignOut>("engine_design", { engine });
  }

  /** `engine_simulate`: the engine's blowdown run (`runs/engine.<id>/<run>/`; page 06 Engineering). */
  engineSimulate(engine: string, duration: string | undefined): Promise<schema.SimulateOut> {
    return this.tool<schema.SimulateOut>("engine_simulate", duration === undefined ? { engine } : { engine, duration });
  }

  /** `cfd_import`: a CSV step or a directory of steps into `runs/cfd.<id>/<run>/` (page 06 Imported CFD, M5.4). A user action: not gated. */
  cfdImport(q: { path: string; study?: string; dry_run?: boolean }): Promise<schema.CfdImportOut> {
    return this.tool<schema.CfdImportOut>("cfd_import", q, "Import CFD dataset");
  }

  /** `thrustcurve_search`: thrustcurve.org over the network, only when the user asks (Configurations > Motors). Writes nothing. */
  thrustcurveSearch(q: { query?: string; manufacturer?: string; diameter?: string; impulse_class?: string; limit?: number }): Promise<schema.ThrustcurveSearchOut> {
    return this.tool<schema.ThrustcurveSearchOut>("thrustcurve_search", q);
  }

  /** `thrustcurve_fetch`: downloads a motor's data file into `lib/motors/` (one history step). A user action: not gated. */
  thrustcurveFetch(q: { motor: string; manufacturer?: string; format?: "eng" | "rse"; dry_run?: boolean }): Promise<schema.ThrustcurveFetchOut> {
    return this.tool<schema.ThrustcurveFetchOut>("thrustcurve_fetch", q);
  }

  /** The imported CFD datasets on disk (read only). */
  cfdList(): { datasets: schema.CfdDataset[] } {
    return { datasets: listCfdDatasets(this.info.dir) };
  }

  /** One sidecar tool call as the UI; tool errors become `api_error`. */
  async tool<T>(name: string, args: Record<string, unknown>, label?: string): Promise<T> {
    if (this.closed) throw new RpcFail("not_found", `project ${this.info.projectId} is closed`);
    const meta: Record<string, unknown> = { [META_ORIGIN]: "ui", [META_THREAD]: UI_THREAD };
    if (label !== undefined) meta[META_LABEL] = label;
    const r = await this.sidecar.callTool(name, args, meta);
    if (r.isError === true) {
      const api = (r._meta as Record<string, unknown> | undefined)?.["rw/error"] as ApiError | undefined;
      const text = r.content.map((c) => ("text" in c && typeof c.text === "string" ? c.text : "")).join("\n");
      throw new RpcFail("api_error", api?.message ?? (text || `${name} failed`), api);
    }
    if (r.structuredContent === undefined) throw new RpcFail("internal", `${name}: no structured result`);
    return r.structuredContent as T;
  }

  // ---- mirror ----

  private sidecarState(s: SidecarState): void {
    this.snap.sidecar = { state: s, version: s === "ready" ? this.sidecar.version() : this.snap.sidecar.version };
    this.emitPatch(["sidecar"]);
  }

  /** After every (re)start or upstream change: subscribe, then refresh everything. */
  private async resync(conn: SidecarConnection): Promise<void> {
    const uris = [...Object.values(MIRROR_RESOURCES), ...[...this.jobs.keys()].map(jobUri)];
    await Promise.all(uris.map((u) => conn.subscribe(u).catch(() => undefined)));
    this.invalidate(MIRROR_KEYS);
    for (const id of this.jobs.keys()) void this.pollJob(id);
  }

  private resourceUpdated(uri: string): void {
    const jobId = jobIdOf(uri);
    if (jobId !== undefined) {
      if (this.jobs.has(jobId)) void this.pollJob(jobId);
      return;
    }
    this.invalidate(mirrorKeysFor(uri));
  }

  /** Queues keys for refresh; notifications arriving together become one patch. */
  private invalidate(keys: readonly SnapshotKey[]): void {
    if (keys.length === 0 || this.closed) return;
    for (const k of keys) this.pending.add(k);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => {
      this.flushScheduled = false;
      this.flushing = this.flushing.then(() => this.flush());
    }, this.opts.coalesceMs ?? 15);
  }

  private async flush(): Promise<void> {
    const keys = [...this.pending].sort() as SnapshotKey[];
    this.pending.clear();
    if (keys.length === 0 || this.closed) return;
    let conn: SidecarConnection;
    try {
      conn = await this.sidecar.ready();
    } catch {
      return; // the next resync refreshes everything
    }
    const changed: SnapshotKey[] = [];
    await Promise.all(
      keys.map(async (k) => {
        if (!(k in MIRROR_RESOURCES)) return;
        try {
          const v = await conn.readJson(MIRROR_RESOURCES[k as MirrorKey]);
          (this.snap as unknown as Record<string, unknown>)[k] = v;
          changed.push(k);
        } catch {
          // Keep the last good value (a parse error keeps the last good model).
        }
      }),
    );
    if (changed.length > 0) this.emitPatch(changed.sort());
  }

  private emitPatch(keys: SnapshotKey[]): void {
    if (this.closed) return;
    const patch: ProjectPatch = { projectId: this.info.projectId };
    for (const k of keys) (patch as unknown as Record<string, unknown>)[k] = structuredClone(this.snap[k]);
    this.events.patch(patch);
  }

  // ---- jobs ----

  private trackJob(initial: JobInfo): void {
    this.upsertJob(initial);
    if (this.jobs.has(initial.job_id)) return;
    this.jobs.set(initial.job_id, { timer: undefined, inFlight: false, again: false });
    void this.sidecar
      .ready()
      .then((c) => c.subscribe(jobUri(initial.job_id)))
      .catch(() => undefined);
    void this.pollJob(initial.job_id);
  }

  private async pollJob(jobId: string): Promise<void> {
    const j = this.jobs.get(jobId);
    if (j === undefined) return;
    if (j.inFlight) {
      j.again = true;
      return;
    }
    if (j.timer !== undefined) clearTimeout(j.timer);
    j.timer = undefined;
    j.inFlight = true;
    let info: JobInfo | undefined;
    try {
      info = await this.tool<JobInfo>("job_status", { job_id: jobId });
    } catch (e) {
      if (e instanceof RpcFail && e.code === "api_error" && e.api?.code === "not_found") {
        this.upsertJob({ ...this.jobInfo(jobId), state: "failed", error: errMessage(e) });
        this.untrackJob(jobId, true);
        return;
      }
    } finally {
      j.inFlight = false;
    }
    if (!this.jobs.has(jobId)) return;
    if (info !== undefined) {
      this.upsertJob(info);
      if (isTerminal(info)) {
        this.untrackJob(jobId, true);
        return;
      }
    }
    if (j.again) {
      j.again = false;
      void this.pollJob(jobId);
      return;
    }
    j.timer = setTimeout(() => void this.pollJob(jobId), this.opts.jobPollMs ?? 500);
  }

  private jobInfo(jobId: string): JobInfo {
    return this.snap.jobs.find((x) => x.job_id === jobId) ?? { job_id: jobId, kind: "simulate", state: "running", progress: 0 };
  }

  private upsertJob(info: JobInfo): void {
    const i = this.snap.jobs.findIndex((x) => x.job_id === info.job_id);
    if (i >= 0) this.snap.jobs[i] = info;
    else this.snap.jobs.push(info);
    const finished = this.snap.jobs.filter(isTerminal);
    if (finished.length > KEEP_FINISHED_JOBS) {
      const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED_JOBS));
      this.snap.jobs = this.snap.jobs.filter((x) => !drop.has(x));
    }
    this.emitPatch(["jobs"]);
  }

  private untrackJob(jobId: string, refreshRuns: boolean): void {
    const j = this.jobs.get(jobId);
    if (j === undefined) return;
    if (j.timer !== undefined) clearTimeout(j.timer);
    this.jobs.delete(jobId);
    void this.sidecar
      .ready(1000)
      .then((c) => c.unsubscribe(jobUri(jobId)))
      .catch(() => undefined);
    if (refreshRuns) this.invalidate(["runs"]);
  }
}
