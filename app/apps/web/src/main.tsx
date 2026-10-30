/**
 * Web entry.
 * - With a server (`?rpc=ws://127.0.0.1:<port>/rpc` plus the server's token
 *   in the fragment `#token=…`, the desktop preload's
 *   `window.rwDesktop.rpcUrl` (M1.52), or `VITE_RW_RPC_URL`; `rpcUrl.ts`):
 *   the store-driven shell (M1.49) with the Lecturn agent pane on the first
 *   project, or
 *   `?project=<id>`. Results (M1.51) fetches run series from `?http=http://…`
 *   (same origin when absent).
 * - Without one: the static shell (M1.19) with a picture of a canned exchange.
 * - Either way `?page=01..06` picks the starting page (bar captures) and the
 *   shell publishes `window.__rwShell` once mounted with fonts loaded. Live,
 *   Design > Assembly is the store-driven page (M1.50: viewport, inspector,
 *   toolbar, Components tree); Design > Components (M2.9) and Configurations
 *   (M2.10) are live pages too, as are Propulsion > Liquid propulsion (M4.7)
 *   and Simulate > Propulsion simulation's Engineering tier (M4.8); static,
 *   the workspace holds the spike viewport.
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
import { useEffect, useMemo, useState } from "react";
import type { BrokerOp, BrokerRequest, BrokerResponse, PageId, schema } from "@rw/contracts";
import { pageRpcUrl } from "./rpcUrl.ts";
import { createRoot } from "react-dom/client";
import { loadRwWasm } from "@rw/rw-wasm";
import type { SourceFiles } from "@rw/rw-wasm";
import { answer, startBrokerHost, windowHostDeps } from "./broker/host.ts";
import { PLACEHOLDER_ALT, PLACEHOLDER_HEIGHT, PLACEHOLDER_SRC, PLACEHOLDER_WIDTH } from "./chat/placeholder.ts";
import { openArtifactThread } from "./embed/rail.ts";
import { assemblySlots } from "./pages/assembly/AssemblyPage.tsx";
import { ComparePage } from "./pages/compare/ComparePage.tsx";
import { componentsSlots, createComponentsUi } from "./pages/components/ComponentsPage.tsx";
import { configurationsSlots, createConfigurationsUi } from "./pages/configurations/ConfigurationsPage.tsx";
import { createLiquidUi, liquidSlots } from "./pages/liquid/LiquidPage.tsx";
import { createCfdUi } from "./pages/propsim/cfd.tsx";
import { createEngineeringUi } from "./pages/propsim/engineering.tsx";
import { createVisualUi } from "./pages/propsim/visual.tsx";
import { propSimSlots } from "./pages/propsim/PropSimPage.tsx";
import { ConnectedShell, type PageSlots } from "./shell/ConnectedShell.tsx";
import { ThumbnailBaker } from "./render/ThumbnailBaker.tsx";
import { isBarPage, pageOfBar, PLACEHOLDER_SHELL, type BarPage } from "./shell/model.ts";
import { ShellApp } from "./shell/ShellApp.tsx";
import { ResultsPage } from "./pages/results/ResultsPage.tsx";
import { RunSnapshots } from "./pages/results/RunSnapshots.tsx";
import { RunsRail } from "./pages/results/RunsRail.tsx";
import { cachedSource, httpRunSource, type RunDataSource } from "./pages/results/source.ts";
import { trackLecturnStatus } from "./embed/status.ts";
import { RpcClient } from "./state/rpc.ts";
import { createAppStore } from "./state/store.ts";
import { browserGlbDeps } from "./viewport/glb-source.ts";
import { Viewport } from "./viewport/Viewport.tsx";
import { runRenderJob, type JobOptions, type JobReply } from "./render/job.ts";
import type { ViewportProbe } from "./viewport/probe.ts";

type Status<T> = { status: "pending" } | ({ status: "ready" } & T) | { status: "error"; error: string };

declare global {
  interface Window {
    __rwProbe?: Status<{ probe: ViewportProbe }>;
    __rwShell?: Status<{ page: string }>;
    /** This window's broker host answering one op directly, as a server push would reach it (e2e probes, e.g. page 04's `plot_render`). */
    __rwBroker?: (op: BrokerOp, args: unknown) => Promise<BrokerResponse>;
    /** Set by the Electron preload (`apps/desktop/src/preload.ts`) when the desktop app spawned a server. */
    rwDesktop?: {
      desktop: true;
      platform: string;
      rpcUrl: string | null;
      serverUrl: string | null;
      /** Main's embedded-pane messages (`lecturn-embed:rw-to-host`, `embed/bridge.ts`). */
      lecturn?: { onMessage(cb: (message: unknown) => void): () => void };
    };
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

