/**
 * `rocketwright://open?workspace=<dir>&thread=<id>` (B10; the registration's
 * `openUrlTemplate`, W2.1): Lecturn's "Open in RocketWright" link.
 *
 * - `parseOpenUrl` reads the link (workspace required, absolute; thread
 *   optional) and refuses anything else.
 * - `installProtocol` takes the single-instance lock, so a link opened while
 *   RocketWright runs reaches the running app (`second-instance` argv on
 *   Linux/Windows, `open-url` on macOS) instead of starting a second app
 *   with its own app server and project locks. A link that arrives before
 *   the window is ready is queued (`linkQueue`). `main.ts` installs it only
 *   in packaged builds or with `RW_REGISTER_PROTOCOL=1`, so a dev or test
 *   run never rewrites the user's handler or blocks a parallel window.
 * - `openFromLink` resolves the link's real folder, asks the person first when
 *   that folder is neither open here nor in Recents, resolves it again after
 *   the answer and refuses if it moved, then maps it to `project.open` on the
 *   app server (main's RPC) and activates the project (`projectActivator`). A
 *   link the app could not act on is shown, not just logged.
 * - `projectActivator` is the one way main brings a project forward (links and
 *   `host.show`): it raises the window, has the pane open the thread once the
 *   project's view is mounted (`PaneController.openThread`), and asks the page
 *   to show the project.
 *
 * Electron-free: `app` and the RPC come in through the `*Like` slices.
 */
import { isAbsolute } from "node:path";
import type { HostDecline, ProjectInfo } from "@rw/contracts";

export const PROTOCOL_SCHEME = "rocketwright";

export interface OpenLink {
  workspace: string;
  thread?: string;
}

/** `rocketwright://open?workspace=…&thread=…` → its parts; null for anything else. */
export function parseOpenUrl(raw: string): OpenLink | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== `${PROTOCOL_SCHEME}:`) return null;
  // `rocketwright://open?…` parses with host `open`; `rocketwright:open?…` with path `open`.
  const action = u.host !== "" ? u.host : u.pathname.replace(/^\/+/, "");
  if (action.replace(/\/+$/, "") !== "open") return null;
  const workspace = u.searchParams.get("workspace");
  if (workspace === null || workspace === "" || !isAbsolute(workspace) || workspace.includes("\0")) return null;
  const thread = u.searchParams.get("thread");
  return thread !== null && thread !== "" ? { workspace, thread } : { workspace };
}

/** The first `rocketwright:` link in an argv (a second instance's command line), if any. */
export function linkInArgv(argv: readonly string[]): string | null {
  return argv.find((a) => a.startsWith(`${PROTOCOL_SCHEME}:`)) ?? null;
}

/** The slice of Electron's `app` this module uses. */
export interface AppLike {
  requestSingleInstanceLock(): boolean;
  setAsDefaultProtocolClient(protocol: string): boolean;
  on(event: "second-instance", listener: (event: unknown, argv: string[]) => void): unknown;
  on(event: "open-url", listener: (event: { preventDefault(): void }, url: string) => void): unknown;
}

export interface ProtocolOptions {
  app: AppLike;
  /** Registers the scheme with the OS (packaged builds; dev only with `RW_REGISTER_PROTOCOL=1`). */
  register: boolean;
  /** Called for each well-formed link, in arrival order. */
  onOpen: (link: OpenLink) => void;
  /** Called for each link that is not one this app can act on. */
  onInvalid?: (raw: string) => void;
  /** Brings the window forward when another instance was started. */
  focus?: () => void;
  log?: (line: string) => void;
}

/**
 * Takes the single-instance lock and listens for links. Returns false when
 * another instance holds the lock: this one should quit (its argv already
 * went to the holder's `second-instance`).
 */
