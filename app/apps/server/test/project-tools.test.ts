/**
 * U37 (R1.3, D10, D13): `project_new` and `project_open`. The branches run
 * against fake deps, where a dialog can be held open; the last block drives
 * the real route, host channel and `rw init`. Projects stay under `/tmp`.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { PROJECT_TOOLS, type HostRequest, type HostResponse, type HostShow, type JsonObject, type ProjectInfo } from "@rw/contracts";
import { TestClient, makeValidator } from "@rw/contracts/mock/harness";
import { ProjectTools, cleanRequest, threadLaunchUnavailable, type ProjectThreadStart, type ProjectToolsDeps } from "../src/mcp/projectTools.ts";
import { MAX_PROJECT_REALPATH } from "../src/project/create.ts";
import { RpcFail } from "../src/rpc/errors.ts";
import { HostChannelError } from "../src/rpc/HostChannel.ts";
import { AppServer } from "../src/rpc/AppServer.ts";
import { LecturnLink } from "../src/lecturn/connection.ts";
import type { SidecarConnection } from "../src/sidecar/SidecarSupervisor.ts";
import { connectTo, FakeConnection } from "./helpers/fakeLecturn.ts";
import { sidecarBin } from "./helpers/harness.ts";

type Result = Awaited<ReturnType<ProjectTools["call"]>>;

const text = (r: unknown): string => (r as { content: { type: string; text?: string }[] }).content.find((c) => c.type === "text")?.text ?? "";
const errorCode = (r: Result): unknown => (r._meta?.["rw/error"] as { code?: unknown } | undefined)?.code;
const CALLER = { threadId: "caller-thread", projectId: "caller-project" };
const accepted = (): Promise<HostResponse> => Promise.resolve({ requestId: "r", accepted: true });
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("project tools: branches (U37)", () => {
  let base: string;
  let asked: Omit<HostRequest, "requestId">[];
  let shown: HostShow[];
  let created: string[];
  let opened: string[];
  let starts: ProjectThreadStart[];

  const info = (dir: string): ProjectInfo => ({ projectId: "p1", dir, name: "Solstice" });

  function tools(over: Partial<ProjectToolsDeps> = {}): ProjectTools {
    return new ProjectTools({
      askHost: (request) => {
        asked.push(request);
        return accepted();
      },
      show: (s) => shown.push(s),
      create: (args) => {
        const dir = join(args.location!, args.name);
        created.push(dir);
        return Promise.resolve(dir);
      },
      collisions: () => Promise.resolve([]),
      open: (dir) => {
        opened.push(dir);
        return Promise.resolve(info(dir));
      },
      isOpen: () => false,
      startThread: (start) => {
        starts.push(start);
        return Promise.resolve({ threadId: "new-thread" });
      },
      ...over,
    });
  }

  const projectAt = (name: string): string => {
    const dir = join(base, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "rocketwright.toml"), 'name = "x"\n');
    return dir;
  };
  const newArgs = (over: JsonObject = {}): JsonObject => ({ name: "solstice", location: base, ...over });

  beforeEach(() => {
    base = realpathSync(mkdtempSync("/tmp/rwu37-"));
    asked = [];
    shown = [];
    created = [];
    opened = [];
    starts = [];
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** What a refused call must look like: an error, with nothing asked or done. */
  const outcome = (r: Result): Record<string, unknown> => ({ isError: r.isError, code: errorCode(r), message: text(r), asked, created, opened });
  const refusedBeforeDialog = (code: string, message: RegExp): Record<string, unknown> => ({ isError: true, code, message: expect.stringMatching(message), asked: [], created: [], opened: [] });

  it("declares both tools, with the rules the agent needs in their descriptions", () => {
    const list = tools().tools();
    expect(list.map((t) => t.name)).toEqual([...PROJECT_TOOLS]);
    for (const t of list) {
      expect(t.description).toMatch(/cannot change projects/);
      expect(t.description).toMatch(/do not retry/);
      expect(t.description).toMatch(/Planning and scratch files are welcome.*inside its `artifacts\/` folder/);
      expect(t.annotations?.idempotentHint).toBe(false);
    }
    expect(list[0]!.inputSchema.required).toEqual(["name"]);
    expect(list[1]!.inputSchema.required).toEqual(["path"]);
  });

  describe("refusals before the dialog", () => {
    it.each([
      ["a relative location", { location: "relative/dir" }, /location: expected an absolute path/],
      ["a ~user location", { location: "~root/dir" }, /location: expected an absolute path/],
      ["a name with a slash", { name: "a/b" }, /name: /],
      ["a name of dots", { name: ".." }, /name: /],
      ["an empty name", { name: "" }, /name: /],
      ["a name with a bidi override", { name: "abc\u202Etxt" }, /name: cannot contain/],
      ["a name over 255 bytes", { name: "n".repeat(256) }, /name: at most 255 bytes/],
      ["a location with a bidi override", { location: "/tmp/\u202Eabc" }, /location: cannot contain/],
      ["an unknown template", { template: "nope" }, /template: expected/],
      ["an argument the tool does not take", { source: { ork: "/tmp/a.ork" } }, /source: not an argument/],
      ["a non-string request", { request: 5 }, /request: expected a string/],
    ] as const)("project_new refuses %s", async (_label, args, message) => {
      expect(outcome(await tools().call("project_new", newArgs(args as unknown as JsonObject), CALLER))).toMatchObject(refusedBeforeDialog("invalid_args", message));
    });

    it("project_new refuses a request over the cap rather than truncating it (D13)", async () => {
      const r = await tools().call("project_new", newArgs({ request: "x".repeat(2001) }), CALLER);
      expect(outcome(r)).toMatchObject(refusedBeforeDialog("invalid_args", /request: at most 2000 characters/));
    });

    it("project_new on a folder holding a project hints rw_project_open", async () => {
      projectAt("solstice");
      expect(outcome(await tools().call("project_new", newArgs(), CALLER))).toMatchObject(refusedBeforeDialog("conflict", /already holds a project; use rw_project_open/));
    });

    it("project_new refuses a name taken by a file", async () => {
      writeFileSync(join(base, "solstice"), "x");
      expect(outcome(await tools().call("project_new", newArgs(), CALLER))).toMatchObject(refusedBeforeDialog("conflict", /is a file/));
    });

    it("project_new lists the files a manifest-less folder would lose (D3)", async () => {
      mkdirSync(join(base, "solstice"));
      writeFileSync(join(base, "solstice", "rocket.rw.toml"), "x");
      const r = await tools({ collisions: () => Promise.resolve(["rocket.rw.toml"]) }).call("project_new", newArgs(), CALLER);
      expect(outcome(r)).toMatchObject(refusedBeforeDialog("conflict", /would replace: rocket\.rw\.toml/));
    });

    it("project_new refuses a path too long to create", async () => {
      const deep = `/${"d".repeat(200)}`.repeat(Math.ceil(MAX_PROJECT_REALPATH / 201) + 1);
      const r = await tools().call("project_new", newArgs({ location: deep }), CALLER);
      expect(outcome(r)).toMatchObject(refusedBeforeDialog("invalid_args", /a project's path can be at most/));
    });

    it.each([
      ["a relative path", { path: "some/dir" }, "invalid_args", /path: expected an absolute path/],
      ["no path", {}, "invalid_args", /path: expected a non-empty string/],
      ["an unknown argument", { path: "/tmp", name: "x" }, "invalid_args", /name: not an argument/],
      ["a missing folder", { path: "/tmp/rwu37-no-such-folder" }, "not_found", /no such folder/],
    ] as const)("project_open refuses %s", async (_label, args, code, message) => {
      expect(outcome(await tools().call("project_open", args as unknown as JsonObject, CALLER))).toMatchObject(refusedBeforeDialog(code, message));
    });

    it("project_open refuses a file and a folder with no project", async () => {
      writeFileSync(join(base, "file"), "x");
      mkdirSync(join(base, "plain"));
      expect(outcome(await tools().call("project_open", { path: join(base, "file") }, CALLER))).toMatchObject(refusedBeforeDialog("invalid_args", /is a file/));
      expect(outcome(await tools().call("project_open", { path: join(base, "plain") }, CALLER))).toMatchObject(refusedBeforeDialog("not_a_project", /use rw_project_new/));
    });
  });

  describe("the dialog's answer", () => {
    it("Cancel is an error that tells the agent to stop, and nothing happens", async () => {
      const r = await tools({ askHost: () => Promise.resolve({ requestId: "r", accepted: false }) }).call("project_new", newArgs(), CALLER);
      expect(r.isError).toBe(true);
      expect(errorCode(r)).toBe("cancelled");
      expect(text(r)).toMatch(/cancelled\. Nothing was created/);
      expect(text(r)).toMatch(/do not call this tool again/);
      expect(created).toEqual([]);
      expect(shown).toEqual([]);
    });

    it("an unanswered dialog times out at the deadline, through the signal it was given", async () => {
      let signal: AbortSignal | undefined;
      const r = await tools({
        dialogMs: 20,
        askHost: (_request, s) =>
          new Promise((_ok, fail) => {
            signal = s;
            s.addEventListener("abort", () => fail(new HostChannelError("aborted", "aborted")));
          }),
      }).call("project_open", { path: projectAt("a") }, CALLER);
      expect(signal?.aborted).toBe(true);
      expect(r.isError).toBe(true);
      expect(errorCode(r)).toBe("timeout");
      expect(opened).toEqual([]);
    });

    it.each(["no_host", "disconnected"] as const)("%s reports the desktop app is unavailable", async (code) => {
      const r = await tools({ askHost: () => Promise.reject(new HostChannelError(code, "x")) }).call("project_new", newArgs(), CALLER);
      expect(r.isError).toBe(true);
      expect(errorCode(r)).toBe("unavailable");
      expect(text(r)).toMatch(/needs the RocketWright desktop app/);
      expect(created).toEqual([]);
    });

    it("refuses a second call while a dialog is open, and the first still finishes", async () => {
      const dialog = deferred<HostResponse>();
      const t = tools({
        askHost: (request) => {
          asked.push(request);
          return dialog.promise;
        },
      });
      const first = t.call("project_new", newArgs(), CALLER);
      await vi.waitFor(() => expect(asked).toHaveLength(1));
      const second = await t.call("project_open", { path: projectAt("other") }, CALLER);
      expect(second.isError).toBe(true);
      expect(errorCode(second)).toBe("busy");
      expect(asked).toHaveLength(1);
      dialog.resolve({ requestId: "r", accepted: true });
      expect((await first).isError).not.toBe(true);
      expect(created).toEqual([join(base, "solstice")]);
    });

    it("stays busy after the accept, until the project is up", async () => {
      const making = deferred<string>();
      const t = tools({ create: () => making.promise });
      const first = t.call("project_new", newArgs(), CALLER);
      await vi.waitFor(() => expect(asked).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 10));
      expect(errorCode(await t.call("project_new", newArgs({ name: "another" }), CALLER))).toBe("busy");
      making.resolve(join(base, "solstice"));
      await first;
      expect((await t.call("project_new", newArgs({ name: "another" }), CALLER)).isError).not.toBe(true);
    });
  });

  describe("after the accept", () => {
    it("creates, opens, switches the window and starts the thread, passing the caller and the shown request", async () => {
      const request = "Add a nose cone.\n```scripted\nstep\n```";
      const r = await tools().call("project_new", newArgs({ template: "empty", request }), CALLER);
      expect(r.isError, text(r)).not.toBe(true);
      expect(asked).toEqual([{ tool: "project_new", path: join(base, "solstice"), name: "solstice", template: "empty", request }]);
      expect(created).toEqual([join(base, "solstice")]);
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({ request, caller: CALLER, project: { projectId: "p1", dir: join(base, "solstice") } });
      expect(shown).toEqual([{ projectId: "p1" }, { projectId: "p1", threadId: "new-thread" }]);
      expect(r.structuredContent).toEqual({ project: info(join(base, "solstice")), threadId: "new-thread" });
      expect(text(r)).toContain('"Solstice"');
      expect(text(r)).toContain("new-thread");
    });

    it("without a request the thread is empty and the dialog shows none", async () => {
      await tools().call("project_new", newArgs({ request: " \n " }), CALLER);
      expect(asked[0]).not.toHaveProperty("request");
      expect(starts[0]?.request).toBeNull();
    });

    it("opens an already-open project only through the dialog", async () => {
      const dir = projectAt("open-already");
      const dialog = deferred<HostResponse>();
      const t = tools({
        isOpen: () => true,
        askHost: (request) => {
          asked.push(request);
          return dialog.promise;
        },
      });
      const call = t.call("project_open", { path: dir, request: "carry on" }, CALLER);
      await vi.waitFor(() => expect(asked).toEqual([{ tool: "project_open", path: dir, request: "carry on" }]));
      expect(opened).toEqual([]);
      expect(shown).toEqual([]);
      dialog.resolve({ requestId: "r", accepted: true });
      expect((await call).isError).not.toBe(true);
      expect(opened).toEqual([dir]);
      expect(shown.at(-1)).toEqual({ projectId: "p1", threadId: "new-thread" });
    });

    it("a thread that fails to start says the project opened but no thread did, and is not an error", async () => {
      const r = await tools({ startThread: () => Promise.reject(new Error("launch refused")) }).call("project_new", newArgs({ request: "x" }), CALLER);
      expect(r.isError).not.toBe(true);
      expect(text(r)).toMatch(/is open at .* but no new thread was started there \(launch refused\)/);
      expect(text(r)).toMatch(/Do not call this tool again/);
      expect(r.structuredContent).toEqual({ project: info(join(base, "solstice")), threadId: null });
      expect(shown).toEqual([{ projectId: "p1" }]);
    });

    it("with no Lecturn link the default starter reports opened with no thread", async () => {
      const r = await tools({ startThread: threadLaunchUnavailable }).call("project_new", newArgs(), CALLER);
      expect(r.isError).not.toBe(true);
      expect(text(r)).toMatch(/no new thread was started/);
    });

    it("a thread that exists but did not start says so, names it and shows it", async () => {
      const r = await tools({ startThread: () => Promise.resolve({ threadId: "t9", unstarted: "its first message could not be confirmed" }) }).call("project_new", newArgs({ request: "x" }), CALLER);
      expect(r.isError).not.toBe(true);
      expect(text(r)).toMatch(/thread t9 exists there, but it did not start as asked \(its first message could not be confirmed\)/);
      expect(text(r)).toMatch(/Do not call this tool again/);
      expect(r.structuredContent).toEqual({ project: info(join(base, "solstice")), threadId: "t9" });
      expect(shown).toEqual([{ projectId: "p1" }, { projectId: "p1", threadId: "t9" }]);
    });

    it("tells the starter whether the call made the project", async () => {
      const seen: boolean[] = [];
      const t = tools({
        startThread: (s) => {
          seen.push(s.created);
          return Promise.resolve({ threadId: "t" });
        },
      });
      await t.call("project_new", newArgs(), CALLER);
      await t.call("project_open", { path: projectAt("existing") }, CALLER);
      expect(seen).toEqual([true, false]);
    });

    it("a folder that became a project during the dialog still hints rw_project_open", async () => {
      const r = await tools({
        create: () => {
          projectAt("solstice");
          return Promise.reject(new RpcFail("conflict", "already"));
        },
      }).call("project_new", newArgs(), CALLER);
      expect(r.isError).toBe(true);
      expect(errorCode(r)).toBe("conflict");
      expect(text(r)).toMatch(/use rw_project_open/);
    });

    it("a project created but not opened says so, so the agent does not create it again", async () => {
      const r = await tools({ open: () => Promise.reject(new Error("sidecar died")) }).call("project_new", newArgs(), CALLER);
      expect(r.isError).toBe(true);
      expect(errorCode(r)).toBe("open_failed");
      expect(text(r)).toMatch(/created at .* could not be opened: sidecar died/);
      expect(text(r)).toMatch(/Do not create it again/);
    });
  });

  describe("the overall guard (D10)", () => {
    it("past the accept, answers a partial success, finishes the work and starts no thread", async () => {
      const making = deferred<string>();
      const t = tools({ guardMs: 20, create: () => making.promise });
      const r = await t.call("project_new", newArgs({ request: "x" }), CALLER);
      expect(r.isError).not.toBe(true);
      expect(text(r)).toMatch(/still being set up/);
      expect(text(r)).toMatch(/Do not call this tool again/);
      expect(r.structuredContent).toEqual({ status: "pending", path: join(base, "solstice"), threadId: null });
      expect(errorCode(await t.call("project_new", newArgs({ name: "b" }), CALLER))).toBe("busy");
      making.resolve(join(base, "solstice"));
      await vi.waitFor(() => expect(shown).toEqual([{ projectId: "p1" }]));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(starts).toEqual([]);
    });

    it("during the thread start, reports opened with no thread and aborts the launch", async () => {
      let signal: AbortSignal | undefined;
      const r = await tools({
        guardMs: 20,
        startThread: (s) => {
          signal = s.signal;
          return never();
        },
      }).call("project_open", { path: projectAt("a") }, CALLER);
      expect(r.isError).not.toBe(true);
      expect(text(r)).toMatch(/no new thread was started/);
      expect(signal?.aborted).toBe(true);
      expect(shown).toEqual([{ projectId: "p1" }]);
    });

    it("a launch that never settles does not leave the tools busy", async () => {
      const t = tools({ guardMs: 20, startThread: () => never() });
      await t.call("project_open", { path: projectAt("a") }, CALLER);
      const second = projectAt("b");
      await vi.waitFor(async () => expect((await t.call("project_open", { path: second }, CALLER)).isError).not.toBe(true));
    });

    it("before the accept, nothing has changed and it is a refusal", async () => {
      const r = await tools({ guardMs: 20, dialogMs: 10_000, askHost: () => never() }).call("project_new", newArgs(), CALLER);
      expect(r.isError).toBe(true);
      expect(errorCode(r)).toBe("timeout");
      expect(created).toEqual([]);
    });
  });
});

