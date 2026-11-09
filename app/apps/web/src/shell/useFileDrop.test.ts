// @vitest-environment jsdom
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { DROP_NEEDS_DESKTOP, DROP_ONE_FILE, readDrop, useFileDrop } from "./useFileDrop.ts";

const file = new Blob(["x"]) as File;
const desktop = { pathForFile: () => "/dropped/a.ork" };
const browser = { pathForFile: () => null };

function dragEvent(type: string, types: string[], files: File[] = []): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { types, files, dropEffect: "none" } });
  return e;
}

describe("readDrop", () => {
  it("gives the one dropped file's path", () => {
    expect(readDrop([file], desktop)).toEqual({ path: "/dropped/a.ork" });
  });

  it("refuses several files, or none", () => {
    expect(readDrop([file, file], desktop)).toEqual({ refused: DROP_ONE_FILE });
    expect(readDrop([], desktop)).toEqual({ refused: DROP_ONE_FILE });
  });

  it("says a browser cannot give a dropped file's path (D18)", () => {
    expect(readDrop([file], browser)).toEqual({ refused: DROP_NEEDS_DESKTOP });
  });
});

describe("useFileDrop", () => {
  async function mounted(host = desktop as { pathForFile: () => string | null }) {
    const target = new EventTarget() as unknown as Window;
    const onPath = vi.fn<(path: string) => void>();
    const onRefused = vi.fn<(message: string) => void>();
    const Probe = () => {
      useFileDrop(target, host, onPath, onRefused);
      return null;
    };
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    return { target, onPath, onRefused, root };
  }

  it("cancels a file drag so the window cannot navigate to it, and imports the drop", async () => {
    const { target, onPath, root } = await mounted();
    const over = dragEvent("dragover", ["Files"]);
    target.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    const drop = dragEvent("drop", ["Files"], [file]);
    target.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(onPath.mock.calls).toEqual([["/dropped/a.ork"]]);
    await act(async () => root.unmount());
  });

  it("leaves a text drag for the field under it", async () => {
    const { target, onPath, onRefused, root } = await mounted();
    const over = dragEvent("dragover", ["text/plain"]);
    target.dispatchEvent(over);
    const drop = dragEvent("drop", ["text/plain"]);
    target.dispatchEvent(drop);
    expect(over.defaultPrevented).toBe(false);
    expect(drop.defaultPrevented).toBe(false);
    expect(onPath).not.toHaveBeenCalled();
    expect(onRefused).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("still cancels a browser's drop, and says why it did nothing", async () => {
    const { target, onPath, onRefused, root } = await mounted(browser);
    const drop = dragEvent("drop", ["Files"], [file]);
    target.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(onPath).not.toHaveBeenCalled();
    expect(onRefused.mock.calls).toEqual([[DROP_NEEDS_DESKTOP]]);
    await act(async () => root.unmount());
  });

  it("stops listening when unmounted", async () => {
    const { target, onPath, root } = await mounted();
    await act(async () => root.unmount());
    target.dispatchEvent(dragEvent("drop", ["Files"], [file]));
    expect(onPath).not.toHaveBeenCalled();
  });
});
