/**
 * Viewport broker (IF11, R6.10, R6.11): the agent's view into the web UI.
 *
 * The web window registers per project with `broker.hostRegister`; an op is
 * pushed to it as `broker.request` and answered with `broker.respond`. The
 * agent reaches the agent ops (`viewport_render`, `viewport_select`,
 * `viewport_set_camera`, `plot_render`) as tools on the app HTTP MCP. The
 * `app_*` test hooks exist only when the server runs with `RW_TEST_HOOKS=1`
 * (I12): without it they are neither listed nor callable, over MCP or RPC.
 *
 * Live tools (B9, D20): Lecturn calls the same ops on the live route
 * (`/mcp/live`) with `_meta["lecturn/context"]`; `requestForWorkspace` routes
 * each by `realpath(workspaceRoot)` to the open project and takes the thread
 * from the same meta. `viewport_render` and `plot_render` declare
 * `_meta.ui.resourceUri: ui://rw/render-card` (D7), served by that route.
 *
 * Stored pictures (CPW2B): Lecturn hands cards results without image bytes,
 * so the render card reads the PNG a result names (`path`) through the CLI's
 * `render_picture`, which serves `renders/**.png` only. With a project's
 * `PictureStore` registered (`ProjectHost`: the sidecar's `render_store`,
 * the session being the only writer, I1), a window render's PNG is stored
 * under `renders/window/` and its result gains `path`.
 *
 * Ported from Lecturn (MIT) apps/server/src/preview/PreviewAutomationBroker.ts
 * (design only; rewritten in plain TS).
 */
import { randomUUID } from "node:crypto";
import {
  AGENT_OPS,
  BROKER_OP_TITLES,
  TEST_HOOK_OPS,
  type BrokerArgs,
  type BrokerCapabilities,
  type BrokerOp,
  type BrokerRequest,
  type BrokerResponse,
  type BrokerResults,
} from "@rw/contracts";
import { workspaceRootOf } from "../lecturn/connection.ts";
import { META_APPROVAL, type SidecarTool } from "../sidecar/SidecarClient.ts";

/** `_meta` key of every call Lecturn proxies: `{projectId, threadId, workspaceRoot, turnId}`. */
export const META_LECTURN_CONTEXT = "lecturn/context";
/** The MCP Apps card `viewport_render` and `plot_render` render in (D7). */
export const RENDER_CARD_URI = "ui://rw/render-card";
/** A live call for a workspace with no open project (or no window for it). */
export const PROJECT_NOT_OPEN = "project not open in RocketWright";

/** The routing half of `_meta["lecturn/context"]`. */
export interface LecturnCallContext {
  workspaceRoot: string;
  threadId: string | null;
}

/** `_meta["lecturn/context"]` of a live call, or undefined without a workspace root. */
export function lecturnContextOf(meta: Record<string, unknown> | undefined): LecturnCallContext | undefined {
  const c = meta?.[META_LECTURN_CONTEXT];
  if (typeof c !== "object" || c === null) return undefined;
  const { workspaceRoot, threadId } = c as Record<string, unknown>;
  if (typeof workspaceRoot !== "string" || workspaceRoot === "") return undefined;
  return { workspaceRoot, threadId: typeof threadId === "string" && threadId !== "" ? threadId : null };
}

/** Default wait for `broker.respond`. */
export const BROKER_TIMEOUT_MS = 10_000;

export interface BrokerHost {
  /** The connection that registered (only it may answer its requests). */
  owner: unknown;
  hostId: string;
  capabilities: BrokerCapabilities;
  /** Pushes a `broker.request` to the host. */
  send(req: BrokerRequest): void;
}

export interface ViewportBrokerOptions {
  /** Expose `app_*` (default `RW_TEST_HOOKS=1`). */
  testHooks?: boolean;
  timeoutMs?: number;
  /** Reports a picture that could not be stored (the result keeps its image, without `path`). */
  log?: (line: string) => void;
}

type BrokerError = Extract<BrokerResponse, { ok: false }>["error"];

