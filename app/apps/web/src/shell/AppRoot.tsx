/**
 * The live window: one server connection, and which project it is showing
 * (`lifecycle.ts`). Everything per-project lives in `ProjectSurface`, so this
 * survives a switch and keeps the socket.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { PageId, ProjectInfo } from "@rw/contracts";
import { desktopPaneGlobals, onOpenProject } from "../embed/bridge.ts";
import { trackLecturnStatus } from "../embed/status.ts";
import { createPathPrompts } from "../host/browserHost.ts";
import { hostFor, type HostApi } from "../host/HostApi.ts";
import type { RunDataSource } from "../pages/results/source.ts";
import { RpcClient, type RpcLike } from "../state/rpc.ts";
import { BRAND } from "./brand.ts";
import { dispatchCommand, type CommandHandlers } from "./commands.ts";
import { INITIAL_LIFECYCLE, lifecycle, shellOutcome, type LifecycleState } from "./lifecycle.ts";
import { PathPromptModal } from "./PathPromptModal.tsx";
import { errorText, nextOpen } from "./projectActions.ts";
import { ProjectSurface } from "./ProjectSurface.tsx";
import { QuickStart } from "./QuickStart.tsx";
import { undoInField } from "./undo.ts";
import { useFileDrop } from "./useFileDrop.ts";
import { useProjectActions, type SurfaceHandle } from "./useProjectActions.tsx";
import { Welcome } from "./Welcome.tsx";
import { applyZoom, nextZoom, ZOOM_DEFAULT } from "./zoom.ts";

export interface AppRootProps {
  url: string;
  /** `?project=`: show this one rather than what main reopened. */
  requestedProjectId: string | null;
  initialPage: PageId;
  runSource: RunDataSource;
  httpBase: string;
  /** Called whenever the window settles (or fails); publishes `window.__rwShell`. */
  onOutcome?: (outcome: NonNullable<ReturnType<typeof shellOutcome>>) => void;
  /** Test seams. */
  connect?: (url: string) => Promise<RpcLike>;
  host?: HostApi | undefined;
}

const connectRpc = (url: string): Promise<RpcLike> => RpcClient.connect(url);

/** The startup failure itself, in the window (a blank one tells nobody anything). */
export function FatalScreen({ error }: { error: string }) {
  return (
    <main className="rw-lifecycle" role="alert" data-testid="fatal">
      <h1>RocketWright could not start</h1>
      <p>{error}</p>
    </main>
  );
}

