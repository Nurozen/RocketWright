/**
 * One open project on screen: its store, per-page UI objects and broker host.
 * `AppRoot` keys it on the project id, so a switch remounts all of it rather
 * than re-pointing a live store (seam 3): page UI that is created once, such
 * as the CFD dataset list, and the Results `seeded` flag start fresh, and the
 * new project gets a broker host of its own.
 */
import { useEffect, useMemo, useState, type RefObject } from "react";
import type { BrokerRequest, DesktopPrefs, PageId, ProjectInfo, SidecarState } from "@rw/contracts";
import { answer, startBrokerHost, windowHostDeps } from "../broker/host.ts";
import { openArtifactThread, openProviders } from "../embed/rail.ts";
import { assemblySlots } from "../pages/assembly/AssemblyPage.tsx";
import { ComparePage } from "../pages/compare/ComparePage.tsx";
import { componentsSlots, createComponentsUi } from "../pages/components/ComponentsPage.tsx";
import { configurationsSlots, createConfigurationsUi } from "../pages/configurations/ConfigurationsPage.tsx";
import { createLiquidUi, liquidSlots } from "../pages/liquid/LiquidPage.tsx";
import type { HostApi } from "../host/HostApi.ts";
import { createCfdUi } from "../pages/propsim/cfd.tsx";
import { createEngineeringUi } from "../pages/propsim/engineering.tsx";
import { propSimSlots } from "../pages/propsim/PropSimPage.tsx";
import { createVisualUi } from "../pages/propsim/visual.tsx";
import { ResultsPage } from "../pages/results/ResultsPage.tsx";
import { RunSnapshots } from "../pages/results/RunSnapshots.tsx";
import { RunsRail } from "../pages/results/RunsRail.tsx";
import type { RunDataSource } from "../pages/results/source.ts";
import { ThumbnailBaker } from "../render/ThumbnailBaker.tsx";
import { flushProject } from "../state/dirtyFields.ts";
import { exportChoices } from "../state/selectors.ts";
import type { RpcLike } from "../state/rpc.ts";
import { createAppStore, useAppState } from "../state/store.ts";
import { restoredViewOptions, viewOptionsOf } from "../state/slices/ui.ts";
import { browserGlbDeps } from "../viewport/glb-source.ts";
import { ConnectedShell, type PageSlots } from "./ConnectedShell.tsx";
import type { CommandHandlers } from "./commands.ts";
import type { ProjectMenuModel } from "./model.ts";
import type { SurfaceHandle } from "./useProjectActions.tsx";

