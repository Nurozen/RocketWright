/**
 * Main's side of `window.rwDesktop` (`@rw/contracts` `desktop.ts`), free of
 * Electron imports: native pickers, Recents and the page-pulled boot state.
 *
 * `ipcMain.handle` channels are process-global, so each handler first checks
 * the sender is the app window: the agent pane's guest and anything else are
 * refused (`createPaneController` in `lecturn.ts` checks the same way).
 * Arguments come from the page, so they are checked, not trusted.
 *
 * `dialog.showX` is looked up on every call, so a test can stub it after this
 * registers (Playwright's `app.evaluate`).
 */
import { DESKTOP_INVOKE_CHANNELS, type DesktopBoot, type FileFilter } from "@rw/contracts";
import { isAbsolute, join } from "node:path";
import type { Recents } from "./recents.ts";

interface OpenOptions {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
  properties: ("openFile" | "openDirectory" | "createDirectory")[];
}

interface SaveOptions {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
}

export interface DialogLike<W> {
  showOpenDialog(window: W, options: OpenOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog(window: W, options: SaveOptions): Promise<{ canceled: boolean; filePath?: string | undefined }>;
}

export interface WindowLike {
  readonly webContents: unknown;
  isDestroyed(): boolean;
}

export interface HandlerIpc {
  handle(channel: string, listener: (event: { sender: unknown }, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export interface DesktopServices<W extends WindowLike> {
  ipc: HandlerIpc;
  dialog: DialogLike<W>;
  /** The window allowed to call these, once it exists. */
  window: () => W | null;
  /** Read per dialog, so `app.getPath` and test overrides stay current. */
  documents: () => string;
  recents: Recents;
  boot: () => DesktopBoot;
  /** A hidden run: no dialog can be answered, so every picker reads as cancelled. */
  headless?: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

function fileFilters(v: unknown): FileFilter[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const filters = v.flatMap((f: unknown): FileFilter[] => {
    if (!isRecord(f) || typeof f.name !== "string" || !Array.isArray(f.extensions)) return [];
    return [{ name: f.name, extensions: f.extensions.filter((e): e is string => typeof e === "string") }];
  });
  return filters.length === 0 ? undefined : filters;
}

/** The page's options, keeping only known fields; a relative default (a bare file name) lands in Documents. */
function dialogOptions(options: unknown, documents: () => string): { title?: string; defaultPath: string; filters?: FileFilter[] } {
  const o = isRecord(options) ? options : {};
  const title = text(o.title);
  const given = text(o.defaultPath);
  const filters = fileFilters(o.filters);
  return {
    ...(title !== undefined ? { title } : {}),
    defaultPath: given === undefined ? documents() : isAbsolute(given) ? given : join(documents(), given),
    ...(filters !== undefined ? { filters } : {}),
  };
}

function activeProject(v: unknown): { dir: string; name: string } | null {
  if (v === null) return null;
  if (!isRecord(v) || typeof v.dir !== "string" || !isAbsolute(v.dir) || typeof v.name !== "string") throw new TypeError("setActiveProject: expected a project or null");
  return { dir: v.dir, name: v.name };
}

/** Registers the handlers on `ipc`; the returned function removes them. */
export function registerDesktopServices<W extends WindowLike>(deps: DesktopServices<W>): () => void {
  const { ipc, dialog, recents, documents, headless = false } = deps;
  const channels: string[] = [];
  const handle = (channel: string, fn: (win: W, ...args: unknown[]) => unknown): void => {
    channels.push(channel);
    ipc.handle(channel, (event, ...args) => {
      const win = deps.window();
      if (win === null || win.isDestroyed() || event.sender !== win.webContents) throw new Error(`${channel}: not the app window`);
      return fn(win, ...args);
    });
  };
  const pickOne = async (win: W, options: unknown, properties: OpenOptions["properties"]): Promise<string | null> => {
    if (headless) return null;
    const r = await dialog.showOpenDialog(win, { ...dialogOptions(options, documents), properties });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  };

  const c = DESKTOP_INVOKE_CHANNELS;
  handle(c.boot, () => deps.boot());
  handle(c.pickFolder, (win, options) => pickOne(win, options, ["openDirectory", "createDirectory"]));
  handle(c.pickFile, (win, options) => pickOne(win, options, ["openFile"]));
  handle(c.saveAs, async (win, options) => {
    if (headless) return null;
    const r = await dialog.showSaveDialog(win, dialogOptions(options, documents));
    return r.canceled ? null : text(r.filePath) ?? null;
  });
  handle(c.recents, () => recents.list());
  handle(c.removeRecent, (_win, dir) => {
    if (typeof dir !== "string") throw new TypeError("removeRecent: expected a path");
    return recents.remove(dir);
  });
  handle(c.setActiveProject, (_win, project) => recents.see(activeProject(project)));
  return () => {
    for (const channel of channels) ipc.removeHandler(channel);
  };
}