/** A server-side op body (e.g. `app_seed_thread` writes the thread before the host opens it). */
export type LocalHandler<O extends BrokerOp> = (args: BrokerArgs[O], threadId: string | null) => Promise<BrokerResults[O]>;

/** Stores a window render's PNG for a project; resolves its project-relative path under `renders/`. */
export type PictureStore = (kind: BrokerOp, pngBase64: string) => Promise<string>;

/** The ops whose PNG is stored for the render card (`viewport_render`, `plot_render`). */
export const STORED_PICTURE_OPS: readonly BrokerOp[] = ["viewport_render", "plot_render"];

/** Bad arguments to a local handler (answered as `invalid_args`). */
export class BrokerArgsError extends Error {}

interface Pending {
  projectId: string;
  owner: unknown;
  done(r: BrokerResponse): void;
}

export const testHooksFromEnv = (env: NodeJS.ProcessEnv = process.env): boolean => env.RW_TEST_HOOKS === "1";

export class ViewportBroker {
  readonly testHooks: boolean;
  private readonly timeoutMs: number;
  private readonly hosts = new Map<string, BrokerHost>();
  private readonly pending = new Map<string, Pending>();
  private readonly local = new Map<string, Map<BrokerOp, LocalHandler<BrokerOp>>>();
  private readonly stores = new Map<string, PictureStore>();
  private readonly log: (line: string) => void;

  constructor(opts: ViewportBrokerOptions = {}) {
    this.testHooks = opts.testHooks ?? testHooksFromEnv();
    this.timeoutMs = opts.timeoutMs ?? BROKER_TIMEOUT_MS;
    this.log = opts.log ?? (() => undefined);
  }

  /** The ops this server serves: the agent ops, plus `app_*` with test hooks on. */
  ops(): BrokerOp[] {
    return this.testHooks ? [...AGENT_OPS, ...TEST_HOOK_OPS] : [...AGENT_OPS];
  }

  serves(op: string): op is BrokerOp {
    return (this.ops() as string[]).includes(op);
  }

  /** MCP tool definitions for `ops()` (listed after the sidecar's tools). */
  tools(): SidecarTool[] {
    return this.ops().map((op) => BROKER_TOOLS[op]);
  }

  register(projectId: string, host: BrokerHost): void {
    this.hosts.set(projectId, host);
  }

  hasHost(projectId: string): boolean {
    return this.hosts.has(projectId);
  }

  /** A connection closed: drop its hosts and fail what it still owed. */
  dropOwner(owner: unknown): void {
    for (const [pid, h] of [...this.hosts]) if (h.owner === owner) this.hosts.delete(pid);
    for (const [id, p] of [...this.pending]) {
      if (p.owner === owner) p.done({ requestId: id, ok: false, error: { code: "failed", message: "viewport host disconnected" } });
    }
  }

  /** Serves `op` for `projectId` in the server instead of forwarding it (the handler may still `forward`). */
  handleLocally<O extends BrokerOp>(projectId: string, op: O, fn: LocalHandler<O>): void {
    const m = this.local.get(projectId) ?? new Map<BrokerOp, LocalHandler<BrokerOp>>();
    m.set(op, fn as unknown as LocalHandler<BrokerOp>);
    this.local.set(projectId, m);
  }

  /** Stores `projectId`'s window renders (STORED_PICTURE_OPS) through `store`; their results gain `path`. */
  storePictures(projectId: string, store: PictureStore): void {
    this.stores.set(projectId, store);
  }

  dropProject(projectId: string): void {
    this.hosts.delete(projectId);
    this.local.delete(projectId);
    this.stores.delete(projectId);
    for (const [id, p] of [...this.pending]) {
      if (p.projectId === projectId) p.done({ requestId: id, ok: false, error: { code: "failed", message: "project closed" } });
    }
  }

  /**
   * Runs one op: its local handler when one is registered, else `forward`.
   * Resolves with the answer, `no_host`, or `timeout`. Never rejects.
   */
  request<O extends BrokerOp>(projectId: string, op: O, args: BrokerArgs[O], threadId: string | null): Promise<BrokerResponse<O>> {
    return this.run(projectId, op, args, threadId).then((r) => this.withStoredPicture(projectId, op, r));
  }

