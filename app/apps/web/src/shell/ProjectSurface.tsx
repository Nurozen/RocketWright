/**
 * One open project on screen: its store, per-page UI objects and broker host.
 * `AppRoot` keys it on the project id, so a switch remounts all of it rather
 * than re-pointing a live store (seam 3): page UI that is created once, such
 * as the CFD dataset list, and the Results `seeded` flag start fresh, and the
 * new project gets a broker host of its own.
 */
import { useEffect, useMemo, useState, type RefObject } from "react";
import type { BrokerRequest, PageId, ProjectInfo } from "@rw/contracts";
import { answer, startBrokerHost, windowHostDeps } from "../broker/host.ts";
import { openArtifactThread } from "../embed/rail.ts";
import { assemblySlots } from "../pages/assembly/AssemblyPage.tsx";
import { ComparePage } from "../pages/compare/ComparePage.tsx";
import { componentsSlots, createComponentsUi } from "../pages/components/ComponentsPage.tsx";
import { configurationsSlots, createConfigurationsUi } from "../pages/configurations/ConfigurationsPage.tsx";
import { createLiquidUi, liquidSlots } from "../pages/liquid/LiquidPage.tsx";
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
  projectMenu?: ProjectMenuModel | undefined;
  /** Filled while this surface is mounted: what `AppRoot` needs before it can leave the project. */
  surfaceRef?: RefObject<SurfaceHandle | null> | undefined;
  commandsRef?: RefObject<CommandHandlers | null> | undefined;
  onOpenHelp?: (() => void) | undefined;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function ProjectSurface({ client, projectId, initialPage, runSource, httpBase, onPageChange, onOpenFailed, onSwitchProject, onProjectInfo, projectMenu, surfaceRef, commandsRef, onOpenHelp }: ProjectSurfaceProps) {
  const [store] = useState(() => {
    const st = createAppStore();
    st.getState().ui.navigate(initialPage);
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
      store.getState().project.disconnect();
      if (window.__rwBroker === probe) delete window.__rwBroker;
    };
  }, [client, projectId, store, runSource, onOpenFailed]);

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
    };
    surfaceRef.current = handle;
    return () => {
      if (surfaceRef.current === handle) surfaceRef.current = null;
    };
  }, [surfaceRef, store, client, projectId, onOpenFailed]);

  const page = useAppState(store, (s) => s.ui.page);
  useEffect(() => onPageChange(page), [page, onPageChange]);
  const info = useAppState(store, (s) => s.project.snapshot?.project ?? null);
  useEffect(() => {
    if (info !== null) onProjectInfo(info);
  }, [info, onProjectInfo]);

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
      ? { toolbar: assembly.toolbar, nav: assembly.nav, navAdd: assembly.navAdd }
      : p === "components"
        ? { nav: components.nav, navAdd: components.navAdd, railFooter: components.railFooter, agentExtra: components.agentExtra }
        : p === "configurations"
          ? { toolbar: configurations.toolbar, nav: configurations.nav, navAdd: configurations.navAdd, agentExtra: configurations.agentExtra }
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
      <ConnectedShell store={store} client={client} renderPage={renderPage} renderCompare={renderCompare} pageSlots={pageSlots} onSwitchProject={onSwitchProject} projectMenu={projectMenu} commandsRef={commandsRef} onOpenHelp={onOpenHelp} />
      <ThumbnailBaker store={store} glbDeps={glbDeps} />
    </>
  );
}
