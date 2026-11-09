/**
 * The native application menu (R0.10), Electron-free so it is tested as data:
 * `buildMenuTemplate` turns what main knows into a template, and
 * `createMenuController` keeps it current. Interactive windows only; a hidden
 * run has no menu to drive.
 *
 * - Labels come from the one command table (`APP_COMMANDS`, seam 6). What a
 *   project command does belongs to the page (`W/shell/useProjectActions.tsx`),
 *   so the menu only sends it, and a failure lands where the same action from
 *   the header would show it.
 * - Undo and Redo are custom items, because a role acts on whatever is focused
 *   and nothing can pick "field or design history". `routeEdit` sends them to
 *   the agent pane's guest when it has focus, else to the page. No focused
 *   contents at all counts as the page (U05 saw the accelerator fire that way).
 *   The page's own Cmd-Z keydown calls `preventDefault`, which suppresses the
 *   accelerator, so one press never restores twice.
 * - Zoom is CSS `zoom` applied by the page (D7): no zoom role and no
 *   `setZoomFactor`, which would leave the pane's rect stale.
 * - No `role: close`: Cmd-W means Close project and Cmd-Shift-W closes the
 *   window. Delete has no accelerator, because the Delete key removes parts.
 */
import { commandAccelerator, commandLabel, TOP_TABS, type DesktopCommand, type RecentProject, type RecentStatus, type ZoomDirection } from "@rw/contracts";
import type { MenuItemConstructorOptions } from "electron";

export const APP_NAME = "RocketWright";
export const DOCS_URL = "https://github.com/Nurozen/RocketWright#readme";
export const ISSUES_URL = "https://github.com/Nurozen/RocketWright/issues/new";

/** Native menus get long fast; Welcome keeps the full list. */
const MAX_MENU_RECENTS = 10;

const RECENT_STATUS: Partial<Record<RecentStatus, string>> = { missing: "Missing", denied: "No access", locked: "In use" };

export type EditKind = "undo" | "redo";

export interface MenuState {
  platform: NodeJS.Platform;
  /** Reload is for development only (R0.10). */
  dev: boolean;
  /** Whether the window is showing a project, as the page last told main. */
  projectOpen: boolean;
  recents: readonly RecentProject[];
  /** Said in the Recent submenu in place of the list that could not be read. */
  recentsError: string | null;
}

export interface MenuActions {
  send(command: DesktopCommand): void;
  edit(kind: EditKind): void;
  closeWindow(): void;
  quit(): void;
  openExternal(url: string): void;
}

const SEPARATOR: MenuItemConstructorOptions = { type: "separator" };

function recentItems({ recents, recentsError, projectOpen }: MenuState, send: MenuActions["send"]): MenuItemConstructorOptions[] {
  if (recentsError !== null) return [{ label: recentsError, enabled: false }];
  // With a project showing, the header's own list reaches the others; on Welcome nothing else does.
  const listed = projectOpen ? recents.filter((r) => r.open !== true) : recents;
  if (listed.length === 0) return [{ label: "No recent projects", enabled: false }];
  return listed.slice(0, MAX_MENU_RECENTS).map((r) => {
    const status = RECENT_STATUS[r.status];
    return {
      id: `recent:${r.dir}`,
      label: status === undefined ? r.name : `${r.name} (${status})`,
      enabled: r.status !== "missing",
      click: () => send({ id: "project.openRecent", dir: r.dir }),
    };
  });
}

function accelerator(id: DesktopCommand["id"]): Pick<MenuItemConstructorOptions, "accelerator"> {
  const key = commandAccelerator(id);
  return key === undefined ? {} : { accelerator: key };
}

function zoomItem(label: string, direction: ZoomDirection, accelerator: string, send: MenuActions["send"], visible = true): MenuItemConstructorOptions {
  return { ...(visible ? { id: `view.zoom:${direction}` } : {}), label, accelerator, visible, click: () => send({ id: "view.zoom", direction }) };
}