  private run<O extends BrokerOp>(projectId: string, op: O, args: BrokerArgs[O], threadId: string | null): Promise<BrokerResponse<O>> {
    const local = this.serves(op) ? this.local.get(projectId)?.get(op) : undefined;
    if (local === undefined) return this.forward(projectId, op, args, threadId);
    const requestId = `broker-${randomUUID()}`;
    return Promise.resolve()
      .then(() => (local as unknown as LocalHandler<O>)(args, threadId))
      .then(
        (result): BrokerResponse<O> => ({ requestId, ok: true, result }),
        (e: unknown): BrokerResponse<O> => ({
          requestId,
          ok: false,
          error: { code: e instanceof BrokerArgsError ? "invalid_args" : "failed", message: e instanceof Error ? e.message : String(e) },
        }),
      );
  }

  /** A window render's answer with its PNG stored and `path` added; unchanged without a store or on a store failure. Never rejects. */
  private async withStoredPicture<O extends BrokerOp>(projectId: string, op: O, r: BrokerResponse<O>): Promise<BrokerResponse<O>> {
    if (!r.ok || !STORED_PICTURE_OPS.includes(op)) return r;
    const store = this.stores.get(projectId);
    const png = (r.result as { png_base64?: unknown } | undefined)?.png_base64;
    if (store === undefined || typeof png !== "string") return r;
    try {
      const path = await store(op, png);
      return { ...r, result: { ...(r.result as object), path } as BrokerResults[O] };
    } catch (e) {
      this.log(`viewport broker: ${op} picture not stored: ${e instanceof Error ? e.message : String(e)}`);
      return r;
    }
  }

  /**
   * A live call (B9): `realpath(workspaceRoot)` picks the RocketWright project
   * (`projectOf` is handed the realpath), then `request` runs as for `/mcp`.
   * No open project, or no window for it (`no_host`), answers `no_host` with
   * PROJECT_NOT_OPEN. Never rejects.
   */
  async requestForWorkspace<O extends BrokerOp>(
    context: LecturnCallContext,
    op: O,
    args: BrokerArgs[O],
    projectOf: (workspaceRoot: string) => string | undefined,
  ): Promise<BrokerResponse<O>> {
    const projectId = projectOf(workspaceRootOf(context.workspaceRoot));
    const r = projectId === undefined ? undefined : await this.request(projectId, op, args, context.threadId);
    if (r !== undefined && (r.ok || r.error.code !== "no_host")) return r;
    return { requestId: r?.requestId ?? `broker-${randomUUID()}`, ok: false, error: { code: "no_host", message: PROJECT_NOT_OPEN } };
  }

  /** Sends one op to the project's host; resolves with its answer, `no_host`, or `timeout`. Never rejects. */
  forward<O extends BrokerOp>(projectId: string, op: O, args: BrokerArgs[O], threadId: string | null): Promise<BrokerResponse<O>> {
    const requestId = `broker-${randomUUID()}`;
    const fail = (error: BrokerError): Promise<BrokerResponse<O>> => Promise.resolve({ requestId, ok: false, error });
    if (!this.serves(op)) return fail({ code: "invalid_args", message: `${op} is not available` });
    const host = this.hosts.get(projectId);
    if (host === undefined) return fail({ code: "no_host", message: "no viewport host registered; open the project in RocketWright" });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ requestId, ok: false, error: { code: "timeout", message: `${op} timed out` } });
      }, this.timeoutMs);
      this.pending.set(requestId, {
        projectId,
        owner: host.owner,
        done: (r) => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          resolve(r as BrokerResponse<O>);
        },
      });
      host.send({ requestId, projectId, threadId, op, args });
    });
  }

  /** A host's answer; false when unknown, already answered, or from another connection. */
  respond(owner: unknown, r: BrokerResponse): boolean {
    const p = this.pending.get(r.requestId);
    if (p === undefined || p.owner !== owner) return false;
    p.done(r);
    return true;
  }
}

// ---- MCP tool definitions ------------------------------------------------------

