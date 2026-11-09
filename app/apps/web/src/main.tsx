/**
 * Web entry.
 * - With a server (`?rpc=ws://127.0.0.1:<port>/rpc` plus the server's token
 *   in the fragment `#token=…`, the desktop preload's
 *   `window.rwDesktop.rpcUrl` (M1.52), or `VITE_RW_RPC_URL`; `rpcUrl.ts`):
 *   `shell/AppRoot.tsx`: the store-driven shell (M1.49) with the Lecturn
 *   agent pane on `?project=<id>`, the project main reopened, or the first
 *   open project; Welcome when there is none. Results (M1.51) fetches run
 *   series from `?http=http://…` (same origin when absent).
 * - Without one, in a preload-free page (spikes, bar captures): the static
 *   shell (M1.19) with a picture of a canned exchange. With a preload and no
 *   server, the startup failure.
 * - Either way `?page=01..06` picks the starting page (bar captures) and the
 *   shell publishes `window.__rwShell` once mounted with fonts loaded. Live,
 *   Design > Assembly is the store-driven page (M1.50: viewport, inspector,
 *   toolbar, Components tree); Design > Components (M2.9) and Configurations
 *   (M2.10) are live pages too, as are Propulsion > Liquid propulsion (M4.7)
 *   and Simulate > Propulsion simulation's Engineering tier (M4.8); static,
 *   the workspace holds the spike viewport. `?surface=s-*` (B3 captures)
 *   starts on that surface's page and adds it to `window.__rwShell`.
 * - `?mode=render`: the hidden-window render path used by the desktop capture
 *   (M1.9): the viewport alone, publishing its probe on `window.__rwProbe`.
 * - `?mode=render&job=1`: `rocketwright-render` (RL3): a full-window canvas
 *   and `window.__rwRunJob(request, opts)` (`render/job.ts`), which the
 *   Electron main (`apps/desktop/src/render-main.ts`) calls with the IF8
 *   `RenderRequest` it read on stdin.
 * - `?mode=spike&spike=recovery-bay&frame=01|01-focus`: the RL5 detail
 *   spike (`spikes/recovery-bay/`), lazily loaded; also reports on `__rwProbe`.
 * - `?mode=spike&spike=propsim`: the RL1d page 06 cutaway prototype
 *   (`spikes/propsim/`): the Visual flow view on a canned study, no server;
 *   reports on `__rwFluid`.
 */
// @rw/ui is consumed by path until web takes a workspace dependency on it (SRV owns the lock).
import "../../../packages/ui/tokens.css";
import "./shell/fonts.css";
import "./shell/shell.css";
import { useEffect, useState } from "react";
import type { BrokerOp, BrokerResponse, schema } from "@rw/contracts";
import { pageRpcUrl } from "./rpcUrl.ts";
import { createRoot } from "react-dom/client";
import { loadRwWasm } from "@rw/rw-wasm";
import type { SourceFiles } from "@rw/rw-wasm";
import type { RwDesktopGlobal } from "./host/HostApi.ts";
import { PLACEHOLDER_ALT, PLACEHOLDER_HEIGHT, PLACEHOLDER_SRC, PLACEHOLDER_WIDTH } from "./chat/placeholder.ts";
import { cachedSource, httpRunSource } from "./pages/results/source.ts";
import { AppRoot, FatalScreen } from "./shell/AppRoot.tsx";
import { launchMode } from "./shell/lifecycle.ts";
import { BAR_SURFACES, isBarPage, isBarSurface, pageOfBar, PLACEHOLDER_SHELL, type BarPage } from "./shell/model.ts";
import { ShellApp } from "./shell/ShellApp.tsx";
import { Viewport } from "./viewport/Viewport.tsx";
import { runRenderJob, type JobOptions, type JobReply } from "./render/job.ts";
import type { ViewportProbe } from "./viewport/probe.ts";

type Status<T> = { status: "pending" } | ({ status: "ready" } & T) | { status: "error"; error: string };

declare global {
  interface Window {
    __rwProbe?: Status<{ probe: ViewportProbe }>;
    __rwShell?: Status<{ page: string; surface?: string }>;
    /** This window's broker host answering one op directly, as a server push would reach it (e2e probes, e.g. page 04's `plot_render`). */
    __rwBroker?: (op: BrokerOp, args: unknown) => Promise<BrokerResponse>;
    /** Set by the Electron preload (`apps/desktop/src/preload.ts`) when the desktop app spawned a server. */
    rwDesktop?: RwDesktopGlobal;
    /** `?mode=render&job=1`: runs one `rocketwright-render` job. */
    __rwRunJob?: (request: schema.RenderRequest, opts?: JobOptions) => Promise<JobReply>;
  }
}

/**
 * Render-mode stand-in project (the M1.9 GPU gate): a 54 mm ogive and a 0.6 m
 * body tube, evaluated and meshed by rw-wasm like any project (M1.32).
 */
export const RENDER_STANDIN: SourceFiles = {
  "rocketwright.toml": 'format = 1\nname = "Render stand-in"\n',
  "rocket.rw.toml": [
    'name = "Render stand-in"',
    "[c.nose]",
    'type = "nose_cone"',
    'shape = "ogive"',
    'length = "160 mm"',
    'od = "54 mm"',
    "[c.body]",
    'type = "body_tube"',
    'attach = { to = "nose.base" }',
    'length = "600 mm"',
    'od = "54 mm"',
    'id = "50 mm"',
    "",
  ].join("\n"),
};

const errorText = (e: unknown) => (e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e));

window.__rwProbe = { status: "pending" };
const failProbe = (e: unknown) => {
  window.__rwProbe = { status: "error", error: errorText(e) };
  console.error(e);
};

