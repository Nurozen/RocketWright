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
 *
 * `createConsentDialogs` is the native dialog behind the agent's project tools
 * (R1.3, D10, D11). The host channel brings it the request; no page is involved.
 */
import { DESKTOP_INVOKE_CHANNELS, EXPORT_FILE_TYPES, type DesktopBoot, type ExportFileRequest, type FileFilter, type HostRequest, type schema } from "@rw/contracts";
import { basename, isAbsolute, join } from "node:path";
import type { HostAnswer } from "./mainRpc.ts";
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
  /**
   * Writes the export over main's role-bound socket (D11, D18), to the path the
   * person chose in the save dialog. Absent without an app server.
   */
  exportFile?: (request: ExportFileRequest, path: string) => Promise<schema.ExportOut>;
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

/** The page's export request. It names what to export, never where: only the save dialog answers that. */
function exportRequest(v: unknown): ExportFileRequest {
  if (!isRecord(v) || typeof v.projectId !== "string" || typeof v.format !== "string" || !Object.hasOwn(EXPORT_FILE_TYPES, v.format)) throw new TypeError("exportFile: expected a project and a format");
  const config = text(v.config);
  const run = text(v.run);
  const defaultName = text(v.defaultName);
  return {
    projectId: v.projectId,
    format: v.format as schema.ExportFormat,
    ...(config !== undefined ? { config } : {}),
    ...(run !== undefined ? { run } : {}),
    ...(defaultName !== undefined ? { defaultName } : {}),
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
  handle(c.exportFile, async (win, raw) => {
    const request = exportRequest(raw);
    if (headless) return { canceled: true };
    if (deps.exportFile === undefined) throw new Error("exportFile: the app server is not connected");
    const type = EXPORT_FILE_TYPES[request.format];
    // A bare name, so the dialog opens in Documents whatever the page sent.
    const name = basename(request.defaultName ?? `export.${type.extension}`);
    const options = { title: `Export ${type.label}`, defaultPath: name, filters: [{ name: type.label, extensions: [type.extension] }] };
    const r = await dialog.showSaveDialog(win, dialogOptions(options, documents));
    const path = r.canceled ? undefined : text(r.filePath);
    if (path === undefined) return { canceled: true };
    return { canceled: false, out: await deps.exportFile(request, path) };
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

/**
 * D10: Lecturn's live-tool call ends at 120 s and the server's guard at about
 * 115 s, so the dialog gives up first. A later accept would create a project
 * the agent was told failed.
 */
export const CONSENT_DEADLINE_MS = 100_000;

/** Button indexes: Cancel comes first, so it is the default on every platform. */
export const CONSENT_CANCEL_BUTTON = 0;
export const CONSENT_ACCEPT_BUTTON = 1;

export interface ConsentBoxOptions {
  type: "question";
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
  signal: AbortSignal;
}

export interface ConsentDialogLike<W> {
  /** `response` is optional because electron#55367 can resolve an aborted box without one. */
  showMessageBox(window: W, options: ConsentBoxOptions): Promise<{ response?: number }>;
}

export interface ConsentDeps<W extends WindowLike> {
  dialog: ConsentDialogLike<W>;
  /** Read per dialog: a box needs a parent, because `signal` does nothing on a parentless macOS box. */
  window: () => W | null;
  /** Raises the window, so the sheet is not hidden behind another app. */
  focus: () => void;
  /** A hidden run: nobody can answer, so every request is refused. */
  headless?: boolean;
}

export interface ConsentDialogs {
  /** Shows the request once its turn comes. `signal` closes the box as a Cancel. */
  ask(request: HostRequest, signal: AbortSignal): Promise<HostAnswer>;
  /** Closes every box as a Cancel and refuses every later request. */
  close(): void;
}

const REFUSED: HostAnswer = { accepted: false };

/** A control or bidi character could make the path on screen differ from the path acted on. `request` is cleaned by the server (D13). */
const MISLEADING = /[\p{Cc}\p{Bidi_Control}]/u;

function consentText(r: HostRequest): Pick<ConsentBoxOptions, "message" | "detail" | "buttons"> {
  const isNew = r.tool === "project_new";
  const facts = [...(r.name !== undefined ? [`Name: ${r.name}`] : []), `Folder: ${r.path}`, ...(r.template !== undefined ? [`Template: ${r.template}`] : [])];
  const work = r.request !== undefined && r.request !== "" ? `\n\nA new thread will then start on this request:\n\n${r.request}` : "";
  return {
    message: isNew ? "The agent wants to create a new project" : "The agent wants to open a project",
    detail: facts.join("\n") + work,
    buttons: ["Cancel", isNew ? "Create project" : "Open project"],
  };
}

/**
 * One box at a time, in arrival order. `HostChannel` refuses a second request
 * while one waits, but its caller's deadline can free that slot with a box
 * still up, so main keeps its own order.
 */
export function createConsentDialogs<W extends WindowLike>(deps: ConsentDeps<W>): ConsentDialogs {
  const { dialog, headless = false } = deps;
  const asking = new Set<AbortController>();
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();

  const show = (request: HostRequest, signal: AbortSignal): Promise<{ response?: number }> | null => {
    const win = deps.window();
    if (win === null || win.isDestroyed()) return null;
    deps.focus();
    return dialog.showMessageBox(win, {
      type: "question",
      title: "RocketWright",
      ...consentText(request),
      defaultId: CONSENT_CANCEL_BUTTON,
      cancelId: CONSENT_CANCEL_BUTTON,
      noLink: true,
      signal,
    });
  };

  return {
    ask: async (request, signal) => {
      if (headless || closed || signal.aborted || MISLEADING.test(request.path) || MISLEADING.test(request.name ?? "")) return REFUSED;
      const cancel = new AbortController();
      asking.add(cancel);
      const abort = (): void => cancel.abort();
      signal.addEventListener("abort", abort, { once: true });
      // From arrival, not from showing: the server's clock started when it sent this.
      const deadline = setTimeout(abort, CONSENT_DEADLINE_MS);
      const cancelled = new Promise<null>((resolve) => cancel.signal.addEventListener("abort", () => resolve(null), { once: true }));
      // A box already aborted is never opened (electron#55367), and the next waits until this one has really closed.
      const turn = tail.then(() => (cancel.signal.aborted ? null : show(request, cancel.signal)));
      tail = turn.catch(() => undefined);
      try {
        // The race answers on time even if a box ignores its signal.
        const result = await Promise.race([turn, cancelled]);
        return { accepted: result?.response === CONSENT_ACCEPT_BUTTON };
      } finally {
        clearTimeout(deadline);
        signal.removeEventListener("abort", abort);
        asking.delete(cancel);
      }
    },
    close: () => {
      closed = true;
      for (const cancel of asking) cancel.abort();
    },
  };
}