const VIEW = { type: "string", enum: ["iso", "top", "side", "front", "rear"] } as const;
const PAGE = { type: "string", enum: ["assembly", "components", "configurations", "results", "liquid", "propulsion-sim"] } as const;
const SIZE = { type: "integer", minimum: 64, maximum: 4096 } as const;
const VEC3 = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 } as const;
const REF = { type: "string", pattern: "^rw:[a-z]+/" } as const;

function tool(
  name: BrokerOp,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  readOnly: boolean,
  card?: string,
): SidecarTool {
  const title = BROKER_OP_TITLES[name];
  return {
    name,
    title,
    description,
    inputSchema: { type: "object", properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false },
    annotations: { title, readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    // UI-only: these never touch project files, so they run without a prompt.
    _meta: { [META_APPROVAL]: "never", "rw/broker": true, ...(card === undefined ? {} : { ui: { resourceUri: card } }) },
  } as SidecarTool;
}

/** Tool definitions, one per broker op (IF11 `BrokerArgs`). */
export const BROKER_TOOLS: Record<BrokerOp, SidecarTool> = {
  viewport_render: tool(
    "viewport_render",
    "Captures the live 3D viewport in the RocketWright window as a PNG (the tone-mapped image the user sees). " +
      "Use it to confirm a geometry edit visually after `design_check` passes. Returns an image plus " +
      "`{width, height, backend, adapter}`. Needs the project open in the app.",
    { view: VIEW, width: SIZE, height: SIZE },
    [],
    true,
    RENDER_CARD_URI,
  ),
  viewport_select: tool(
    "viewport_select",
    "Selects components (rw:c/<id> refs) in the app; the tree, viewport, and inspector follow. Returns `{selected}`.",
    { refs: { type: "array", items: REF } },
    ["refs"],
    false,
  ),
  viewport_set_camera: tool(
    "viewport_set_camera",
    "Moves the viewport camera to a named view or a position/target (metres, body frame), and sets explode (0..1) and the section cut.",
    { view: VIEW, position: VEC3, target: VEC3, explode: { type: "number", minimum: 0, maximum: 1 }, section: { type: "boolean" } },
    [],
    false,
  ),
  plot_render: tool(
    "plot_render",
    "Renders a Results plot (`altitude`, `velocity`, `acceleration`, `stability`) of up to two flight runs as a PNG, drawn as the Results page draws it (lines, legend, event lines), from any page. " +
      "`runs`: run ids from `simulate`/`job_status`/`run_list` (also rw:run/<id>, <sim>/<run id>, or a sim id for its latest run); empty plots the runs the Results page shows. " +
      "Returns an image plus `{width, height, plot, runs}`. An unknown or unfinished run answers `invalid_args` naming the runs the window knows. Needs the project open in the app.",
    { plot: { type: "string", enum: ["altitude", "velocity", "acceleration", "stability"] }, runs: { type: "array", items: { type: "string" } }, width: SIZE, height: SIZE },
    ["plot", "runs"],
    true,
    RENDER_CARD_URI,
  ),
  app_navigate: tool("app_navigate", "Test hook: opens a page and tab.", { page: PAGE, tab: { type: "string" } }, ["page"], false),
  app_select: tool("app_select", "Test hook: selects one ref.", { ref: REF }, ["ref"], false),
  app_set_view: tool(
    "app_set_view",
    "Test hook: sets explode, section, and view. `animate` eases the explode change; `explode_t` (0..1) pins the tween at that time (null releases it).",
    {
      explode: { type: "number", minimum: 0, maximum: 1 },
      section: { type: "boolean" },
      view: VIEW,
      animate: { type: "boolean" },
      explode_t: { type: ["number", "null"], minimum: 0, maximum: 1 },
    },
    [],
    false,
  ),
  app_seed_thread: tool(
    "app_seed_thread",
    "Test hook: imports a Lecturn thread bundle (`bundle`, optional `now`) through the app's Lecturn connection and opens its last thread in the pane. Returns `{threadId, threadIds}`.",
    {
      bundle: { type: "object" },
      now: { type: "integer", minimum: 0 },
      // What the server forwards to the window: the Lecturn thread to open.
      thread: { type: "string" },
    },
    // {bundle} from a caller, {thread} from the server to the window; the handler checks which.
    [],
    false,
  ),
};

/** Result `_meta` key Lecturn reads for a tool row's secondary text (CPW1R4B, the CLI's `presentation::SUMMARY`). */
export const SUMMARY_META_KEY = "lecturn/summary";
/** Lecturn's cap on that text (`MAX_APP_TOOL_SUMMARY_LENGTH`). */
export const MAX_SUMMARY = 120;

const BROKER_FAILURES: Record<Extract<BrokerResponse, { ok: false }>["error"]["code"], string> = {
  no_host: "Project not open",
  timeout: "Timed out",
  invalid_args: "Invalid input",
  failed: "Failed",
};

/** `iso` → `Iso view`. */
const viewName = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? `${v[0]!.toUpperCase()}${v.slice(1)} view` : undefined);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One line of plain text within Lecturn's cap. */
export function clipSummary(text: string): string {
  // Control characters (C0, DEL, C1) read as spaces, as the CLI's `clip` does.
  const plain = Array.from(text, (c) => {
    const n = c.codePointAt(0) ?? 0;
    return n < 0x20 || (n >= 0x7f && n < 0xa0) ? " " : c;
  }).join("");
  const line = plain.replace(/\s+/g, " ").trim();
  return line.length <= MAX_SUMMARY ? line : `${line.slice(0, MAX_SUMMARY - 1).trimEnd()}…`;
}