/** Loads rw-wasm, meshes the stand-in project, and mounts the viewport; reports through `__rwProbe`. */
function ViewportHost() {
  const [mesh, setMesh] = useState<{ glb: Uint8Array; coreVersion: string } | null>(null);
  useEffect(() => {
    let live = true;
    loadRwWasm().then((rw) => {
      if (live) setMesh({ glb: rw.meshModelGlb(rw.evalModel(RENDER_STANDIN), { radial_segments: 96 }), coreVersion: rw.coreVersion() });
    }, failProbe);
    return () => {
      live = false;
    };
  }, []);
  if (!mesh) return null;
  return (
    <Viewport
      glb={mesh.glb}
      coreVersion={mesh.coreVersion}
      onReady={(probe) => {
        window.__rwProbe = { status: "ready", probe };
      }}
      onError={failProbe}
    />
  );
}

/** The static shell with the concept-01 exchange in the agent pane (a still picture, D19). */
function StaticShell({ page }: { page: BarPage }) {
  const agent = (
    <>
      <img className="rw-agent__placeholder" data-testid="agent.placeholder" src={PLACEHOLDER_SRC} width={PLACEHOLDER_WIDTH} height={PLACEHOLDER_HEIGHT} alt={PLACEHOLDER_ALT} />
      <p className="rw-agent__hint" data-testid="agent.hint">
        Select any part to ask about it.
      </p>
    </>
  );
  return <ShellApp model={PLACEHOLDER_SHELL} page={page} viewport={<ViewportHost />} agent={agent} />;
}

/** `rocketwright-render` page: one canvas filling the window, jobs through `window.__rwRunJob`. */
function startRenderJobHost(root: HTMLElement): void {
  document.documentElement.style.background = "#ffffff";
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
  const canvas = document.createElement("canvas");
  canvas.dataset.testid = "render-canvas";
  canvas.style.cssText = "display:block;position:fixed;left:0;top:0;width:100vw;height:100vh";
  root.replaceChildren(canvas);
  window.__rwRunJob = async (request, opts) => runRenderJob(canvas, request, await loadRwWasm(), opts);
}

function start(): void {
  const root = document.getElementById("root");
  if (!root) throw new Error("#root missing");
  const params = new URLSearchParams(window.location.search);
  if (params.get("mode") === "render" && params.get("job") === "1") {
    startRenderJobHost(root);
    return;
  }
  if (params.get("mode") === "render") {
    createRoot(root).render(<ViewportHost />);
    return;
  }
  if (params.get("mode") === "spike" && params.get("spike") === "recovery-bay") {
    const frame = params.get("frame");
    void import("../spikes/recovery-bay/RecoveryBaySpike.tsx").then(({ RecoveryBaySpike, isFramingId }) => {
      const hideMesh = params.get("hide");
      const debug = { noSelect: params.get("select") === "none", ...(hideMesh ? { hideMesh } : {}) };
      createRoot(root).render(<RecoveryBaySpike frame={isFramingId(frame) ? frame : "01"} debug={debug} />);
    }, failProbe);
    return;
  }
  if (params.get("mode") === "spike" && params.get("spike") === "propsim") {
    void import("../spikes/propsim/PropsimSpike.tsx").then(({ PropsimSpike }) => {
      createRoot(root).render(<PropsimSpike />);
    }, failProbe);
    return;
  }
  const requested = params.get("page");
  // A B3 surface capture (`?surface=`): the page it starts on comes from the surface.
  const surfaceParam = params.get("surface");
  const surface = isBarSurface(surfaceParam) ? surfaceParam : null;
  const page = surface !== null ? BAR_SURFACES[surface] : isBarPage(requested) ? requested : "01";
  window.__rwShell = { status: "pending" };
  const desktop = window.rwDesktop;
  const rpc = pageRpcUrl({ search: location.search, hash: location.hash, desktopUrl: desktop?.rpcUrl, envUrl: import.meta.env.VITE_RW_RPC_URL as string | undefined });
  const http = params.get("http") ?? desktop?.serverUrl ?? "";
  const mode = launchMode({ rpc, desktop: desktop !== undefined });
  // Two frames after the window settles, once the webfonts are in, the layout is final.
  const fonts = Promise.all([document.fonts.load('400 13px "Inter"'), document.fonts.load('600 20px "Inter"')]).catch(() => undefined);
  const publishReady = () =>
    void fonts
      .then(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
      .then(() => {
        if (window.__rwShell?.status === "pending") window.__rwShell = { status: "ready", page, ...(surface !== null ? { surface } : {}) };
      });
  const reactRoot = createRoot(root);
  if (mode === "live") {
    reactRoot.render(
      <AppRoot
        url={rpc!}
        requestedProjectId={params.get("project")}
        initialPage={pageOfBar(page)}
        pageForced={surface !== null || isBarPage(requested)}
        runSource={cachedSource(httpRunSource(http))}
        httpBase={http}
        onOutcome={(o) => {
          if (o.status === "error") window.__rwShell = { status: "error", error: o.error };
          else publishReady();
        }}
      />,
    );
  } else if (mode === "fatal") {
    const error = desktop?.startupError ?? "The app server did not start.";
    window.__rwShell = { status: "error", error };
    reactRoot.render(<FatalScreen error={error} onRelaunch={() => void desktop?.relaunch().catch((e: unknown) => console.error(e))} />);
  } else {
    reactRoot.render(<StaticShell page={page} />);
    publishReady();
  }
}

try {
  start();
} catch (e) {
  window.__rwShell = { status: "error", error: errorText(e) };
  failProbe(e);
}
