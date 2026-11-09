import type { DesktopCommand, RecentProject } from "@rw/contracts";
import { describe, expect, it, vi } from "vitest";
import type { MenuEntry, MenuItem } from "../ui/Menu.tsx";
import type { ProjectMenuModel } from "./model.ts";
import { projectMenuEntries, type ProjectMenuInput } from "./projectMenu.ts";

const recent = (name: string, status: RecentProject["status"] = "ok"): RecentProject => ({ dir: `/p/${name}`, name, lastOpened: "2026-01-01T00:00:00.000Z", status });

function model(over: Partial<ProjectMenuModel> = {}): ProjectMenuModel {
  return { recents: [], errors: [], onOpen: () => undefined, onCommand: vi.fn<(c: DesktopCommand) => void>(), onRemoveRecent: vi.fn<(dir: string) => void>(), ...over };
}

function entries(over: Partial<ProjectMenuInput> = {}): MenuEntry[] {
  return projectMenuEntries({ projects: [], projectId: "a", projectName: "Solstice", menu: model(), onSwitch: () => undefined, ...over });
}

const texts = (list: MenuEntry[]) => list.map((e) => (e.kind === "divider" ? "---" : e.label));
const item = (list: MenuEntry[], label: string) => list.find((e) => e.kind !== "divider" && e.label === label) as MenuItem;

describe("the header's project menu", () => {
  it("follows the mockup: current project, Recent, then the commands", () => {
    const list = entries({ menu: model({ recents: [recent("weekend-flyer"), recent("altitude-study")] }) });
    expect(texts(list)).toEqual(["Solstice", "---", "Recent", "weekend-flyer", "altitude-study", "---", "New project…", "Open folder…", "Open sample rocket", "Rename project…", "Close project"]);
    expect(item(list, "Solstice").checked).toBe(true);
    expect(item(list, "New project…").gutter).toBe(false);
  });

  it("leaves Recent out when there is none", () => {
    expect(texts(entries())).toEqual(["Solstice", "---", "New project…", "Open folder…", "Open sample rocket", "Rename project…", "Close project"]);
  });

  it("puts the shown project first under its live name, then the other open ones", () => {
    const onSwitch = vi.fn<(id: string) => void>();
    const list = entries({ projects: [{ id: "b", name: "Other" }, { id: "a", name: "Old name" }], onSwitch });
    expect(texts(list).slice(0, 2)).toEqual(["Solstice", "Other"]);
    item(list, "Solstice").onSelect?.();
    expect(onSwitch).not.toHaveBeenCalled();
    item(list, "Other").onSelect?.();
    expect(onSwitch).toHaveBeenCalledWith("b");
  });

  it("sends every command through the one table", () => {
    const menu = model({ recents: [recent("weekend-flyer")] });
    const list = entries({ menu });
    item(list, "Close project").onSelect?.();
    item(list, "Rename project…").onSelect?.();
    item(list, "weekend-flyer").onSelect?.();
    expect(vi.mocked(menu.onCommand).mock.calls.map(([c]) => c)).toEqual([{ id: "project.close" }, { id: "project.rename" }, { id: "project.openRecent", dir: "/p/weekend-flyer" }]);
  });

  it("offers to remove a missing recent, which cannot be opened", () => {
    const menu = model({ recents: [recent("gone", "missing"), recent("busy", "locked")] });
    const list = entries({ menu });
    expect(item(list, "gone")).toMatchObject({ disabled: true, hint: "Missing" });
    expect(item(list, "busy")).toMatchObject({ disabled: false, hint: "In use" });
    const remove = list.find((e) => e.kind !== "divider" && e.kind !== "heading" && e.accessibleName === "Remove gone from Recent") as MenuItem;
    expect(remove).toMatchObject({ label: "Remove", quiet: true });
    remove.onSelect?.();
    expect(menu.onRemoveRecent).toHaveBeenCalledWith("/p/gone");
  });

  it("shows a load failure in the menu, not only in the console", () => {
    expect(texts(entries({ menu: model({ errors: ["Could not read recent projects: denied"] }) }))).toContain("Could not read recent projects: denied");
  });

  it("is only the open projects without a menu model (the static shell)", () => {
    expect(texts(entries({ projectId: null, projectName: "x", projects: [{ id: "b", name: "Other" }], menu: undefined }))).toEqual(["Other"]);
    expect(texts(entries({ projectId: null, menu: undefined }))).toEqual(["No other projects open"]);
  });
});
