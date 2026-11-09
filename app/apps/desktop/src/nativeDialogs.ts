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
import { DESKTOP_INVOKE_CHANNELS, DIALOG_UNSAFE_NAME, DIALOG_UNSAFE_TEXT, EXPORT_FILE_TYPES, PROJECT_TOOL_REQUEST_MAX, PROJECT_TOOL_REQUEST_MAX_LINES, type DesktopBoot, type DesktopFlushResult, type DisplayUnits, type ExportFileRequest, type FileFilter, type HostDecline, type HostRequest, type schema } from "@rw/contracts";
import { basename, isAbsolute, join } from "node:path";
import type { HostAnswer } from "./mainRpc.ts";
import { prefsPatch, type Preferences } from "./preferences.ts";
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
  /** Starts a new instance of the app and ends this one (R3.3, D19). */
  relaunch: () => void;
  prefs: Pick<Preferences, "get" | "update">;
  /** Opens Lecturn's providers panel in the agent pane; throws without a mounted pane. */
  openProviders: () => void;
  /** The page says whether it holds typed work the model does not have (R3.7). */
  setDirty?: (dirty: boolean) => void;
  /** The page's answer to main's request to save (Save and quit). */
  flushDone?: (result: DesktopFlushResult) => void;
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

function flushResult(raw: unknown): DesktopFlushResult {
  const v = raw as Partial<DesktopFlushResult> | null;
  if (typeof v !== "object" || v === null || typeof v.id !== "number" || !Array.isArray(v.problems) || !v.problems.every((p) => typeof p === "string")) throw new TypeError("flushDone: expected { id, problems }");
  return { id: v.id, problems: v.problems };
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
  handle(c.setDirty, (_win, dirty) => {
    if (typeof dirty !== "boolean") throw new TypeError("setDirty: expected a boolean");
    deps.setDirty?.(dirty);
  });
  handle(c.flushDone, (_win, raw) => deps.flushDone?.(flushResult(raw)));
  handle(c.relaunch, () => deps.relaunch());
  handle(c.prefs, () => deps.prefs.get());
  handle(c.setPrefs, (_win, patch) => deps.prefs.update(prefsPatch(patch)));
  handle(c.openProviders, () => deps.openProviders());
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
  /** The default-units preference, read when a `project_new` is accepted (R3.4). */
  displayUnits?: () => DisplayUnits | null;
}

export interface ConsentDialogs {
  /** Shows the request once its turn comes. `signal` closes the box; the answer says why, when it is not an accept. */
  ask(request: HostRequest, signal: AbortSignal): Promise<HostAnswer>;
  /** Asks about a `rocketwright://open` link for a folder not already known here. */
  askOpenLink(path: string): Promise<HostAnswer>;
  /** Closes every box and refuses every later request. */
  close(): void;
}

const declining = (declined: HostDecline): HostAnswer => ({ accepted: false, declined });

/** Main checks again here: it is the one showing the box, whatever the server sent. */
function refusedText(r: HostRequest): boolean {
  if (DIALOG_UNSAFE_NAME.test(r.path) || DIALOG_UNSAFE_NAME.test(r.name ?? "")) return true;
  if (r.request === undefined) return false;
  return DIALOG_UNSAFE_TEXT.test(r.request) || Array.from(r.request).length > PROJECT_TOOL_REQUEST_MAX || r.request.split("\n").length > PROJECT_TOOL_REQUEST_MAX_LINES;
}

function linkText(path: string): Pick<ConsentBoxOptions, "message" | "detail" | "buttons"> {
  return {
    message: "A link wants to open a project",
    detail: `Folder: ${path}\n\nOpen it only if you started this and trust the folder.`,
    buttons: ["Cancel", "Open project"],
  };
}

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

  type Text = Pick<ConsentBoxOptions, "message" | "detail" | "buttons">;
  const show = (text: Text, signal: AbortSignal): Promise<{ response?: number }> | "no_window" => {
    const win = deps.window();
    if (win === null || win.isDestroyed()) return "no_window";
    deps.focus();
    return dialog.showMessageBox(win, {
      type: "question",
      title: "RocketWright",
      ...text,
      defaultId: CONSENT_CANCEL_BUTTON,
      cancelId: CONSENT_CANCEL_BUTTON,
      noLink: true,
      signal,
    });
  };

  const present = async (text: Text, signal: AbortSignal | null, onAccept: () => HostAnswer): Promise<HostAnswer> => {
    const cancel = new AbortController();
    asking.add(cancel);
    const abort = (): void => cancel.abort();
    signal?.addEventListener("abort", abort, { once: true });
    // From arrival, not from showing: the server's clock started when it sent this.
    const deadline = setTimeout(abort, CONSENT_DEADLINE_MS);
    const cancelled = new Promise<null>((resolve) => cancel.signal.addEventListener("abort", () => resolve(null), { once: true }));
    // A box already aborted is never opened (electron#55367), and the next waits until this one has really closed.
    const turn = tail.then(async (): Promise<{ response?: number } | "no_window" | null> => (cancel.signal.aborted ? null : await show(text, cancel.signal)));
    tail = turn.catch(() => undefined);
    try {
      // The race answers on time even if a box ignores its signal.
      const result = await Promise.race([turn, cancelled]);
      if (result === "no_window") return declining("unavailable");
      if (result?.response === CONSENT_ACCEPT_BUTTON) return onAccept();
      // Electron can answer an aborted box with no response or with Cancel; the abort is what happened.
      if (cancel.signal.aborted) return declining(closed ? "unavailable" : "timeout");
      return declining("cancelled");
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      asking.delete(cancel);
    }
  };

  return {
    ask: async (request, signal) => {
      if (headless || closed) return declining("unavailable");
      if (signal.aborted) return declining("timeout");
      if (refusedText(request)) return declining("refused");
      return present(consentText(request), signal, () => {
        const displayUnits = request.tool === "project_new" ? deps.displayUnits?.() : null;
        return displayUnits === null || displayUnits === undefined ? { accepted: true } : { accepted: true, displayUnits };
      });
    },
    askOpenLink: async (path) => {
      if (headless || closed) return declining("unavailable");
      if (DIALOG_UNSAFE_NAME.test(path)) return declining("refused");
      return present(linkText(path), null, () => ({ accepted: true }));
    },
    close: () => {
      closed = true;
      for (const cancel of asking) cancel.abort();
    },
  };
}