export function installProtocol(opts: ProtocolOptions): boolean {
  const { app } = opts;
  const log = opts.log ?? (() => {});
  if (!app.requestSingleInstanceLock()) return false;
  if (opts.register && !app.setAsDefaultProtocolClient(PROTOCOL_SCHEME)) log(`protocol: could not register ${PROTOCOL_SCHEME}://`);
  const handle = (raw: string | null): void => {
    if (raw === null) return;
    const link = parseOpenUrl(raw);
    if (link === null) {
      log(`protocol: ignored ${raw.slice(0, 120)}`);
      opts.onInvalid?.(raw);
      return;
    }
    opts.onOpen(link);
  };
  app.on("second-instance", (_e, argv) => {
    opts.focus?.();
    handle(linkInArgv(argv));
  });
  app.on("open-url", (e, url) => {
    e.preventDefault();
    opts.focus?.();
    handle(url);
  });
  return true;
}

/** Queues links until `ready` is called with the handler (links can arrive before the window). */
export function linkQueue(): { push(link: OpenLink): void; ready(handler: (link: OpenLink) => void): void; pending(): boolean } {
  let handler: ((link: OpenLink) => void) | null = null;
  const queued: OpenLink[] = [];
  return {
    push(link) {
      if (handler !== null) handler(link);
      else queued.push(link);
    },
    ready(h) {
      handler = h;
      for (const link of queued.splice(0)) h(link);
    },
    pending: () => queued.length > 0,
  };
}

export interface ActivatorDeps {
  /** Raises the window. */
  focus(): void;
  /** The pane: open the thread now or once the project mounts. */
  openThread(projectId: string, threadId: string): void;
  /** Asks the page to show the project (`open-project` on the pane channel). */
  showProject(projectId: string, threadId?: string): void;
}

/** The thread is queued before the page is asked to switch, so the pane has it when the project mounts. */
export function projectActivator(deps: ActivatorDeps): (projectId: string, threadId?: string) => void {
  return (projectId, threadId) => {
    deps.focus();
    if (threadId !== undefined) deps.openThread(projectId, threadId);
    deps.showProject(projectId, threadId);
  };
}

export interface OpenDeps {
  /** The real path of the link's folder; rejects when it cannot be resolved. */
  realpath(dir: string): Promise<string>;
  /** True when the folder is already open here or in Recents: a link to it needs no question. */
  known(dir: string): Promise<boolean>;
  /** The native confirmation; resolves false when the person did not agree. */
  confirm(dir: string): Promise<{ accepted: boolean; declined?: HostDecline }>;
  /** `project.open` on the app server (main's RPC). */
  openProject(dir: string): Promise<ProjectInfo>;
  /** Brings the opened project (and the link's thread) forward. */
  activateProject(projectId: string, threadId?: string): void;
  /** Shows the person why the link did not open. */
  showFailure(message: string): void;
  log?: (line: string) => void;
}

/**
 * The link's folder through the consent gate and `project.open`, then the
 * thread; resolves with the project (null when it did not open). A declined
 * question is the person's choice and shows nothing, except when the box
 * itself could not be shown truthfully.
 */
export async function openFromLink(link: OpenLink, deps: OpenDeps): Promise<ProjectInfo | null> {
  const fail = (message: string): null => {
    deps.log?.(`protocol: ${message}`);
    deps.showFailure(message);
    return null;
  };
  let dir: string;
  try {
    dir = await deps.realpath(link.workspace);
  } catch (e) {
    return fail(`The link's folder ${link.workspace} could not be opened: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!(await deps.known(dir))) {
    const answer = await deps.confirm(dir);
    if (!answer.accepted) {
      if (answer.declined === "refused") return fail(`The link's folder ${dir} has invisible characters in its name, so it cannot be shown for confirmation.`);
      deps.log?.(`protocol: not opening ${dir}: ${answer.declined ?? "cancelled"}`);
      return null;
    }
    // The sheet can stay up for a while, and what the person agreed to was this folder, not this name.
    let now: string;
    try {
      now = await deps.realpath(link.workspace);
    } catch (e) {
      return fail(`The link's folder ${dir} could not be opened: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (now !== dir) return fail(`The link's folder ${dir} changed while you were being asked, so it was not opened. Open the link again if you still want it.`);
  }
  let project: ProjectInfo;
  try {
    project = await deps.openProject(dir);
  } catch (e) {
    return fail(`The link's folder ${dir} could not be opened: ${e instanceof Error ? e.message : String(e)}`);
  }
  deps.activateProject(project.projectId, link.thread);
  return project;
}
