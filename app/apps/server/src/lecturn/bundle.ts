/**
 * Thread bundle fixtures (plan B13, spec W5.1): Lecturn's
 * `ConnectedAppThreadBundleV1` (`apps.exportThreads` / `apps.importThreads`)
 * as RocketWright commits it under `tests/fixtures/lecturn/`.
 *
 * A committed bundle is a template:
 * - every project's `workspaceRoot` is `{workspaceRoot}` and its `title`
 *   `{projectName}`, because each capture seeds a fresh project directory
 *   (`/tmp/<rand>/Research vehicle`) and Lecturn keys a bundle's threads by
 *   `(appId, workspaceRoot)`;
 * - every timestamp is relative to the fixture clock: `exportedAt` is
 *   `FIXTURE_CLOCK`, and `instantiateBundle` moves every timestamp by
 *   `now - exportedAt`, so rail ages ("3m", "1h") read the same at any time
 *   (pass the frozen clock as `now` when the capture freezes one);
 * - a run's id is `{runId:<sim>}` (B14): run ids hash the model and the core
 *   version, so a run card's result names the sim and `instantiateBundle`
 *   puts in the project's latest complete run of it (`runIds`).
 *
 * The shapes below mirror the bundle's fields the app reads or rewrites;
 * messages and turn items stay opaque JSON (Lecturn decodes them on import).
 *
 * A thread's `runtimeMode`, `interactionMode` and `modelSelection` (Lecturn
 * pin8, FIXM) are optional: an import keeps them (a copy is never more
 * permissive than its source), and a thread without them takes the
 * importing server's defaults. The committed fixtures set the modes
 * (Supervised, as every W-B2 thread runs) and leave the model out: a model
 * whose provider instance the importing server lacks makes Lecturn add a
 * "<provider> is not available here" notice to the copied thread.
 */

export const WORKSPACE_ROOT_TEMPLATE = "{workspaceRoot}";
export const PROJECT_NAME_TEMPLATE = "{projectName}";
/** `{runId:<sim>}`: the project's latest complete run of `<sim>` (B14). */
export const RUN_ID_TEMPLATE = /\{runId:([A-Za-z0-9_.-]+)\}/g;
export const runIdTemplate = (sim: string): string => `{runId:${sim}}`;
/** The clock a committed bundle's timestamps are relative to (its `exportedAt`). */
export const FIXTURE_CLOCK = "2026-10-24T12:00:00.000Z";

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** Lecturn `RuntimeMode` (`approval-required` is Supervised). */
export const BUNDLE_RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
export type BundleRuntimeMode = (typeof BUNDLE_RUNTIME_MODES)[number];
/** Lecturn `ProviderInteractionMode`. */
export const BUNDLE_INTERACTION_MODES = ["default", "plan"] as const;
export type BundleInteractionMode = (typeof BUNDLE_INTERACTION_MODES)[number];

export interface BundleThread {
  sourceThreadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  historyRevision: number;
  appData: string | null;
  subtitle: string | null;
  pinned: boolean;
  runtimeMode?: BundleRuntimeMode;
  interactionMode?: BundleInteractionMode;
  /** Lecturn `ModelSelection` (`instanceId`, `model`, options); opaque here. */
  modelSelection?: JsonObject;
  messages: JsonObject[];
  turnItems: JsonObject[];
}

export interface BundleProject {
  workspaceRoot: string;
  title: string;
  threads: BundleThread[];
}

export interface BundleAsset {
  sourceAttachmentId: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
  dataBase64: string;
}

export interface ThreadBundle {
  version: 1;
  appId: string;
  sourceEnvironmentId: string;
  exportedAt: string;
  projects: BundleProject[];
  assets: BundleAsset[];
}

/** A bundle that does not have the V1 shape. */
export class BundleError extends Error {
  override readonly name = "BundleError";
}