export interface ProjectSurfaceProps {
  client: RpcLike;
  projectId: string;
  /** The page to start on (a switch keeps the person where they were). */
  initialPage: PageId;
  runSource: RunDataSource;
  httpBase: string;
  onPageChange: (page: PageId) => void;
  /** The project could not be shown; `AppRoot` falls back to Welcome. */
  onOpenFailed: (projectId: string, error: string) => void;
  onSwitchProject: (projectId: string) => void;
  /** This project's name and folder, once known and whenever they change. */
  onProjectInfo: (project: ProjectInfo) => void;
  /** This project's engine, once known; null when the surface goes. */
  onSidecarState?: ((state: SidecarState | null) => void) | undefined;
  /** A shell action failed: `AppRoot` shows it on the dismissible banner. */
  onError?: ((message: string) => void) | undefined;
  projectMenu?: ProjectMenuModel | undefined;
  /** Filled while this surface is mounted: what `AppRoot` needs before it can leave the project. */
  surfaceRef?: RefObject<SurfaceHandle | null> | undefined;
  commandsRef?: RefObject<CommandHandlers | null> | undefined;
  onOpenHelp?: (() => void) | undefined;
  /** Saved view options to start from (R3.4). */
  initialView?: DesktopPrefs["view"] | undefined;
  onViewOptions?: ((view: DesktopPrefs["view"]) => void) | undefined;
  /** Header Settings; `AppRoot` owns the dialog. */
  onOpenSettings?: (() => void) | undefined;
  /** Native pickers on the desktop; absent in the tests that render a surface on its own. */
  host?: HostApi | undefined;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function ProjectSurface({ client, projectId, initialPage, runSource, httpBase, onPageChange, onOpenFailed, onSwitchProject, onProjectInfo, onSidecarState, onError, projectMenu, surfaceRef, commandsRef, onOpenHelp, initialView, onViewOptions, onOpenSettings, host = undefined }: ProjectSurfaceProps) {
  const [store] = useState(() => {
    const st = createAppStore();
    st.getState().ui.navigate(initialPage);
    if (initialView !== undefined) st.getState().ui.setView(restoredViewOptions(initialView));
    return st;
  });
  useEffect(() => {
    let live = true;
    // Stops the listener as soon as this surface goes, even mid-registration: a leftover one would refuse the next project's requests as foreign.
    const stop = new AbortController();
    // This window hosts the agent's window ops (viewport_render/select/set_camera, plot_render from the run source).
    const hostDeps = windowHostDeps(runSource);
    const probe = (op: BrokerRequest["op"], args: unknown) => answer({ requestId: `probe-${op}`, projectId, threadId: null, op, args } as BrokerRequest, store, hostDeps);
    window.__rwBroker = probe;
    startBrokerHost(client, projectId, store, { deps: hostDeps, signal: stop.signal }).catch((e: unknown) => {
      if (live) console.error("broker.hostRegister", e);
    });
    store
      .getState()
      .project.connect(client, projectId)
      .catch((e: unknown) => {
        console.error(e);
        if (live) onOpenFailed(projectId, message(e));
      });
    return () => {
      live = false;
      stop.abort();
      if (window.__rwBroker === probe) delete window.__rwBroker;
    };
  }, [client, projectId, store, runSource, onOpenFailed]);
  // Only leaving the project ends the connection: on a reconnect `project.connect` keeps the mirror and the draft (D19).
  useEffect(() => () => store.getState().project.disconnect(), [store]);

  useEffect(() => {
    if (surfaceRef === undefined) return;
    const handle: SurfaceHandle = {
      flush: () => flushProject(store),
      exportChoices: () => exportChoices(store.getState()),
      disconnect: () => store.getState().project.disconnect(),
      reconnect: () => {
        store
          .getState()
          .project.connect(client, projectId)
          .catch((e: unknown) => onOpenFailed(projectId, message(e)));
      },
      openProviders: () => openProviders(store),
    };
    surfaceRef.current = handle;
    return () => {
      if (surfaceRef.current === handle) surfaceRef.current = null;
    };
  }, [surfaceRef, store, client, projectId, onOpenFailed]);

  useEffect(() => {
    if (onViewOptions === undefined) return;
    return store.subscribe((next, prev) => {
      if (next.ui === prev.ui) return;
      const options = viewOptionsOf(next.ui);
      const before = viewOptionsOf(prev.ui);
      if (Object.keys(options).some((k) => options[k] !== before[k])) onViewOptions(options);
    });
  }, [store, onViewOptions]);

  const page = useAppState(store, (s) => s.ui.page);
  useEffect(() => onPageChange(page), [page, onPageChange]);
  const info = useAppState(store, (s) => s.project.snapshot?.project ?? null);
  useEffect(() => {
    if (info !== null) onProjectInfo(info);
  }, [info, onProjectInfo]);
  const sidecar = useAppState(store, (s) => s.project.snapshot?.sidecar.state ?? null);
  useEffect(() => {
    onSidecarState?.(sidecar);
  }, [sidecar, onSidecarState]);
  useEffect(() => () => onSidecarState?.(null), [onSidecarState]);

  const glbDeps = useMemo(() => browserGlbDeps(import.meta.env.BASE_URL), []);
  const assembly = useMemo(() => assemblySlots(store, glbDeps, client, httpBase), [store, glbDeps, client, httpBase]);
  const [componentsUi] = useState(createComponentsUi);
  const components = useMemo(() => componentsSlots(store, client, glbDeps, componentsUi), [store, client, glbDeps, componentsUi]);
  const [configurationsUi] = useState(createConfigurationsUi);
  const configurations = useMemo(() => configurationsSlots(store, client, configurationsUi), [store, client, configurationsUi]);
  const [liquidUi] = useState(createLiquidUi);
  const liquid = useMemo(() => liquidSlots(store, client, glbDeps, liquidUi), [store, client, glbDeps, liquidUi]);
  const [engineeringUi] = useState(createEngineeringUi);
  const [visualUi] = useState(createVisualUi);
  const [cfdUi] = useState(createCfdUi);
  const propsim = useMemo(() => propSimSlots(store, client, httpBase, engineeringUi, visualUi, cfdUi, runSource, host ?? null), [store, client, httpBase, engineeringUi, visualUi, cfdUi, runSource, host]);
  const results: PageSlots = useMemo(
    () => ({
      railNav: <RunsRail app={store} onOpenRun={(sim, name) => void openArtifactThread(store, `rw:sim/${sim}`, name).catch((e: unknown) => console.error(e))} />,
      historyExtra: <RunSnapshots app={store} />,
    }),
    [store],
  );
  const pageSlots = (p: PageId): PageSlots | null =>
    p === "assembly"
      ? { toolbar: assembly.toolbar, nav: assembly.nav, navAdd: assembly.navAdd }
      : p === "components"
        ? { nav: components.nav, navAdd: components.navAdd, railFooter: components.railFooter, agentExtra: components.agentExtra }
        : p === "configurations"
          ? { toolbar: configurations.toolbar, nav: configurations.nav, navAdd: configurations.navAdd, agentExtra: configurations.agentExtra }
          : p === "results"
            ? results
            : p === "liquid"
              ? { nav: liquid.nav, navAdd: liquid.navAdd, agentExtra: liquid.agentExtra }
              : p === "propulsion-sim"
                ? { nav: propsim.nav, navAdd: propsim.navAdd }
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
      <ConnectedShell store={store} client={client} renderPage={renderPage} renderCompare={renderCompare} pageSlots={pageSlots} onSwitchProject={onSwitchProject} onError={onError} projectMenu={projectMenu} commandsRef={commandsRef} onOpenHelp={onOpenHelp} onOpenSettings={onOpenSettings} />
      <ThumbnailBaker store={store} glbDeps={glbDeps} />
    </>
  );
}
