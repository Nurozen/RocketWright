// @vitest-environment jsdom
/** The plot tabs beside the Simulation conditions sheet: the ones that do not fit are reachable under More. */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlotTabId } from "../../plots/quantities.ts";
import { PlotTabs } from "./PlotTabs.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/** Every tab and More are 100 wide; the row is `rowWidth` wide from x = 0. */
function layout(rowWidth: number): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const width = this.classList.contains("rw-plot-bar") ? rowWidth : this.classList.contains("rw-plot-tabs") ? 0 : 100;
    return { left: 0, right: width, top: 0, bottom: 32, width, height: 32, x: 0, y: 0, toJSON: () => ({}) };
  });
}

function Harness() {
  const [active, setActive] = useState<PlotTabId>("altitude");
  return <PlotTabs active={active} onSelect={setActive} />;
}

async function mount(): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness />));
}

const onRow = (): (string | null)[] => [...document.querySelectorAll('[data-testid="plot.tab"]:not([data-overflow])')].map((t) => t.textContent);
const more = (): HTMLElement => document.querySelector<HTMLElement>('[data-testid="plot.more"]')!;

describe("PlotTabs", () => {
  it("shows every tab with More out of the way when they fit", async () => {
    layout(900);
    await mount();
    expect(onRow()).toHaveLength(9);
    expect(document.querySelector(".rw-plot-more")?.getAttribute("data-overflow")).toBe("none");
  });

  it("keeps the tabs that fit, and offers the rest under More by name", async () => {
    layout(400);
    await mount();
    expect(onRow()).toEqual(["Altitude", "Velocity", "Acceleration"]);
    expect(document.querySelector(".rw-plot-more")?.getAttribute("data-overflow")).toBe("more");
    await act(async () => more().click());
    expect([...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((i) => i.textContent)).toEqual(["Stability", "Mach", "Drag coefficient", "Mass", "Thrust", "Lateral distance"]);
  });

  it("brings a tab picked from More onto the row, selected", async () => {
    layout(400);
    await mount();
    await act(async () => more().click());
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === "Thrust")?.click());
    expect(onRow()).toEqual(["Altitude", "Velocity", "Thrust"]);
    expect(document.querySelector('[data-tab="thrust"]')?.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector('[data-tab="thrust"]')?.hasAttribute("data-overflow")).toBe(false);
  });
});