describe("cleanRequest (D13)", () => {
  it("keeps newlines, backticks and text; strips control and text-direction characters", () => {
    expect(cleanRequest("a\u0007b\u202Ec\u2066d\u200Fe\u0085f")).toBe("abcdef");
    expect(cleanRequest("```\ncode\n```")).toBe("```\ncode\n```");
    expect(cleanRequest("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
    expect(cleanRequest("a\tb")).toBe("a b");
    expect(cleanRequest("a\u2028b")).toBe("ab");
    expect(cleanRequest("emoji \u{1F680}")).toBe("emoji \u{1F680}");
  });

  it("treats nothing left as no request, and counts characters not UTF-16 units", () => {
    expect(cleanRequest(undefined)).toBeNull();
    expect(cleanRequest(null)).toBeNull();
    expect(cleanRequest("")).toBeNull();
    expect(cleanRequest(" \u202E\n")).toBeNull();
    expect(cleanRequest("x".repeat(2000))).toHaveLength(2000);
    expect(cleanRequest("\u{1F680}".repeat(2000))).not.toBeNull();
    expect(() => cleanRequest("x".repeat(2001))).toThrow(/at most 2000/);
  });
});

class FakeSidecar implements SidecarConnection {
  start(): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
  onClose(): () => void {
    return () => undefined;
  }
  onResourceUpdated(): () => void {
    return () => undefined;
  }
  subscribe(): Promise<unknown> {
    return Promise.resolve({});
  }
  unsubscribe(): Promise<unknown> {
    return Promise.resolve({});
  }
  readJson(): Promise<unknown> {
    return Promise.resolve({});
  }
  serverVersion(): { name: string; version: string } {
    return { name: "rocketwright", version: "0.0.0-test" };
  }
  pid(): number {
    return 1;
  }
  listTools(): Promise<never[]> {
    return Promise.resolve([]);
  }
  callTool(): Promise<{ content: [] }> {
    return Promise.resolve({ content: [] });
  }
}

describe("project tools: the real route and host channel (U37)", () => {
  const validator = makeValidator();
  let base: string;
  let server: AppServer;
  let page: TestClient;
  let main: TestClient;
  let mcp: Client;
  let starts: ProjectThreadStart[];
  let startThread: (s: ProjectThreadStart) => Promise<{ threadId: string }>;

  beforeAll(async () => {
    base = realpathSync(mkdtempSync("/tmp/rwu37r-"));
    starts = [];
    startThread = (s) => {
      starts.push(s);
      return Promise.resolve({ threadId: "launched" });
    };
    server = await AppServer.start({
      bin: sidecarBin(),
      coreVersion: "0.0.0-test",
      stderr: "ignore",
      testHooks: false,
      connect: () => new FakeSidecar(),
      startThread: (s) => startThread(s),
      log: () => undefined,
    });
    page = await TestClient.connect(server.rpcUrl, validator);
    main = await TestClient.connect(server.rpcUrl, validator);
    mcp = new Client({ name: "lecturn-live-test", version: "0" }, { capabilities: {} });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(server.liveMcpUrl), { requestInit: { headers: { Authorization: `Bearer ${server.liveBearer.token}` } } }));
  }, 600_000);

  afterAll(async () => {
    await mcp?.close();
    page?.close();
    main?.close();
    await server?.close();
    if (base !== undefined) rmSync(base, { recursive: true, force: true });
  });

  const context = { "lecturn/context": { projectId: "lecturn-p", threadId: "lecturn-t", workspaceRoot: "/nowhere/open", turnId: "u" } };
  const call = (name: string, args: Record<string, unknown>, meta: Record<string, unknown> = context) => mcp.callTool({ name, arguments: args, _meta: meta });

  // Runs first: `host.register` can only ever be claimed once per server.
  it("answers unavailable when no desktop host holds the channel", async () => {
    const r = await call("project_new", { name: "no-host", location: base });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^unavailable: /);
    expect(existsSync(join(base, "no-host"))).toBe(false);
  });

  it("creates through the dialog: main alone is asked and told, and rw init really ran", async () => {
    await main.call("host.register", { token: server.mainToken });
    const pending = call("project_new", { name: "solstice-rocket", location: base, template: "empty", request: "Add a nose cone." });
    const asked = await main.push("host.request");
    expect(asked).toMatchObject({ tool: "project_new", path: join(base, "solstice-rocket"), name: "solstice-rocket", template: "empty", request: "Add a nose cone." });
    await main.call("host.respond", { requestId: asked.requestId, accepted: true });
    const r = await pending;
    expect(r.isError, text(r)).not.toBe(true);
    expect(existsSync(join(base, "solstice-rocket", "rocketwright.toml"))).toBe(true);
    const shown = await main.push("host.show", (s) => s.threadId !== undefined);
    expect(shown).toEqual({ projectId: "solstice-rocket", threadId: "launched" });
    expect(page.pushes("host.show")).toEqual([]);
    expect(page.pushes("host.request")).toEqual([]);
    expect(starts.at(-1)).toMatchObject({ request: "Add a nose cone.", caller: { threadId: "lecturn-t", projectId: "lecturn-p" }, project: { projectId: "solstice-rocket" } });
    expect(r.structuredContent).toMatchObject({ project: { projectId: "solstice-rocket", dir: join(base, "solstice-rocket") }, threadId: "launched" });
  });

  it("works with no workspace root: the caller is simply unknown", async () => {
    const pending = mcp.callTool({ name: "project_new", arguments: { name: "no-context", location: base } });
    const asked = await main.push("host.request", (q) => q.name === "no-context");
    await main.call("host.respond", { requestId: asked.requestId, accepted: true });
    expect((await pending).isError).not.toBe(true);
    expect(starts.at(-1)).toMatchObject({ request: null, caller: { threadId: null, projectId: null } });
  });

  it("Cancel from the dialog creates nothing", async () => {
    const pending = call("project_new", { name: "declined", location: base });
    const asked = await main.push("host.request", (q) => q.name === "declined");
    await main.call("host.respond", { requestId: asked.requestId, accepted: false });
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^cancelled: /);
    expect(existsSync(join(base, "declined"))).toBe(false);
  });

  it("project_open on an already-open project still asks, then shows it", async () => {
    const dir = join(base, "solstice-rocket");
    expect(server.listProjects().map((p) => p.dir)).toContain(dir);
    const shownBefore = main.pushes("host.show").length;
    const pending = call("project_open", { path: dir });
    const asked = await main.push("host.request", (q) => q.tool === "project_open");
    expect(asked.path).toBe(dir);
    expect(main.pushes("host.show")).toHaveLength(shownBefore);
    await main.call("host.respond", { requestId: asked.requestId, accepted: true });
    const r = await pending;
    expect(r.isError, text(r)).not.toBe(true);
    expect(main.pushes("host.show").slice(shownBefore)).toEqual([{ projectId: "solstice-rocket" }, { projectId: "solstice-rocket", threadId: "launched" }]);
  });

  it("project_new on a project refuses with the hint, before any dialog", async () => {
    const before = main.pushes("host.request").length;
    const r = await call("project_new", { name: "solstice-rocket", location: base });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^conflict: .*use rw_project_open/);
    expect(main.pushes("host.request")).toHaveLength(before);
  });

  it("a thread that cannot start still reports the opened project", async () => {
    startThread = () => Promise.reject(new Error("no thread today"));
    const pending = call("project_new", { name: "thread-fails", location: base });
    const asked = await main.push("host.request", (q) => q.name === "thread-fails");
    await main.call("host.respond", { requestId: asked.requestId, accepted: true });
    const r = await pending;
    expect(r.isError).not.toBe(true);
    expect(r.structuredContent).toMatchObject({ project: { projectId: "thread-fails" }, threadId: null });
    expect(text(r)).toContain("no thread today");
  });
});

