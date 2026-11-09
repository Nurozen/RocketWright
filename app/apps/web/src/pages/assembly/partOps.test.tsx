// @vitest-environment jsdom
/** U48: what a delete takes with it, where a part can move, and the controls that do it. */
import type { schema } from "@rw/contracts";
import { MockRpc } from "@rw/contracts/mock";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedShell } from "../../shell/ConnectedShell.tsx";
import { RENAME_OUTDATES_RUNS } from "../../shell/RenameProjectDialog.tsx";
import type { RpcLike } from "../../state/rpc.ts";
import { createAppStore, type AppStore } from "../../state/store.ts";
import { ComponentTreeSlot } from "./AssemblyPage.tsx";
import { partMenuItems } from "./PartActions.tsx";
import { attachedParts, deleteKeyTarget, deletePart, isPartDeleteKey, moveTargets, overlayOpen, removalSet, renameOps } from "./partOps.ts";

vi.mock("../../embed/EmbedPane.tsx", () => ({ EmbedPane: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Part = schema.EvalComponent;

const ANCHORS = ["fore", "aft", "mid", "inner", "base"].map((name) => ({ name, x: 0, r: 0 }));
function part(id: string, type: string, to?: string, parent?: string): Part {
  return { id, name: id.toUpperCase(), shape: { type }, anchors: ANCHORS, ...(to === undefined ? {} : { attach: { to: `${to}.aft` } }), ...(parent ?? to ? { parent: parent ?? to } : {}) } as unknown as Part;
}

/** A nose, two stacked tubes, and contents; the ring is against the motor tube but nests under the body. */
const ROCKET: Part[] = [
  part("nose", "nose_cone"),
  part("upper", "body_tube", "nose"),
  part("lower", "body_tube", "upper"),
  part("fins", "trapezoidal_fin_set", "lower"),
  part("mount", "inner_tube", "lower"),
  part("ring", "centering_ring", "mount", "lower"),
  part("chute", "parachute", "upper"),
];

describe("removalSet", () => {
  it("follows attachments through every level", () => {
    expect(removalSet(ROCKET, "upper").sort()).toEqual(["chute", "fins", "lower", "mount", "ring", "upper"]);
  });

  it("follows the attach target, not the tree parent", () => {
    expect(removalSet(ROCKET, "mount").sort()).toEqual(["mount", "ring"]);
  });

  it("is only the part when nothing attaches to it", () => {
    expect(removalSet(ROCKET, "fins")).toEqual(["fins"]);
  });

  it("terminates on an attachment cycle", () => {
    expect(removalSet([part("a", "body_tube", "b"), part("b", "body_tube", "a")], "a").sort()).toEqual(["a", "b"]);
  });

  it("lists what goes with a part in model order, without the part", () => {
    expect(attachedParts(ROCKET, "lower").map((c) => c.id)).toEqual(["fins", "mount", "ring"]);
  });
});

describe("moveTargets", () => {
  const targets = (id: string, parts: Part[] = ROCKET) => moveTargets(parts, id).map((t) => t.id);

  it("never offers the part or anything attached below it", () => {
    const out = targets("upper");
    for (const below of ["upper", "lower", "fins", "mount", "ring", "chute"]) expect(out).not.toContain(below);
  });

  it("excludes a tree child even when it is attached elsewhere", () => {
    const parts = [part("body", "body_tube"), part("other", "inner_tube", "body"), part("kid", "inner_tube", "other", "mover"), part("mover", "inner_tube", "body")];
    expect(targets("mover", parts)).not.toContain("kid");
  });

  it("leaves out the part it is already on", () => {
    expect(targets("fins")).not.toContain("lower");
    expect(targets("fins")).toContain("upper");
  });

  it("offers only parts that can hold its kind", () => {
    expect(targets("fins")).not.toContain("chute");
  });

  it("gives the attachment the part will take", () => {
    expect(moveTargets(ROCKET, "fins").find((t) => t.id === "upper")?.attach).toMatchObject({ to: "upper.aft" });
  });

  it("is empty for a nose cone, which no part can hold, and for an unknown part", () => {
    expect(targets("nose")).toEqual([]);
    expect(targets("gone")).toEqual([]);
  });

  it("terminates on a cycle", () => {
    expect(targets("a", [part("a", "inner_tube", "b"), part("b", "inner_tube", "a"), part("c", "body_tube")])).toEqual(["c"]);
  });
});

it("renameOps writes only the display name, keeping the id", () => {
  expect(renameOps("fins", "  Big fins ")).toEqual([{ op: "add", path: "/c/fins/name", value: "Big fins" }]);
});

describe("isPartDeleteKey", () => {
  const ev = (key: string, tagName = "BODY", mods: Partial<KeyboardEvent> = {}, extra: object = {}) =>
    ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods, target: { tagName, ...extra } as unknown as EventTarget });

  it("takes Delete and macOS's Backspace", () => {
    expect(isPartDeleteKey(ev("Delete"))).toBe(true);
    expect(isPartDeleteKey(ev("Backspace"))).toBe(true);
    expect(isPartDeleteKey(ev("a"))).toBe(false);
  });

  it("leaves editable controls alone", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) expect(isPartDeleteKey(ev("Backspace", tag))).toBe(false);
    expect(isPartDeleteKey(ev("Delete", "DIV", {}, { isContentEditable: true }))).toBe(false);
  });

  it("leaves a chord alone", () => {
    expect(isPartDeleteKey(ev("Backspace", "BODY", { metaKey: true }))).toBe(false);
    expect(isPartDeleteKey(ev("Delete", "BODY", { shiftKey: true }))).toBe(false);
  });
});

