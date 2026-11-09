/**
 * The Electron main ↔ page seam (`window.rwDesktop`, `apps/desktop/src/preload.ts`):
 * channels, command ids, and the shapes main persists in userData. The
 * sandboxed preload cannot import this file, so `preload.test.ts` asserts its
 * channel names match. A browser page has no `rwDesktop`; `W/host/HostApi.ts`
 * is the only web code that knows the difference.
 */
import type { ExportFormat, ExportOut } from "./generated/types.ts";
import type { ProjectInfo } from "./rpc.ts";
import type { DisplayUnits } from "./projectTools.ts";

/** Page → main `ipcRenderer.invoke` channels, by `rwDesktop` method. Main checks `event.sender` on each. */
export const DESKTOP_INVOKE_CHANNELS = {
  boot: "rw-desktop:boot",
  pickFolder: "rw-desktop:pick-folder",
  pickFile: "rw-desktop:pick-file",
  saveAs: "rw-desktop:save-as",
  exportFile: "rw-desktop:export-file",
  recents: "rw-desktop:recents",
  removeRecent: "rw-desktop:remove-recent",
  setActiveProject: "rw-desktop:set-active-project",
  setDirty: "rw-desktop:set-dirty",
  flushDone: "rw-desktop:flush-done",
  dirtyAnswer: "rw-desktop:dirty-answer",
  prefs: "rw-desktop:prefs",
  setPrefs: "rw-desktop:set-prefs",
  openProviders: "rw-desktop:open-providers",
  relaunch: "rw-desktop:relaunch",
} as const;

/** Main → page: one `DesktopCommand`. */
export const DESKTOP_COMMAND_CHANNEL = "rw-desktop:command";

/** Main → page: save typed work the way Close does, then answer on `flushDone` with this request's id (Save and quit). */
export const DESKTOP_FLUSH_CHANNEL = "rw-desktop:flush";

/** Main → page: does this page hold typed work right now? Answer on `dirtyAnswer` with this request's id. Main's copy can be behind the keystroke. */
export const DESKTOP_DIRTY_CHECK_CHANNEL = "rw-desktop:dirty-check";

/** The page's answer to one dirty check. */
export interface DesktopDirtyAnswer {
  id: number;
  dirty: boolean;
}

/** What the page reports back for one flush; `problems` is empty when everything was saved. */
export interface DesktopFlushResult {
  id: number;
  problems: string[];
}

/** Commands the native menu sends the page (`W/shell/commands.ts` is the table behind menu, header menus and shortcuts). */
export const DESKTOP_COMMAND_IDS = [
  "project.new",
  "project.open",
  "project.openSample",
  "project.openRecent",
  "project.close",
  "project.rename",
  "file.import",
  "file.export",
  "edit.undo",
  "edit.redo",
  "view.tab",
  "view.zoom",
  "help.quickStart",
  "app.settings",
] as const;
export type DesktopCommandId = (typeof DESKTOP_COMMAND_IDS)[number];

export type ZoomDirection = "in" | "out" | "reset";

export type DesktopCommand =
  | { id: Exclude<DesktopCommandId, "project.openRecent" | "view.tab" | "view.zoom"> }
  | { id: "project.openRecent"; dir: string }
  | { id: "view.tab"; tab: string }
  | { id: "view.zoom"; direction: ZoomDirection };

export interface AppCommand {
  id: DesktopCommandId;
  label: string;
  menu: "File" | "Edit" | "View" | "Help" | "App";
  /** The native menu item's key, when it has one. */
  accelerator?: string;
  /** A plain browser tab can take this key too. Absent for keys a browser keeps for itself, such as Cmd-N and Cmd-W (R0.12). */
  browser?: true;
}

/**
 * The one table of app commands (seam 6): the native menu (`D/menu.ts`), the
 * header menus and the shortcuts all read it, so a command cannot exist in one
 * and be missing from another. Here rather than in the web app because Electron
 * main has to read it too.
 */
export const APP_COMMANDS: readonly AppCommand[] = [
  { id: "project.new", label: "New project…", menu: "File", accelerator: "CmdOrCtrl+N" },
  { id: "project.open", label: "Open folder…", menu: "File", accelerator: "CmdOrCtrl+O", browser: true },
  { id: "project.openSample", label: "Open sample rocket", menu: "File" },
  { id: "project.openRecent", label: "Recent", menu: "File" },
  { id: "project.close", label: "Close project", menu: "File", accelerator: "CmdOrCtrl+W" },
  { id: "project.rename", label: "Rename project…", menu: "File" },
  { id: "file.import", label: "Import…", menu: "File" },
  { id: "file.export", label: "Export…", menu: "File" },
  { id: "edit.undo", label: "Undo", menu: "Edit" },
  { id: "edit.redo", label: "Redo", menu: "Edit" },
  { id: "view.tab", label: "Tab", menu: "View" },
  { id: "view.zoom", label: "Zoom", menu: "View" },
  { id: "help.quickStart", label: "Quick start", menu: "Help" },
  { id: "app.settings", label: "Settings…", menu: "App", accelerator: "CmdOrCtrl+,", browser: true },
];

/** A command's label as every menu shows it. */
export function commandLabel(id: DesktopCommandId): string {
  return APP_COMMANDS.find((c) => c.id === id)?.label ?? id;
}

/** A command's native menu key, if it has one. */
export function commandAccelerator(id: DesktopCommandId): string | undefined {
  return APP_COMMANDS.find((c) => c.id === id)?.accelerator;
}

