/**
 * IF11: viewport broker ops (frozen at M1.5). The agent calls them as MCP
 * tools through Lecturn's live tier (the app server's `/mcp/live`, B9); the
 * server forwards each as a `broker.request`
 * push to the registered web host, which answers with `broker.respond`
 * (Lecturn `PreviewAutomationBroker` design, rewritten). `app_*` ops exist
 * only when the server runs with `RW_TEST_HOOKS=1` (I12).
 */
import type { JsonObject, RenderResult, RwRef } from "./types.ts";

export type ViewId = "iso" | "top" | "side" | "front" | "rear";
export type PlotId = "altitude" | "velocity" | "acceleration" | "stability";
export type PageId = "assembly" | "components" | "configurations" | "results" | "liquid" | "propulsion-sim";

/** Op → arguments. */
export interface BrokerArgs {
  /** Capture the live viewport (tone-mapped sRGB canvas). */
  viewport_render: { view?: ViewId; width?: number; height?: number };
  viewport_select: { refs: RwRef[] };
  viewport_set_camera: { view?: ViewId; position?: [number, number, number]; target?: [number, number, number]; explode?: number; section?: boolean };
  /**
   * A Results plot of up to two runs, drawn off-screen in the window
   * (`apps/web/src/broker/plot.ts`). `runs`: run ids, `rw:run/<id>`,
   * `<sim>/<run id>` or sim ids; empty plots what the Results page overlays.
   */
  plot_render: { plot: PlotId; runs: string[]; width?: number; height?: number };
  app_navigate: { page: PageId; tab?: string };
  app_select: { ref: RwRef };
  /**
   * `animate` eases the explode change (M3.2); `explode_t` (0..1) then pins
   * the tween at that normalised time for a deterministic capture, `null`
   * releases it.
   */
  app_set_view: { explode?: number; section?: boolean; view?: ViewId; animate?: boolean; explode_t?: number | null };
  /**
   * Test hook (B13, W5.1): the server imports a Lecturn thread `bundle`
   * through its Lecturn connection, then forwards `{thread}` (the bundle's
   * last thread) to the web host so the window opens it in the pane.
   */
  app_seed_thread: SeedBundleArgs | SeedOpenArgs;
}

/**
 * `app_seed_thread` with the Lecturn embed (B13, W5.1): a committed
 * `tests/fixtures/lecturn/<page>.bundle.json` (Lecturn
 * `ConnectedAppThreadBundleV1` with `{workspaceRoot}` / `{projectName}`
 * templates). The server substitutes the project's realpath and name, moves
 * the timestamps to `now`, imports it (`apps.importThreads`) and answers once
 * the project's thread list shows every thread.
 */
export interface SeedBundleArgs {
  bundle: JsonObject;
  /** The clock the bundle's `exportedAt` maps to (epoch ms; default: the server's now). */
  now?: number;
}

/** What the server forwards to the web host after an `app_seed_thread` import: the Lecturn thread to open. */
export interface SeedOpenArgs {
  thread: string;
}

/**
 * Op → result. `path` (CPW2B, server-added): where the server stored a
 * window render's PNG (`renders/window/<op>.<sha>.png`, project-relative),
 * which the render card reads through `render_picture`; absent when it
 * could not be stored.
 */
export interface BrokerResults {
  viewport_render: { png_base64: string; width: number; height: number; backend: "webgpu" | "webgl2"; adapter: string; path?: string };
  viewport_select: { selected: RwRef[] };
  viewport_set_camera: Record<string, never>;
  /** The image, plus which runs it plots (`ref` is `rw:run/<id>`). */
  plot_render: { png_base64: string; width: number; height: number; plot?: PlotId; runs?: Array<{ ref: RwRef; sim: string; run_id: string; name: string }>; path?: string };
  app_navigate: Record<string, never>;
  app_select: Record<string, never>;
  app_set_view: Record<string, never>;
  /** The opened thread; the server's answer also lists every imported thread's Lecturn id, in bundle order. */
  app_seed_thread: { threadId: string; threadIds?: string[] };
}

export type BrokerOp = keyof BrokerArgs;

export const AGENT_OPS = ["viewport_render", "viewport_select", "viewport_set_camera", "plot_render"] as const satisfies readonly BrokerOp[];
export const TEST_HOOK_OPS = ["app_navigate", "app_select", "app_set_view", "app_seed_thread"] as const satisfies readonly BrokerOp[];
export type AgentOp = (typeof AGENT_OPS)[number];
/**
 * Each op's MCP `title` (CPW1R4B): what Lecturn's tool row reads instead of
 * `rw_<op>`. Sentence case, a short verb phrase (the CLI's
 * `crates/rw-cli/src/mcp/presentation.rs` `TITLES` for its tools).
 */
export const BROKER_OP_TITLES = {
  viewport_render: "Render view",
  viewport_select: "Select parts",
  viewport_set_camera: "Move camera",
  plot_render: "Plot results",
  app_navigate: "Navigate (test hook)",
  app_select: "Select (test hook)",
  app_set_view: "Set view (test hook)",
  app_seed_thread: "Seed a thread (test hook)",
} as const satisfies Record<BrokerOp, string>;
export type TestHookOp = (typeof TEST_HOOK_OPS)[number];

export interface BrokerCapabilities {
  ops: BrokerOp[];
  backend: "webgpu" | "webgl2";
}

export type BrokerRequest<O extends BrokerOp = BrokerOp> = {
  requestId: string;
  projectId: string;
  /** Thread that issued the call (`null` for test hooks). */
  threadId: string | null;
  op: O;
  args: BrokerArgs[O];
};

export type BrokerResponse<O extends BrokerOp = BrokerOp> =
  | { requestId: string; ok: true; result: BrokerResults[O] }
  | { requestId: string; ok: false; error: { code: "no_host" | "timeout" | "invalid_args" | "failed"; message: string } };

/** A rendered still saved by the broker carries the same metadata as `render`. */
export type BrokerRenderRecord = RenderResult & JsonObject;
