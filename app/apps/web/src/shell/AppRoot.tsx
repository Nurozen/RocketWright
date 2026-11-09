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
import { dispatchCommand, type CommandHandlers } from "./commands.ts";
import { INITIAL_LIFECYCLE, lifecycle, shellOutcome, type LifecycleState } from "./lifecycle.ts";
import { PathPromptModal } from "./PathPromptModal.tsx";
import { errorText } from "./projectActions.ts";
import { ProjectSurface } from "./ProjectSurface.tsx";
import { Welcome } from "./Welcome.tsx";

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

/** The next open project after `closed` goes, or null for Welcome. */
async function nextOpen(client: RpcLike, closed: string): Promise<string | null> {
  try {
    const { projects } = await client.call("project.list", {});
    return projects.find((p) => p.projectId !== closed)?.projectId ?? null;
  } catch {
    return null;
  }
}

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
  const onSwitchProject = useCallback((projectId: string) => dispatch({ type: "select", projectId }), []);

  // Main keeps Recents and last-active from this alone, never from `project.opened` (seam 2).
  const onProjectInfo = useCallback((project: ProjectInfo) => void host.setActiveProject(project).catch((e: unknown) => console.error(e)), [host]);
  const onWelcome = state.phase === "welcome";
  useEffect(() => {
    if (onWelcome) void host.setActiveProject(null).catch((e: unknown) => console.error(e));
  }, [host, onWelcome]);

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
    return onOpenProject(desktop, (id) => dispatch({ type: "select", projectId: id }));
  }, [desktop, client]);

  useEffect(() => {
    if (client === null) return;
    const handlers: CommandHandlers = {
      "project.openRecent": ({ dir }) => {
        client.call("project.open", { dir }).then(
          ({ project }) => dispatch({ type: "select", projectId: project.projectId }),
          (e: unknown) => console.error(e),
        );
      },
      "project.close": () => {
        const shown = stateRef.current;
        if (shown.phase !== "project") return;
        // The server's `project.closed` push moves the window on.
        client.call("project.close", { projectId: shown.projectId }).catch((e: unknown) => console.error(e));
      },
    };
    return host.onCommand((command) => void dispatchCommand(command, handlers));
  }, [client, host]);

  let screen = null;
  if (state.phase === "fatal") {
    screen = <FatalScreen error={state.error} />;
  } else if (client !== null && state.phase === "welcome") {
    screen = <Welcome client={client} host={host} notice={state.notice} onOpened={onSwitchProject} />;
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
        onSwitchProject={onSwitchProject}
        onProjectInfo={onProjectInfo}
      />
    );
  }
  return (
    <>
      {screen}
      <PathPromptModal prompts={prompts} />
    </>
  );
}
