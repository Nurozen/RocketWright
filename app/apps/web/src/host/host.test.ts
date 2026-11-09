import type { DesktopBridge, DesktopCommand, ProjectInfo, RecentProject } from "@rw/contracts";
import { describe, expect, it, vi } from "vitest";
import { createBrowserHost, createPathPrompts } from "./browserHost.ts";
import { createElectronHost } from "./electronHost.ts";
import { hostFor, type PathPrompt, type PathPromptRequest } from "./HostApi.ts";

const PROJECT: ProjectInfo = { projectId: "p1", dir: "/work/rocket", name: "Rocket" };
const RECENT: RecentProject = { dir: "/work/rocket", name: "Rocket", lastOpened: "2026-01-01T00:00:00.000Z", status: "ok" };
const FILE = new Blob(["x"]) as File;

function fakeBridge(overrides: Partial<DesktopBridge> = {}) {
  const calls: [string, ...unknown[]][] = [];
  const listeners = new Set<(command: DesktopCommand) => void>();
  const record = <R>(name: string, result: R) => (...args: unknown[]) => {
    calls.push([name, ...args]);
    return Promise.resolve(result);
  };
  const flushListeners = new Set<(id: number) => void>();
const dirtyListeners = new Set<(id: number) => void>();
  const bridge: DesktopBridge = {
    boot: record("boot", { activeProjectId: "p1", notice: "n" }),
    pickFolder: record("pickFolder", "/picked/folder"),
    pickFile: record("pickFile", "/picked/file.ork"),
    saveCsv: record("saveCsv", { canceled: false as const, path: "/picked/results.csv" }),
    exportFile: record("exportFile", { canceled: true as const }),
    recents: record("recents", [RECENT]),
    removeRecent: record("removeRecent", undefined),
    setActiveProject: record("setActiveProject", undefined),
    setDirty: record("setDirty", undefined),
    flushDone: record("flushDone", undefined),
    dirtyAnswer: record("dirtyAnswer", undefined),
    onFlush: (listener) => {
      flushListeners.add(listener);
      return () => void flushListeners.delete(listener);
    },
    onDirtyCheck: (listener) => {
      dirtyListeners.add(listener);
      return () => void dirtyListeners.delete(listener);
    },
    prefs: record("prefs", { window: null, view: {}, lastTab: null, defaultDisplayUnits: null }),
    setPrefs: record("setPrefs", undefined),
    openProviders: record("openProviders", undefined),
    relaunch: record("relaunch", undefined),
    onCommand: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    pathForFile: () => "/dropped/rocket.ork",
    ...overrides,
  };
  return { bridge, calls, listeners, flushListeners, dirtyListeners };
}

describe("electron host", () => {
  it("forwards each call and its answer to the bridge", async () => {
    const { bridge, calls } = fakeBridge();
    const host = createElectronHost(bridge);
    const options = { title: "Pick", defaultPath: "/d" };
    expect(host.kind).toBe("desktop");
    expect(await host.boot()).toEqual({ activeProjectId: "p1", notice: "n" });
    expect(await host.pickFolder(options)).toBe("/picked/folder");
    expect(await host.pickFile(options)).toBe("/picked/file.ork");
    expect(await host.recents()).toEqual([RECENT]);
    await host.removeRecent("/gone");
    await host.setActiveProject(PROJECT);
    await host.setActiveProject(null);
    expect(calls).toEqual([
      ["boot"],
      ["pickFolder", options],
      ["pickFile", options],
      ["recents"],
      ["removeRecent", "/gone"],
      ["setActiveProject", PROJECT],
      ["setActiveProject", null],
    ]);
  });

  it("forwards a CSV save to the bridge and its answer back", async () => {
    const { bridge, calls } = fakeBridge();
    const request = { defaultName: "results.csv", text: "t\n" };
    expect(await createElectronHost(bridge).saveCsv(request)).toEqual({ canceled: false, path: "/picked/results.csv" });
    expect(calls).toEqual([["saveCsv", request]]);
  });

  it("passes a cancelled picker through as null", async () => {
    const { bridge } = fakeBridge({ pickFolder: () => Promise.resolve(null) });
    expect(await createElectronHost(bridge).pickFolder()).toBeNull();
  });

  it("delivers native menu commands until unsubscribed", () => {
    const { bridge, listeners } = fakeBridge();
    const seen: DesktopCommand[] = [];
    const off = createElectronHost(bridge).onCommand((c) => seen.push(c));
    for (const l of listeners) l({ id: "project.new" });
    expect(seen).toEqual([{ id: "project.new" }]);
    off();
    expect(listeners.size).toBe(0);
  });

  it("answers a request to save with what the flush reports", async () => {
    const { bridge, calls, flushListeners } = fakeBridge();
    const off = createElectronHost(bridge).onFlush(() => Promise.resolve(["Delay: needs a number"]));
    for (const l of flushListeners) l(7);
    await vi.waitFor(() => expect(calls).toEqual([["flushDone", { id: 7, problems: ["Delay: needs a number"] }]]));
    off();
    expect(flushListeners.size).toBe(0);
  });

  it("reports a flush that throws as a failure, never as saved", async () => {
    const { bridge, calls, flushListeners } = fakeBridge();
    createElectronHost(bridge).onFlush(() => Promise.reject(new Error("socket closed")));
    for (const l of flushListeners) l(8);
    await vi.waitFor(() => expect(calls).toEqual([["flushDone", { id: 8, problems: ["socket closed"] }]]));
  });

  it("answers a dirty check with what the page says right now", async () => {
    const { bridge, calls, dirtyListeners } = fakeBridge();
    let dirty = false;
    const off = createElectronHost(bridge).onDirtyCheck(() => dirty);
    for (const l of dirtyListeners) l(4);
    dirty = true;
    for (const l of dirtyListeners) l(5);
    await vi.waitFor(() => expect(calls).toEqual([["dirtyAnswer", { id: 4, dirty: false }], ["dirtyAnswer", { id: 5, dirty: true }]]));
    off();
    expect(dirtyListeners.size).toBe(0);
  });

  it("reports a dirty check that throws as dirty, so the person is asked", async () => {
    const { bridge, calls, dirtyListeners } = fakeBridge();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    createElectronHost(bridge).onDirtyCheck(() => {
      throw new Error("no store");
    });
    for (const l of dirtyListeners) l(6);
    await vi.waitFor(() => expect(calls).toEqual([["dirtyAnswer", { id: 6, dirty: true }]]));
    error.mockRestore();
  });

  it("reports a dropped file's path, and null for one not on disk", () => {
    expect(createElectronHost(fakeBridge().bridge).pathForFile(FILE)).toBe("/dropped/rocket.ork");
    expect(createElectronHost(fakeBridge({ pathForFile: () => "" }).bridge).pathForFile(FILE)).toBeNull();
  });
});

