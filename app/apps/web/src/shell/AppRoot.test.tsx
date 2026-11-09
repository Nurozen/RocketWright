// @vitest-environment jsdom
/**
 * AppRoot and ProjectSurface together, on a fake connection: which project
 * is on screen, what a switch resets, and that the broker follows the window.
 * The shell itself is a stub; its own tests cover what it draws.
 */
import type { BrokerRequest, BrokerResponse, DesktopCommand, DesktopPrefs, DisplayUnits, ProjectInfo, RpcTopics } from "@rw/contracts";
import { MockRpc } from "@rw/contracts/mock";
import { act, isValidElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostApi } from "../host/HostApi.ts";
import type { CfdStore } from "../pages/propsim/cfd.tsx";
import type { RunDataSource } from "../pages/results/source.ts";
import type { RpcLike } from "../state/rpc.ts";
import type { AppStore } from "../state/store.ts";
import { registerDirtyField, resetDirtyFields, trackWrite } from "../state/dirtyFields.ts";
import { AppRoot, type AppRootProps } from "./AppRoot.tsx";
import { RECONNECT_DELAYS_MS } from "./connection.ts";
import type { ConnectedShellProps } from "./ConnectedShell.tsx";

const shells = vi.hoisted(() => {
  // uPlot reads this at import; jsdom has none.
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
  return { mounted: [] as unknown[] };
});

