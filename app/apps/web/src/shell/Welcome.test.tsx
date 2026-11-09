// @vitest-environment jsdom
/**
 * Welcome and New project on the zero-project mock, through the real
 * `RpcClient`, so an error here is the same object a person's window gets.
 */
import type { RecentProject } from "@rw/contracts";
import { MOCK_DEFAULT_LOCATION, MockRpc } from "@rw/contracts/mock";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserHost, createPathPrompts, type PathPrompts } from "../host/browserHost.ts";
import type { HostApi } from "../host/HostApi.ts";
import { RpcClient, type SocketLike } from "../state/rpc.ts";
import { PathPromptModal } from "./PathPromptModal.tsx";
import { Welcome } from "./Welcome.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mockSocket(mock: MockRpc): new (url: string) => SocketLike {
  return class implements SocketLike {
    readyState = 1;
    private readonly listeners = new Map<string, ((e: { data: unknown }) => void)[]>();
    private conn: ReturnType<MockRpc["connect"]> | null = null;
    constructor() {
      queueMicrotask(() => {
        this.emit("open", { data: null });
        this.conn = mock.connect((frame) => this.emit("message", { data: JSON.stringify(frame) }));
      });
    }
    private emit(type: string, e: { data: unknown }) {
      for (const fn of this.listeners.get(type) ?? []) fn(e);
    }
    send(data: string) {
      this.conn?.receive(data);
    }
    close() {
      this.conn?.close();
    }
    addEventListener(type: string, fn: (e: { data: unknown }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
  };
}

let root: Root | null = null;
let el: HTMLElement;
let mock: MockRpc;
let prompts: PathPrompts;
let onOpened: ReturnType<typeof vi.fn<(id: string) => void>>;

const settled = () => act(async () => void (await new Promise((r) => setTimeout(r, 5))));

async function mount(hostOver: Partial<HostApi> = {}, notice: string | null = null, wrap?: (c: RpcClient) => RpcClient) {
  const raw = await RpcClient.connect("ws://mock", { WebSocket: mockSocket(mock) });
  const client = wrap?.(raw) ?? raw;
  const host = { ...createBrowserHost(prompts.prompt), ...hostOver };
  root = createRoot(el);
  await act(async () => {
    root!.render(
      <>
        <Welcome client={client} host={host} notice={notice} onOpened={onOpened} />
        <PathPromptModal prompts={prompts} />
      </>,
    );
  });
  await settled();
}

const dialogNamed = (name: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => document.getElementById(d.getAttribute("aria-labelledby")!)?.textContent === name);
const button = (scope: ParentNode, text: string): HTMLButtonElement => {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text || b.getAttribute("aria-label") === text);
  if (found === undefined) throw new Error(`no button ${text}`);
  return found;
};
const field = (scope: ParentNode, label: string): HTMLInputElement => {
  const found = [...scope.querySelectorAll("label")].find((l) => l.textContent === label);
  if (found === undefined) throw new Error(`no field ${label}`);
  return document.getElementById(found.htmlFor) as HTMLInputElement;
};
const radio = (scope: ParentNode, title: string): HTMLInputElement => {
  const found = [...scope.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((r) => document.getElementById(r.getAttribute("aria-labelledby")!)?.textContent === title);
  if (found === undefined) throw new Error(`no radio ${title}`);
  return found;
};
const click = async (target: HTMLElement) => {
  await act(async () => target.click());
  await settled();
};
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const answerPrompt = async (path: string) => {
  const prompt = document.querySelector<HTMLElement>('[data-testid="path-prompt"]');
  expect(prompt).not.toBeNull();
  await type(field(prompt!, "Path"), path);
  await click(button(prompt!, "Choose"));
};
const openNewDialog = async () => {
  await click(button(el, "New project"));
  return dialogNamed("New project")!;
};
const errorLine = (scope: ParentNode, id: string) => scope.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

beforeEach(() => {
  mock = new MockRpc({ testHooks: false, zeroProjects: true });
  prompts = createPathPrompts();
  onOpened = vi.fn<(id: string) => void>();
  el = document.createElement("div");
  document.body.append(el);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  el.remove();
  mock.dispose();
});

describe("Welcome", () => {
  it("offers the three ways in and, in a browser, no Recent list", async () => {
    await mount();
    expect(el.querySelector("h1")?.textContent).toBe("RocketWright");
    for (const name of ["New project", "Open folder…", "Open sample rocket"]) expect(button(el, name).disabled).toBe(false);
    expect(el.textContent).not.toContain("Recent");
  });

  it("shows why the window came back here, until something else is tried", async () => {
    await mount({}, "That project has moved.");
    expect(errorLine(el, "welcome.notice")).toContain("That project has moved.");
    await click(button(el, "Open folder…"));
    expect(errorLine(el, "welcome.notice")).toBeNull();
  });

  it("creates the sample in the default location and opens it", async () => {
    await mount();
    await click(button(el, "Open sample rocket"));
    expect(onOpened).toHaveBeenCalledTimes(1);
    expect(mock.snapshot(onOpened.mock.calls[0]![0]).project.dir).toBe(`${MOCK_DEFAULT_LOCATION}/Sample rocket`);
  });

  it("shows a failed sample instead of swallowing it", async () => {
    await mount({}, null, (c) => Object.assign(Object.create(c) as RpcClient, { call: () => Promise.reject(new Error("rw init failed")) }));
    await click(button(el, "Open sample rocket"));
    expect(errorLine(el, "welcome.error")).toContain("rw init failed");
    expect(onOpened).not.toHaveBeenCalled();
    expect(button(el, "New project").disabled).toBe(false);
  });
});

describe("Open folder", () => {
  it("does nothing when the prompt is cancelled", async () => {
    await mount();
    await click(button(el, "Open folder…"));
    const prompt = document.querySelector<HTMLElement>('[data-testid="path-prompt"]')!;
    expect(dialogNamed("Open folder")).toBe(prompt);
    await click(button(prompt, "Cancel"));
    expect(document.querySelector('[data-testid="path-prompt"]')).toBeNull();
    expect(errorLine(el, "welcome.error")).toBeNull();
    expect(dialogNamed("New project")).toBeUndefined();
  });

  it("opens a typed path holding a project", async () => {
    await mount();
    const { project } = await (await RpcClient.connect("ws://mock", { WebSocket: mockSocket(mock) })).call("project.create", { name: "existing", location: "/work" });
    await click(button(el, "Open folder…"));
    await answerPrompt("/work/existing");
    expect(onOpened).toHaveBeenCalledWith(project.projectId);
  });

  it("lists the files in the way of a folder with no project, and offers nothing", async () => {
    await mount();
    await click(button(el, "Open folder…"));
    await answerPrompt("/work/not-a-project");
    expect(errorLine(el, "welcome.error")).toContain("rocket.rw.toml");
    expect(dialogNamed("New project")).toBeUndefined();
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("offers to create in an empty folder, and creates exactly there", async () => {
    await mount();
    await click(button(el, "Open folder…"));
    await answerPrompt("/work/empty-one");
    const dialog = dialogNamed("New project")!;
    expect(dialog.textContent).toContain("/work/empty-one has no RocketWright project");
    expect(field(dialog, "Name").value).toBe("empty-one");
    expect(field(dialog, "Location").value).toBe("/work");
    await click(button(dialog, "Create project"));
    expect(mock.snapshot(onOpened.mock.calls[0]![0]).project.dir).toBe("/work/empty-one");
    expect(dialogNamed("New project")).toBeUndefined();
  });

  it("shows a failed picker", async () => {
    await mount({ pickFolder: () => Promise.reject(new Error("the picker broke")) });
    await click(button(el, "Open folder…"));
    expect(errorLine(el, "welcome.error")).toContain("the picker broke");
  });
});

describe("New project", () => {
  it("defaults to Minimal in the default location, and describes the template", async () => {
    await mount();
    const dialog = await openNewDialog();
    expect(radio(dialog, "Minimal").checked).toBe(true);
    expect(radio(dialog, "Empty").checked).toBe(false);
    expect(dialog.textContent).toContain("Nose, tube, fins, motor mount, and streamer");
    expect(field(dialog, "Location").value).toBe(MOCK_DEFAULT_LOCATION);
    expect(dialog.textContent).toContain(`Creates a folder in ${MOCK_DEFAULT_LOCATION}`);
    expect(document.activeElement).toBe(field(dialog, "Name"));
  });

  it("previews the final path and creates the project with the chosen template", async () => {
    await mount();
    const dialog = await openNewDialog();
    await type(field(dialog, "Name"), " solstice-rocket ");
    expect(dialog.textContent).toContain(`Creates ${MOCK_DEFAULT_LOCATION}/solstice-rocket`);
    await click(radio(dialog, "Simple rocket"));
    expect(radio(dialog, "Simple rocket").checked).toBe(true);
    await click(button(dialog, "Create project"));
    expect(mock.snapshot(onOpened.mock.calls[0]![0]).project.dir).toBe(`${MOCK_DEFAULT_LOCATION}/solstice-rocket`);
    expect(dialogNamed("New project")).toBeUndefined();
  });

  it("uses the location the person chooses", async () => {
    await mount();
    const dialog = await openNewDialog();
    await click(button(dialog, "Choose"));
    await answerPrompt("/work/rockets");
    expect(field(dialog, "Location").value).toBe("/work/rockets");
  });

  it("keeps the location when the choice is cancelled", async () => {
    await mount({ pickFolder: () => Promise.resolve(null) });
    const dialog = await openNewDialog();
    await click(button(dialog, "Choose"));
    expect(field(dialog, "Location").value).toBe(MOCK_DEFAULT_LOCATION);
  });

  it("refuses an empty name with a message, and sends nothing", async () => {
    await mount();
    const dialog = await openNewDialog();
    await click(button(dialog, "Create project"));
    expect(dialog.textContent).toContain("Enter a name.");
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("says what is wrong with a name as it is typed", async () => {
    await mount();
    const dialog = await openNewDialog();
    await type(field(dialog, "Name"), "a/b");
    expect(dialog.textContent).toContain("cannot contain a slash");
  });

  it("refuses an empty location", async () => {
    await mount();
    const dialog = await openNewDialog();
    await type(field(dialog, "Name"), "rocket");
    await type(field(dialog, "Location"), "  ");
    await click(button(dialog, "Create project"));
    expect(dialog.textContent).toContain("Enter a location.");
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("shows the server's refusal in the dialog and lets the person try again", async () => {
    await mount();
    const other = await RpcClient.connect("ws://mock", { WebSocket: mockSocket(mock) });
    await other.call("project.create", { name: "taken" });
    const dialog = await openNewDialog();
    await type(field(dialog, "Name"), "taken");
    await click(button(dialog, "Create project"));
    expect(errorLine(dialog, "new-project.error")).toContain("already holds a project");
    expect(onOpened).not.toHaveBeenCalled();
    await type(field(dialog, "Name"), "free");
    await click(button(dialog, "Create project"));
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it("shows a failed default location and still lets the person type one", async () => {
    await mount({}, null, (c) => {
      const call = c.call.bind(c) as (m: string, p: unknown) => Promise<unknown>;
      return Object.assign(Object.create(c) as RpcClient, { call: (m: string, p: unknown) => (m === "project.defaults" ? Promise.reject(new Error("no documents folder")) : call(m, p)) });
    });
    const dialog = await openNewDialog();
    expect(errorLine(dialog, "new-project.error")).toContain("no documents folder");
    await type(field(dialog, "Name"), "rocket");
    await type(field(dialog, "Location"), "/work");
    await click(button(dialog, "Create project"));
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it("closes without creating on Cancel", async () => {
    await mount();
    const dialog = await openNewDialog();
    await click(button(dialog, "Cancel"));
    expect(dialogNamed("New project")).toBeUndefined();
    expect(onOpened).not.toHaveBeenCalled();
  });
});

describe("Recent", () => {
  const ROW = (over: Partial<RecentProject>): RecentProject => ({ dir: "/work/a", name: "alpha", lastOpened: "2026-01-01T00:00:00.000Z", status: "ok", ...over });

  it("lists recent projects and opens one", async () => {
    await mount({ kind: "desktop", recents: () => Promise.resolve([ROW({})]) });
    expect(el.textContent).toContain("Recent");
    const row = el.querySelector<HTMLElement>('[data-status="ok"]')!;
    expect(row.textContent).toContain("alpha");
    expect(row.textContent).toContain("/work/a");
    await click(row.querySelector("button")!);
    expect(mock.snapshot(onOpened.mock.calls[0]![0]).project.dir).toBe("/work/a");
  });

  it("marks a missing folder, does not open it, and removes it on request", async () => {
    let list = [ROW({ status: "missing" })];
    const removed: string[] = [];
    await mount({
      kind: "desktop",
      recents: () => Promise.resolve(list),
      removeRecent: (dir) => {
        removed.push(dir);
        list = [];
        return Promise.resolve();
      },
    });
    const row = el.querySelector<HTMLElement>('[data-status="missing"]')!;
    expect(row.textContent).toContain("Missing");
    expect(row.querySelector("button")!.disabled).toBe(true);
    await click(button(row, "Remove alpha from Recent"));
    expect(removed).toEqual(["/work/a"]);
    expect(el.querySelector('[data-status="missing"]')).toBeNull();
  });

  it.each([
    ["denied", "No access"],
    ["locked", "In use"],
  ] as const)("a %s project says so, keeps no Remove, and shows why it failed", async (status, text) => {
    await mount({ kind: "desktop", recents: () => Promise.resolve([ROW({ status })]) }, null, (c) => Object.assign(Object.create(c) as RpcClient, { call: () => Promise.reject(new Error("the lock is held")) }));
    const row = el.querySelector<HTMLElement>(`[data-status="${status}"]`)!;
    expect(row.textContent).toContain(text);
    expect(row.querySelectorAll("button")).toHaveLength(1);
    await click(row.querySelector("button")!);
    expect(errorLine(el, "welcome.error")).toContain("the lock is held");
  });

  it("shows a failure to read the list", async () => {
    await mount({ recents: () => Promise.reject(new Error("recents.json is unreadable")) });
    expect(errorLine(el, "welcome.error")).toContain("recents.json is unreadable");
  });
});
