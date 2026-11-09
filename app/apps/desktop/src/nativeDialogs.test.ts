import { describe, expect, it, vi } from "vitest";
import { DESKTOP_INVOKE_CHANNELS, type DesktopBoot } from "@rw/contracts";
import { registerDesktopServices, type DialogLike, type HandlerIpc } from "./nativeDialogs.ts";
import type { Recents } from "./recents.ts";

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown;

interface FakeWindow {
  webContents: object;
  isDestroyed(): boolean;
}

function setup(opts: { headless?: boolean; window?: FakeWindow | null } = {}) {
  const handlers = new Map<string, Handler>();
  const ipc: HandlerIpc = {
    handle: (channel, listener) => void handlers.set(channel, listener),
    removeHandler: (channel) => void handlers.delete(channel),
  };
  const win: FakeWindow = { webContents: {}, isDestroyed: () => false };
  const dialog: DialogLike<FakeWindow> = {
    showOpenDialog: vi.fn<DialogLike<FakeWindow>["showOpenDialog"]>(() => Promise.resolve({ canceled: false, filePaths: ["/picked"] })),
    showSaveDialog: vi.fn<DialogLike<FakeWindow>["showSaveDialog"]>(() => Promise.resolve({ canceled: false, filePath: "/saved" })),
  };
  const recents: Recents = {
    list: vi.fn<Recents["list"]>(() => Promise.resolve([{ dir: "/a", name: "A", lastOpened: "t", status: "ok" }])),
    see: vi.fn<Recents["see"]>(() => Promise.resolve()),
    remove: vi.fn<Recents["remove"]>(() => Promise.resolve()),
    pickLastActive: vi.fn<Recents["pickLastActive"]>(() => Promise.resolve(null)),
  };
  let documents = "/docs";
  const boot: { value: DesktopBoot } = { value: { activeProjectId: null, notice: null } };
  const documentsCalls = { count: 0 };
  const dispose = registerDesktopServices({
    ipc,
    dialog,
    window: () => (opts.window === undefined ? win : opts.window),
    documents: () => {
      documentsCalls.count += 1;
      return documents;
    },
    recents,
    boot: () => boot.value,
    ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
  });
  const call = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`no handler: ${channel}`);
    return Promise.resolve().then(() => handler({ sender: win.webContents }, ...args));
  };
  const callAs = (sender: unknown, channel: string, ...args: unknown[]): Promise<unknown> => Promise.resolve().then(() => handlers.get(channel)!({ sender }, ...args));
  return { handlers, win, dialog, recents, boot, documentsCalls, setDocuments: (d: string) => (documents = d), call, callAs, dispose };
}

const c = DESKTOP_INVOKE_CHANNELS;
const OWNED = [c.boot, c.pickFolder, c.pickFile, c.saveAs, c.recents, c.removeRecent, c.setActiveProject];

