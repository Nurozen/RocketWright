// @vitest-environment jsdom
/** R3.6: the rail's Search and "+", the Agent button, and the Saved cue. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// uPlot reads matchMedia when imported (PropSimPage reaches the plots).
vi.hoisted(() => {
  (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined });
});
import { AddEngineRailButton } from "../pages/liquid/EngineEditor.tsx";
import { createCfdUi } from "../pages/propsim/cfd.tsx";
import { createEngineeringUi } from "../pages/propsim/engineering.tsx";
import { propSimSlots } from "../pages/propsim/PropSimPage.tsx";
import { createVisualUi } from "../pages/propsim/visual.tsx";
import { createAppStore, type AppStore } from "../state/store.ts";
import { AgentPane } from "./AgentPane.tsx";
import { shellModelFrom } from "./connect.ts";
import { LeftRail } from "./LeftRail.tsx";
import type { ShellNavSection } from "./model.ts";
import { useRailSearch } from "./railSearch.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let el: HTMLElement;

beforeEach(() => {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});

afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
});

const nav: ShellNavSection = {
  title: "Components",
  rows: [
    { id: "nose", label: "Nose cone", icon: "nose-cone" },
    { id: "fins", label: "Fin set", icon: "fin-set" },
  ],
};
const rail = { threads: [], selectedThreadId: null, selectedNavId: null, nav };

const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const rowLabels = () => [...document.querySelectorAll('[data-testid="rail.nav-row"] .rw-nav-row__label')].map((n) => n.textContent);

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("rail Search and +", () => {
  it("filters the section's rows and says so when nothing matches", async () => {
    await act(async () => root.render(<LeftRail {...rail} />));
    expect(document.querySelector("input[type=search]")).toBeNull();
    await act(async () => button("Search Components")!.click());
    expect(button("Search Components")!.getAttribute("aria-pressed")).toBe("true");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Filter Components"]')!;
    await type(input, "FIN");
    expect(rowLabels()).toEqual(["Fin set"]);
    await type(input, "zzz");
    expect(rowLabels()).toEqual([]);
    expect(document.querySelector(".rw-rail__nav")!.textContent).toContain("Nothing matches");
    await act(async () => button("Search Components")!.click());
    expect(rowLabels()).toEqual(["Nose cone", "Fin set"]);
  });

  it("hands the text to a page-owned list", async () => {
    function Body() {
      return <p data-testid="body">{`q=${useRailSearch()}`}</p>;
    }
    await act(async () => root.render(<LeftRail {...rail} navBody={<Body />} />));
    await act(async () => button("Search Components")!.click());
    await type(document.querySelector<HTMLInputElement>("input[type=search]")!, " Tube ");
    expect(document.querySelector('[data-testid="body"]')!.textContent).toBe("q=tube");
  });

  it('has no inert "+": only a page-owned add control appears', async () => {
    await act(async () => root.render(<LeftRail {...rail} />));
    expect(button("Add to Components")).toBeNull();
    expect(document.querySelector(".rw-rail__nav .rw-header__sep")).toBeNull();
    await act(async () => root.render(<LeftRail {...rail} navAdd={<button type="button" aria-label="Add part" />} />));
    expect(button("Add part")).not.toBeNull();
    expect(document.querySelector(".rw-rail__nav .rw-header__sep")).not.toBeNull();
  });

  it("starts closed on a page with a different list", async () => {
    await act(async () => root.render(<LeftRail {...rail} />));
    await act(async () => button("Search Components")!.click());
    await act(async () => root.render(<LeftRail {...rail} nav={{ ...nav, title: "Runs" }} />));
    expect(document.querySelector("input[type=search]")).toBeNull();
  });
});

const snapshot = (steps: { seq: number; ts: string }[], configs: Record<string, unknown> = {}) =>
  ({
    project: { name: "P", projectId: "p" },
    history: { steps: steps.map((s) => ({ id: `s${s.seq}`, origin: "user", title: `Step ${s.seq}`, ...s })), revisions: [] },
    files: { files: {} },
    runs: { runs: [] },
    check: null,
    evaluated: { components: [], configs, sims: {}, engines: {} },
  }) as never;

function storeWith(snap: never, mutate?: () => unknown): AppStore {
  const store = createAppStore();
  store.setState((s) => ({ project: { ...s.project, snapshot: snap }, ...(mutate ? { draft: { ...s.draft, mutate: mutate as never } } : {}) }));
  return store;
}

describe("Saved cue (R3.6)", () => {
  const NOW = Date.parse("2026-11-08T12:00:00Z");

  it("reads the head step, not the last push", () => {
    const store = storeWith(snapshot([{ seq: 1, ts: "2026-11-08T09:00:00Z" }, { seq: 2, ts: "2026-11-08T11:30:00Z" }]));
    expect(shellModelFrom(store.getState(), NOW).saveState).toBe("Saved 30 minutes ago");
  });

  it("says not saved with no history", () => {
    expect(shellModelFrom(storeWith(snapshot([])).getState(), NOW).saveState).toBe("Not saved yet");
  });
});

describe("Agent button", () => {
  it("is a plain button: no popup role and no chevron", async () => {
    const onOpenSettings = vi.fn<() => void>();
    await act(async () => root.render(<AgentPane title="T" onOpenSettings={onOpenSettings} />));
    const b = document.querySelector<HTMLButtonElement>('[data-testid="agent.model-picker"]')!;
    expect(b.hasAttribute("aria-haspopup")).toBe(false);
    expect(b.textContent).toBe("Agent");
    await act(async () => b.click());
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});

describe("page rail + buttons", () => {
  it("adds an engine and shows it", async () => {
    const mutate = vi.fn<() => Promise<{ model_hash: null }>>(async () => ({ model_hash: null }));
    const store = storeWith(snapshot([]), mutate as never);
    const onShow = vi.fn<(id: string) => void>();
    await act(async () => root.render(<AddEngineRailButton app={store} onShow={onShow} />));
    await act(async () => button("Add engine")!.click());
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("New simulation goes to Results and is disabled without a configuration", async () => {
    const store = storeWith(snapshot([], {}));
    const slots = propSimSlots(store, null, "", createEngineeringUi(), createVisualUi(), createCfdUi(), null, null);
    await act(async () => root.render(slots.navAdd));
    expect(button("New simulation")!.disabled).toBe(true);
    await act(async () => store.setState((s) => ({ project: { ...s.project, snapshot: snapshot([], { base: {} }) } })));
    expect(button("New simulation")!.disabled).toBe(false);
    const navigate = vi.spyOn(store.getState().ui, "navigate");
    await act(async () => button("New simulation")!.click());
    expect(navigate).toHaveBeenCalledWith("results");
  });
});
