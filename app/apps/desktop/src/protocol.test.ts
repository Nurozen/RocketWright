/**
 * B10: `rocketwright://open` links (the registration's `openUrlTemplate`),
 * the single-instance lock, and the `project.open` → `openThread` order.
 */
import { describe, expect, it } from "vitest";
import type { ProjectInfo } from "@rw/contracts";
import { installProtocol, linkInArgv, linkQueue, openFromLink, parseOpenUrl, projectActivator, type AppLike, type OpenLink } from "./protocol.ts";

const PROJECT: ProjectInfo = { projectId: "research-vehicle", name: "Research vehicle", dir: "/private/tmp/rv" } as ProjectInfo;

function fakeApp(lock = true) {
  const handlers = new Map<string, (...a: never[]) => void>();
  const registered: string[] = [];
  const app: AppLike = {
    requestSingleInstanceLock: () => lock,
    setAsDefaultProtocolClient: (p) => (registered.push(p), true),
    on: (event: string, l: (...a: never[]) => void) => handlers.set(event, l),
  };
  return { app, handlers, registered };
}

describe("rocketwright://open", () => {
  it("parses the registration's template, thread optional", () => {
    const url = "rocketwright://open?workspace={workspaceRoot}&thread={threadId}".replace("{workspaceRoot}", encodeURIComponent("/private/tmp/My Rocket")).replace("{threadId}", "lt-1");
    expect(parseOpenUrl(url)).toEqual({ workspace: "/private/tmp/My Rocket", thread: "lt-1" });
    expect(parseOpenUrl("rocketwright://open?workspace=%2Ftmp%2Frv")).toEqual({ workspace: "/tmp/rv" });
    expect(parseOpenUrl("rocketwright://open/?workspace=/tmp/rv&thread=")).toEqual({ workspace: "/tmp/rv" });
    expect(parseOpenUrl("rocketwright:open?workspace=/tmp/rv")).toEqual({ workspace: "/tmp/rv" });
  });

  it("refuses other schemes, actions, relative or missing workspaces", () => {
    for (const bad of ["https://open?workspace=/tmp/rv", "rocketwright://delete?workspace=/tmp/rv", "rocketwright://open?workspace=rv", "rocketwright://open", "rocketwright://open?workspace=/tmp/a%00b", "not a url"]) {
      expect(parseOpenUrl(bad), bad).toBeNull();
    }
  });

  it("finds the link in a second instance's argv", () => {
    expect(linkInArgv(["/Electron", "main.ts", "rocketwright://open?workspace=/tmp/rv"])).toBe("rocketwright://open?workspace=/tmp/rv");
    expect(linkInArgv(["/Electron", "main.ts", "--project", "/tmp/rv"])).toBeNull();
  });
});

describe("single instance", () => {
  it("takes the lock, registers only when asked, and routes second-instance and open-url links", () => {
    const { app, handlers, registered } = fakeApp();
    const opened: OpenLink[] = [];
    let focused = 0;
    expect(installProtocol({ app, register: false, onOpen: (l) => opened.push(l), focus: () => focused++ })).toBe(true);
    expect(registered).toEqual([]);
    handlers.get("second-instance")!({} as never, ["/Electron", "rocketwright://open?workspace=/tmp/a&thread=t"] as never);
    let prevented = false;
    handlers.get("open-url")!({ preventDefault: () => (prevented = true) } as never, "rocketwright://open?workspace=/tmp/b" as never);
    handlers.get("open-url")!({ preventDefault: () => undefined } as never, "rocketwright://evil" as never);
    expect(opened).toEqual([{ workspace: "/tmp/a", thread: "t" }, { workspace: "/tmp/b" }]);
    expect(prevented).toBe(true);
    expect(focused).toBe(3);
    const reg = fakeApp();
    installProtocol({ app: reg.app, register: true, onOpen: () => undefined });
    expect(reg.registered).toEqual(["rocketwright"]);
  });

  it("returns false and listens to nothing when another instance holds the lock", () => {
    const { app, handlers } = fakeApp(false);
    expect(installProtocol({ app, register: true, onOpen: () => undefined })).toBe(false);
    expect(handlers.size).toBe(0);
  });

  it("queues links until the window is ready", () => {
    const q = linkQueue();
    q.push({ workspace: "/tmp/a" });
    const got: OpenLink[] = [];
    q.ready((l) => got.push(l));
    q.push({ workspace: "/tmp/b" });
    expect(got).toEqual([{ workspace: "/tmp/a" }, { workspace: "/tmp/b" }]);
  });
});

describe("projectActivator", () => {
  function activator(): { activate: ReturnType<typeof projectActivator>; calls: string[] } {
    const calls: string[] = [];
    const activate = projectActivator({
      focus: () => void calls.push("focus"),
      openThread: (p, t) => void calls.push(`openThread ${p} ${t}`),
      showProject: (p, t) => void calls.push(`show ${p} ${t ?? "-"}`),
    });
    return { activate, calls };
  }

  it("raises the window, queues the thread, then asks the page to switch", () => {
    const { activate, calls } = activator();
    activate("p1", "t1");
    expect(calls).toEqual(["focus", "openThread p1 t1", "show p1 t1"]);
  });

  it("opens no thread when none is named", () => {
    const { activate, calls } = activator();
    activate("p1");
    expect(calls).toEqual(["focus", "show p1 -"]);
  });
});

describe("openFromLink", () => {
  it("opens the project, queues the thread for its pane, then asks the page to show it", async () => {
    const calls: string[] = [];
    const project = await openFromLink(
      { workspace: "/tmp/rv", thread: "lt-3" },
      {
        openProject: async (dir) => (calls.push(`project.open ${dir}`), PROJECT),
        activateProject: (p, t) => void calls.push(`activate ${p} ${t ?? "-"}`),
      },
    );
    expect(project).toEqual(PROJECT);
    expect(calls).toEqual(["project.open /tmp/rv", "activate research-vehicle lt-3"]);
  });

  it("does nothing more when project.open fails", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const project = await openFromLink(
      { workspace: "/tmp/missing", thread: "lt-3" },
      {
        openProject: async () => {
          throw new Error("not_found: no project");
        },
        activateProject: () => void calls.push("activate"),
        log: (l) => void logs.push(l),
      },
    );
    expect(project).toBeNull();
    expect(calls).toEqual([]);
    expect(logs[0]).toMatch(/project\.open \/tmp\/missing failed/);
  });

  it("says whether a link is waiting, and stops once a handler takes it", () => {
    const q = linkQueue();
    expect(q.pending()).toBe(false);
    q.push({ workspace: "/tmp/rv" });
    expect(q.pending()).toBe(true);
    q.ready(() => undefined);
    expect(q.pending()).toBe(false);
  });
});
