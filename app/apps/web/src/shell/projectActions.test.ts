import type { ProjectInspection } from "@rw/contracts";
import { describe, expect, it, vi } from "vitest";
import { nameProblem, openFolder, recentAge, splitFolder, targetPreview, type ProjectRpc } from "./projectActions.ts";

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
