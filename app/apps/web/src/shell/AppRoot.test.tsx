// @vitest-environment jsdom
/**
 * AppRoot and ProjectSurface together, on a fake connection: which project
 * is on screen, what a switch resets, and that the broker follows the window.
 * The shell itself is a stub; its own tests cover what it draws.
 */
import type { BrokerRequest, BrokerResponse, DesktopCommand, ProjectInfo, RpcTopics } from "@rw/contracts";
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
    recents: () => Promise.resolve([]),
    removeRecent: () => Promise.resolve(),
    setActiveProject: (p) => {
      active.push(p);
      return Promise.resolve();
    },
    onCommand: (l) => {
      commands.push(l);
      return () => void commands.splice(commands.indexOf(l), 1);
    },
    pathForFile: () => null,
    ...over,
  };
  return { host, active, send: (c: DesktopCommand) => commands.forEach((l) => l(c)) };
}

const NO_RUNS: RunDataSource = { load: () => Promise.reject(new Error("no runs in this test")) };

let root: Root | null = null;
let el: HTMLElement;

const shown = () => shells.mounted.at(-1) as ConnectedShellProps | undefined;
const storeOf = (s: ConnectedShellProps | undefined): AppStore => s!.store;
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

  it("an empty window whose connection drops is fatal", async () => {
    const t = fakeClient([]);
    await mount(t, fakeHost());
    await act(async () => t.lose("socket closed"));
    expect(el.querySelector('[data-testid="fatal"]')?.textContent).toContain("socket closed");
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