/** Keys whose ISO timestamp values `instantiateBundle` moves to the target clock. */
const TIME_KEYS = new Set(["createdAt", "updatedAt", "startedAt", "completedAt", "exportedAt"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v) && Number.isFinite(Date.parse(v));

function need(ok: boolean, what: string): void {
  if (!ok) throw new BundleError(`thread bundle: ${what}`);
}

/** Checks the V1 shape the app relies on (ids, timestamps, appData size, assets); returns the bundle typed. */
export function parseThreadBundle(raw: unknown): ThreadBundle {
  need(isObject(raw), "not an object");
  const b = raw as Record<string, unknown>;
  need(b["version"] === 1, "version must be 1");
  need(typeof b["appId"] === "string" && b["appId"] !== "", "appId");
  need(typeof b["sourceEnvironmentId"] === "string" && b["sourceEnvironmentId"] !== "", "sourceEnvironmentId");
  need(isIso(b["exportedAt"]), "exportedAt must be an ISO time");
  need(Array.isArray(b["projects"]) && Array.isArray(b["assets"]), "projects and assets must be arrays");
  const ids = new Set<string>();
  for (const p of b["projects"] as unknown[]) {
    need(isObject(p) && typeof p["workspaceRoot"] === "string" && typeof p["title"] === "string" && Array.isArray(p["threads"]), "project shape");
    for (const t of (p as { threads: unknown[] }).threads) {
      need(isObject(t), "thread shape");
      const th = t as Record<string, unknown>;
      const id = th["sourceThreadId"];
      need(typeof id === "string" && id !== "" && !ids.has(id), `sourceThreadId ${String(id)} missing or repeated`);
      ids.add(id as string);
      need(typeof th["title"] === "string", `${String(id)}: title`);
      need(isIso(th["createdAt"]) && isIso(th["updatedAt"]), `${String(id)}: createdAt/updatedAt`);
      need(Number.isInteger(th["historyRevision"]) && (th["historyRevision"] as number) >= 0, `${String(id)}: historyRevision`);
      need(th["appData"] === null || (typeof th["appData"] === "string" && Buffer.byteLength(th["appData"]) <= 1024), `${String(id)}: appData (≤ 1 KB string or null)`);
      need(th["subtitle"] === null || (typeof th["subtitle"] === "string" && th["subtitle"].length <= 80), `${String(id)}: subtitle (≤ 80 chars or null)`);
      need(typeof th["pinned"] === "boolean", `${String(id)}: pinned`);
      need(th["runtimeMode"] === undefined || (BUNDLE_RUNTIME_MODES as readonly unknown[]).includes(th["runtimeMode"]), `${String(id)}: runtimeMode`);
      need(th["interactionMode"] === undefined || (BUNDLE_INTERACTION_MODES as readonly unknown[]).includes(th["interactionMode"]), `${String(id)}: interactionMode`);
      need(th["modelSelection"] === undefined || (isObject(th["modelSelection"]) && typeof th["modelSelection"]["instanceId"] === "string" && typeof th["modelSelection"]["model"] === "string"), `${String(id)}: modelSelection`);
      need(Array.isArray(th["messages"]) && (th["messages"] as unknown[]).every(isObject), `${String(id)}: messages`);
      need(Array.isArray(th["turnItems"]) && (th["turnItems"] as unknown[]).every(isObject), `${String(id)}: turnItems`);
    }
  }
  for (const a of b["assets"] as unknown[]) {
    need(isObject(a) && typeof a["sourceAttachmentId"] === "string" && /^[a-z0-9_-]+$/i.test(a["sourceAttachmentId"]), "asset id");
    const asset = a as Record<string, unknown>;
    need(typeof asset["mimeType"] === "string" && typeof asset["dataBase64"] === "string", `asset ${String(asset["sourceAttachmentId"])}: mimeType/dataBase64`);
    need(typeof asset["sha256"] === "string" && /^[a-f0-9]{64}$/.test(asset["sha256"]), `asset ${String(asset["sourceAttachmentId"])}: sha256`);
    need(Buffer.from(asset["dataBase64"] as string, "base64").byteLength === asset["byteLength"], `asset ${String(asset["sourceAttachmentId"])}: byteLength`);
  }
  return raw as unknown as ThreadBundle;
}

export interface InstantiateOptions {
  /** The project's workspace root as Lecturn knows it (its realpath, D13). */
  workspaceRoot: string;
  projectName: string;
  /** The clock the bundle's `exportedAt` moves to (default `Date.now()`). */
  now?: number;
  /** sim → the run id `{runId:<sim>}` stands for; a template without one is a `BundleError`. */
  runIds?: Readonly<Record<string, string>>;
}

/** sim → its complete run's id (the one not superseded when the list has several): `InstantiateOptions.runIds`. */
export function completeRunIds(runs: readonly { sim: string; status: string; run_id?: string | null; superseded_by?: string | null }[]): Record<string, string> {
  const out: Record<string, string> = {};
  const current = new Set<string>();
  for (const r of runs) {
    if (r.status !== "complete" || typeof r.run_id !== "string" || r.run_id === "" || current.has(r.sim)) continue;
    out[r.sim] = r.run_id;
    if (r.superseded_by == null) current.add(r.sim);
  }
  return out;
}

function runIds(v: string, o: InstantiateOptions): string {
  return v.replace(RUN_ID_TEMPLATE, (_m, sim: string) => {
    const id = o.runIds?.[sim];
    if (id === undefined) throw new BundleError(`the bundle names a run of ${sim}, and the project has no complete one`);
    return id;
  });
}

function rewrite(v: unknown, key: string | null, shift: number, o: InstantiateOptions): unknown {
  if (typeof v === "string") {
    if (key !== null && TIME_KEYS.has(key) && isIso(v)) return new Date(Date.parse(v) + shift).toISOString();
    const named = v.includes(WORKSPACE_ROOT_TEMPLATE) || v.includes(PROJECT_NAME_TEMPLATE) ? v.replaceAll(WORKSPACE_ROOT_TEMPLATE, o.workspaceRoot).replaceAll(PROJECT_NAME_TEMPLATE, o.projectName) : v;
    return named.includes("{runId:") ? runIds(named, o) : named;
  }
  if (Array.isArray(v)) return v.map((x) => rewrite(x, null, shift, o));
  if (isObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = k === "dataBase64" ? x : rewrite(x, k, shift, o);
    return out;
  }
  return v;
}

/**
 * The bundle for one project: `{workspaceRoot}`, `{projectName}` and
 * `{runId:<sim>}` substituted everywhere (asset bytes excepted), and every timestamp moved
 * by `now - exportedAt`. The input is not modified.
 */
export function instantiateBundle(bundle: ThreadBundle, o: InstantiateOptions): ThreadBundle {
  const shift = (o.now ?? Date.now()) - Date.parse(bundle.exportedAt);
  return rewrite(bundle, null, shift, o) as ThreadBundle;
}

/** The bundle's source thread ids, in bundle order (the last one is the thread a capture opens). */
export function bundleThreadIds(bundle: ThreadBundle): string[] {
  return bundle.projects.flatMap((p) => p.threads.map((t) => t.sourceThreadId));
}

/** `rw:step/<n>`, `step:<n>` or `<n>`: the step a tool result names. */
const STEP_VALUE = /^(?:rw:step\/|step:)?([1-9]\d*)$/;
/** An app tool row of RocketWright's (`mcp__lecturn__rw_<tool>`, the scripted provider's `lecturn.rw_<tool>`, or `rw_<tool>`). */
const RW_TOOL = /^(?:mcp__lecturn__|lecturn\.)?rw_[a-z0-9_]+$/;
/** Most step links one thread's appData carries (the web's `LINKED_STEPS_MAX`). */
const MAX_LINKED_STEPS = 64;

/** The step `value` names: a step string or number (`MutationOut`, a step card's), or `history_show`'s `HistoryStep` object (`seq`). */
function stepOf(value: unknown): number | null {
  const v = isObject(value) ? value["seq"] : value;
  const m = typeof v === "string" ? STEP_VALUE.exec(v) : typeof v === "number" ? STEP_VALUE.exec(String(v)) : null;
  return m !== null ? Number(m[1]) : null;
}

/**
 * A tool row's result: the CallToolResult a live app call leaves as the
 * row's output (AppToolkit), the one inside a card tool's envelope
 * (`structuredContent: { lecturnMcpApp, result }`, AppCardEnvelope), or an
 * older bundle's `{ result }`.
 */
function toolRowResult(output: unknown): Record<string, unknown> | undefined {
  if (!isObject(output)) return undefined;
  if (isObject(output["result"])) return output["result"];
  const structured = output["structuredContent"];
  if (isObject(structured) && isObject(structured["lecturnMcpApp"]) && isObject(structured["result"])) return structured["result"];
  return output;
}

/**
 * The history steps a thread's turn items name: each completed RocketWright
 * tool row whose result's `structuredContent.step` is a step (a `MutationOut`
 * or a step card's string, or `history_show`'s step object with its `seq`).
 * Ascending, deduplicated.
 */
export function threadStepLinks(thread: Pick<BundleThread, "turnItems">): number[] {
  const out = new Set<number>();
  for (const item of thread.turnItems) {
    if (item["type"] !== "dynamic_tool" || item["status"] !== "completed") continue;
    if (typeof item["toolName"] !== "string" || !RW_TOOL.test(item["toolName"])) continue;
    const result = toolRowResult(item["output"]);
    if (result === undefined || result["isError"] === true) continue;
    const structured = result["structuredContent"];
    const step = stepOf(isObject(structured) ? structured["step"] : undefined);
    if (step !== null) out.add(step);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The bundle with each thread's step links in its appData (`"steps": [n, …]`,
 * next to the page binding): an imported thread's history predates it, so
 * `HistoryStep.thread` cannot attribute those steps, and the pane strip's
 * thread history (`embedThreadSteps`, web) reads them from here. Threads
 * that name no step, and appData that is not a JSON object, are left as
 * they are. The input is not modified.
 */
export function linkThreadSteps(bundle: ThreadBundle): ThreadBundle {
  const link = (t: BundleThread): BundleThread => {
    const steps = threadStepLinks(t).slice(0, MAX_LINKED_STEPS);
    if (steps.length === 0) return t;
    let data: unknown = {};
    if (t.appData !== null) {
      try {
        data = JSON.parse(t.appData);
      } catch {
        return t;
      }
    }
    if (!isObject(data)) return t;
    const appData = JSON.stringify({ ...data, steps });
    return Buffer.byteLength(appData) <= 1024 ? { ...t, appData } : t;
  };
  return { ...bundle, projects: bundle.projects.map((p) => ({ ...p, threads: p.threads.map(link) })) };
}