it("overlayOpen sees a menu or dialog", () => {
  const box = document.createElement("div");
  document.body.append(box);
  expect(overlayOpen(document)).toBe(false);
  box.setAttribute("role", "menu");
  expect(overlayOpen(document)).toBe(true);
  box.remove();
});

let root: Root | null = null;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function render(ui: ReactNode): void {
  act(() => {
    root ??= createRoot(host);
    root.render(ui);
  });
}

type Call = { method: string; params: Record<string, unknown> };

function setup(components: Part[] = ROCKET, respond: (c: Call) => Promise<unknown> = () => Promise.resolve({ step: "step:9" })): { store: AppStore; client: RpcLike; calls: Call[] } {
  const store = createAppStore();
  const snapshot = new MockRpc().snapshot();
  store.setState((s) => ({ ...s, project: { ...s.project, projectId: "p", connection: "open", snapshot: { ...snapshot, evaluated: { ...snapshot.evaluated!, components } } as never } }));
  const calls: Call[] = [];
  const client = {
    call: (method: string, params: Record<string, unknown>) => {
      if (method === "project.list") return Promise.resolve({ projects: [] });
      if (method === "component.remove" || method === "model.patch") {
        const c = { method, params };
        calls.push(c);
        return respond(c);
      }
      return Promise.resolve({});
    },
    on: () => () => undefined,
  } as unknown as RpcLike;
  // The real draft actions are covered in `state/mutate.test.ts`; here they only record the call.
  const send = (method: string, p: Record<string, unknown>) => (client as unknown as { call: (m: string, p: Record<string, unknown>) => Promise<never> }).call(method, { projectId: "p", ...p });
  store.setState((s) => ({
    ...s,
    draft: {
      ...s.draft,
      mutate: (ops, label) => send("model.patch", { ops: [...ops], label }),
      removeComponent: (id, label) => send("component.remove", { id, recursive: true, label }),
    },
  }));
  return { store, client, calls };
}

const select = (store: AppStore, ...ids: string[]) => store.getState().selection.select(ids.map((id) => `rw:c/${id}` as const), "tree");
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (name: string, within: ParentNode = document) => [...within.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);
const press = (key: string, target: EventTarget = window) => act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));

describe("deletePart", () => {
  it("asks the sidecar to cascade, as one call, and forgets the removed parts", async () => {
    const { store, calls } = setup();
    select(store, "lower", "ring", "nose");
    act(() => store.getState().ui.toggleHidden("fins"));
    act(() => store.getState().ui.toggleHidden("nose"));
    await act(() => deletePart(store, "lower"));
    expect(calls).toEqual([{ method: "component.remove", params: { projectId: "p", id: "lower", recursive: true, label: "Delete LOWER" } }]);
    expect(store.getState().selection.refs).toEqual(["rw:c/nose"]);
    expect(store.getState().ui.hidden).toEqual(["nose"]);
  });

  it("keeps the selection when the delete fails", async () => {
    const { store } = setup(ROCKET, () => Promise.reject(new Error("no")));
    select(store, "lower");
    await expect(deletePart(store, "lower")).rejects.toThrow("no");
    expect(store.getState().selection.refs).toEqual(["rw:c/lower"]);
  });
});

