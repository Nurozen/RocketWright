// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let el: HTMLElement;

beforeEach(() => {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  el.remove();
  vi.restoreAllMocks();
});

const state = { broken: true };
function Page() {
  if (state.broken) throw new Error("no such part");
  return <p>the page</p>;
}

describe("ErrorBoundary", () => {
  it("says what broke instead of blanking the window, and Try again renders it again", async () => {
    state.broken = true;
    await act(async () => {
      root!.render(
        <ErrorBoundary>
          <Page />
        </ErrorBoundary>,
      );
    });
    expect(el.querySelector('[data-testid="page.error"]')?.textContent).toContain("no such part");
    state.broken = false;
    await act(async () => [...el.querySelectorAll("button")].find((b) => b.textContent === "Try again")!.click());
    expect(el.textContent).toBe("the page");
  });

  it("renders its children when nothing throws", async () => {
    state.broken = false;
    await act(async () => {
      root!.render(
        <ErrorBoundary>
          <Page />
        </ErrorBoundary>,
      );
    });
    expect(el.textContent).toBe("the page");
    expect(el.querySelector('[data-testid="page.error"]')).toBeNull();
  });

  it("a new key clears the failure, so leaving a broken page starts the next one clean", async () => {
    state.broken = true;
    await act(async () => {
      root!.render(
        <ErrorBoundary key="a">
          <Page />
        </ErrorBoundary>,
      );
    });
    expect(el.querySelector('[data-testid="page.error"]')).not.toBeNull();
    state.broken = false;
    await act(async () => {
      root!.render(
        <ErrorBoundary key="b">
          <Page />
        </ErrorBoundary>,
      );
    });
    expect(el.textContent).toBe("the page");
  });
});