export function buildMenuTemplate(state: MenuState, actions: MenuActions): MenuItemConstructorOptions[] {
  const { platform, dev, projectOpen } = state;
  const { send } = actions;
  const mac = platform === "darwin";
  const command = (id: Exclude<DesktopCommand["id"], "project.openRecent" | "view.tab" | "view.zoom">, extra: MenuItemConstructorOptions = {}): MenuItemConstructorOptions => ({
    id,
    label: commandLabel(id),
    click: () => send({ id }),
    ...accelerator(id),
    ...extra,
  });
  // Default units are for the projects to come, so Settings works from Welcome too.
  const settings = command("app.settings");
  // Electron's role gives Cmd/Ctrl-Q everywhere but Windows, whose convention is Alt-F4.
  const quitAccelerator: MenuItemConstructorOptions = platform === "win32" ? {} : { accelerator: "CmdOrCtrl+Q" };

  const file: MenuItemConstructorOptions[] = [
    command("project.new"),
    command("project.open"),
    command("project.openSample"),
    { id: "project.openRecent", label: commandLabel("project.openRecent"), submenu: recentItems(state, send) },
    SEPARATOR,
    // Import stays on with no project: an .ork there starts a new one (D17).
    command("file.import"),
    command("file.export", { enabled: projectOpen }),
    SEPARATOR,
    command("project.rename", { enabled: projectOpen }),
    command("project.close", { enabled: projectOpen }),
    { id: "window.close", label: "Close window", accelerator: "CmdOrCtrl+Shift+W", click: () => actions.closeWindow() },
    ...(mac ? [] : [SEPARATOR, settings]),
    SEPARATOR,
    // macOS keeps Quit in the app menu too, and only that one carries the accelerator.
    mac ? { id: "file.quit", label: `Quit ${APP_NAME}`, click: () => actions.quit() } : { id: "file.quit", role: "quit", ...quitAccelerator },
  ];

  const edit: MenuItemConstructorOptions[] = [
    { id: "edit.undo", label: commandLabel("edit.undo"), accelerator: "CmdOrCtrl+Z", click: () => actions.edit("undo") },
    { id: "edit.redo", label: commandLabel("edit.redo"), accelerator: platform === "win32" ? "Control+Y" : "CmdOrCtrl+Shift+Z", click: () => actions.edit("redo") },
    SEPARATOR,
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
    { role: "selectAll" },
    { role: "delete" },
  ];

  const view: MenuItemConstructorOptions[] = [
    ...TOP_TABS.map((t, i): MenuItemConstructorOptions => ({ id: `view.tab:${t.id}`, label: t.label, accelerator: `CmdOrCtrl+${i + 1}`, enabled: projectOpen, click: () => send({ id: "view.tab", tab: t.id }) })),
    SEPARATOR,
    zoomItem("Actual size", "reset", "CmdOrCtrl+0", send),
    zoomItem("Zoom in", "in", "CmdOrCtrl+=", send),
    // The same key with Shift held, which is how a US keyboard types "+".
    zoomItem("Zoom in", "in", "CmdOrCtrl+Plus", send, false),
    zoomItem("Zoom out", "out", "CmdOrCtrl+-", send),
    ...(dev ? [SEPARATOR, { role: "reload" } as const] : []),
  ];

  const help: MenuItemConstructorOptions[] = [
    command("help.quickStart"),
    { id: "help.docs", label: "Online documentation", click: () => actions.openExternal(DOCS_URL) },
    { id: "help.issue", label: "Report an issue", click: () => actions.openExternal(ISSUES_URL) },
    SEPARATOR,
    { role: "about", label: `About ${APP_NAME}` },
  ];

  const appMenu: MenuItemConstructorOptions = {
    label: APP_NAME,
    submenu: [
      { role: "about", label: `About ${APP_NAME}` },
      SEPARATOR,
      settings,
      SEPARATOR,
      { role: "services" },
      SEPARATOR,
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      SEPARATOR,
      { role: "quit", label: `Quit ${APP_NAME}`, accelerator: "CmdOrCtrl+Q" },
    ],
  };

  return [...(mac ? [appMenu] : []), { label: "File", submenu: file }, { label: "Edit", submenu: edit }, { label: "View", submenu: view }, { label: "Help", submenu: help }];
}