vi.mock("./ConnectedShell.tsx", () => ({
  ConnectedShell: (props: unknown) => {
    shells.mounted.push(props);
    return null;
  },
}));
vi.mock("../render/ThumbnailBaker.tsx", () => ({ ThumbnailBaker: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const info = (projectId: string): ProjectInfo => ({ projectId, dir: `/p/${projectId}`, name: `Project ${projectId}` });

function fakeClient(open: string[], fail: Record<string, string> = {}) {
  const listeners = new Map<string, Set<(payload: never) => void>>();
  const close = new Set<(reason: string) => void>();
  const calls: { method: string; params: unknown }[] = [];
  const responses: BrokerResponse[] = [];
  const projects = [...open];
  const call = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    calls.push({ method, params });
    if (method === "project.list") return Promise.resolve({ projects: projects.map(info) });
    if (method === "project.defaults") return Promise.resolve({ location: "/docs" });
    if (method === "project.create") return Promise.resolve({ project: info(params["name"] as string) });
    if (method === "project.subscribe") {
      const projectId = params["projectId"] as string;
      if (fail[projectId] !== undefined) return Promise.reject(new Error(fail[projectId]));
      const snapshot = new MockRpc().snapshot();
      snapshot.project = info(projectId);
      return Promise.resolve({ subscriptionId: `sub-${projectId}`, snapshot });
    }
    if (method === "broker.respond") responses.push(params as unknown as BrokerResponse);
    return Promise.resolve({});
  };
  const client = {
    hello: { kind: "hello", coreVersion: "0.0.0-mock" },
    call,
    on: (topic: string, fn: (payload: never) => void) => {
      let set = listeners.get(topic);
      if (set === undefined) listeners.set(topic, (set = new Set()));
      set.add(fn);
      return () => void set.delete(fn);
    },
    onClose: (fn: (reason: string) => void) => {
      close.add(fn);
      return () => void close.delete(fn);
    },
    close: vi.fn<() => void>(),
  } as unknown as RpcLike;
  const push = <T extends keyof RpcTopics>(topic: T, payload: RpcTopics[T]) => {
    for (const fn of [...(listeners.get(topic) ?? [])]) (fn as (p: RpcTopics[T]) => void)(payload);
  };
  return { client, calls, responses, projects, push, lose: (reason: string) => [...close].forEach((fn) => fn(reason)) };
}

function fakeHost(over: Partial<HostApi> = {}) {
  const commands: ((c: DesktopCommand) => void)[] = [];
  const active: (ProjectInfo | null)[] = [];
  const host: HostApi = {
    kind: "desktop",
    boot: () => Promise.resolve({ activeProjectId: null, notice: null }),
    pickFolder: () => Promise.resolve(null),
    pickFile: () => Promise.resolve(null),
    saveAs: () => Promise.resolve(null),
    exportFile: () => Promise.resolve({ canceled: true }),
    recents: () => Promise.resolve([]),
    removeRecent: () => Promise.resolve(),
    setDirty: () => Promise.resolve(),
    onFlush: () => () => undefined,
    setActiveProject: (p) => {
      active.push(p);
      return Promise.resolve();
    },
    onCommand: (l) => {
      commands.push(l);
      return () => void commands.splice(commands.indexOf(l), 1);
    },
    pathForFile: () => null,
    relaunch: vi.fn<HostApi["relaunch"]>(() => Promise.resolve()),
    prefs: () => Promise.resolve({ window: null, view: {}, lastTab: null, defaultDisplayUnits: null }),
    setPrefs: () => Promise.resolve(),
    openProviders: () => Promise.resolve(),
    ...over,
  };
  return { host, active, send: (c: DesktopCommand) => commands.forEach((l) => l(c)) };
}

const NO_RUNS: RunDataSource = { load: () => Promise.reject(new Error("no runs in this test")) };

let root: Root | null = null;
let el: HTMLElement;

const shown = () => shells.mounted.at(-1) as ConnectedShellProps | undefined;
const storeOf = (s: ConnectedShellProps | undefined): AppStore => s!.store;
const buttonNamed = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name);
const settled = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

async function mount(t: ReturnType<typeof fakeClient>, h: ReturnType<typeof fakeHost>, over: Partial<AppRootProps> = {}) {
  root = createRoot(el);
  await act(async () => {
    root!.render(<AppRoot url="ws://test" requestedProjectId={null} initialPage="assembly" runSource={NO_RUNS} httpBase="" connect={() => Promise.resolve(t.client)} host={h.host} {...over} />);
  });
  await settled();
  await settled();
}

const elementProp = (node: ReactNode, prop: string): unknown => (isValidElement(node) ? (node as ReactElement<Record<string, unknown>>).props[prop] : undefined);

beforeEach(() => {
  shells.mounted.length = 0;
  el = document.createElement("div");
  document.body.append(el);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  el.remove();
  resetDirtyFields();
  document.title = "";
  vi.restoreAllMocks();
});

describe("what the window shows at launch", () => {
  it("connects and shows the first open project, and tells main it is active", async () => {
    const t = fakeClient(["a", "b"]);
    const h = fakeHost();
    await mount(t, h);
    expect(storeOf(shown()).getState().project.projectId).toBe("a");
    expect(h.active).toEqual([info("a")]);
  });

  it("shows the project main reopened, and ?project= over that", async () => {
    const h = fakeHost({ boot: () => Promise.resolve({ activeProjectId: "b", notice: null }) });
    await mount(fakeClient(["a", "b"]), h);
    expect(storeOf(shown()).getState().project.projectId).toBe("b");
    await act(async () => root?.unmount());
    await mount(fakeClient(["a", "b"]), h, { requestedProjectId: "a" });
    expect(storeOf(shown()).getState().project.projectId).toBe("a");
  });

  it("shows Welcome with no project and never mounts a surface", async () => {
    const h = fakeHost({ boot: () => Promise.resolve({ activeProjectId: null, notice: "That project has moved." }) });
    await mount(fakeClient([]), h);
    expect(shown()).toBeUndefined();
    expect(el.querySelector('[data-testid="welcome"]')?.textContent).toContain("That project has moved.");
    expect(h.active).toEqual([null]);
  });

  it("in a browser, asks for paths in a typed prompt at the window's root", async () => {
    const t = fakeClient([]);
    await mount(t, fakeHost(), { host: undefined });
    const open = [...el.querySelectorAll("button")].find((b) => b.textContent === "Open folder…")!;
    await act(async () => open.click());
    await settled();
    const prompt = document.querySelector<HTMLElement>('[data-testid="path-prompt"]');
    expect(prompt?.textContent).toContain("Open folder");
    const cancel = [...prompt!.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
    await act(async () => cancel.click());
    await settled();
    expect(document.querySelector('[data-testid="path-prompt"]')).toBeNull();
    expect(el.querySelector('[data-testid="welcome"]')).not.toBeNull();
  });

  it("reports the window as ready", async () => {
    const onOutcome = vi.fn<NonNullable<AppRootProps["onOutcome"]>>();
    await mount(fakeClient([]), fakeHost(), { onOutcome });
    expect(onOutcome).toHaveBeenCalledWith({ status: "ready" });
  });

  it("shows a startup failure in the window and reports it", async () => {
    const onOutcome = vi.fn<NonNullable<AppRootProps["onOutcome"]>>();
    await mount(fakeClient([]), fakeHost(), { onOutcome, connect: () => Promise.reject(new Error("no hello from ws://test")) });
    expect(el.querySelector('[data-testid="fatal"]')?.textContent).toContain("no hello from ws://test");
    expect(onOutcome).toHaveBeenCalledWith({ status: "error", error: "no hello from ws://test" });
  });

  it("falls back to Welcome, saying why, when the project will not open", async () => {
    await mount(fakeClient(["a"], { a: "not_found: no such project" }), fakeHost());
    expect(el.querySelector('[data-testid="welcome"]')?.textContent).toContain("not_found: no such project");
  });

  it("offers Relaunch when startup fails, and it asks the host", async () => {
    const h = fakeHost();
    await mount(fakeClient([]), h, { connect: () => Promise.reject(new Error("no hello")) });
    await act(async () => buttonNamed("Relaunch")!.click());
    expect(h.host.relaunch).toHaveBeenCalledOnce();
  });
});

describe("losing the connection", () => {
  const banner = (id: string) => document.querySelector(`[data-testid="${id}"]`);
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  afterEach(() => vi.useRealTimers());

  async function lost(reason = "socket closed") {
    const first = fakeClient(["a"]);
    const again = fakeClient(["a"]);
    const next = vi.fn<NonNullable<AppRootProps["connect"]>>(() => Promise.resolve(again.client));
    let isFirst = true;
    const h = fakeHost();
    await mount(first, h, { connect: (url) => (isFirst ? ((isFirst = false), Promise.resolve(first.client)) : next(url)) });
    vi.useFakeTimers();
    await act(async () => first.lose(reason));
    return { first, again, next, h };
  }

  it("says so, reconnects with backoff, and resubscribes the same project on the new socket", async () => {
    const { again, next } = await lost();
    expect(banner("connection.reconnecting")?.textContent).toContain("Reconnecting");
    expect(next).not.toHaveBeenCalled();
    await advance(RECONNECT_DELAYS_MS[0]!);
    expect(next).toHaveBeenCalledOnce();
    expect(banner("connection.reconnecting")).toBeNull();
    expect(again.calls.map((c) => c.method)).toContain("project.subscribe");
  });

  it("keeps the project on screen and its draft through a reconnect", async () => {
    const { first } = await lost();
    const store = storeOf(shown());
    const snapshot = store.getState().project.snapshot;
    expect(snapshot).not.toBeNull();
    store.setState((s) => ({ draft: { ...s.draft, ops: [{ op: "replace", path: "/c/a", value: "1" }] } }));
    await advance(RECONNECT_DELAYS_MS[0]!);
    expect(storeOf(shown())).toBe(store);
    expect(store.getState().project.snapshot).toBe(snapshot);
    expect(store.getState().draft.ops).toEqual([{ op: "replace", path: "/c/a", value: "1" }]);
    expect(store.getState().project.connection).toBe("open");
    expect(first.calls.filter((c) => c.method === "project.subscribe")).toHaveLength(1);
  });

  it("shows Relaunch once every retry has failed, and it asks the host", async () => {
    const { next, h } = await lost();
    next.mockImplementation(() => Promise.reject(new Error("refused")));
    for (const delay of RECONNECT_DELAYS_MS) {
      expect(banner("connection.lost")).toBeNull();
      await advance(delay);
    }
    expect(next).toHaveBeenCalledTimes(RECONNECT_DELAYS_MS.length);
    expect(banner("connection.lost")?.textContent).toContain("The app server has stopped");
    expect(banner("connection.reconnecting")).toBeNull();
    await act(async () => buttonNamed("Relaunch")!.click());
    expect(h.host.relaunch).toHaveBeenCalledOnce();
  });

  it("offers Reload rather than Relaunch in a browser", async () => {
    const t = fakeClient(["a"]);
    await mount(t, fakeHost({ kind: "browser" }), { connect: () => (t.calls.length === 0 ? Promise.resolve(t.client) : Promise.reject(new Error("refused"))) });
    vi.useFakeTimers();
    await act(async () => t.lose("socket closed"));
    for (const delay of RECONNECT_DELAYS_MS) await advance(delay);
    expect(buttonNamed("Reload")).toBeDefined();
    expect(buttonNamed("Relaunch")).toBeUndefined();
  });

  it("keeps Welcome through a dropped socket instead of ending the window", async () => {
    const t = fakeClient([]);
    await mount(t, fakeHost());
    vi.useFakeTimers();
    await act(async () => t.lose("socket closed"));
    expect(el.querySelector('[data-testid="welcome"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="fatal"]')).toBeNull();
    expect(banner("connection.reconnecting")).not.toBeNull();
  });
});

describe("a stopped engine", () => {
  it("offers Restart on a failed sidecar and calls project.restartSidecar", async () => {
    const t = fakeClient(["a"]);
    await mount(t, fakeHost());
    const store = storeOf(shown());
    expect(document.querySelector('[data-testid="sidecar.failed"]')).toBeNull();
    await act(async () => store.setState((s) => ({ project: { ...s.project, snapshot: { ...s.project.snapshot!, sidecar: { state: "failed", version: null } } } })));
    await act(async () => buttonNamed("Restart engine")!.click());
    expect(t.calls.filter((c) => c.method === "project.restartSidecar")).toEqual([{ method: "project.restartSidecar", params: { projectId: "a" } }]);
  });
});

describe("switching projects", () => {
  async function switched() {
    const t = fakeClient(["a", "b"]);
    const h = fakeHost();
    await mount(t, h);
    const before = shown()!;
    await act(async () => before.onSwitchProject!("b"));
    await settled();
    await settled();
    return { t, h, before, after: shown()! };
  }

  it("remounts on a new store, and leaves the old one disconnected", async () => {
    const { before, after } = await switched();
    expect(storeOf(after)).not.toBe(storeOf(before));
    expect(storeOf(after).getState().project.projectId).toBe("b");
    expect(storeOf(before).getState().project.projectId).toBeNull();
  });

  it("gives every page fresh per-project UI, and the Results page a store it has not seeded", async () => {
    const { before, after } = await switched();
    expect(elementProp(before.renderPage!("configurations"), "ui")).toBeDefined();
    expect(elementProp(after.renderPage!("configurations"), "ui")).not.toBe(elementProp(before.renderPage!("configurations"), "ui"));
    const cfd = (shell: ConnectedShellProps) => elementProp(shell.renderPage!("propulsion-sim"), "cfdUi") as CfdStore;
    expect(cfd(after)).not.toBe(cfd(before));
    expect(cfd(after).getState().datasets).toBeNull();
    expect(elementProp(after.renderPage!("results"), "app")).toBe(storeOf(after));
    expect(elementProp(before.renderPage!("results"), "app")).toBe(storeOf(before));
  });

  it("keeps the page the person was on", async () => {
    const t = fakeClient(["a", "b"]);
    await mount(t, fakeHost());
    const before = shown()!;
    await act(async () => storeOf(before).getState().ui.navigate("results"));
    await act(async () => before.onSwitchProject!("b"));
    await settled();
    expect(storeOf(shown()).getState().ui.page).toBe("results");
  });

  it("the broker answers for the new project and refuses the old one", async () => {
    const { t, after } = await switched();
    const request = (projectId: string): BrokerRequest => ({ requestId: `r-${projectId}`, projectId, threadId: null, op: "viewport_select", args: { refs: ["rw:c/nose"] } }) as BrokerRequest;
    await act(async () => {
      t.push("broker.request", request("b"));
      t.push("broker.request", request("a"));
    });
    await settled();
    expect(t.calls.filter((c) => c.method === "broker.hostRegister").map((c) => (c.params as { projectId: string }).projectId)).toEqual(["a", "b"]);
    expect(t.responses).toContainEqual({ requestId: "r-b", ok: true, result: { selected: ["rw:c/nose"] } });
    expect(t.responses).toContainEqual(expect.objectContaining({ requestId: "r-a", ok: false, error: expect.objectContaining({ code: "no_host" }) as unknown }));
    expect(t.responses.filter((r) => r.requestId === "r-b")).toHaveLength(1);
    expect(storeOf(after).getState().selection.refs).toEqual(["rw:c/nose"]);
  });

  it("keeps the socket across a switch", async () => {
    const { t } = await switched();
    expect(t.client.close).not.toHaveBeenCalled();
  });

  it("tells main each project in turn", async () => {
    const { h } = await switched();
    expect(h.active).toEqual([info("a"), info("b")]);
  });
});

describe("closing and commands", () => {
  it("moves to the next open project when the shown one closes", async () => {
    const t = fakeClient(["a", "b"]);
    await mount(t, fakeHost());
    t.projects.splice(0, 1);
    await act(async () => t.push("project.closed", { projectId: "a" }));
    await settled();
    await settled();
    expect(storeOf(shown()).getState().project.projectId).toBe("b");
  });

  it("goes to Welcome when the last project closes", async () => {
    const t = fakeClient(["a"]);
    const h = fakeHost();
    await mount(t, h);
    t.projects.splice(0, 1);
    await act(async () => t.push("project.closed", { projectId: "a" }));
    await settled();
    expect(el.querySelector('[data-testid="welcome"]')).not.toBeNull();
    expect(h.active.at(-1)).toBeNull();
  });

  it("ignores another project closing", async () => {
    const t = fakeClient(["a", "b"]);
    await mount(t, fakeHost());
    const before = shown();
    await act(async () => t.push("project.closed", { projectId: "b" }));
    await settled();
    expect(storeOf(shown()).getState().project.projectId).toBe("a");
    expect(shown()!.store).toBe(before!.store);
  });

  it("in a browser, Cmd-O asks for a folder and Cmd-N stays the browser's", async () => {
    const t = fakeClient([]);
    await mount(t, fakeHost({ kind: "browser" }), { host: undefined });
    const press = (key: string) => {
      const e = new KeyboardEvent("keydown", { key, metaKey: true, cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(press("n")).toBe(false);
    await settled();
    expect(document.querySelector('[data-testid="path-prompt"]')).toBeNull();
    await act(async () => void press("o"));
    await settled();
    expect(document.querySelector('[data-testid="path-prompt"]')?.textContent).toContain("Open folder");
  });

  it("on the desktop, the page leaves those keys to the native menu", async () => {
    const t = fakeClient([]);
    const pickFolder = vi.fn<HostApi["pickFolder"]>(() => Promise.resolve(null));
    await mount(t, fakeHost({ pickFolder }));
    const e = new KeyboardEvent("keydown", { key: "o", metaKey: true, cancelable: true });
    await act(async () => void window.dispatchEvent(e));
    await settled();
    expect(e.defaultPrevented).toBe(false);
    expect(pickFolder).not.toHaveBeenCalled();
  });

  it("tells main while typed work is unsaved, and that it is safe once the project is left", async () => {
    const t = fakeClient(["a"]);
    const setDirty = vi.fn<HostApi["setDirty"]>(() => Promise.resolve());
    await mount(t, fakeHost({ setDirty }));
    let dirty = true;
    const off = registerDirtyField({ dirty: () => dirty, commit: () => null });
    await settled();
    expect(setDirty.mock.calls).toEqual([[true]]);
    dirty = false;
    off();
    await settled();
    expect(setDirty.mock.calls).toEqual([[true], [false]]);
    dirty = true;
    registerDirtyField({ dirty: () => dirty, commit: () => null });
    await settled();
    await act(async () => root?.unmount());
    root = null;
    expect(setDirty.mock.lastCall).toEqual([false]);
  });

  it("Save and quit runs the same flush as Close, reports what failed, and stops listening with the window", async () => {
    const t = fakeClient(["a"]);
    let flush: (() => Promise<string[]>) | undefined;
    const off = vi.fn<() => void>();
    await mount(
      t,
      fakeHost({
        onFlush: (f) => {
          flush = f;
          return off;
        },
      }),
    );
    let dirty = true;
    const commit = vi.fn<() => string | null>(() => "Delay: needs a number");
    registerDirtyField({ dirty: () => dirty, commit });
    await expect(flush!()).resolves.toEqual(["Delay: needs a number"]);
    expect(commit).toHaveBeenCalledOnce();
    dirty = false;
    await expect(flush!()).resolves.toEqual([]);
    expect(commit).toHaveBeenCalledOnce();
    await act(async () => root?.unmount());
    root = null;
    expect(off).toHaveBeenCalledOnce();
  });

  it("a native close asks the server to close the shown project", async () => {
    const t = fakeClient(["a"]);
    const h = fakeHost();
    await mount(t, h);
    await act(async () => h.send({ id: "project.close" }));
    expect(t.calls).toContainEqual({ method: "project.close", params: { projectId: "a" } });
  });

  it("opening a recent project shows it", async () => {
    const t = fakeClient(["a"]);
    const h = fakeHost();
    await mount(t, h);
    const call = t.client.call.bind(t.client);
    (t.client as { call: unknown }).call = (method: string, params: { dir?: string }) => (method === "project.open" ? Promise.resolve({ project: info("recent") }) : call(method as never, params as never));
    await act(async () => h.send({ id: "project.openRecent", dir: "/p/recent" }));
    await settled();
    await settled();
    expect(storeOf(shown()).getState().project.projectId).toBe("recent");
  });
});

describe("a dialog and the project it was opened for", () => {
  const dialogNamed = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const errorText = () => document.querySelector('[data-testid="project-actions.error"]')?.textContent ?? "";
  const noticeText = () => document.querySelector('[data-testid="project-actions.notice"]')?.textContent ?? "";

  async function openOrkDialog(t: ReturnType<typeof fakeClient>, h: ReturnType<typeof fakeHost>) {
    await mount(t, h);
    await act(async () => h.send({ id: "file.import" }));
    await settled();
    expect(dialogNamed("ork-import")).not.toBeNull();
  }

  /** The `.ork` dialog's Replace, through its confirmation. */
  async function confirmReplace() {
    await act(async () => buttonNamed("Replace current design…")!.click());
    await settled();
    await act(async () => buttonNamed("Replace design")!.click());
    await settled();
    await settled();
  }

  const orkHost = () => fakeHost({ pickFile: () => Promise.resolve("/designs/rocket.ork") });

  it("keeps the project on screen when a Recent is picked past the dialog, and Replace still names it", async () => {
    const t = fakeClient(["a", "b"]);
    const h = orkHost();
    await openOrkDialog(t, h);
    await act(async () => h.send({ id: "project.openRecent", dir: "/p/b" }));
    await settled();
    expect(t.calls.some((c) => c.method === "project.open")).toBe(false);
    expect(storeOf(shown()).getState().project.projectId).toBe("a");
    expect(errorText()).toContain("Finish or cancel the open dialog");
    expect(dialogNamed("ork-import")).not.toBeNull();
    await confirmReplace();
    expect(t.calls).toContainEqual({ method: "import.file", params: { projectId: "a", path: "/designs/rocket.ork", kind: "ork" } });
  });

  it("does not import over another project when the one named goes away mid-Replace", async () => {
    const t = fakeClient(["a", "b"]);
    const h = orkHost();
    await openOrkDialog(t, h);
    let finishWrite = () => undefined as void;
    void trackWrite(new Promise<void>((ok) => (finishWrite = ok)));
    await confirmReplace();
    t.projects.splice(0, 1);
    await act(async () => t.push("project.closed", { projectId: "a" }));
    await settled();
    await act(async () => finishWrite());
    await settled();
    await settled();
    expect(storeOf(shown()).getState().project.projectId).toBe("b");
    expect(t.calls.some((c) => c.method === "import.file")).toBe(false);
    expect(errorText()).toContain("rocket.ork");
  });

  it("closes a project-bound dialog when the project it named closes", async () => {
    const t = fakeClient(["a", "b"]);
    const h = orkHost();
    await openOrkDialog(t, h);
    t.projects.splice(0, 1);
    await act(async () => t.push("project.closed", { projectId: "a" }));
    await settled();
    await settled();
    expect(storeOf(shown()).getState().project.projectId).toBe("b");
    expect(dialogNamed("ork-import")).toBeNull();
  });

  it("closes the Rename dialog when the window moves to another project", async () => {
    const t = fakeClient(["a", "b"]);
    const h = fakeHost();
    await mount(t, h);
    await act(async () => h.send({ id: "project.rename" }));
    await settled();
    expect(dialogNamed("rename-project")).not.toBeNull();
    t.projects.splice(0, 1);
    await act(async () => t.push("project.closed", { projectId: "a" }));
    await settled();
    await settled();
    expect(dialogNamed("rename-project")).toBeNull();
  });

  it.each([
    ["project.close", { id: "project.close" }],
    ["project.new", { id: "project.new" }],
    ["project.open", { id: "project.open" }],
    ["project.openSample", { id: "project.openSample" }],
  ] as const)("%s waits for an open dialog instead of replacing it", async (_name, command) => {
    const t = fakeClient(["a"]);
    const h = orkHost();
    const pickFolder = vi.fn<HostApi["pickFolder"]>(() => Promise.resolve(null));
    h.host.pickFolder = pickFolder;
    await openOrkDialog(t, h);
    await act(async () => h.send(command as DesktopCommand));
    await settled();
    expect(t.calls.some((c) => c.method === "project.close" || c.method === "project.create")).toBe(false);
    expect(pickFolder).not.toHaveBeenCalled();
    expect(dialogNamed("ork-import")).not.toBeNull();
    expect(dialogNamed("new-project")).toBeNull();
    expect(errorText()).toContain("Finish or cancel the open dialog");
  });

  it("does not stack a second New project over Welcome's own", async () => {
    const h = fakeHost();
    await mount(fakeClient([]), h);
    await act(async () => buttonNamed("New project")!.click());
    await settled();
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
    await act(async () => h.send({ id: "project.new" }));
    await settled();
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
  });

  it("runs one Open sample when Welcome's button and the menu both ask", async () => {
    const t = fakeClient([]);
    const h = fakeHost();
    await mount(t, h);
    await act(async () => {
      buttonNamed("Open sample rocket")!.click();
      h.send({ id: "project.openSample" });
    });
    await settled();
    await settled();
    expect(t.calls.filter((c) => c.method === "project.create")).toHaveLength(1);
  });

  describe("main asking the window to show a project", () => {
    type OpenListener = (m: unknown) => void;
    const listeners: OpenListener[] = [];
    const openProject = async (projectId: string) => act(async () => listeners.forEach((l) => l({ type: "open-project", projectId })));

    beforeEach(() => {
      listeners.length = 0;
      const g = globalThis as Record<string, unknown>;
      g["lecturnEmbedIpc"] = { send: () => undefined, on: () => () => undefined };
      g["rwDesktop"] = { lecturn: { onMessage: (l: OpenListener) => (listeners.push(l), () => undefined), send: () => undefined } };
    });
    afterEach(() => {
      const g = globalThis as Record<string, unknown>;
      delete g["lecturnEmbedIpc"];
      delete g["rwDesktop"];
    });

    it("waits for an open dialog, says so, then switches when it closes", async () => {
      const t = fakeClient(["a", "b"]);
      const h = fakeHost();
      await mount(t, h);
      await act(async () => h.send({ id: "project.rename" }));
      await settled();
      await openProject("b");
      await settled();
      expect(storeOf(shown()).getState().project.projectId).toBe("a");
      expect(noticeText()).toContain("when you finish");
      await act(async () => buttonNamed("Cancel")!.click());
      await settled();
      await settled();
      await settled();
      expect(storeOf(shown()).getState().project.projectId).toBe("b");
    });

    it("waits for a running action rather than dropping the switch", async () => {
      let answer = (_: string | null) => undefined as void;
      const t = fakeClient(["a", "b"]);
      const h = fakeHost({ pickFolder: () => new Promise((ok) => (answer = ok)) });
      await mount(t, h);
      await act(async () => h.send({ id: "project.open" }));
      await settled();
      await openProject("b");
      await settled();
      expect(storeOf(shown()).getState().project.projectId).toBe("a");
      await act(async () => answer(null));
      await settled();
      await settled();
      expect(storeOf(shown()).getState().project.projectId).toBe("b");
    });

    it("waits for Welcome's own action too", async () => {
      let answer = (_: string | null) => undefined as void;
      const t = fakeClient([]);
      const h = fakeHost({ pickFolder: () => new Promise((ok) => (answer = ok)) });
      await mount(t, h);
      await act(async () => buttonNamed("Open folder…")!.click());
      await settled();
      t.projects.push("b");
      await openProject("b");
      await settled();
      expect(shown()).toBeUndefined();
      await act(async () => answer(null));
      await settled();
      await settled();
      expect(storeOf(shown()).getState().project.projectId).toBe("b");
    });

    it("says the window stayed put when the person keeps their unsaved work", async () => {
      const t = fakeClient(["a", "b"]);
      const h = fakeHost();
      await mount(t, h);
      registerDirtyField({ dirty: () => true, commit: () => "Part length" });
      await act(async () => undefined);
      await openProject("b");
      await settled();
      await act(async () => buttonNamed("Keep editing")!.click());
      await settled();
      await settled();
      expect(storeOf(shown()).getState().project.projectId).toBe("a");
      expect(noticeText()).toContain("Project b");
    });
  });
});

describe("native menu commands", () => {
  const quickStart = () => document.querySelector('[data-testid="quick-start"]');
  const history = () => vi.fn<() => void>();

  it("opens the quick start from the native Help menu with a project showing", async () => {
    const h = fakeHost();
    await mount(fakeClient(["a"]), h);
    expect(quickStart()).toBeNull();
    await act(async () => h.send({ id: "help.quickStart" }));
    expect(quickStart()).not.toBeNull();
  });

  it("opens the quick start from Welcome too", async () => {
    const h = fakeHost();
    await mount(fakeClient([]), h);
    expect(el.querySelector('[data-testid="welcome"]')).not.toBeNull();
    await act(async () => h.send({ id: "help.quickStart" }));
    expect(quickStart()).not.toBeNull();
  });

  it("opens the same quick start from the header's Help", async () => {
    await mount(fakeClient(["a"]), fakeHost());
    await act(async () => shown()!.onOpenHelp!());
    expect(quickStart()).not.toBeNull();
  });

  it("zooms the whole page and reports a resize, across a project switch", async () => {
    const h = fakeHost();
    await mount(fakeClient(["a"]), h);
    const resized = vi.fn<() => void>();
    window.addEventListener("resize", resized);
    await act(async () => h.send({ id: "view.zoom", direction: "in" }));
    window.removeEventListener("resize", resized);
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("1.1");
    expect(resized).toHaveBeenCalledOnce();
    await act(async () => h.send({ id: "view.zoom", direction: "reset" }));
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("1");
  });

  describe("Undo and Redo", () => {
    let execCommand: ReturnType<typeof vi.fn<(command: string) => boolean>>;

    beforeEach(() => {
      execCommand = vi.fn<(command: string) => boolean>(() => true);
      (document as unknown as { execCommand: unknown }).execCommand = execCommand;
    });
    afterEach(() => {
      delete (document as unknown as { execCommand?: unknown }).execCommand;
    });

    async function withShell() {
      const h = fakeHost();
      await mount(fakeClient(["a"]), h);
      const undo = history();
      const redo = history();
      shown()!.commandsRef!.current = { "edit.undo": undo, "edit.redo": redo };
      return { h, undo, redo };
    }

    it("goes to the focused text field, not the design history", async () => {
      const { h, undo, redo } = await withShell();
      const input = document.createElement("input");
      document.body.append(input);
      input.focus();
      await act(async () => h.send({ id: "edit.undo" }));
      await act(async () => h.send({ id: "edit.redo" }));
      input.remove();
      expect(execCommand.mock.calls.map(([c]) => c)).toEqual(["undo", "redo"]);
      expect(undo).not.toHaveBeenCalled();
      expect(redo).not.toHaveBeenCalled();
    });

    it("goes to the design history with no text field focused", async () => {
      const { h, undo, redo } = await withShell();
      await act(async () => h.send({ id: "edit.undo" }));
      await act(async () => h.send({ id: "edit.redo" }));
      expect(undo).toHaveBeenCalledOnce();
      expect(redo).toHaveBeenCalledOnce();
      expect(execCommand).not.toHaveBeenCalled();
    });

    it("still undoes typing on Welcome, which has no design history", async () => {
      const h = fakeHost();
      await mount(fakeClient([]), h);
      const input = document.createElement("input");
      document.body.append(input);
      input.focus();
      await act(async () => h.send({ id: "edit.undo" }));
      input.remove();
      expect(execCommand).toHaveBeenCalledWith("undo");
    });

    it("does nothing with no field and no project", async () => {
      const h = fakeHost();
      await mount(fakeClient([]), h);
      await act(async () => h.send({ id: "edit.undo" }));
      expect(execCommand).not.toHaveBeenCalled();
    });
  });

  it("hands tab and settings commands to the project's shell", async () => {
    const h = fakeHost();
    await mount(fakeClient(["a"]), h);
    const tab = vi.fn<(c: { id: "view.tab"; tab: string }) => void>();
    shown()!.commandsRef!.current = { "view.tab": tab };
    await act(async () => h.send({ id: "view.tab", tab: "results" }));
    expect(tab).toHaveBeenCalledWith({ id: "view.tab", tab: "results" });
  });

  describe("settings (R3.4)", () => {
    const dialog = () => document.querySelector<HTMLElement>('[data-testid="settings"]');
    const select = () => document.querySelector<HTMLSelectElement>('[data-testid="settings.default-units"]')!;

    it("opens from the native menu with a project showing, offering Agent providers", async () => {
      const openProviders = vi.fn<HostApi["openProviders"]>(() => Promise.resolve());
      const h = fakeHost({ openProviders });
      await mount(fakeClient(["a"]), h);
      await act(async () => h.send({ id: "app.settings" }));
      await settled();
      expect(dialog()).not.toBeNull();
      await act(async () => buttonNamed("Agent providers…")!.click());
      await settled();
      expect(dialog()).toBeNull();
      expect(openProviders).toHaveBeenCalledOnce();
    });

    it("opens from the header gear", async () => {
      await mount(fakeClient(["a"]), fakeHost());
      await act(async () => shown()!.onOpenSettings!());
      expect(dialog()).not.toBeNull();
    });

    it("on Welcome it opens too, with no Agent providers entry", async () => {
      const h = fakeHost();
      await mount(fakeClient([]), h);
      await act(async () => h.send({ id: "app.settings" }));
      await settled();
      expect(dialog()).not.toBeNull();
      expect(buttonNamed("Agent providers…")).toBeUndefined();
    });

    it("opens from a visible control on Welcome, with no Agent providers entry", async () => {
      await mount(fakeClient([]), fakeHost());
      await act(async () => buttonNamed("Settings…")!.click());
      await settled();
      expect(dialog()).not.toBeNull();
      expect(buttonNamed("Agent providers…")).toBeUndefined();
    });

    it("saves the default units, and a project created next carries them", async () => {
      const setPrefs = vi.fn<HostApi["setPrefs"]>(() => Promise.resolve());
      let saved: DisplayUnits | null = null;
      const h = fakeHost({ setPrefs: (p) => { if (p.defaultDisplayUnits !== undefined) saved = p.defaultDisplayUnits; return setPrefs(p); }, prefs: () => Promise.resolve({ window: null, view: {}, lastTab: null, defaultDisplayUnits: saved }) });
      const t = fakeClient([]);
      await mount(t, h);
      await act(async () => h.send({ id: "app.settings" }));
      await settled();
      await act(async () => {
        select().value = "in";
        select().dispatchEvent(new Event("change", { bubbles: true }));
      });
      await settled();
      expect(setPrefs).toHaveBeenCalledWith({ defaultDisplayUnits: { length: "in" } });
      await act(async () => buttonNamed("Done")!.click());
      await act(async () => buttonNamed("New project")!.click());
      await settled();
      const input = document.querySelector<HTMLInputElement>('[data-testid="new-project"] input')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Inch");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => buttonNamed("Create project")!.click());
      await settled();
      expect(t.calls.find((c) => c.method === "project.create")?.params).toMatchObject({ name: "Inch", displayUnits: { length: "in" } });
    });

    it("says so when the setting cannot be saved, and keeps the old choice", async () => {
      const h = fakeHost({ setPrefs: () => Promise.reject(new Error("disk full")) });
      await mount(fakeClient(["a"]), h);
      await act(async () => h.send({ id: "app.settings" }));
      await settled();
      await act(async () => {
        select().value = "in";
        select().dispatchEvent(new Event("change", { bubbles: true }));
      });
      await settled();
      expect(document.querySelector('[data-testid="settings.error"]')?.textContent).toContain("disk full");
      expect(select().value).toBe("");
    });
  });

  describe("restored preferences (R3.4)", () => {
    const prefs = (over: Partial<DesktopPrefs>) => () => Promise.resolve<DesktopPrefs>({ window: null, view: {}, lastTab: null, defaultDisplayUnits: null, ...over });

    it("reopens on the last tab", async () => {
      await mount(fakeClient(["a"]), fakeHost({ prefs: prefs({ lastTab: "results" }) }));
      expect(storeOf(shown()).getState().ui.page).toBe("results");
    });

    it("a page named in the URL wins, and nothing is recorded over it", async () => {
      const setPrefs = vi.fn<HostApi["setPrefs"]>(() => Promise.resolve());
      await mount(fakeClient(["a"]), fakeHost({ prefs: prefs({ lastTab: "results" }), setPrefs }), { initialPage: "configurations", pageForced: true });
      expect(storeOf(shown()).getState().ui.page).toBe("configurations");
      await act(async () => storeOf(shown()).getState().ui.navigate("assembly"));
      await settled();
      expect(setPrefs).not.toHaveBeenCalledWith(expect.objectContaining({ lastTab: expect.anything() }));
    });

    it("ignores a saved page that no longer exists", async () => {
      await mount(fakeClient(["a"]), fakeHost({ prefs: prefs({ lastTab: "old-page" }) }));
      expect(storeOf(shown()).getState().ui.page).toBe("assembly");
    });

    it("records the tab the person moves to", async () => {
      const setPrefs = vi.fn<HostApi["setPrefs"]>(() => Promise.resolve());
      await mount(fakeClient(["a"]), fakeHost({ setPrefs }));
      await act(async () => storeOf(shown()).getState().ui.navigate("results"));
      await settled();
      expect(setPrefs).toHaveBeenCalledWith({ lastTab: "results" });
    });

    it("restores view options, keeping a value that is still valid", async () => {
      await mount(fakeClient(["a"]), fakeHost({ prefs: prefs({ view: { view: "top", explode: 0.4, section: true, showInternals: true, shadows: false, stale: "x" } }) }));
      expect(storeOf(shown()).getState().ui).toMatchObject({ view: "top", explode: 0.4, section: true, showInternals: true, shadows: false });
    });

    it("drops a view that no longer exists", async () => {
      await mount(fakeClient(["a"]), fakeHost({ prefs: prefs({ view: { view: "gone" } }) }));
      expect(storeOf(shown()).getState().ui.view).toBe("iso");
    });

    it("records view options when they change, and carries them across a switch", async () => {
      const setPrefs = vi.fn<HostApi["setPrefs"]>(() => Promise.resolve());
      await mount(fakeClient(["a", "b"]), fakeHost({ setPrefs }));
      const before = shown()!;
      await act(async () => storeOf(before).getState().ui.setView({ section: true }));
      await settled();
      expect(setPrefs).toHaveBeenCalledWith({ view: { view: "iso", explode: 0, section: true, showInternals: false, shadows: true } });
      await act(async () => before.onSwitchProject!("b"));
      await settled();
      expect(storeOf(shown()).getState().ui.section).toBe(true);
    });

    it("starts anyway when the preferences cannot be read", async () => {
      await mount(fakeClient(["a"]), fakeHost({ prefs: () => Promise.reject(new Error("no")) }));
      expect(shown()).toBeDefined();
    });
  });

  it("ignores a tab command with no project showing", async () => {
    const h = fakeHost();
    await mount(fakeClient([]), h);
    await act(async () => h.send({ id: "view.tab", tab: "results" }));
    expect(el.querySelector('[data-testid="welcome"]')).not.toBeNull();
  });
});

describe("the project menu", () => {
  const order = (t: ReturnType<typeof fakeClient>) => t.calls.map((c) => c.method).filter((m) => m === "project.unsubscribe" || m === "project.close" || m === "model.patch");
  const dialog = (name: string) => document.querySelector(`[role="dialog"][aria-labelledby] h2`)?.textContent === name;
  const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name)!;
  const banner = () => document.querySelector('[data-testid="project-actions.error"]')?.textContent ?? "";
  const send = async (command: DesktopCommand) => {
    await act(async () => shown()!.projectMenu!.onCommand(command));
    await settled();
    await settled();
  };

  function failing(t: ReturnType<typeof fakeClient>, method: string, message: string) {
    const call = t.client.call.bind(t.client);
    (t.client as { call: unknown }).call = (m: string, params: never) => (m === method ? Promise.reject(new Error(message)) : call(m as never, params));
  }

  it("closes in order: flush, disconnect, close, then Welcome", async () => {
    const t = fakeClient(["a"]);
    await mount(t, fakeHost());
    let release!: () => void;
    registerDirtyField({
      dirty: () => true,
      commit: () => {
        void t.client.call("model.patch", { projectId: "a", ops: [] });
        void trackWrite(new Promise<void>((ok) => (release = ok)));
        return null;
      },
    });
    await act(async () => shown()!.projectMenu!.onCommand({ id: "project.close" }));
    await settled();
    expect(order(t)).toEqual(["model.patch"]);
    release();
    await settled();
    await settled();
    expect(order(t)).toEqual(["model.patch", "project.unsubscribe", "project.close"]);
    expect(el.querySelector('[data-testid="welcome"]')).not.toBeNull();
  });

  it("goes to the next open project once the server has closed this one", async () => {
    const t = fakeClient(["a", "b"]);
    await mount(t, fakeHost());
    t.projects.splice(0, 1);
    await send({ id: "project.close" });
    expect(storeOf(shown()).getState().project.projectId).toBe("b");
  });

  it("shows a close that failed, and stays connected to the project", async () => {
    const t = fakeClient(["a"]);
    await mount(t, fakeHost());
    failing(t, "project.close", "the sidecar would not stop");
    await send({ id: "project.close" });
    expect(banner()).toContain("the sidecar would not stop");
    expect(el.querySelector('[data-testid="welcome"]')).toBeNull();
    expect(storeOf(shown()).getState().project.projectId).toBe("a");
    expect(storeOf(shown()).getState().project.snapshot).not.toBeNull();
  });

  it("asks before dropping what could not be saved, and Keep editing stays", async () => {
    const t = fakeClient(["a"]);
    await mount(t, fakeHost());
    registerDirtyField({ dirty: () => true, commit: () => "Length needs a number." });
    await send({ id: "project.close" });
    expect(dialog("Unsaved changes")).toBe(true);
    expect(document.body.textContent).toContain("Length needs a number.");
    expect(order(t)).toEqual([]);
    await act(async () => button("Keep editing").click());
    await settled();
    expect(dialog("Unsaved changes")).toBe(false);
    expect(order(t)).toEqual([]);
    expect(el.querySelector('[data-testid="welcome"]')).toBeNull();
  });

  it("Don't save goes ahead", async () => {
    const t = fakeClient(["a"]);
    await mount(t, fakeHost());
    registerDirtyField({ dirty: () => true, commit: () => "Length needs a number." });
    await send({ id: "project.close" });
    t.projects.splice(0, 1);
    await act(async () => button("Don't save").click());
    await settled();
    await settled();
    expect(order(t)).toEqual(["project.unsubscribe", "project.close"]);
    expect(el.querySelector('[data-testid="welcome"]')).not.toBeNull();
  });

  it.each([
    ["switching", async () => act(async () => shown()!.onSwitchProject!("b"))],
    ["New project", async () => send({ id: "project.new" })],
    ["Open folder", async () => send({ id: "project.open" })],
    ["a recent project", async () => send({ id: "project.openRecent", dir: "/p/b" })],
    ["the sample rocket", async () => send({ id: "project.openSample" })],
  ] as const)("guards %s the same way", async (_name, act_) => {
    const t = fakeClient(["a", "b"]);
    const pickFolder = vi.fn<HostApi["pickFolder"]>(() => Promise.resolve(null));
    await mount(t, fakeHost({ pickFolder }));
    registerDirtyField({ dirty: () => true, commit: () => "Length needs a number." });
    await act_();
    await settled();
    expect(dialog("Unsaved changes")).toBe(true);
    expect(pickFolder).not.toHaveBeenCalled();
    expect(t.calls.filter((c) => c.method === "project.open" || c.method === "project.create")).toEqual([]);
    expect(storeOf(shown()).getState().project.projectId).toBe("a");
  });

  it("New project opens the dialog and shows what it creates", async () => {
    const t = fakeClient(["a"]);
    await mount(t, fakeHost());
    await send({ id: "project.new" });
    expect(dialog("New project")).toBe(true);
  });

  it("says inline when a folder cannot be opened", async () => {
    const t = fakeClient(["a"]);
    const h = fakeHost({ pickFolder: () => Promise.resolve("/p/nope") });
    await mount(t, h);
    failing(t, "project.inspect", "no permission");
    await send({ id: "project.open" });
    expect(banner()).toContain("no permission");
  });

  it("says inline when a recent project will not open, on the native menu too", async () => {
    const t = fakeClient(["a"]);
    const h = fakeHost();
    await mount(t, h);
    failing(t, "project.open", "its folder is gone");
    await act(async () => h.send({ id: "project.openRecent", dir: "/p/gone" }));
    await settled();
    await settled();
    expect(banner()).toContain("its folder is gone");
  });

  it("says why a recent project did not open while another project action is running", async () => {
    const t = fakeClient(["a"]);
    let finishPick!: (dir: string | null) => void;
    const pickFolder = () => new Promise<string | null>((resolve) => (finishPick = resolve));
    const h = fakeHost({ pickFolder });
    await mount(t, h);
    await act(async () => h.send({ id: "project.open" }));
    await settled();
    await act(async () => h.send({ id: "project.openRecent", dir: "/p/b" }));
    await settled();
    expect(t.calls.filter((c) => c.method === "project.open")).toEqual([]);
    expect(banner()).toContain("another project action is still running");
    await act(async () => finishPick(null));
    await settled();
  });

  it("says why a recent project did not open before the window has connected", async () => {
    let finishConnect!: (c: RpcLike) => void;
    const t = fakeClient(["a"]);
    const h = fakeHost();
    await mount(t, h, { connect: () => new Promise<RpcLike>((resolve) => (finishConnect = resolve)) });
    await act(async () => h.send({ id: "project.openRecent", dir: "/p/b" }));
    await settled();
    expect(banner()).toContain("still connecting");
    await act(async () => finishConnect(t.client));
    await settled();
  });

  it("reads Recent from the host each time the menu opens, and shows a failure there", async () => {
    const recents = vi.fn<HostApi["recents"]>(() => Promise.resolve([{ dir: "/p/z", name: "Z", lastOpened: "t", status: "ok" as const }]));
    await mount(fakeClient(["a"]), fakeHost({ recents }));
    await act(async () => shown()!.projectMenu!.onOpen());
    await settled();
    expect(shown()!.projectMenu!.recents.map((r) => r.name)).toEqual(["Z"]);
    recents.mockRejectedValueOnce(new Error("unreadable"));
    await act(async () => shown()!.projectMenu!.onOpen());
    await settled();
    expect(shown()!.projectMenu!.errors).toEqual(["Could not read recent projects: unreadable"]);
  });

  it("says inline when a recent cannot be removed", async () => {
    await mount(fakeClient(["a"]), fakeHost({ removeRecent: () => Promise.reject(new Error("read-only store")) }));
    await act(async () => shown()!.projectMenu!.onRemoveRecent("/p/gone"));
    await settled();
    expect(banner()).toContain("read-only store");
  });

  it("says inline when main cannot record the shown project", async () => {
    await mount(fakeClient(["a"]), fakeHost({ setActiveProject: () => Promise.reject(new Error("no store")) }));
    await settled();
    expect(banner()).toContain("Could not update recent projects: no store");
  });

  describe("rename", () => {
    const named = (projectId: string, name: string): ProjectInfo => ({ ...info(projectId), name });
    const nameField = () => document.querySelector<HTMLInputElement>('[data-testid="rename-project"] input')!;
    const type = (input: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };

    async function renaming(t: ReturnType<typeof fakeClient>) {
      await mount(t, fakeHost());
      await send({ id: "project.rename" });
    }

    it("warns that runs become outdated before anything is written", async () => {
      const t = fakeClient(["a"]);
      await renaming(t);
      expect(document.querySelector('[data-testid="rename-project.warning"]')?.textContent).toMatch(/runs .*outdated/);
      expect(nameField().value).toBe("Project a");
      expect(t.calls.some((c) => c.method === "project.rename")).toBe(false);
    });

    it("renames, and the push updates the store, Recent and the window title", async () => {
      const t = fakeClient(["a"]);
      const h = fakeHost();
      await mount(t, h);
      await settled();
      expect(document.title).toBe("Project a – RocketWright");
      await send({ id: "project.rename" });
      await act(async () => type(nameField(), "  Solstice  "));
      await act(async () => button("Rename").click());
      await settled();
      expect(t.calls).toContainEqual({ method: "project.rename", params: { projectId: "a", name: "Solstice" } });
      await act(async () => t.push("project.updated", { project: named("a", "Solstice") }));
      await settled();
      expect(storeOf(shown()).getState().project.snapshot?.project.name).toBe("Solstice");
      expect(h.active.at(-1)).toEqual(named("a", "Solstice"));
      expect(document.title).toBe("Solstice – RocketWright");
      expect(document.querySelector('[data-testid="rename-project"]')).toBeNull();
    });

    it("ignores another project's rename", async () => {
      const t = fakeClient(["a", "b"]);
      await mount(t, fakeHost());
      await settled();
      await act(async () => t.push("project.updated", { project: named("b", "Other") }));
      expect(storeOf(shown()).getState().project.snapshot?.project.name).toBe("Project a");
    });

    it("does not write when the name is unchanged", async () => {
      const t = fakeClient(["a"]);
      await renaming(t);
      await act(async () => button("Rename").click());
      await settled();
      expect(t.calls.some((c) => c.method === "project.rename")).toBe(false);
      expect(document.querySelector('[data-testid="rename-project"]')).toBeNull();
    });

    it("refuses an empty name and shows a server refusal in the dialog", async () => {
      const t = fakeClient(["a"]);
      await renaming(t);
      await act(async () => type(nameField(), "   "));
      await act(async () => button("Rename").click());
      expect(document.body.textContent).toContain("Enter a name.");
      expect(t.calls.some((c) => c.method === "project.rename")).toBe(false);
      failing(t, "project.rename", "a project name cannot hold control characters");
      await act(async () => type(nameField(), "Good name"));
      await act(async () => button("Rename").click());
      await settled();
      expect(document.querySelector('[data-testid="rename-project.error"]')?.textContent).toContain("control characters");
      expect(document.querySelector('[data-testid="rename-project"]')).not.toBeNull();
    });
  });
});

describe("import and export", () => {
  const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
  const click = async (name: string) => {
    await act(async () => button(name)!.click());
    await settled();
  };
  const dialog = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const text = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
  const send = async (h: ReturnType<typeof fakeHost>, command: DesktopCommand) => {
    await act(async () => h.send(command));
    await settled();
  };
  const imports = (t: ReturnType<typeof fakeClient>) => t.calls.filter((c) => c.method === "import.file").map((c) => c.params);
  const picking = (path: string) => fakeHost({ pickFile: () => Promise.resolve(path) });

  describe("on Welcome", () => {
    it("creates a project from an .ork through the New project flow (D17)", async () => {
      const t = fakeClient([]);
      const h = picking("/outside/My Rocket.ork");
      await mount(t, h);
      await send(h, { id: "file.import" });
      const form = dialog("new-project")!;
      expect(form.querySelector("input")?.value).toBe("My Rocket");
      expect(form.textContent).toContain("Imports My Rocket.ork into the new project.");
      expect(form.textContent).not.toContain("Template");
      await click("Create project");
      expect(t.calls.find((c) => c.method === "project.create")?.params).toEqual({ name: "My Rocket", location: "/docs", source: { ork: "/outside/My Rocket.ork" } });
      expect(imports(t)).toEqual([]);
    });

    it("offers only designs in the picker, and has a control a browser can reach", async () => {
      const t = fakeClient([]);
      const pickFile = vi.fn<HostApi["pickFile"]>(() => Promise.resolve(null));
      await mount(t, fakeHost({ pickFile }));
      await click("Import an .ork file…");
      expect(pickFile.mock.calls[0]![0]?.filters).toEqual([{ name: "OpenRocket design", extensions: ["ork"] }]);
    });

    it("says a motor needs a project, and sends nothing", async () => {
      const t = fakeClient([]);
      const h = picking("/outside/C6.eng");
      await mount(t, h);
      await send(h, { id: "file.import" });
      expect(text("project-actions.error")).toContain("Open a project first");
      expect(imports(t)).toEqual([]);
    });
  });

  describe("with a project open", () => {
    it("imports a motor from a picked path over the page's own socket", async () => {
      const t = fakeClient(["a"]);
      const h = picking("/outside/C6.eng");
      await mount(t, h);
      await send(h, { id: "file.import" });
      expect(imports(t)).toEqual([{ projectId: "a", path: "/outside/C6.eng", kind: "motor" }]);
      expect(text("project-actions.notice")).toContain("Imported C6.eng.");
    });

    it("refuses a file it cannot read, without calling the server", async () => {
      const t = fakeClient(["a"]);
      const h = picking("/outside/notes.txt");
      await mount(t, h);
      await send(h, { id: "file.import" });
      expect(text("project-actions.error")).toContain(".ork, .eng and .rse");
      expect(imports(t)).toEqual([]);
    });

    it("asks before an .ork changes anything, with a new project as the default", async () => {
      const t = fakeClient(["a"]);
      const h = picking("/outside/r.ork");
      await mount(t, h);
      await send(h, { id: "file.import" });
      expect(dialog("ork-import")).not.toBeNull();
      expect(document.activeElement?.textContent).toBe("Create new project");
      expect(imports(t)).toEqual([]);
      await click("Create new project");
      expect(dialog("new-project")?.textContent).toContain("Imports r.ork");
      expect(imports(t)).toEqual([]);
    });

    it("replaces the design only after a second, explicit step", async () => {
      const t = fakeClient(["a"]);
      const h = picking("/outside/r.ork");
      await mount(t, h);
      await send(h, { id: "file.import" });
      await click("Replace current design…");
      expect(document.activeElement?.textContent).toBe("Keep current design");
      expect(imports(t)).toEqual([]);
      await click("Replace design");
      expect(imports(t)).toEqual([{ projectId: "a", path: "/outside/r.ork", kind: "ork" }]);
      expect(text("project-actions.notice")).toContain("Imported r.ork.");
    });

    it("backs out of the replace without importing", async () => {
      const t = fakeClient(["a"]);
      const h = picking("/outside/r.ork");
      await mount(t, h);
      await send(h, { id: "file.import" });
      await click("Replace current design…");
      await click("Keep current design");
      expect(dialog("ork-import")).not.toBeNull();
      await click("Cancel");
      expect(dialog("ork-import")).toBeNull();
      expect(imports(t)).toEqual([]);
    });

    it("exports through the host and warns about what the format left out (U44)", async () => {
      const t = fakeClient(["a"]);
      const exportFile = vi.fn<HostApi["exportFile"]>(() => Promise.resolve({ canceled: false, out: { path: "/o/r.ork", bytes: 1, sha256: "x", skipped: ["lox_tank"] } }));
      const h = fakeHost({ exportFile });
      await mount(t, h);
      await send(h, { id: "file.export" });
      await click("Export…");
      expect(exportFile.mock.calls[0]![0]).toEqual({ projectId: "a", format: "ork", defaultName: "Project a.ork" });
      expect(text("project-actions.notice")).toContain("leaving out a part this format cannot hold: lox_tank");
    });

    it("says nothing was exported when the person cancels the save", async () => {
      const t = fakeClient(["a"]);
      const h = fakeHost();
      await mount(t, h);
      await send(h, { id: "file.export" });
      await click("Export…");
      expect(text("project-actions.notice")).toBeNull();
    });

    it("does not offer an export of a project with no parts", async () => {
      const t = fakeClient(["a"]);
      const exportFile = vi.fn<HostApi["exportFile"]>(() => Promise.resolve({ canceled: true }));
      const h = fakeHost({ exportFile });
      await mount(t, h);
      const store = storeOf(shown());
      await act(async () => {
        store.setState((s) => {
          const snapshot = s.project.snapshot!;
          return { project: { ...s.project, snapshot: { ...snapshot, evaluated: { ...snapshot.evaluated!, components: [] } } } };
        });
      });
      await send(h, { id: "file.export" });
      expect(dialog("export-dialog")?.textContent).toContain("no parts yet");
      expect(button("Export…")!.disabled).toBe(true);
    });

    it("will not let a drop replace a dialog that is open", async () => {
      const t = fakeClient(["a"]);
      const h = picking("/outside/r.ork");
      await mount(t, h, { host: { ...h.host, pathForFile: () => "/outside/C6.eng" } });
      await send(h, { id: "file.import" });
      const drop = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [new Blob(["x"])] } });
      await act(async () => void window.dispatchEvent(drop));
      await settled();
      expect(drop.defaultPrevented).toBe(true);
      expect(text("project-actions.error")).toContain("finish what is open first");
      expect(imports(t)).toEqual([]);
      expect(dialog("ork-import")).not.toBeNull();
    });

    it("imports a dropped file like a picked one", async () => {
      const t = fakeClient(["a"]);
      const h = fakeHost();
      await mount(t, h, { host: { ...h.host, pathForFile: () => "/outside/C6.rse" } });
      const drop = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [new Blob(["x"])] } });
      await act(async () => void window.dispatchEvent(drop));
      await settled();
      expect(imports(t)).toEqual([{ projectId: "a", path: "/outside/C6.rse", kind: "motor" }]);
    });
  });
});
