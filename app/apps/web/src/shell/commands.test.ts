import { DESKTOP_COMMAND_IDS } from "@rw/contracts";
import { describe, expect, it, vi } from "vitest";
import { APP_COMMANDS, dispatchCommand } from "./commands.ts";

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
});