/** The header's tabs, which the native View menu lists too. */
export const TOP_TABS = [
  { id: "design", label: "Design" },
  { id: "propulsion", label: "Propulsion" },
  { id: "simulate", label: "Simulate" },
  { id: "results", label: "Results" },
] as const;

/** Pulled by the page once it can show it (a `send` before React listens is lost). */
export interface DesktopBoot {
  /** The project main reopened, which the page shows first; null: Welcome. */
  activeProjectId: string | null;
  /** Why the last project did not reopen, for a notice on Welcome. */
  notice: string | null;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface PickFolderOptions {
  title?: string;
  defaultPath?: string;
}

export interface PickFileOptions extends PickFolderOptions {
  filters?: FileFilter[];
}

export type SaveAsOptions = PickFileOptions;

/** Main owns the save dialog and calls `export.file` over its role socket (D18). */
export interface ExportFileRequest {
  projectId: string;
  format: ExportFormat;
  config?: string;
  run?: string;
  defaultName?: string;
}

export type ExportFileResult = { canceled: true } | { canceled: false; out: ExportOut };

/** What each export format is called and where it lands; main names the save dialog's filter from this, the page the choice. */
export const EXPORT_FILE_TYPES: Record<ExportFormat, { label: string; description: string; extension: string }> = {
  ork: { label: "OpenRocket design", description: "The rocket as an .ork file.", extension: "ork" },
  rasp: { label: "Motor curves", description: "The motors of the default configuration, as a RASP .eng file.", extension: "eng" },
  glb: { label: "3D model", description: "A .glb model of the rocket.", extension: "glb" },
  stl: { label: "3D print mesh", description: "An .stl mesh of the rocket.", extension: "stl" },
  csv: { label: "Flight data", description: "One flown run as a .csv table.", extension: "csv" },
};

/**
 * Computed when read, never stored. Only ENOENT is `missing` (D5): `denied`
 * (EPERM/EACCES, e.g. TCC on an ad-hoc build, or a mount that has stopped
 * answering) and `locked` (another process
 * holds the project) must not invite removing a healthy project.
 */
export type RecentStatus = "ok" | "missing" | "denied" | "locked";

export interface RecentEntry {
  dir: string;
  name: string;
  /** ISO 8601. */
  lastOpened: string;
}

export interface RecentProject extends RecentEntry {
  status: RecentStatus;
  /** Already open in this app. The header lists those itself; Welcome keeps them, or they could not be reached. */
  open?: boolean;
}

/** `recents.json` in userData (temp-plus-rename; a corrupt file reads as empty). */
export interface RecentsFile {
  version: 1;
  recents: RecentEntry[];
  /** The realpath last shown, for `reopenLast`. */
  lastActive: string | null;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `preferences.json` in userData (R3.4). */
export interface DesktopPrefs {
  window: WindowBounds | null;
  view: Record<string, boolean | number | string>;
  lastTab: string | null;
  /** Reaches `rw init --display-units` from both creation paths. */
  defaultDisplayUnits: DisplayUnits | null;
}

/** Native message boxes: Electron indexes the labels in array order. */
export const CONSENT_CANCEL_ID = 0;
export const CONSENT_ACCEPT_ID = 1;
/** Cancel is first so it is both `defaultId` and `cancelId`: Return and Escape refuse. */
export const CONSENT_BUTTONS = {
  project_new: ["Cancel", "Create project"],
  project_open: ["Cancel", "Open project"],
} as const;

export const UNSAVED_SAVE_ID = 0;
export const UNSAVED_DISCARD_ID = 1;
export const UNSAVED_CANCEL_ID = 2;
/** The R3.7 prompt when quitting or closing with an uncommitted field edit. */
export const UNSAVED_BUTTONS = ["Save", "Don't Save", "Cancel"] as const;

/** `window.rwDesktop`'s desktop services, as the preload exposes them. */
export interface DesktopBridge {
  boot(): Promise<DesktopBoot>;
  pickFolder(options?: PickFolderOptions): Promise<string | null>;
  pickFile(options?: PickFileOptions): Promise<string | null>;
  saveAs(options?: SaveAsOptions): Promise<string | null>;
  exportFile(request: ExportFileRequest): Promise<ExportFileResult>;
  recents(): Promise<RecentProject[]>;
  removeRecent(dir: string): Promise<void>;
  /** What feeds Recents and last-active (never `project.opened`); null on Welcome. */
  setActiveProject(project: ProjectInfo | null): Promise<void>;
  setDirty(dirty: boolean): Promise<void>;
  /** Answers one `onFlush` request. */
  flushDone(result: DesktopFlushResult): Promise<void>;
  /** Answers one `onDirtyCheck` request. */
  dirtyAnswer(result: DesktopDirtyAnswer): Promise<void>;
  prefs(): Promise<DesktopPrefs>;
  setPrefs(patch: Partial<DesktopPrefs>): Promise<void>;
  openProviders(): Promise<void>;
  relaunch(): Promise<void>;
  onCommand(listener: (command: DesktopCommand) => void): () => void;
  /** Main asking the page to save (Save and quit); the id goes back with `flushDone`. */
  onFlush(listener: (id: number) => void): () => void;
  /** Main asking whether the page holds typed work (before a quit or a close); the id goes back with `dirtyAnswer`. */
  onDirtyCheck(listener: (id: number) => void): () => void;
  /** A dropped file's path (`File.path` is gone; `webUtils.getPathForFile`). */
  pathForFile(file: File): string;
}
