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
  const bridge: DesktopBridge = {
    boot: record("boot", { activeProjectId: "p1", notice: "n" }),
    pickFolder: record("pickFolder", "/picked/folder"),
    pickFile: record("pickFile", "/picked/file.ork"),
    saveAs: record("saveAs", "/picked/out.ork"),
    exportFile: record("exportFile", { canceled: true as const }),
    recents: record("recents", [RECENT]),
    removeRecent: record("removeRecent", undefined),
    setActiveProject: record("setActiveProject", undefined),
    setDirty: record("setDirty", undefined),
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
  return { bridge, calls, listeners };
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
    expect(await host.saveAs(options)).toBe("/picked/out.ork");
    expect(await host.recents()).toEqual([RECENT]);
    await host.removeRecent("/gone");
    await host.setActiveProject(PROJECT);
    await host.setActiveProject(null);
    expect(calls).toEqual([
      ["boot"],
      ["pickFolder", options],
      ["pickFile", options],
      ["saveAs", options],
      ["recents"],
      ["removeRecent", "/gone"],
      ["setActiveProject", PROJECT],
      ["setActiveProject", null],
    ]);
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

  it("reports a dropped file's path, and null for one not on disk", () => {
    expect(createElectronHost(fakeBridge().bridge).pathForFile(FILE)).toBe("/dropped/rocket.ork");
    expect(createElectronHost(fakeBridge({ pathForFile: () => "" }).bridge).pathForFile(FILE)).toBeNull();
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
    expect(await host.saveAs({ defaultPath: "out.csv" })).toBe("/typed/save");
    expect(asked).toEqual([
      { kind: "folder", title: "Choose a folder" },
      { kind: "file", title: "Import", filters: [{ name: "OpenRocket", extensions: ["ork"] }] },
      { kind: "save", title: "Save as", defaultPath: "out.csv" },
    ]);
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