/** Connects the store to the server and renders the live shell. */
function LiveShell({ url, projectId, page, runSource, httpBase }: { url: string; projectId: string | null; page: BarPage; runSource: RunDataSource; httpBase: string }) {
  const [store] = useState(() => {
    const st = createAppStore();
    st.getState().ui.navigate(pageOfBar(page));
    return st;
  });
  const [client, setClient] = useState<RpcClient | null>(null);
  useEffect(() => {
    let live = true;
    let c: RpcClient | null = null;
    let stopHost: (() => void) | null = null;
    RpcClient.connect(url)
      .then(async (conn) => {
        c = conn;
        if (!live) return conn.close();
        // The first `lecturn.status` follows `hello` at once: keep it before React renders (B10).
        trackLecturnStatus(conn);
        setClient(conn);
        const id = projectId ?? (await conn.call("project.list", {})).projects[0]?.projectId;
        if (id === undefined) return;
        // This window hosts the agent's window ops (viewport_render/select/set_camera, plot_render from the run source).
        const hostDeps = windowHostDeps(runSource);
        window.__rwBroker = (op, args) => answer({ requestId: `probe-${op}`, projectId: id, threadId: null, op, args } as BrokerRequest, store, hostDeps);
        void startBrokerHost(conn, id, store, { deps: hostDeps }).then(
          (off) => (live ? (stopHost = off) : off()),
          (e: unknown) => console.error("broker.hostRegister", e),
        );
        await store.getState().project.connect(conn, id);
      })
      .catch((e: unknown) => console.error(e));
    return () => {
      live = false;
      stopHost?.();
      store.getState().project.disconnect();
      c?.close();
    };
  }, [url, projectId, store, runSource]);
  const glbDeps = useMemo(() => browserGlbDeps(import.meta.env.BASE_URL), []);
  const assembly = useMemo(() => assemblySlots(store, glbDeps), [store, glbDeps]);
  const [componentsUi] = useState(createComponentsUi);
  const components = useMemo(() => componentsSlots(store, client, glbDeps, componentsUi), [store, client, glbDeps, componentsUi]);
  const [configurationsUi] = useState(createConfigurationsUi);
  const configurations = useMemo(() => configurationsSlots(store, client, configurationsUi), [store, client, configurationsUi]);
  const [liquidUi] = useState(createLiquidUi);
  const liquid = useMemo(() => liquidSlots(store, client, glbDeps, liquidUi), [store, client, glbDeps, liquidUi]);
  const [engineeringUi] = useState(createEngineeringUi);
  const [visualUi] = useState(createVisualUi);
  const [cfdUi] = useState(createCfdUi);
  const propsim = useMemo(() => propSimSlots(store, client, httpBase, engineeringUi, visualUi, cfdUi, runSource), [store, client, httpBase, engineeringUi, visualUi, cfdUi, runSource]);
  const results: PageSlots = useMemo(
    () => ({
      railNav: <RunsRail app={store} onOpenRun={(sim, name) => void openArtifactThread(store, `rw:sim/${sim}`, name).catch((e: unknown) => console.error(e))} />,
      historyExtra: <RunSnapshots app={store} />,
    }),
    [store],
  );
  const pageSlots = (p: PageId): PageSlots | null =>
    p === "assembly"
      ? { toolbar: assembly.toolbar, nav: assembly.nav }
      : p === "components"
        ? { nav: components.nav, railFooter: components.railFooter, agentExtra: components.agentExtra }
        : p === "configurations"
          ? { toolbar: configurations.toolbar, nav: configurations.nav, agentExtra: configurations.agentExtra }
          : p === "results"
            ? results
            : p === "liquid"
              ? { nav: liquid.nav, agentExtra: liquid.agentExtra }
              : p === "propulsion-sim"
                ? { nav: propsim.nav }
                : null;
  const renderPage = (p: PageId) =>
    p === "assembly"
      ? assembly.content
      : p === "components"
        ? components.content
        : p === "configurations"
          ? configurations.content
          : p === "results"
            ? <ResultsPage app={store} source={runSource} />
            : p === "liquid"
              ? liquid.content
              : p === "propulsion-sim"
                ? propsim.content
                : null;
  const renderCompare = () => <ComparePage store={store} client={client} glbDeps={glbDeps} />;
  return (
    <>
      <ConnectedShell store={store} client={client} renderPage={renderPage} renderCompare={renderCompare} pageSlots={pageSlots} />
      <ThumbnailBaker store={store} glbDeps={glbDeps} />
    </>
  );
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
  const page = isBarPage(requested) ? requested : "01";
  window.__rwShell = { status: "pending" };
  const desktop = window.rwDesktop;
  const rpc = pageRpcUrl({ search: location.search, hash: location.hash, desktopUrl: desktop?.rpcUrl, envUrl: import.meta.env.VITE_RW_RPC_URL as string | undefined });
  const http = params.get("http") ?? desktop?.serverUrl ?? "";
  createRoot(root).render(
    rpc ? <LiveShell url={rpc} projectId={params.get("project")} page={page} runSource={cachedSource(httpRunSource(http))} httpBase={http} /> : <StaticShell page={page} />,
  );
  // Two frames after mount, once the webfonts are in, the layout is final.
  void Promise.all([document.fonts.load('400 13px "Inter"'), document.fonts.load('600 20px "Inter"')])
    .catch(() => undefined)
    .then(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    .then(() => {
      window.__rwShell = { status: "ready", page };
    });
}

try {
  start();
} catch (e) {
  window.__rwShell = { status: "error", error: errorText(e) };
  failProbe(e);
}
