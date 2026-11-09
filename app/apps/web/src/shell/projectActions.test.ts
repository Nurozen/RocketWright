import type { ProjectInspection } from "@rw/contracts";
import { describe, expect, it, vi } from "vitest";
import { createProject, exportDefaultName, exportedNotice, fileBase, fileStem, importedNotice, importKindOf, nameProblem, openFolder, recentAge, splitFolder, targetPreview, type ProjectRpc } from "./projectActions.ts";

const INFO = { projectId: "p", dir: "/w/a", name: "a" };

function rpc(found: Partial<ProjectInspection>) {
  const call = vi.fn<(method: string, params: unknown) => Promise<unknown>>((method) => Promise.resolve(method === "project.inspect" ? { dir: "/w/a", state: "missing", name: null, collisions: [], ...found } : { project: INFO }));
  return { call, client: { call } as unknown as ProjectRpc };
}

describe("project names", () => {
  it("accepts one ordinary folder name, with spaces inside it", () => {
    expect(nameProblem("solstice rocket")).toBeNull();
    expect(nameProblem("  padded ")).toBeNull();
  });

  it.each([
    ["", "Enter a name."],
    ["   ", "Enter a name."],
    [".hidden", "A name cannot start with a dot."],
    ["a/b", "A name cannot contain a slash, a backslash or a control character."],
    ["a\\b", "A name cannot contain a slash, a backslash or a control character."],
    ["a\tb", "A name cannot contain a slash, a backslash or a control character."],
  ])("refuses %j", (name, problem) => {
    expect(nameProblem(name)).toBe(problem);
  });
});

describe("the path preview", () => {
  it("joins the location and the name", () => {
    expect(targetPreview("/w/RocketWright", "solstice")).toBe("Creates /w/RocketWright/solstice");
    expect(targetPreview(" /w/RocketWright/ ", " solstice ")).toBe("Creates /w/RocketWright/solstice");
    expect(targetPreview("/", "solstice")).toBe("Creates /solstice");
  });

  it("names the folder before there is a project name", () => {
    expect(targetPreview("/w/RocketWright", "")).toBe("Creates a folder in /w/RocketWright");
    expect(targetPreview("", "solstice")).toBe("Choose where to create it.");
  });
});

describe("splitting a folder for project.create", () => {
  it("gives the parent and the last segment", () => {
    expect(splitFolder("/w/deep/rocket")).toEqual({ location: "/w/deep", name: "rocket" });
    expect(splitFolder("/rocket")).toEqual({ location: "/", name: "rocket" });
  });
});

describe("opening a folder", () => {
  it("opens a project, by the path the server resolved", async () => {
    const r = rpc({ dir: "/resolved/a", state: "project", name: "a" });
    await expect(openFolder(r.client, "~/a")).resolves.toEqual({ kind: "opened", project: INFO });
    expect(r.call).toHaveBeenCalledWith("project.open", { dir: "/resolved/a" });
  });

  it("offers to create in a folder with no project, on its parent and name", async () => {
    const outcome = await openFolder(rpc({ state: "empty" }).client, "/w/a");
    expect(outcome).toMatchObject({ kind: "offer", location: "/w", name: "a", message: "/w/a has no RocketWright project. Create one there?" });
  });

  it("says when the folder does not exist yet", async () => {
    expect(await openFolder(rpc({ state: "missing" }).client, "/w/a")).toMatchObject({ kind: "offer", message: "/w/a does not exist yet. Create a project there?" });
  });

  it("lists the files that block creating there, and never offers", async () => {
    const r = rpc({ state: "folder", collisions: ["rocket.rw.toml", "configs/default.rw.toml"] });
    const outcome = await openFolder(r.client, "/w/a");
    expect(outcome.kind).toBe("blocked");
    expect(outcome).toMatchObject({ message: expect.stringContaining("rocket.rw.toml, configs/default.rw.toml") });
    expect(r.call).toHaveBeenCalledTimes(1);
  });

  it("offers on a folder of unrelated files", async () => {
    expect(await openFolder(rpc({ state: "folder", collisions: [] }).client, "/w/a")).toMatchObject({ kind: "offer" });
  });
});