/** What can hold focus: the app page, the agent pane's guest, or devtools. */
export interface EditTarget {
  undo(): void;
  redo(): void;
  isDestroyed(): boolean;
}

/** The focused guest takes the edit itself; anything else, nothing focused included, is the page's to decide. */
export function routeEdit(kind: EditKind, focused: EditTarget | null, host: EditTarget, sendToPage: (command: DesktopCommand) => void): void {
  if (focused !== null && focused !== host && !focused.isDestroyed()) {
    focused[kind]();
    return;
  }
  sendToPage({ id: kind === "undo" ? "edit.undo" : "edit.redo" });
}

export type LinkAction = "navigate" | "external" | "deny";

/** Where a link in the app window may go: its own origin stays, web links open the browser, anything else is refused. */
export function linkAction(url: string, appOrigin: string): LinkAction {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "deny";
  }
  if (parsed.origin === appOrigin) return "navigate";
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? "external" : "deny";
}

export interface MenuWindow {
  readonly webContents: EditTarget & { send(channel: string, ...args: unknown[]): void };
  isDestroyed(): boolean;
  close(): void;
}

export interface MenuControllerDeps {
  win: MenuWindow;
  channel: string;
  platform: NodeJS.Platform;
  dev: boolean;
  recents: () => Promise<RecentProject[]>;
  apply: (template: MenuItemConstructorOptions[]) => void;
  focused: () => EditTarget | null;
  openExternal: (url: string) => Promise<void>;
  quit: () => void;
  log: (line: string) => void;
}

export interface MenuController {
  /** Sets the menu now, without reading Recents: a stalled mount must not leave the app with no menu at launch. */
  install(): void;
  /** Rebuilds after Recents or the open projects change. */
  refresh(): Promise<void>;
  /** The page said which project, if any, it is showing. */
  setProjectOpen(open: boolean): Promise<void>;
}

export function createMenuController(deps: MenuControllerDeps): MenuController {
  const { win, channel, platform, dev } = deps;
  let projectOpen = false;
  let recents: readonly RecentProject[] = [];
  let recentsError: string | null = "Loading recent projects…";
  // Rebuilds read Recents off disk and can overlap; only the newest may land.
  let latest = 0;
  const install = (): void => deps.apply(buildMenuTemplate({ platform, dev, projectOpen, recents, recentsError }, actions));

  const send = (command: DesktopCommand): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, command);
  };
  const actions: MenuActions = {
    send,
    edit: (kind) => {
      if (!win.isDestroyed()) routeEdit(kind, deps.focused(), win.webContents, send);
    },
    closeWindow: () => {
      if (!win.isDestroyed()) win.close();
    },
    quit: deps.quit,
    openExternal: (url) => {
      deps.openExternal(url).catch((e: unknown) => deps.log(`menu: cannot open ${url}: ${e instanceof Error ? e.message : String(e)}`));
    },
  };

  const refresh = async (): Promise<void> => {
    const mine = ++latest;
    let nextRecents: readonly RecentProject[] = [];
    let nextError: string | null = null;
    try {
      nextRecents = await deps.recents();
    } catch (e) {
      deps.log(`menu: cannot read recents: ${e instanceof Error ? e.message : String(e)}`);
      nextError = "Could not read recent projects";
    }
    if (mine !== latest) return;
    recents = nextRecents;
    recentsError = nextError;
    install();
  };

  return {
    install,
    refresh,
    setProjectOpen: (open) => {
      projectOpen = open;
      // Close project and the rest follow at once; only the Recent rows wait for the disk.
      install();
      return refresh();
    },
  };
}