/** What one broker call did, as its tool row's secondary text: `Iso view`, `2 selected`, or a short failure phrase. */
export function brokerSummary(op: BrokerOp, args: Record<string, unknown>, r: BrokerResponse): string {
  if (!r.ok) return BROKER_FAILURES[r.error.code] ?? "Failed";
  const result = (r.result ?? {}) as Record<string, unknown>;
  const text = ((): string => {
    switch (op) {
      case "viewport_render":
        return viewName(args.view) ?? "Current view";
      case "viewport_select": {
        const n = Array.isArray(result.selected) ? result.selected.length : 0;
        return n === 0 ? "Selection cleared" : `${n} selected`;
      }
      case "viewport_set_camera": {
        const parts = [viewName(args.view) ?? (args.position !== undefined || args.target !== undefined ? "Custom view" : "Camera set")];
        if (typeof args.explode === "number" && args.explode > 0) parts.push(`exploded ${Math.round(args.explode * 100)}%`);
        if (args.section === true) parts.push("section");
        return parts.join(" · ");
      }
      case "plot_render": {
        const plot = typeof args.plot === "string" && args.plot.length > 0 ? `${args.plot[0]!.toUpperCase()}${args.plot.slice(1)} plot` : "Plot";
        return Array.isArray(args.runs) && args.runs.length > 0 ? `${plot} · ${plural(args.runs.length, "run", "runs")}` : plot;
      }
      default:
        return "Done";
    }
  })();
  return clipSummary(text);
}

/** MCP `tools/call` result for a broker answer: images as image content, everything as `structuredContent`, the row summary in `_meta`. */
export function brokerToolResult(
  op: BrokerOp,
  r: BrokerResponse,
  args: Record<string, unknown> = {},
): {
  isError?: boolean;
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  structuredContent?: Record<string, unknown>;
  _meta: Record<string, unknown>;
} {
  const summary = { [SUMMARY_META_KEY]: brokerSummary(op, args, r) };
  if (!r.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: `${r.error.code}: ${r.error.message}` }],
      _meta: { "rw/error": { code: r.error.code, message: r.error.message }, ...summary },
    };
  }
  const result = { ...(r.result as Record<string, unknown>) };
  const png = typeof result.png_base64 === "string" ? result.png_base64 : undefined;
  if (png === undefined) return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, _meta: summary };
  delete result.png_base64;
  return {
    content: [
      { type: "image", data: png, mimeType: "image/png" },
      { type: "text", text: `${op}: ${JSON.stringify(result)}` },
    ],
    structuredContent: result,
    _meta: summary,
  };
}