describe("recent ages", () => {
  const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it.each([
    [10_000, "Just now"],
    [MIN, "1 minute ago"],
    [59 * MIN, "59 minutes ago"],
    [2 * HOUR, "2 hours ago"],
    [25 * HOUR, "Yesterday"],
    [3 * DAY, "3 days ago"],
    [30 * DAY, "Oct 9, 2026"],
  ])("%d ms ago", (ms, text) => {
    expect(recentAge(ago(ms), NOW)).toBe(text);
  });

  it("says nothing for an unreadable time", () => {
    expect(recentAge("not a date", NOW)).toBe("");
  });
});

describe("import and export helpers", () => {
  it.each([
    ["/a/rocket.ork", "ork"],
    ["/a/ROCKET.ORK", "ork"],
    ["C6.eng", "motor"],
    ["/a/b.c/D9.Rse", "motor"],
    ["/a/notes.txt", null],
    ["/a.ork/plain", null],
  ])("reads %s as %s", (path, kind) => {
    expect(importKindOf(path)).toBe(kind);
  });

  it("names a file from its path", () => {
    expect(fileBase("/a/b/My rocket.v2.ork")).toBe("My rocket.v2.ork");
    expect(fileStem("/a/b/My rocket.v2.ork")).toBe("My rocket.v2");
  });

  it("creates from an .ork with no template, and from a template without a source", async () => {
    const { call, client } = rpc({});
    await createProject(client, { name: " A ", location: " /w ", template: "minimal", ork: "/x/a.ork" });
    await createProject(client, { name: "B", location: "/w", template: "minimal" });
    expect(call.mock.calls.map((c) => c[1])).toEqual([
      { name: "A", location: "/w", source: { ork: "/x/a.ork" } },
      { name: "B", location: "/w", template: "minimal" },
    ]);
  });

  it("warns about every part the format left out", () => {
    expect(exportedNotice({ path: "/o/a.ork" })).toEqual({ tone: "success", text: "Exported to /o/a.ork." });
    expect(exportedNotice({ path: "/o/a.ork", skipped: [] }).tone).toBe("success");
    expect(exportedNotice({ path: "/o/a.ork", skipped: ["lox_tank"] })).toEqual({ tone: "warning", text: "Exported to /o/a.ork, leaving out a part this format cannot hold: lox_tank." });
    expect(exportedNotice({ path: "a", skipped: ["1", "2", "3", "4", "5", "6", "7"] }).text).toBe("Exported to a, leaving out 7 parts this format cannot hold: 1, 2, 3, 4, 5, and 2 more.");
  });

  it("carries the file's import warnings to the person", () => {
    expect(importedNotice("a.ork", {})).toEqual({ tone: "success", text: "Imported a.ork." });
    const d = { code: "RW-W010", severity: "warning", path: "/c/x", message: "pod approximated" } as NonNullable<Parameters<typeof importedNotice>[1]["diagnostics"]>[number];
    expect(importedNotice("a.ork", { diagnostics: [d] })).toEqual({ tone: "warning", text: "Imported a.ork, with a warning: pod approximated" });
  });

  it("starts the save dialog from a safe name", () => {
    expect(exportDefaultName("Solstice", "ork")).toBe("Solstice.ork");
    expect(exportDefaultName("Solstice", "rasp")).toBe("Solstice-motors.eng");
    expect(exportDefaultName("a/b:c", "stl")).toBe("a-b-c.stl");
    expect(exportDefaultName("  ", "glb")).toBe("rocket.glb");
    expect(exportDefaultName("Solstice", "csv", "baseline")).toBe("results-baseline.csv");
  });
});