describe("the menu", () => {
  const items = (store: AppStore, id: string, parts: Part[] = ROCKET) => partMenuItems(store, parts as never, id);
  const labels = (list: ReturnType<typeof items>) => list.flatMap((e) => (e.kind === "divider" || e.kind === "heading" ? [] : [e.label]));
  const item = (list: ReturnType<typeof items>, id: string) => list.find((e) => e.id === id) as Extract<ReturnType<typeof items>[number], { label: string; kind?: "item" }>;

  it("offers the four operations, with Delete in the danger colour", () => {
    const { store } = setup();
    const list = items(store, "fins");
    expect(labels(list)).toEqual(["Rename", "Duplicate", "Move to", "Delete"]);
    expect(item(list, "delete").danger).toBe(true);
  });

  it("gives each operation a leading icon", () => {
    const { store } = setup();
    const list = items(store, "fins");
    expect(["rename", "duplicate", "move", "delete"].map((id) => item(list, id).icon !== undefined)).toEqual([true, true, true, true]);
  });

  it("lists Move to targets without descendants, and disables it for a root nose cone", () => {
    const { store } = setup();
    expect(item(items(store, "upper"), "move").submenu?.map((e) => e.id)).not.toContain("lower");
    expect(item(items(store, "nose"), "move").disabled).toBe(true);
  });

  it("disables Duplicate where a copy could not attach", () => {
    const { store } = setup();
    expect(item(items(store, "nose"), "duplicate").disabled).toBe(true);
    expect(item(items(store, "fins"), "duplicate").disabled).toBe(false);
  });

  it("moves through one patch of the attachment", async () => {
    const { store, calls } = setup();
    const upper = (item(items(store, "fins"), "move").submenu as readonly { id: string; onSelect?: () => void }[]).find((e) => e.id === "upper")!;
    await act(async () => upper.onSelect!());
    expect(calls[0]).toMatchObject({ method: "model.patch", params: { ops: [{ op: "add", path: "/c/fins/attach", value: { to: "upper.aft" } }] } });
  });

  it("says when an operation fails", async () => {
    const { store } = setup(ROCKET, () => Promise.reject(new Error("the model refused")));
    await act(async () => item(items(store, "fins"), "duplicate").onSelect!());
    expect(store.getState().ui.partDialog).toEqual({ kind: "error", title: "Could not duplicate the part", message: "the model refused" });
  });
});

describe("the tree's context menu", () => {
  const row = (id: string) => document.querySelector<HTMLElement>(`[role="treeitem"][data-part="${id}"]`)!;
  const rightClick = (el: HTMLElement) => {
    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 80, button: 2 });
    act(() => void el.dispatchEvent(e));
    return e;
  };
  const menu = () => document.querySelector('[data-testid="tree.context-menu.list"]');

  it("opens on a row, replaces the browser's menu, and selects the row", () => {
    const { store } = setup();
    render(<ComponentTreeSlot store={store} />);
    expect(rightClick(row("fins")).defaultPrevented).toBe(true);
    expect([...menu()!.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent)).toEqual(["Rename", "Duplicate", "Move to", "Delete"]);
    expect(menu()!.querySelector('[data-item="delete"]')!.getAttribute("data-danger")).toBe("true");
    expect(store.getState().selection.refs).toEqual(["rw:c/fins"]);
  });

  it("keeps a multi-selection the row is part of", () => {
    const { store } = setup();
    select(store, "fins", "mount");
    render(<ComponentTreeSlot store={store} />);
    rightClick(row("mount"));
    expect(store.getState().selection.refs).toEqual(["rw:c/fins", "rw:c/mount"]);
  });
});

