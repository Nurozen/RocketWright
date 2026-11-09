import { DESKTOP_COMMAND_IDS } from "@rw/contracts";
import { describe, expect, it, vi } from "vitest";
import { APP_COMMANDS, browserShortcut, dispatchCommand } from "./commands.ts";

describe("app commands", () => {
  it("has one labelled entry for every native menu command", () => {
    expect(APP_COMMANDS.map((c) => c.id).sort()).toEqual([...DESKTOP_COMMAND_IDS].sort());
    expect(APP_COMMANDS.every((c) => c.label !== "")).toBe(true);
  });

  it("passes the command to its handler and reports an unhandled one", () => {
    const openRecent = vi.fn<(c: { id: "project.openRecent"; dir: string }) => void>();
    expect(dispatchCommand({ id: "project.openRecent", dir: "/p" }, { "project.openRecent": openRecent })).toBe(true);
    expect(openRecent).toHaveBeenCalledWith({ id: "project.openRecent", dir: "/p" });
    expect(dispatchCommand({ id: "project.new" }, { "project.openRecent": openRecent })).toBe(false);
  });

  describe("in a browser tab", () => {
    const key = (k: string, over: Partial<KeyboardEvent> = {}) => ({ key: k, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, ...over });

    it("takes the keys a page can have", () => {
      expect(browserShortcut(key("o"))).toEqual({ id: "project.open" });
      expect(browserShortcut(key("O", { metaKey: false, ctrlKey: true }))).toEqual({ id: "project.open" });
      expect(browserShortcut(key(","))).toEqual({ id: "app.settings" });
    });

    it("drops what the browser keeps for itself, and tab switching", () => {
      for (const k of ["n", "w", "t", "1", "4"]) expect(browserShortcut(key(k)), k).toBeNull();
    });

    it("needs the modifier alone", () => {
      expect(browserShortcut(key("o", { metaKey: false }))).toBeNull();
      expect(browserShortcut(key("o", { shiftKey: true }))).toBeNull();
      expect(browserShortcut(key("o", { altKey: true }))).toBeNull();
    });
  });
});
