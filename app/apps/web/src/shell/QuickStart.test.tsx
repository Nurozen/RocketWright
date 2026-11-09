// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Header } from "./Header.tsx";
import { QuickStart } from "./QuickStart.tsx";

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

describe("quick start", () => {
  it("walks through a first flight and closes", async () => {
    const onClose = vi.fn<() => void>();
    await act(async () => root.render(<QuickStart onClose={onClose} />));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector("h2")?.textContent).toBe("Quick start");
    expect(dialog.querySelectorAll("ol li").length).toBeGreaterThanOrEqual(5);
    expect(dialog.textContent).toContain("Check model");
    await act(async () => [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Done")!.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("opens from the header's Help button", async () => {
    const onOpenHelp = vi.fn<() => void>();
    await act(async () =>
      root.render(<Header projectName="Demo" saveState="Saved" activeTab="design" check={{ status: "ok", issues: 0 }} onOpenHelp={onOpenHelp} />),
    );
    await act(async () => (el.querySelector('[data-testid="header.help"]') as HTMLButtonElement).click());
    expect(onOpenHelp).toHaveBeenCalledOnce();
  });
});
