import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_INVOKE_CHANNELS, type DesktopBoot, type HostRequest } from "@rw/contracts";
import { CONSENT_ACCEPT_BUTTON, CONSENT_CANCEL_BUTTON, CONSENT_DEADLINE_MS, createConsentDialogs, registerDesktopServices, type ConsentBoxOptions, type ConsentDialogLike, type DesktopServices, type DialogLike, type HandlerIpc } from "./nativeDialogs.ts";
import type { Recents } from "./recents.ts";

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown;

interface FakeWindow {
  webContents: object;
  isDestroyed(): boolean;
}

function setup(opts: { headless?: boolean; window?: FakeWindow | null; exportFile?: DesktopServices<FakeWindow>["exportFile"] } = {}) {
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
  const relaunch = vi.fn<() => void>();
  const setDirty = vi.fn<(dirty: boolean) => void>();
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
    relaunch,
    setDirty,
    ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
    ...(opts.exportFile !== undefined ? { exportFile: opts.exportFile } : {}),
  });
  const call = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`no handler: ${channel}`);
    return Promise.resolve().then(() => handler({ sender: win.webContents }, ...args));
  };
  const callAs = (sender: unknown, channel: string, ...args: unknown[]): Promise<unknown> => Promise.resolve().then(() => handlers.get(channel)!({ sender }, ...args));
  return { handlers, win, dialog, recents, boot, relaunch, setDirty, documentsCalls, setDocuments: (d: string) => (documents = d), call, callAs, dispose };
}

const c = DESKTOP_INVOKE_CHANNELS;
const OWNED = [c.boot, c.pickFolder, c.pickFile, c.saveAs, c.exportFile, c.recents, c.removeRecent, c.setActiveProject, c.setDirty, c.relaunch];

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

describe("setDirty", () => {
  it("tells main what the page says, and refuses anything but a boolean", async () => {
    const t = setup();
    await t.call(c.setDirty, true);
    await t.call(c.setDirty, false);
    expect(t.setDirty.mock.calls).toEqual([[true], [false]]);
    await expect(t.call(c.setDirty, "yes")).rejects.toThrow(/boolean/);
  });
});