describe("sender check", () => {
  it("registers the services it owns and removes them", () => {
    const t = setup();
    expect([...t.handlers.keys()].sort()).toEqual([...OWNED].sort());
    t.dispose();
    expect(t.handlers.size).toBe(0);
  });

  it.each(OWNED)("refuses the agent pane's guest on %s", async (channel) => {
    const t = setup();
    await expect(t.callAs({ guest: true }, channel, null)).rejects.toThrow("not the app window");
    expect(t.dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(t.dialog.showSaveDialog).not.toHaveBeenCalled();
    expect(t.recents.list).not.toHaveBeenCalled();
    expect(t.recents.see).not.toHaveBeenCalled();
    expect(t.recents.remove).not.toHaveBeenCalled();
  });

  it("refuses every call before the window exists, and after it is destroyed", async () => {
    await expect(setup({ window: null }).callAs({}, c.boot)).rejects.toThrow("not the app window");
    const gone = setup({ window: { webContents: {}, isDestroyed: () => true } });
    await expect(gone.callAs(gone.win.webContents, c.boot)).rejects.toThrow("not the app window");
  });
});

describe("pickers", () => {
  it("opens the folder picker on Documents with folder creation, parented to the app window", async () => {
    const t = setup();
    await expect(t.call(c.pickFolder)).resolves.toBe("/picked");
    expect(t.dialog.showOpenDialog).toHaveBeenCalledWith(t.win, { defaultPath: "/docs", properties: ["openDirectory", "createDirectory"] });
  });

  it("reads Documents for each dialog, not at registration", async () => {
    const t = setup();
    expect(t.documentsCalls.count).toBe(0);
    await t.call(c.pickFolder);
    t.setDocuments("/elsewhere");
    await t.call(c.pickFolder);
    expect(vi.mocked(t.dialog.showOpenDialog).mock.calls.map((x) => x[1].defaultPath)).toEqual(["/docs", "/elsewhere"]);
  });

  it("uses a stub installed after registration", async () => {
    const t = setup();
    const stub = vi.fn<DialogLike<FakeWindow>["showOpenDialog"]>(() => Promise.resolve({ canceled: false, filePaths: ["/stubbed"] }));
    t.dialog.showOpenDialog = stub;
    await expect(t.call(c.pickFile)).resolves.toBe("/stubbed");
    expect(stub).toHaveBeenCalledOnce();
  });

  it("keeps the file picker to files and passes known options only", async () => {
    const t = setup();
    await t.call(c.pickFile, { title: "Import", defaultPath: "/work", filters: [{ name: "OpenRocket", extensions: ["ork", 3] }, "bad"], properties: ["multiSelections"], extra: 1 });
    expect(t.dialog.showOpenDialog).toHaveBeenCalledWith(t.win, { title: "Import", defaultPath: "/work", filters: [{ name: "OpenRocket", extensions: ["ork"] }], properties: ["openFile"] });
  });

  it("treats non-object options as none", async () => {
    const t = setup();
    await t.call(c.pickFile, "nonsense");
    expect(t.dialog.showOpenDialog).toHaveBeenCalledWith(t.win, { defaultPath: "/docs", properties: ["openFile"] });
  });

  it("returns null when cancelled or empty", async () => {
    const t = setup();
    vi.mocked(t.dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: ["/ignored"] });
    await expect(t.call(c.pickFolder)).resolves.toBeNull();
    vi.mocked(t.dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [] });
    await expect(t.call(c.pickFile)).resolves.toBeNull();
  });

  it("puts a bare save name in Documents, and keeps an absolute one", async () => {
    const t = setup();
    await expect(t.call(c.saveAs, { defaultPath: "rocket.ork" })).resolves.toBe("/saved");
    await t.call(c.saveAs, { defaultPath: "/work/rocket.ork" });
    expect(vi.mocked(t.dialog.showSaveDialog).mock.calls.map((x) => x[1].defaultPath)).toEqual(["/docs/rocket.ork", "/work/rocket.ork"]);
  });

  it("returns null when the save is cancelled or has no path", async () => {
    const t = setup();
    vi.mocked(t.dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath: "/ignored" });
    await expect(t.call(c.saveAs)).resolves.toBeNull();
    vi.mocked(t.dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: "" });
    await expect(t.call(c.saveAs)).resolves.toBeNull();
  });

  it("never shows a dialog on a hidden run", async () => {
    const t = setup({ headless: true });
    await expect(t.call(c.pickFolder)).resolves.toBeNull();
    await expect(t.call(c.pickFile)).resolves.toBeNull();
    await expect(t.call(c.saveAs)).resolves.toBeNull();
    expect(t.dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(t.dialog.showSaveDialog).not.toHaveBeenCalled();
  });
});

describe("recents and boot", () => {
  it("answers boot with the current state when the page asks", async () => {
    const t = setup();
    await expect(t.call(c.boot)).resolves.toEqual({ activeProjectId: null, notice: null });
    t.boot.value = { activeProjectId: "p1", notice: "Could not reopen" };
    await expect(t.call(c.boot)).resolves.toEqual({ activeProjectId: "p1", notice: "Could not reopen" });
  });

  it("lists and removes recents", async () => {
    const t = setup();
    await expect(t.call(c.recents)).resolves.toEqual([{ dir: "/a", name: "A", lastOpened: "t", status: "ok" }]);
    await t.call(c.removeRecent, "/a");
    expect(t.recents.remove).toHaveBeenCalledWith("/a");
    await expect(t.call(c.removeRecent, 7)).rejects.toThrow(TypeError);
  });

  it("records the active project and Welcome, refusing anything else", async () => {
    const t = setup();
    await t.call(c.setActiveProject, { projectId: "p1", dir: "/work/a", name: "A", extra: true });
    await t.call(c.setActiveProject, null);
    expect(vi.mocked(t.recents.see).mock.calls).toEqual([[{ dir: "/work/a", name: "A" }], [null]]);
    for (const bad of [undefined, "x", { dir: "relative", name: "A" }, { dir: "/a" }]) await expect(t.call(c.setActiveProject, bad)).rejects.toThrow(TypeError);
    expect(t.recents.see).toHaveBeenCalledTimes(2);
  });
});