describe("preferences and Agent providers (R3.4)", () => {
  it("are main's on the desktop", async () => {
    const { bridge, calls } = fakeBridge();
    const host = createElectronHost(bridge);
    await expect(host.prefs()).resolves.toMatchObject({ lastTab: null });
    await host.setPrefs({ lastTab: "results" });
    const inPane = vi.fn<() => void>();
    await host.openProviders(inPane);
    expect(calls).toEqual([["prefs"], ["setPrefs", { lastTab: "results" }], ["openProviders"]]);
    expect(inPane).not.toHaveBeenCalled();
  });

  it("last only as long as the tab in a browser, and the page's bridge opens the panel", async () => {
    const host = createBrowserHost(vi.fn<PathPrompt>());
    await host.setPrefs({ defaultDisplayUnits: { length: "in" } });
    await expect(host.prefs()).resolves.toMatchObject({ defaultDisplayUnits: { length: "in" } });
    await expect(createBrowserHost(vi.fn<PathPrompt>()).prefs()).resolves.toMatchObject({ defaultDisplayUnits: null });
    const inPane = vi.fn<() => void>();
    await host.openProviders(inPane);
    expect(inPane).toHaveBeenCalledOnce();
  });
});

describe("relaunch", () => {
  it("goes to main on the desktop", async () => {
    const { bridge, calls } = fakeBridge();
    await createElectronHost(bridge).relaunch();
    expect(calls).toEqual([["relaunch"]]);
  });

  it("reloads the page in a browser", async () => {
    const reload = vi.fn<() => void>();
    vi.stubGlobal("window", { location: { reload } });
    try {
      await createBrowserHost(vi.fn<PathPrompt>()).relaunch();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe("browser host", () => {
  it("has no recents, no reopen and no dropped paths", async () => {
    const prompt = vi.fn<PathPrompt>();
    const host = createBrowserHost(prompt);
    expect(host.kind).toBe("browser");
    expect(await host.boot()).toEqual({ activeProjectId: null, notice: null });
    expect(await host.recents()).toEqual([]);
    await expect(host.removeRecent("/x")).resolves.toBeUndefined();
    await expect(host.setActiveProject(PROJECT)).resolves.toBeUndefined();
    expect(host.pathForFile(FILE)).toBeNull();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("never delivers a command, and unsubscribing is safe", () => {
    const listener = vi.fn<(command: DesktopCommand) => void>();
    createBrowserHost(vi.fn<PathPrompt>()).onCommand(listener)();
    expect(listener).not.toHaveBeenCalled();
  });

  it("asks for each path with a typed prompt", async () => {
    const asked: PathPromptRequest[] = [];
    const host = createBrowserHost((r) => {
      asked.push(r);
      return Promise.resolve(`/typed/${r.kind}`);
    });
    expect(await host.pickFolder()).toBe("/typed/folder");
    expect(await host.pickFile({ title: "Import", filters: [{ name: "OpenRocket", extensions: ["ork"] }] })).toBe("/typed/file");
    expect(asked).toEqual([
      { kind: "folder", title: "Choose a folder" },
      { kind: "file", title: "Import", filters: [{ name: "OpenRocket", extensions: ["ork"] }] },
    ]);
  });
});

describe("browser CSV save", () => {
  it("downloads under the default name and reports no path", async () => {
    const blobs: Blob[] = [];
    vi.stubGlobal("URL", { createObjectURL: (b: Blob) => (blobs.push(b), "blob:x"), revokeObjectURL: () => undefined });
    const links: { download: string; clicked: boolean }[] = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const a = { href: "", download: "", style: { display: "" }, clicked: false, click() { a.clicked = true; links.push(a); }, remove() {} };
        return a;
      },
      body: { append: () => undefined },
    });
    try {
      const result = await createBrowserHost(() => Promise.resolve(null)).saveCsv({ defaultName: "results-a.csv", text: "t\n1\n" });
      expect(result).toEqual({ canceled: false, path: null });
      expect(links.map((l) => l.download)).toEqual(["results-a.csv"]);
      await expect(blobs[0]!.text()).resolves.toBe("t\n1\n");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("export", () => {
  const OUT = { path: "exports/a.ork", bytes: 1, sha256: "x" };
  const request = { projectId: "p1", format: "ork" as const, defaultName: "a.ork" };

  it("leaves the desktop's export to main and its save dialog", async () => {
    const { bridge, calls } = fakeBridge({ exportFile: () => Promise.resolve({ canceled: false, out: OUT }) });
    const write = vi.fn<(path: string) => Promise<typeof OUT>>();
    const seen = vi.spyOn(bridge, "exportFile");
    expect(await createElectronHost(bridge).exportFile(request, write)).toEqual({ canceled: false, out: OUT });
    expect(seen).toHaveBeenCalledWith(request);
    expect(write).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("in a browser, asks for a path in the project and writes through the page's own socket", async () => {
    const asked: PathPromptRequest[] = [];
    const host = createBrowserHost((r) => {
      asked.push(r);
      return Promise.resolve("exports/typed.ork");
    });
    const write = vi.fn<(path: string) => Promise<typeof OUT>>(() => Promise.resolve(OUT));
    expect(await host.exportFile(request, write)).toEqual({ canceled: false, out: OUT });
    expect(write.mock.calls).toEqual([["exports/typed.ork"]]);
    expect(asked[0]).toMatchObject({ kind: "save", title: "Export", defaultPath: "exports/a.ork" });
    expect(asked[0]?.hint).toContain("inside the project");
  });

  it("writes nothing when a browser's prompt is cancelled", async () => {
    const write = vi.fn<(path: string) => Promise<typeof OUT>>();
    expect(await createBrowserHost(() => Promise.resolve(null)).exportFile(request, write)).toEqual({ canceled: true });
    expect(write).not.toHaveBeenCalled();
  });
});

describe("path prompts", () => {
  const REQ: PathPromptRequest = { kind: "folder", title: "Open" };

  it("shows the question until it is answered, then resolves with the trimmed path", async () => {
    const p = createPathPrompts();
    const notified = vi.fn<() => void>();
    p.subscribe(notified);
    expect(p.current()).toBeNull();
    const answer = p.prompt(REQ);
    expect(p.current()).toBe(REQ);
    expect(notified).toHaveBeenCalledTimes(1);
    p.submit("  /work/rocket ");
    await expect(answer).resolves.toBe("/work/rocket");
    expect(p.current()).toBeNull();
    expect(notified).toHaveBeenCalledTimes(2);
  });

  it("treats cancel and a blank path alike", async () => {
    const p = createPathPrompts();
    const cancelled = p.prompt(REQ);
    p.cancel();
    await expect(cancelled).resolves.toBeNull();
    const blank = p.prompt(REQ);
    p.submit("   ");
    await expect(blank).resolves.toBeNull();
  });

  it("cancels the question showing when a newer one arrives", async () => {
    const p = createPathPrompts();
    const first = p.prompt(REQ);
    const next: PathPromptRequest = { kind: "file", title: "Import" };
    const second = p.prompt(next);
    await expect(first).resolves.toBeNull();
    expect(p.current()).toBe(next);
    p.submit("/a.ork");
    await expect(second).resolves.toBe("/a.ork");
  });

  it("ignores an answer with nothing showing, and stops notifying after unsubscribe", () => {
    const p = createPathPrompts();
    const notified = vi.fn<() => void>();
    const off = p.subscribe(notified);
    p.submit("/x");
    p.cancel();
    expect(notified).not.toHaveBeenCalled();
    off();
    void p.prompt(REQ);
    expect(notified).not.toHaveBeenCalled();
  });
});

describe("hostFor", () => {
  it("picks the desktop host only when the preload ran", () => {
    const prompt = vi.fn<PathPrompt>();
    expect(hostFor({}, prompt).kind).toBe("browser");
    expect(hostFor({ rwDesktop: fakeBridge().bridge }, prompt).kind).toBe("desktop");
  });
});