describe("the dialogs and the Delete key, in the shell", () => {
  function shell(components: Part[] = ROCKET, respond?: (c: Call) => Promise<unknown>) {
    const ctx = setup(components, respond);
    render(<ConnectedShell store={ctx.store} client={ctx.client} />);
    return ctx;
  }

  it("Delete asks first, naming what goes with the part, and focuses Cancel", async () => {
    const { store, calls } = shell();
    select(store, "lower");
    press("Delete");
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Delete LOWER?");
    expect([...dialog()!.querySelectorAll("li")].map((l) => l.textContent)).toEqual(["FINS", "MOUNT", "RING"]);
    expect(calls).toEqual([]);
    expect(document.activeElement).toBe(button("Cancel", dialog()!));
    await act(async () => button("Delete", dialog()!)!.click());
    expect(calls[0]).toMatchObject({ method: "component.remove", params: { id: "lower", recursive: true } });
    expect(dialog()).toBeNull();
    expect(store.getState().selection.refs).toEqual([]);
  });

  it("leaves a key a control already handled alone (the fin outline's Delete)", () => {
    const { store } = shell();
    select(store, "fins");
    const el = document.createElement("div");
    el.tabIndex = 0;
    document.body.append(el);
    el.addEventListener("keydown", (e) => e.preventDefault());
    press("Delete", el);
    expect(dialog()).toBeNull();
    el.remove();
  });

  it("Backspace works too, and a part with nothing attached lists nothing", () => {
    const { store } = shell();
    select(store, "fins");
    press("Backspace");
    expect(dialog()?.querySelector("ul")).toBeNull();
  });

  it("keeps the dialog open and says why when the delete fails", async () => {
    const { store } = shell(ROCKET, () => Promise.reject(new Error("sidecar said no")));
    select(store, "fins");
    press("Delete");
    await act(async () => button("Delete", dialog()!)!.click());
    expect(dialog()?.textContent).toContain("sidecar said no");
  });

  it("does nothing in a text field, on a page without the tree, under Compare, or with no part", () => {
    const { store } = shell();
    press("Delete");
    expect(dialog()).toBeNull();
    select(store, "fins");

    const input = document.createElement("input");
    document.body.append(input);
    press("Backspace", input);
    expect(dialog()).toBeNull();
    input.remove();

    act(() => store.getState().ui.navigate("results"));
    expect(deleteKeyTarget(store.getState())).toBeNull();
    press("Delete");
    expect(dialog()).toBeNull();
    act(() => store.getState().ui.navigate("assembly"));

    act(() => store.getState().ui.setCompare({ old: "step:1", new: "live" }));
    press("Delete");
    expect(dialog()).toBeNull();
  });

  it("does not stack a second dialog over an open menu or dialog", () => {
    const { store } = shell();
    select(store, "fins");
    press("Delete");
    const first = dialog();
    press("Delete");
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(dialog()).toBe(first);
  });

  it("Rename warns with the project dialog's words, and patches only the name", async () => {
    const { store, calls } = shell();
    act(() => store.getState().ui.setPartDialog({ kind: "rename", id: "fins" }));
    expect(dialog()?.textContent).toContain(RENAME_OUTDATES_RUNS);
    const input = dialog()!.querySelector("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Big fins");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Rename", dialog()!)!.click());
    expect(calls[0]?.params).toMatchObject({ ops: [{ op: "add", path: "/c/fins/name", value: "Big fins" }] });
    expect(dialog()).toBeNull();
  });

  it("Rename to the same name writes nothing, and an empty name is refused", async () => {
    const { store, calls } = shell();
    act(() => store.getState().ui.setPartDialog({ kind: "rename", id: "fins" }));
    await act(async () => button("Rename", dialog()!)!.click());
    expect(calls).toEqual([]);
    expect(dialog()).toBeNull();

    act(() => store.getState().ui.setPartDialog({ kind: "rename", id: "fins" }));
    const input = dialog()!.querySelector("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Rename", dialog()!)!.click());
    expect(calls).toEqual([]);
    expect(dialog()?.textContent).toContain("Enter a name.");
  });

  it("closes when the part goes away under the dialog", () => {
    const { store } = shell();
    act(() => store.getState().ui.setPartDialog({ kind: "delete", id: "fins" }));
    expect(dialog()).not.toBeNull();
    act(() =>
      store.setState((s) => ({ ...s, project: { ...s.project, snapshot: { ...s.project.snapshot!, evaluated: { ...s.project.snapshot!.evaluated!, components: ROCKET.filter((c) => c.id !== "fins") } } as never } })),
    );
    expect(dialog()).toBeNull();
    expect(store.getState().ui.partDialog).toBeNull();
  });
});