describe("project tools: the default thread starter is the Lecturn link (U38)", () => {
  const validator = makeValidator();
  const fake = new FakeConnection();
  let base: string;
  let server: AppServer;
  let main: TestClient;
  let mcp: Client;

  beforeAll(async () => {
    base = realpathSync(mkdtempSync("/tmp/rwu38r-"));
    fake.rpcThreads.set("lecturn-t", { modelSelection: { instanceId: "caller", model: "m" }, runtimeMode: "auto", interactionMode: "plan", messages: ["earlier"] });
    server = await AppServer.start({
      bin: sidecarBin(),
      coreVersion: "0.0.0-test",
      stderr: "ignore",
      testHooks: false,
      connect: () => new FakeSidecar(),
      lecturn: (events) => new LecturnLink(connectTo(fake), events, { rpc: fake.rpc }),
      log: () => undefined,
    });
    main = await TestClient.connect(server.rpcUrl, validator);
    await main.call("host.register", { token: server.mainToken });
    mcp = new Client({ name: "lecturn-live-test", version: "0" }, { capabilities: {} });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(server.liveMcpUrl), { requestInit: { headers: { Authorization: `Bearer ${server.liveBearer.token}` } } }));
  }, 600_000);

  afterAll(async () => {
    await mcp?.close();
    main?.close();
    await server?.close();
    if (base !== undefined) rmSync(base, { recursive: true, force: true });
  });

  it("starts a thread with the caller's settings and the request behind the prefix", async () => {
    const pending = mcp.callTool({
      name: "project_new",
      arguments: { name: "launched", location: base, request: "Add a nose cone." },
      _meta: { "lecturn/context": { projectId: "lecturn-p", threadId: "lecturn-t", workspaceRoot: "/nowhere/open", turnId: "u" } },
    });
    const asked = await main.push("host.request", (q) => q.name === "launched");
    await main.call("host.respond", { requestId: asked.requestId, accepted: true });
    const r = await pending;
    expect(r.isError, text(r)).not.toBe(true);
    expect(r.structuredContent).toMatchObject({ project: { projectId: "launched" }, threadId: "thread-1" });
    expect(await main.push("host.show", (s) => s.threadId !== undefined)).toEqual({ projectId: "launched", threadId: "thread-1" });
    const launch = fake.rpcCalls.find((c) => c.tag === "orchestration.launchThread")!;
    expect(launch.payload).toMatchObject({
      threadId: "thread-1",
      modelSelection: { instanceId: "caller", model: "m" },
      runtimeMode: "auto",
      interactionMode: "plan",
      initialMessage: { text: "This project was just created and is open; do not create it again.\n\nAdd a nose cone.", attachments: [] },
    });
    expect(fake.rpcThreads.get("lecturn-t")!.messages).toEqual(["earlier"]);
  });
});