export function AppRoot({ url, requestedProjectId, initialPage, runSource, httpBase, onOutcome, connect = connectRpc, host: hostProp }: AppRootProps) {
  const [prompts] = useState(createPathPrompts);
  const [host] = useState<HostApi>(() => hostProp ?? hostFor(window, prompts.prompt));
  const [state, dispatch] = useReducer(lifecycle, INITIAL_LIFECYCLE);
  const [client, setClient] = useState<RpcLike | null>(null);
  const stateRef = useRef<LifecycleState>(state);
  stateRef.current = state;
  // A switch keeps the page the person is on; only the first surface starts on `?page=`.
  const page = useRef(initialPage);
  const onPageChange = useCallback((p: PageId) => {
    page.current = p;
  }, []);

  useEffect(() => {
    let live = true;
    let conn: RpcLike | null = null;
    let offClose: (() => void) | null = null;
    void (async () => {
      const c = await connect(url);
      conn = c;
      if (!live) return c.close();
      // The first `lecturn.status` follows `hello` at once: keep it before React renders (B10).
      trackLecturnStatus(c);
      offClose = c.onClose((reason) => dispatch({ type: "connectionLost", reason }));
      setClient(c);
      dispatch({ type: "connected" });
      const [boot, list] = await Promise.all([host.boot(), c.call("project.list", {})]);
      if (!live) return;
      dispatch({ type: "listed", requested: requestedProjectId, active: boot.activeProjectId, projects: list.projects.map((p) => p.projectId), notice: boot.notice });
    })().catch((e: unknown) => {
      if (!live) return;
      console.error(e);
      dispatch({ type: "startFailed", error: errorText(e) });
    });
    return () => {
      live = false;
      offClose?.();
      conn?.close();
    };
  }, [url, requestedProjectId, host, connect]);

  useEffect(() => {
    const outcome = shellOutcome(state);
    if (outcome !== null) onOutcome?.(outcome);
  }, [state, onOutcome]);

  const onOpenFailed = useCallback((projectId: string, error: string) => dispatch({ type: "openFailed", projectId, error }), []);
  const show = useCallback((projectId: string) => dispatch({ type: "select", projectId }), []);
  const closedProject = useCallback((projectId: string, next: string | null) => dispatch({ type: "closed", projectId, next }), []);

  const surfaceRef = useRef<SurfaceHandle | null>(null);
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const infoRef = useRef(info);
  infoRef.current = info;
  const actions = useProjectActions({ client, host, lifecycle: stateRef, surface: surfaceRef, info: infoRef, show, closed: closedProject });
  const { report } = actions;
  const latest = useRef(actions);
  latest.current = actions;

  // Main keeps Recents and last-active from this alone, never from `project.opened` (seam 2).
  const reportRecents = useCallback((e: unknown) => report(`Could not update recent projects: ${errorText(e)}`), [report]);
  const onProjectInfo = useCallback(
    (project: ProjectInfo) => {
      setInfo(project);
      host.setActiveProject(project).catch(reportRecents);
    },
    [host, reportRecents],
  );
  const onWelcome = state.phase === "welcome";
  useEffect(() => {
    if (onWelcome) host.setActiveProject(null).catch(reportRecents);
  }, [host, onWelcome, reportRecents]);

  const shownName = state.phase === "project" && info?.projectId === state.projectId ? info.name : null;
  useEffect(() => {
    document.title = shownName === null ? BRAND.name : `${shownName} – ${BRAND.name}`;
  }, [shownName]);

  useEffect(() => {
    if (client === null) return;
    return client.on("project.closed", ({ projectId }) => {
      const shown = stateRef.current;
      if (shown.phase !== "project" || shown.projectId !== projectId) return;
      void nextOpen(client, projectId).then((next) => dispatch({ type: "closed", projectId, next }));
    });
  }, [client]);

  // `rocketwright://open` (desktop): main opened a project and asks the page to show it.
  const desktop = useMemo(() => desktopPaneGlobals(), []);
  useEffect(() => {
    if (desktop === null || client === null) return;
    return onOpenProject(desktop, (id) => latest.current.switchProject(id));
  }, [desktop, client]);

  useFileDrop(window, host, (path) => latest.current.importPath(path), (message) => latest.current.report(message));

  const surfaceCommands = useRef<CommandHandlers | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  const zoom = useRef(ZOOM_DEFAULT);
  // Registered once, not per connection: a pick made while still connecting is told why it did nothing rather than vanishing.
  useEffect(() => {
    // Undo and Redo go to the focused text field first. Only the page can tell, and it has to work with no project too (New project's name field).
    const edit = (kind: "undo" | "redo", history: () => void) => {
      if (!undoInField(kind, document)) history();
    };
    const windowCommands: CommandHandlers = {
      "edit.undo": () => edit("undo", () => dispatchCommand({ id: "edit.undo" }, surfaceCommands.current ?? {})),
      "edit.redo": () => edit("redo", () => dispatchCommand({ id: "edit.redo" }, surfaceCommands.current ?? {})),
      "help.quickStart": openHelp,
      "view.zoom": ({ direction }) => {
        zoom.current = nextZoom(zoom.current, direction);
        applyZoom(window, zoom.current);
      },
    };
    return host.onCommand((command) => void dispatchCommand(command, { ...latest.current.commands, ...surfaceCommands.current, ...windowCommands }));
  }, [host, openHelp]);

  let screen = null;
  if (state.phase === "fatal") {
    screen = <FatalScreen error={state.error} />;
  } else if (client !== null && state.phase === "welcome") {
    screen = <Welcome client={client} host={host} notice={state.notice} onOpened={show} onImport={() => void dispatchCommand({ id: "file.import" }, actions.commands)} />;
  } else if (client !== null && state.phase === "project") {
    screen = (
      <ProjectSurface
        key={state.projectId}
        client={client}
        projectId={state.projectId}
        initialPage={page.current}
        runSource={runSource}
        httpBase={httpBase}
        onPageChange={onPageChange}
        onOpenFailed={onOpenFailed}
        onSwitchProject={actions.switchProject}
        onProjectInfo={onProjectInfo}
        projectMenu={actions.menu}
        surfaceRef={surfaceRef}
        commandsRef={surfaceCommands}
        onOpenHelp={openHelp}
      />
    );
  }
  return (
    <>
      {screen}
      {actions.overlays}
      {helpOpen && <QuickStart onClose={() => setHelpOpen(false)} />}
      <PathPromptModal prompts={prompts} />
    </>
  );
}
