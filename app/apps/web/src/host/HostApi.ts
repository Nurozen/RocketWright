/**
 * What the page asks of whatever hosts it: the Electron main process or a
 * plain browser tab. The only web code that knows the difference (R0.12):
 * everything else calls a `HostApi` and shows whatever comes back, so a
 * browser's empty Recents and typed paths need no second code path.
 */
import type { DesktopBoot, DesktopBridge, DesktopCommand, FileFilter, PickFileOptions, PickFolderOptions, RecentProject, SaveAsOptions, ProjectInfo } from "@rw/contracts";
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
  /** Always empty in a browser, which keeps no store (R0.12). */
  recents(): Promise<RecentProject[]>;
  removeRecent(dir: string): Promise<void>;
  /** What feeds Recents and last-active; null on Welcome. */
  setActiveProject(project: ProjectInfo | null): Promise<void>;
  /** Native menu commands; a browser has none. Returns the unsubscribe. */
  onCommand(listener: (command: DesktopCommand) => void): () => void;
  /** A dropped file's path; null when it has none (always, in a browser: D18). */
  pathForFile(file: File): string | null;
}

/** `window.rwDesktop` as the preload exposes it (`apps/desktop/src/preload.ts`). */
export interface RwDesktopGlobal extends DesktopBridge {
  desktop: true;
  platform: string;
  rpcUrl: string | null;
  serverUrl: string | null;
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
}

/** Resolves to the typed path, or null when the person cancels. */
export type PathPrompt = (request: PathPromptRequest) => Promise<string | null>;

/** The desktop host when the preload ran, else the browser host asking through `prompt`. */
export function hostFor(win: { rwDesktop?: DesktopBridge | undefined }, prompt: PathPrompt): HostApi {
  return win.rwDesktop === undefined ? createBrowserHost(prompt) : createElectronHost(win.rwDesktop);
}
