import type { ProjectInfo } from "@rw/contracts";
import { describe, expect, it, vi } from "vitest";
import type { LastActive } from "./recents.ts";
import { reopenLast, type ReopenDeps } from "./reopen.ts";

const PROJECT = { projectId: "p1", name: "Rocket", dir: "/d/rocket" } as ProjectInfo;

function deps(last: LastActive | null, over: Partial<ReopenDeps> = {}) {
  const openProject = vi.fn<ReopenDeps["openProject"]>(async () => PROJECT);
  return { pickLastActive: async () => last, openProject, linkPending: () => false, ...over } satisfies ReopenDeps;
}

describe("reopenLast", () => {
  it("opens a last project that is ok, and the page shows it first", async () => {
    const d = deps({ dir: "/d/rocket", status: "ok" });
    await expect(reopenLast(d)).resolves.toEqual({ activeProjectId: "p1", notice: null });
    expect(d.openProject).toHaveBeenCalledWith("/d/rocket");
  });

  it("is silent on a first run, with nothing to reopen", async () => {
    await expect(reopenLast(deps(null))).resolves.toEqual({ activeProjectId: null, notice: null });
  });

  it("skips reopening when a link is waiting, and does not look at the last project", async () => {
    const pickLastActive = vi.fn<ReopenDeps["pickLastActive"]>(async () => ({ dir: "/d/rocket", status: "ok" }));
    const d = deps(null, { pickLastActive, linkPending: () => true });
    await expect(reopenLast(d)).resolves.toEqual({ activeProjectId: null, notice: null });
    expect(pickLastActive).not.toHaveBeenCalled();
    expect(d.openProject).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", /no longer exists/],
    ["denied", /could not read/],
    ["locked", /open in another/],
  ] as const)("does not open a %s project, and says why", async (status, notice) => {
    const d = deps({ dir: "/d/rocket", status });
    const boot = await reopenLast(d);
    expect(boot.activeProjectId).toBeNull();
    expect(boot.notice).toMatch(notice);
    expect(boot.notice).toContain("/d/rocket");
    expect(d.openProject).not.toHaveBeenCalled();
  });

  it("turns a failed open into a notice with the server's reason", async () => {
    const d = deps({ dir: "/d/rocket", status: "ok" }, { openProject: async () => Promise.reject(new Error("project.open: not_a_project: /d/rocket holds no RocketWright project")) });
    await expect(reopenLast(d)).resolves.toEqual({ activeProjectId: null, notice: "Could not reopen /d/rocket: /d/rocket holds no RocketWright project" });
  });

  it("gives up after its bound and brings the window up with a notice", async () => {
    const d = deps({ dir: "/d/rocket", status: "ok" }, { openProject: () => new Promise<ProjectInfo>(() => undefined), timeoutMs: 10 });
    const boot = await reopenLast(d);
    expect(boot.activeProjectId).toBeNull();
    expect(boot.notice).toMatch(/took too long/);
  });

  it("never rejects, even if the last project cannot be read at all", async () => {
    const log = vi.fn<(line: string) => void>();
    const d = deps(null, { pickLastActive: async () => Promise.reject(new Error("boom")), log });
    await expect(reopenLast(d)).resolves.toEqual({ activeProjectId: null, notice: null });
    expect(log).toHaveBeenCalledWith("reopen: boom");
  });
});
