/**
 * The web window as the project's viewport host (IF11, R6.10, R6.11). On
 * connect it calls `broker.hostRegister`; the server then forwards the
 * agent's `viewport_render`, `viewport_select`, `viewport_set_camera` and
 * `plot_render` calls (and the `app_*` test hooks when it runs with
 * `RW_TEST_HOOKS=1`) as `broker.request` pushes, answered with
 * `broker.respond`. Every op acts through the store or the mounted viewport,
 * exactly as a user's click would; `plot_render` draws the Results plot
 * off-screen (`./plot.ts`), so it works from any page. The host answers every
 * op the server advertises (`AGENT_OPS` and `TEST_HOOK_OPS`; host.test.ts).
 */
import type { BrokerArgs, BrokerCapabilities, BrokerOp, BrokerRequest, BrokerResponse, RwRef } from "@rw/contracts";
import type { RpcLike } from "../state/rpc.ts";
import { parseRef } from "../state/slices/selection.ts";
import type { AppStore } from "../state/store.ts";
import { settle, waitForViewport, type ViewportController } from "../viewport/registry.ts";
import { hookHandlers } from "../state/brokerHost.ts";
import { renderPlotImage } from "../plots/plotImage.ts";
import type { RunDataSource } from "../pages/results/source.ts";
import { PlotRenderError, renderPlot, type PlotDeps } from "./plot.ts";

/** Ops this host answers: every op the server advertises (`AGENT_OPS`, then `TEST_HOOK_OPS`). */
export const HOST_OPS = [
  "viewport_render",
  "viewport_select",
  "viewport_set_camera",
  "plot_render",
  "app_navigate",
  "app_select",
  "app_set_view",
  "app_seed_thread",
] as const satisfies readonly BrokerOp[];

export interface BrokerHostDeps {
  /** A ready viewport (default: the mounted assembly viewport). */
  viewport(): Promise<ViewportController>;
  /** Lets store changes render (default: two animation frames). */
  settle(): Promise<void>;
  /** `plot_render`'s run source and renderer (default: no source, so it answers that plots are unavailable). */
  plots?: Partial<PlotDeps>;
}

const defaults: BrokerHostDeps = { viewport: () => waitForViewport(), settle };

/** The window's defaults with its run series source (the Results page's), so `plot_render` can draw. */
export function windowHostDeps(runSource: RunDataSource | null): BrokerHostDeps {
  return { ...defaults, plots: { runSource } };
}

const plotDeps = (deps: BrokerHostDeps): PlotDeps => ({ runSource: null, render: renderPlotImage, ...deps.plots });

class InvalidArgs extends Error {}

function refs(v: unknown): RwRef[] {
  if (!Array.isArray(v) || !v.every((r) => typeof r === "string" && parseRef(r) !== null)) throw new InvalidArgs("refs: expected rw: refs");
  return v as RwRef[];
}

/** Opens the assembly page (the viewport mounts there) and returns the ready viewport. */
async function assemblyViewport(store: AppStore, deps: BrokerHostDeps): Promise<ViewportController> {
  if (store.getState().ui.page !== "assembly") store.getState().ui.navigate("assembly");
  return deps.viewport();
}

type Answer = { [O in BrokerOp]?: (args: BrokerArgs[O]) => Promise<unknown> };

function handlers(store: AppStore, deps: BrokerHostDeps): Answer {
  const st = () => store.getState();
  return {
    async viewport_select({ refs: r }) {
      st().selection.select(refs(r), "agent");
      return { selected: [...st().selection.refs] };
    },
    async viewport_set_camera({ view, position, target, explode, section }) {
      if (explode !== undefined && !(explode >= 0 && explode <= 1)) throw new InvalidArgs("explode: expected 0..1");
      const v: Parameters<ReturnType<typeof st>["ui"]["setView"]>[0] = {};
      if (view !== undefined) v.view = view;
      if (explode !== undefined) v.explode = explode;
      if (section !== undefined) v.section = section;
      const vp = await assemblyViewport(store, deps);
      st().ui.setView(v);
      if (position !== undefined || target !== undefined) {
        await deps.settle();
        vp.setCamera(position, target);
      }
      await deps.settle();
      return {};
    },
    async viewport_render({ view, width, height }) {
      const vp = await assemblyViewport(store, deps);
      if (view !== undefined && st().ui.view !== view) st().ui.setView({ view });
      await deps.settle();
      const shot = await vp.capture(width, height);
      return { ...shot, backend: vp.backend() === "webgpu" ? "webgpu" : "webgl2", adapter: vp.adapter() };
    },
    async plot_render(args) {
      return renderPlot(store, args, plotDeps(deps));
    },
    // The `app_*` test hooks (the server forwards them only with RW_TEST_HOOKS=1, I12).
    ...hookHandlers(store),
  };
}

/** Answers one request (never throws). */
export async function answer(req: BrokerRequest, store: AppStore, deps: BrokerHostDeps = defaults): Promise<BrokerResponse> {
  const h = handlers(store, deps)[req.op] as ((a: unknown) => Promise<unknown>) | undefined;
  if (h === undefined) return { requestId: req.requestId, ok: false, error: { code: "failed", message: `${req.op} is not available in this window` } };
  try {
    const result = await h(req.args ?? {});
    return { requestId: req.requestId, ok: true, result } as BrokerResponse;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const code = e instanceof PlotRenderError ? e.code : e instanceof InvalidArgs ? "invalid_args" : "failed";
    return { requestId: req.requestId, ok: false, error: { code, message } };
  }
}

/** WebGPU when the browser exposes it (the engine falls back to WebGL2 otherwise). */
export function detectBackend(): BrokerCapabilities["backend"] {
  return typeof navigator !== "undefined" && "gpu" in navigator && navigator.gpu ? "webgpu" : "webgl2";
}

/**
 * Registers this window as `projectId`'s viewport host and answers its
 * requests until the returned function is called (or the connection closes).
 */
export async function startBrokerHost(
  client: RpcLike,
  projectId: string,
  store: AppStore,
  opts: { hostId?: string; deps?: BrokerHostDeps; backend?: BrokerCapabilities["backend"] } = {},
): Promise<() => void> {
  const deps = opts.deps ?? defaults;
  const off = client.on("broker.request", (req) => {
    if (req.projectId !== projectId) return;
    void answer(req, store, deps).then((r) => client.call("broker.respond", r).catch(() => undefined));
  });
  const hostId = opts.hostId ?? `web-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await client.call("broker.hostRegister", { projectId, hostId, capabilities: { ops: [...HOST_OPS], backend: opts.backend ?? detectBackend() } });
  } catch (e) {
    off();
    throw e;
  }
  return off;
}
