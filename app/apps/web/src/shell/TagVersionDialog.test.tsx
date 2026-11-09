// @vitest-environment jsdom
/** U63: naming a design step from the history strip's menu. */
import { MockRpc } from "@rw/contracts/mock";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcLike } from "../state/rpc.ts";
import { createAppStore } from "../state/store.ts";
import { ConnectedShell } from "./ConnectedShell.tsx";
import { HistoryStrip } from "./HistoryStrip.tsx";
import type { ShellHistoryStep } from "./model.ts";
import { TagVersionDialog } from "./TagVersionDialog.tsx";

vi.mock("../embed/EmbedPane.tsx", () => ({ EmbedPane: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

async function render(ui: ReactNode): Promise<void> {
  await act(async () => {
    root ??= createRoot(host);
    root.render(ui);
  });
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (name: string, within: ParentNode = document) => [...within.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);
const menuItem = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.trim() === name);
const openMenu = () => act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="History menu"]')!.click());
/** The input a visible label names, as `getByLabel` finds it. */
const field = (label: string) => document.getElementById([...document.querySelectorAll("label")].find((l) => l.textContent === label)!.htmlFor) as HTMLInputElement;
function type(input: HTMLInputElement, value: string) {
  return act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const STEP: ShellHistoryStep = { id: "step:4", number: 4, name: "Fins", date: "Oct 1", ref: "rw:step/4" };

describe("the history menu", () => {
  it("offers Tag for the step and closes when chosen", async () => {
    const onTag = vi.fn<() => void>();
    await render(<HistoryStrip steps={[STEP]} currentStepId="step:4" tagLabel="Tag Step 04…" onTag={onTag} />);
    await openMenu();
    await act(async () => menuItem("Tag Step 04…")!.click());
    expect(onTag).toHaveBeenCalledOnce();
    expect(menuItem("Tag Step 04…")).toBeUndefined();
  });

  it("disables Tag when there is no step", async () => {
    await render(<HistoryStrip steps={[]} currentStepId={null} onTag={() => undefined} />);
    await openMenu();
    expect(menuItem("Tag a step (no steps yet)")!.disabled).toBe(true);
  });
});

describe("TagVersionDialog", () => {
  it("names the step, needs a name, and sends it trimmed", async () => {
    const onTag = vi.fn<(name: string) => Promise<unknown>>(() => Promise.resolve({}));
    const onClose = vi.fn<() => void>();
    await render(<TagVersionDialog versionLabel="Step 04" onTag={onTag} onClose={onClose} />);
    expect(dialog()!.querySelector("h2")?.textContent).toBe("Tag Step 04");
    expect(button("Tag", dialog()!)!.disabled).toBe(true);
    expect(document.activeElement).toBe(field("Revision name"));
    await type(field("Revision name"), "   ");
    expect(button("Tag", dialog()!)!.disabled).toBe(true);
    await type(field("Revision name"), "  Flight ready ");
    await act(async () => button("Tag", dialog()!)!.click());
    expect(onTag).toHaveBeenCalledExactlyOnceWith("Flight ready");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the name and shows why when tagging fails", async () => {
    const onClose = vi.fn<() => void>();
    await render(<TagVersionDialog versionLabel="Step 04" onTag={() => Promise.reject(new Error("the project is read only"))} onClose={onClose} />);
    await type(field("Revision name"), "Flight ready");
    await act(async () => button("Tag", dialog()!)!.click());
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()!.textContent).toContain("the project is read only");
    expect(field("Revision name").value).toBe("Flight ready");
    expect(button("Tag", dialog()!)!.disabled).toBe(false);
  });

  it("cannot be dismissed while the tag is being written", async () => {
    let finish: () => void = () => undefined;
    const onClose = vi.fn<() => void>();
    await render(<TagVersionDialog versionLabel="Step 04" onTag={() => new Promise<void>((ok) => (finish = ok))} onClose={onClose} />);
    await type(field("Revision name"), "Flight ready");
    await act(async () => button("Tag", dialog()!)!.click());
    expect(button("Cancel", dialog()!)!.disabled).toBe(true);
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("in the shell", () => {
  function shell() {
    const store = createAppStore();
    store.setState((s) => ({ ...s, project: { ...s.project, projectId: "p", connection: "open", snapshot: new MockRpc().snapshot() as never } }));
    const calls: { method: string; params: unknown }[] = [];
    const client = {
      call: (method: string, params: unknown) => {
        if (method === "project.list") return Promise.resolve({ projects: [] });
        calls.push({ method, params });
        return Promise.resolve({});
      },
      on: () => () => undefined,
    } as unknown as RpcLike;
    return { store, client, calls };
  }

  it("tags the selected step through history.tag", async () => {
    const { store, client, calls } = shell();
    const steps = store.getState().project.snapshot!.history!.steps;
    const target = steps[0]!.seq;
    await render(<ConnectedShell store={store} client={client} />);
    await act(async () => store.getState().selection.select([`rw:step/${target}`], "history"));
    await openMenu();
    const label = `Tag Step ${String(target).padStart(2, "0")}…`;
    await act(async () => menuItem(label)!.click());
    expect(dialog()!.querySelector("h2")?.textContent).toBe(label.slice(0, -1));
    await type(field("Revision name"), "Baseline");
    await act(async () => button("Tag", dialog()!)!.click());
    expect(calls.filter((c) => c.method === "history.tag")).toEqual([{ method: "history.tag", params: { projectId: "p", name: "Baseline", version: `step:${target}` } }]);
    expect(dialog()).toBeNull();
  });
});