describe("relaunch", () => {
  it("relaunches when the app window asks", async () => {
    const t = setup();
    await t.call(c.relaunch);
    expect(t.relaunch).toHaveBeenCalledOnce();
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

describe("export (D18)", () => {
  const OUT = { path: "/saved", bytes: 1, sha256: "x" };
  const writer = () => vi.fn<NonNullable<DesktopServices<FakeWindow>["exportFile"]>>(() => Promise.resolve(OUT));

  it("asks where with the format's filter, then writes only to the path the person chose", async () => {
    const exportFile = writer();
    const t = setup({ exportFile });
    const request = { projectId: "p", format: "glb", defaultName: "Rocket.glb", path: "/etc/page-supplied", allow_outside: true };
    await expect(t.call(c.exportFile, request)).resolves.toEqual({ canceled: false, out: OUT });
    expect(t.dialog.showSaveDialog).toHaveBeenCalledWith(t.win, { title: "Export 3D model", defaultPath: "/docs/Rocket.glb", filters: [{ name: "3D model", extensions: ["glb"] }] });
    expect(exportFile.mock.calls).toEqual([[{ projectId: "p", format: "glb", defaultName: "Rocket.glb" }, "/saved"]]);
  });

  it("keeps the dialog in Documents whatever folder the page names", async () => {
    const t = setup({ exportFile: writer() });
    await t.call(c.exportFile, { projectId: "p", format: "ork", defaultName: "../../etc/a.ork" });
    expect(vi.mocked(t.dialog.showSaveDialog).mock.calls[0]![1].defaultPath).toBe("/docs/a.ork");
  });

  it("passes the run a CSV needs", async () => {
    const exportFile = writer();
    const t = setup({ exportFile });
    await t.call(c.exportFile, { projectId: "p", format: "csv", run: "baseline/r1" });
    expect(exportFile.mock.calls[0]![0]).toEqual({ projectId: "p", format: "csv", run: "baseline/r1" });
  });

  it("writes nothing when the person cancels, or on a hidden run", async () => {
    const exportFile = writer();
    const t = setup({ exportFile });
    vi.mocked(t.dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true });
    await expect(t.call(c.exportFile, { projectId: "p", format: "stl" })).resolves.toEqual({ canceled: true });
    const hidden = setup({ exportFile, headless: true });
    await expect(hidden.call(c.exportFile, { projectId: "p", format: "stl" })).resolves.toEqual({ canceled: true });
    expect(hidden.dialog.showSaveDialog).not.toHaveBeenCalled();
    expect(exportFile).not.toHaveBeenCalled();
  });

  it("refuses a malformed request and a window that is not the app's, before any dialog", async () => {
    const t = setup({ exportFile: writer() });
    await expect(t.call(c.exportFile, { projectId: "p", format: "constructor" })).rejects.toThrow("exportFile");
    await expect(t.callAs({}, c.exportFile, { projectId: "p", format: "ork" })).rejects.toThrow("not the app window");
    expect(t.dialog.showSaveDialog).not.toHaveBeenCalled();
  });

  it("says so when there is no server to write through", async () => {
    await expect(setup().call(c.exportFile, { projectId: "p", format: "ork" })).rejects.toThrow("not connected");
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

describe("consent dialog", () => {
  const NEW: HostRequest = { requestId: "r1", tool: "project_new", path: "/docs/RocketWright/solstice", name: "solstice", template: "empty", request: "Add a nose cone" };
  const OPEN: HostRequest = { requestId: "r2", tool: "project_open", path: "/work/rocket" };

  interface Box {
    options: ConsentBoxOptions;
    answer(response: number): void;
  }

  /** Like Electron: an aborted box closes as if its Cancel was pressed, unless told to ignore the signal. */
  function consent(opts: { headless?: boolean; window?: FakeWindow | null; ignoreAbort?: boolean } = {}) {
    const win: FakeWindow = { webContents: {}, isDestroyed: () => false };
    const boxes: Box[] = [];
    const order: string[] = [];
    const showMessageBox = vi.fn<ConsentDialogLike<FakeWindow>["showMessageBox"]>(
      (_win, options) =>
        new Promise((resolve) => {
          order.push("box");
          boxes.push({ options, answer: (response) => resolve({ response }) });
          if (opts.ignoreAbort !== true) options.signal.addEventListener("abort", () => resolve({ response: options.cancelId }), { once: true });
        }),
    );
    const dialogs = createConsentDialogs<FakeWindow>({
      dialog: { showMessageBox },
      window: () => (opts.window === undefined ? win : opts.window),
      focus: () => void order.push("focus"),
      ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
    });
    const socket = new AbortController();
    const ask = (request: HostRequest, signal: AbortSignal = socket.signal) => dialogs.ask(request, signal);
    return { win, boxes, order, showMessageBox, dialogs, socket, ask };
  }

  /** Lets the promise chain reach the dialog (or the answer) under fake timers. */
  const settle = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  describe("what it shows", () => {
    it("names the action, name, folder, template and request, parented to the window", async () => {
      const t = consent();
      void t.ask(NEW);
      await settle();
      expect(t.showMessageBox).toHaveBeenCalledOnce();
      expect(t.showMessageBox.mock.calls[0]?.[0]).toBe(t.win);
      const o = t.boxes[0]!.options;
      expect(o.message).toBe("The agent wants to create a new project");
      expect(o.detail).toBe("Name: solstice\nFolder: /docs/RocketWright/solstice\nTemplate: empty\n\nA new thread will then start on this request:\n\nAdd a nose cone");
      expect(o.buttons[CONSENT_ACCEPT_BUTTON]).toBe("Create project");
    });

    it("words an open as an open, and leaves out what was not sent", async () => {
      const t = consent();
      void t.ask(OPEN);
      await settle();
      const o = t.boxes[0]!.options;
      expect(o.message).toBe("The agent wants to open a project");
      expect(o.detail).toBe("Folder: /work/rocket");
      expect(o.buttons[CONSENT_ACCEPT_BUTTON]).toBe("Open project");
    });

    it("shows the whole request, newlines and backticks included", async () => {
      const t = consent();
      const request = `${"x".repeat(1990)}\n\`\`\`\nend`;
      void t.ask({ ...NEW, request });
      await settle();
      expect(t.boxes[0]!.options.detail.endsWith(request)).toBe(true);
    });

    it("makes Cancel both the default and the escape answer", async () => {
      const t = consent();
      void t.ask(NEW);
      await settle();
      const o = t.boxes[0]!.options;
      expect(o.buttons[CONSENT_CANCEL_BUTTON]).toBe("Cancel");
      expect([o.defaultId, o.cancelId]).toEqual([CONSENT_CANCEL_BUTTON, CONSENT_CANCEL_BUTTON]);
    });

    it("raises the window before the box", async () => {
      const t = consent();
      void t.ask(NEW);
      await settle();
      expect(t.order).toEqual(["focus", "box"]);
    });

    it.each(["/work/a\u202eb", "/work/a\nb", "/work/a\u2066b"])("refuses a path that would not read as what it is: %j", async (path) => {
      const t = consent();
      await expect(t.ask({ ...OPEN, path })).resolves.toEqual({ accepted: false });
      expect(t.showMessageBox).not.toHaveBeenCalled();
    });

    it("refuses a name that would not read as what it is", async () => {
      const t = consent();
      await expect(t.ask({ ...NEW, name: "a\u202eb" })).resolves.toEqual({ accepted: false });
      expect(t.showMessageBox).not.toHaveBeenCalled();
    });
  });

  describe("the answer", () => {
    it("accepts on the accept button", async () => {
      const t = consent();
      const answer = t.ask(NEW);
      await settle();
      t.boxes[0]!.answer(CONSENT_ACCEPT_BUTTON);
      await expect(answer).resolves.toEqual({ accepted: true });
    });

    it.each([
      ["Cancel", { response: CONSENT_CANCEL_BUTTON }],
      ["a button that does not exist", { response: 7 }],
      ["no response at all (electron#55367)", {}],
    ])("refuses on %s", async (_name, result) => {
      const t = consent();
      t.showMessageBox.mockResolvedValueOnce(result);
      await expect(t.ask(NEW)).resolves.toEqual({ accepted: false });
    });

    it("lets a failing dialog reject, for the channel to answer as a refusal, and still shows the next", async () => {
      const t = consent();
      t.showMessageBox.mockRejectedValueOnce(new Error("no dialog"));
      await expect(t.ask(NEW)).rejects.toThrow("no dialog");
      const next = t.ask(OPEN);
      await settle();
      t.boxes[0]!.answer(CONSENT_ACCEPT_BUTTON);
      await expect(next).resolves.toEqual({ accepted: true });
    });

    it("leaves no timer behind once answered", async () => {
      const t = consent();
      const answer = t.ask(NEW);
      await settle();
      expect(vi.getTimerCount()).toBe(1);
      t.boxes[0]!.answer(CONSENT_CANCEL_BUTTON);
      await answer;
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("no one to ask", () => {
    it("refuses on a hidden run without a dialog", async () => {
      const t = consent({ headless: true });
      await expect(t.ask(NEW)).resolves.toEqual({ accepted: false });
      expect(t.showMessageBox).not.toHaveBeenCalled();
    });

    it("refuses before the window exists and after it is destroyed", async () => {
      for (const window of [null, { webContents: {}, isDestroyed: () => true }]) {
        const t = consent({ window });
        await expect(t.ask(NEW)).resolves.toEqual({ accepted: false });
        expect(t.showMessageBox).not.toHaveBeenCalled();
        expect(t.order).toEqual([]);
      }
    });
  });

  describe("one at a time", () => {
    it("holds the second box until the first closes, in arrival order", async () => {
      const t = consent();
      const first = t.ask(NEW);
      const second = t.ask(OPEN);
      await settle();
      expect(t.boxes).toHaveLength(1);
      expect(t.boxes[0]!.options.detail).toContain("solstice");
      t.boxes[0]!.answer(CONSENT_CANCEL_BUTTON);
      await expect(first).resolves.toEqual({ accepted: false });
      await settle();
      expect(t.boxes).toHaveLength(2);
      expect(t.boxes[1]!.options.detail).toBe("Folder: /work/rocket");
      t.boxes[1]!.answer(CONSENT_ACCEPT_BUTTON);
      await expect(second).resolves.toEqual({ accepted: true });
    });

    it("keeps the order when a waiting request drops out", async () => {
      const t = consent();
      const leaving = new AbortController();
      void t.ask(NEW);
      const dropped = t.ask({ ...OPEN, path: "/dropped" }, leaving.signal);
      const third = t.ask(OPEN);
      await settle();
      leaving.abort();
      await expect(dropped).resolves.toEqual({ accepted: false });
      await settle();
      expect(t.boxes).toHaveLength(1);
      t.boxes[0]!.answer(CONSENT_CANCEL_BUTTON);
      await settle();
      expect(t.boxes.map((b) => b.options.detail)).toEqual([expect.stringContaining("solstice"), "Folder: /work/rocket"]);
      t.boxes[1]!.answer(CONSENT_ACCEPT_BUTTON);
      await expect(third).resolves.toEqual({ accepted: true });
    });
  });

  describe("the deadline (D10)", () => {
    it("is under the server's guard and Lecturn's limit", () => {
      expect(CONSENT_DEADLINE_MS).toBeLessThan(115_000);
    });

    it("stays open until the deadline, then closes the box as a Cancel", async () => {
      const t = consent();
      const answer = t.ask(NEW);
      await settle();
      const { signal } = t.boxes[0]!.options;
      await vi.advanceTimersByTimeAsync(CONSENT_DEADLINE_MS - 1);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
      await expect(answer).resolves.toEqual({ accepted: false });
    });

    it("answers on time even if the box ignores its signal, and holds the next box", async () => {
      const t = consent({ ignoreAbort: true });
      const stuck = t.ask(NEW);
      const next = t.ask(OPEN);
      await settle();
      await vi.advanceTimersByTimeAsync(CONSENT_DEADLINE_MS);
      await expect(stuck).resolves.toEqual({ accepted: false });
      await expect(next).resolves.toEqual({ accepted: false });
      expect(t.boxes).toHaveLength(1);
    });

    it("refuses an accept that comes after the deadline", async () => {
      const t = consent({ ignoreAbort: true });
      const answer = t.ask(NEW);
      await settle();
      await vi.advanceTimersByTimeAsync(CONSENT_DEADLINE_MS);
      t.boxes[0]!.answer(CONSENT_ACCEPT_BUTTON);
      await expect(answer).resolves.toEqual({ accepted: false });
    });

    it("counts from arrival, not from when the box opens", async () => {
      const t = consent();
      const first = t.ask(NEW);
      await vi.advanceTimersByTimeAsync(CONSENT_DEADLINE_MS / 2);
      const second = t.ask(OPEN);
      await vi.advanceTimersByTimeAsync(CONSENT_DEADLINE_MS / 2);
      await expect(first).resolves.toEqual({ accepted: false });
      await settle();
      expect(t.boxes).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(CONSENT_DEADLINE_MS / 2);
      await expect(second).resolves.toEqual({ accepted: false });
    });

    it("skips a queued request whose deadline passed while it waited", async () => {
      const t = consent({ ignoreAbort: true });
      const first = t.ask(NEW);
      const second = t.ask(OPEN);
      await settle();
      await vi.advanceTimersByTimeAsync(CONSENT_DEADLINE_MS);
      await Promise.all([first, second]);
      t.boxes[0]!.answer(CONSENT_CANCEL_BUTTON);
      await settle();
      expect(t.showMessageBox).toHaveBeenCalledOnce();
    });
  });

  describe("abort", () => {
    it("closes the box when the socket's signal fires", async () => {
      const t = consent();
      const answer = t.ask(NEW);
      await settle();
      t.socket.abort();
      expect(t.boxes[0]!.options.signal.aborted).toBe(true);
      await expect(answer).resolves.toEqual({ accepted: false });
    });

    it("never opens a box for a signal already aborted", async () => {
      const t = consent();
      t.socket.abort();
      await expect(t.ask(NEW)).resolves.toEqual({ accepted: false });
      await settle();
      expect(t.showMessageBox).not.toHaveBeenCalled();
    });

    it("on shutdown closes the box and every waiting one, and refuses later requests", async () => {
      const t = consent();
      const open = t.ask(NEW);
      const waiting = t.ask(OPEN);
      await settle();
      t.dialogs.close();
      expect(t.boxes[0]!.options.signal.aborted).toBe(true);
      await expect(open).resolves.toEqual({ accepted: false });
      await expect(waiting).resolves.toEqual({ accepted: false });
      await expect(t.ask(OPEN)).resolves.toEqual({ accepted: false });
      await settle();
      expect(t.showMessageBox).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
