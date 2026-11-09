/**
 * What the page asks of whatever hosts it: the Electron main process or a
 * plain browser tab. The only web code that knows the difference (R0.12):
 * everything else calls a `HostApi` and shows whatever comes back, so a
 * browser's empty Recents and typed paths need no second code path.
 */
import type { DesktopBoot, DesktopBridge, DesktopCommand, DesktopPrefs, ExportFileRequest, ExportFileResult, FileFilter, PickFileOptions, PickFolderOptions, RecentProject, SaveAsOptions, ProjectInfo, schema } from "@rw/contracts";
import { createBrowserHost } from "./browserHost.ts";
import { createElectronHost } from "./electronHost.ts";

export interface HostApi {
  readonly kind: "desktop" | "browser";
  /** Pull once the page can show the result: main's pushes before React listens are lost. */
  boot(): Promise<DesktopBoot>;
  /** Null when the person cancels. */
  pickFolder(options?: PickFolderOptions): Promise<string | null>;
  pickFile(options?: PickFileOptions): Promise<string | null>;
  saveAs(options?: SaveAsOptions): Promise<string | null>;
  /**
   * Asks where and writes the export (D18). The desktop's main process owns the
   * save dialog and may write anywhere the person picked; a browser asks for a
   * path inside the project and writes it through `writeInProject`.
   */
  exportFile(request: ExportFileRequest, writeInProject: (path: string) => Promise<schema.ExportOut>): Promise<ExportFileResult>;
  /** Always empty in a browser, which keeps no store (R0.12). */
  recents(): Promise<RecentProject[]>;
  removeRecent(dir: string): Promise<void>;
  /** What feeds Recents and last-active; null on Welcome. */
  setActiveProject(project: ProjectInfo | null): Promise<void>;
  /** Whether typed work would be lost by leaving, so main can ask before a quit (R3.7). A browser has no quit to guard. */
  setDirty(dirty: boolean): Promise<void>;
  /** Save and quit: main asks, `flush` saves as Close does, and main is told what could not be saved. A browser has no quit. Returns the unsubscribe. */
  onFlush(flush: () => Promise<string[]>): () => void;
  /** Native menu commands; a browser has none. Returns the unsubscribe. */
  onCommand(listener: (command: DesktopCommand) => void): () => void;
  /** A dropped file's path; null when it has none (always, in a browser: D18). */
  pathForFile(file: File): string | null;
  /** A new instance of the app, after this one's server has gone (D19); a browser reloads the page, which is all it can do. */
  relaunch(): Promise<void>;
  /** Saved preferences (R3.4). A browser keeps them only for this tab (R0.12: no store is added for it). */
  prefs(): Promise<DesktopPrefs>;
  setPrefs(patch: Partial<DesktopPrefs>): Promise<void>;
  /** Lecturn's providers panel: main drives the mounted pane on the desktop; a browser uses the page's own bridge, `inPane`. */
  openProviders(inPane: () => void): Promise<void>;
}

/** `window.rwDesktop` as the preload exposes it (`apps/desktop/src/preload.ts`). */
export interface RwDesktopGlobal extends DesktopBridge {
  desktop: true;
  platform: string;
  rpcUrl: string | null;
  serverUrl: string | null;
  /** Why the app server did not start, when it did not (R3.3). */
  startupError: string | null;
  /** Main's embedded-pane messages (`lecturn-embed:rw-to-host`, `embed/bridge.ts`). */
  lecturn?: { onMessage(cb: (message: unknown) => void): () => void };
}

export type PathPromptKind = "folder" | "file" | "save";

/** One typed-path question, the browser's stand-in for a native picker. */
export interface PathPromptRequest {
  kind: PathPromptKind;
  title: string;
  defaultPath?: string;
  filters?: FileFilter[];
  /** The line under the field, when "the full path on this computer" is not what is wanted. */
  hint?: string;
}

/** Resolves to the typed path, or null when the person cancels. */
export type PathPrompt = (request: PathPromptRequest) => Promise<string | null>;

/** The desktop host when the preload ran, else the browser host asking through `prompt`. */
export function hostFor(win: { rwDesktop?: DesktopBridge | undefined }, prompt: PathPrompt): HostApi {
  return win.rwDesktop === undefined ? createBrowserHost(prompt) : createElectronHost(win.rwDesktop);
}
