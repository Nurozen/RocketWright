/**
 * U38: `pnpm --filter @rw/server test -- thread-launch`. The thread launch
 * behind the project tools (R1.3, D12) against the fake Lecturn: what each
 * failure leaves behind, and what the agent is told.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectInfo } from "@rw/contracts";
import { LecturnRpcError, lecturnRpc, type SocketLike } from "../src/lecturn/appsRpc.ts";
import { LecturnLink } from "../src/lecturn/connection.ts";
import type { ProjectThreadStart } from "../src/mcp/projectTools.ts";
import { connectTo, FakeConnection, type FakeRpcCall, type RpcOutcome } from "./helpers/fakeLecturn.ts";

const PROJECT: ProjectInfo = { projectId: "rw-new", dir: "/tmp/rw-u38-new", name: "solstice-rocket" };
const CALLER_ROOT = "/tmp/rw-u38-caller";
const CALLER_THREAD = "caller-thread";
const CALLER_MODEL = { instanceId: "caller-instance", model: "caller-model", options: { effort: "high" } };
const CREATED = "This project was just created and is open; do not create it again.";

const LAUNCH = "orchestration.launchThread";
const READ = "orchestration.getThreadProjection";
const DISPATCH = "orchestration.dispatchCommand";
const CREATE = "apps.createEmbedThread";

const links: LecturnLink[] = [];
afterEach(async () => {
  for (const l of links.splice(0)) await l.close();
});

async function setup(opts: { threadStartMs?: number; threadStepMs?: number; rpc?: typeof lecturnRpc } = {}) {
  const fake = new FakeConnection();
  const logs: string[] = [];
  const link = new LecturnLink(connectTo(fake), { status: () => undefined, threads: () => undefined, log: (l) => logs.push(l) }, { threadStepMs: 40, ...opts, rpc: opts.rpc ?? fake.rpc });
  links.push(link);
  await link.addProject(PROJECT);
  const { projectId: callerProjectId } = await fake.ensureWorkspace(CALLER_ROOT, "caller");
  fake.rpcThreads.set(CALLER_THREAD, { modelSelection: CALLER_MODEL, runtimeMode: "auto-accept-edits", interactionMode: "plan", messages: ["earlier"] });
  const newProjectId = fake.idFor(PROJECT.dir);
  const start = (over: Partial<ProjectThreadStart> = {}) =>
    link.startThreadInProject({ project: PROJECT, request: "Add a nose cone", created: true, caller: { threadId: CALLER_THREAD, projectId: callerProjectId }, signal: new AbortController().signal, ...over });
  const commands = (): Record<string, unknown>[] => fake.rpcCalls.filter((c) => c.tag === DISPATCH).map((c) => c.payload);
  const launches = (): Record<string, unknown>[] => fake.rpcCalls.filter((c) => c.tag === LAUNCH).map((c) => c.payload);
  const created = () => fake.rpcThreads.get("thread-1");
  return { fake, link, logs, start, callerProjectId, newProjectId, commands, launches, created };
}

/** Fails the `n`th call matching `tag`, counting from 1. */
function onCall(tag: string, n: number, outcome: RpcOutcome): (c: FakeRpcCall) => RpcOutcome {
  let seen = 0;
  return (c) => (c.tag === tag && ++seen === n ? outcome : undefined);
}

describe("createThread: a thread a person asked for in the window", () => {
  it("creates it on the project's server with the title and binding, and answers its id", async () => {
    const { fake, link } = await setup();
    const threadId = await link.createThread(PROJECT.projectId, "New thread", '{"page":"components"}');
    const made = fake.rpcCalls.find((c) => c.tag === CREATE);
    expect(made?.payload).toMatchObject({ title: "New thread", appData: '{"page":"components"}' });
    expect(typeof threadId).toBe("string");
    expect(fake.rpcThreads.has(threadId)).toBe(true);
  });

  it("fails visibly when Lecturn gives no thread id", async () => {
    const { link } = await setup({ rpc: async () => ({ nope: 1 }) });
    await expect(link.createThread(PROJECT.projectId, "New thread", "{}")).rejects.toThrow(/answered/);
  });
});

describe("startThreadInProject: the caller's settings (R1.3, D12)", () => {
  it("copies model, runtime and interaction mode, and carries the request", async () => {
    const { fake, start, newProjectId, commands, launches, created } = await setup();
    await expect(start()).resolves.toEqual({ threadId: "thread-1" });
    expect(fake.rpcCalls.map((c) => c.tag)).toEqual([READ, CREATE, DISPATCH, DISPATCH, LAUNCH]);
    expect(fake.rpcCalls[1]!.payload).toEqual({ projectId: newProjectId, title: "solstice-rocket" });
    expect(commands()).toEqual([
      { type: "thread.runtime-mode.set", commandId: "rw:thread.runtime-mode.set:thread-1", threadId: "thread-1", runtimeMode: "auto-accept-edits" },
      { type: "thread.interaction-mode.set", commandId: "rw:thread.interaction-mode.set:thread-1", threadId: "thread-1", interactionMode: "plan" },
    ]);
    expect(launches()).toEqual([
      {
        commandId: "rw:launch:thread-1",
        threadId: "thread-1",
        reuseExistingThread: true,
        projectId: newProjectId,
        title: "solstice-rocket",
        modelSelection: CALLER_MODEL,
        runtimeMode: "auto-accept-edits",
        interactionMode: "plan",
        workspaceStrategy: { type: "root" },
        initialMessage: { text: `${CREATED}\n\nAdd a nose cone`, attachments: [] },
      },
    ]);
    expect(created()).toMatchObject({ modelSelection: CALLER_MODEL, runtimeMode: "auto-accept-edits", interactionMode: "plan" });
  });

  it("leaves the calling thread alone", async () => {
    const { fake, start, commands, launches } = await setup();
    const before = structuredClone(fake.rpcThreads.get(CALLER_THREAD));
    await start();
    expect(fake.rpcThreads.get(CALLER_THREAD)).toEqual(before);
    expect([...commands(), ...launches()].map((p) => p.threadId)).not.toContain(CALLER_THREAD);
  });

  it("keeps a fenced request whole, below the server's prefix", async () => {
    const { start, launches } = await setup();
    const fenced = "Do this:\n```scripted\n{\"steps\": [1]}\n```";
    await start({ request: fenced });
    expect((launches()[0]!.initialMessage as { text: string }).text).toBe(`${CREATED}\n\n${fenced}`);
  });

  it("says the project was opened when this call did not create it", async () => {
    const { start, launches } = await setup();
    await start({ created: false });
    const text = (launches()[0]!.initialMessage as { text: string }).text;
    expect(text).toBe("This project was just opened; do not open it again.\n\nAdd a nose cone");
  });

  it("without a request makes an empty thread with the caller's settings and no turn", async () => {
    const { fake, start, commands, launches, created } = await setup();
    await expect(start({ request: null })).resolves.toEqual({ threadId: "thread-1" });
    expect(launches()).toEqual([]);
    expect(commands().map((c) => c.type)).toEqual(["thread.runtime-mode.set", "thread.interaction-mode.set", "thread.model-selection.set"]);
    expect(created()).toEqual({ modelSelection: CALLER_MODEL, runtimeMode: "auto-accept-edits", interactionMode: "plan", messages: [] });
    expect(fake.rpcCalls.map((c) => c.tag)).not.toContain(LAUNCH);
  });

  it("an empty thread whose model cannot be copied still works on the default", async () => {
    const { fake, start, created } = await setup();
    fake.rpcOutcome = (c) => (c.payload.type === "thread.model-selection.set" ? new LecturnRpcError("no such adapter") : undefined);
    await expect(start({ request: null })).resolves.toEqual({ threadId: "thread-1" });
    expect(created()!.modelSelection).toEqual(fake.threadDefaults.modelSelection);
  });

  it("reads a draining caller on its own server, and starts on the current one", async () => {
    const { fake, link, start, callerProjectId } = await setup();
    fake.origins.set("env-a", "http://127.0.0.1:1001");
    fake.origins.set("env-b", "http://127.0.0.1:2002");
    await fake.ensureWorkspace(CALLER_ROOT, "caller");
    fake.switchTo("env-b", [PROJECT.dir]);
    await new Promise((r) => setTimeout(r, 5));
    await expect(start()).resolves.toEqual({ threadId: "thread-1" });
    expect(callerProjectId.startsWith("env-a:")).toBe(true);
    expect(fake.rpcCalls.map((c) => [c.tag, c.origin])).toEqual([
      [READ, "http://127.0.0.1:1001"],
      [CREATE, "http://127.0.0.1:2002"],
      [DISPATCH, "http://127.0.0.1:2002"],
      [DISPATCH, "http://127.0.0.1:2002"],
      [LAUNCH, "http://127.0.0.1:2002"],
    ]);
    expect(link.status.state).toBe("connected");
  });
});

describe("startThreadInProject: falling back to the project's defaults, capped (R1.3)", () => {
  it.each([
    ["no calling thread", { threadId: null, projectId: "p" }],
    ["no calling project", { threadId: "t", projectId: null }],
  ])("%s", async (_name, caller) => {
    const { fake, start, commands, launches, created } = await setup();
    await expect(start({ caller })).resolves.toEqual({ threadId: "thread-1" });
    expect(fake.rpcCalls.map((c) => c.tag)).toEqual([CREATE, DISPATCH, READ, LAUNCH]);
    expect(commands()).toEqual([{ type: "thread.runtime-mode.set", commandId: "rw:thread.runtime-mode.set:thread-1", threadId: "thread-1", runtimeMode: "approval-required" }]);
    expect(launches()[0]).toMatchObject({ modelSelection: fake.threadDefaults.modelSelection, runtimeMode: "approval-required", interactionMode: "default" });
    expect(created()!.runtimeMode).toBe("approval-required");
  });

  it("caps an empty thread too, without reading it", async () => {
    const { fake, start, created } = await setup();
    await start({ request: null, caller: { threadId: null, projectId: null } });
    expect(fake.rpcCalls.map((c) => c.tag)).toEqual([CREATE, DISPATCH]);
    expect(created()).toMatchObject({ runtimeMode: "approval-required", messages: [] });
  });

  it("a failed read of the caller falls back", async () => {
    const { fake, start, launches, logs } = await setup();
    fake.rpcOutcome = onCall(READ, 1, new LecturnRpcError("thread is gone"));
    await expect(start()).resolves.toEqual({ threadId: "thread-1" });
    expect(launches()[0]).toMatchObject({ runtimeMode: "approval-required", modelSelection: fake.threadDefaults.modelSelection });
    expect(logs.join("\n")).toContain("thread is gone");
  });

  it("a failed mint for the caller falls back", async () => {
    const { fake, start, callerProjectId, launches } = await setup();
    fake.mintFailures.add(callerProjectId);
    await expect(start()).resolves.toEqual({ threadId: "thread-1" });
    expect(fake.rpcCalls[0]!.tag).toBe(CREATE);
    expect(launches()[0]).toMatchObject({ runtimeMode: "approval-required" });
  });

  it("a mint for the caller that never answers falls back after its step", async () => {
    const { fake, start, callerProjectId, launches } = await setup();
    fake.mintStalls.add(callerProjectId);
    await expect(start()).resolves.toEqual({ threadId: "thread-1" });
    expect(launches()[0]).toMatchObject({ runtimeMode: "approval-required" });
  });

  it("a caller thread that has no readable settings falls back", async () => {
    const { fake, start, launches } = await setup();
    fake.rpcThreads.set(CALLER_THREAD, { modelSelection: {}, runtimeMode: "auto", interactionMode: "plan", messages: [] });
    await start();
    expect(launches()[0]).toMatchObject({ runtimeMode: "approval-required" });
  });
});

describe("startThreadInProject: a disabled model (D12)", () => {
  it("does not copy a model disabled here when there is no request, so the first message is not refused", async () => {
    const { fake, start, commands, created } = await setup();
    fake.disabledInstances.add("caller-instance");
    await expect(start({ request: null })).resolves.toEqual({ threadId: "thread-1" });
    expect(commands().map((c) => c.type)).toEqual(["thread.runtime-mode.set", "thread.interaction-mode.set"]);
    expect(created()!.modelSelection).toEqual(fake.threadDefaults.modelSelection);
  });

  it("honours a project's own override of the provider", async () => {
    const { fake, start, created } = await setup();
    const { projectId } = await fake.ensureWorkspace(PROJECT.dir, "project");
    fake.projectOverrides = { [projectId]: { providerInstances: { "caller-instance": { enabled: false } } } };
    await expect(start({ request: null })).resolves.toEqual({ threadId: "thread-1" });
    expect(created()!.modelSelection).toEqual(fake.threadDefaults.modelSelection);
  });

  it("still copies the model when the settings cannot be read", async () => {
    const { fake, start, created } = await setup();
    fake.rpcOutcome = (c) => (c.tag === "server.getConfig" ? new LecturnRpcError("no config") : undefined);
    await expect(start({ request: null })).resolves.toEqual({ threadId: "thread-1" });
    expect(created()).toMatchObject({ modelSelection: expect.objectContaining({ instanceId: "caller-instance" }) });
  });

  it("starts on the project's default model and keeps the caller's modes", async () => {
    const { fake, start, launches, created } = await setup();
    fake.disabledInstances.add("caller-instance");
    await expect(start()).resolves.toEqual({ threadId: "thread-1" });
    expect(launches().map((l) => [l.commandId, l.modelSelection])).toEqual([
      ["rw:launch:thread-1", CALLER_MODEL],
      ["rw:launch-default-model:thread-1", fake.threadDefaults.modelSelection],
    ]);
    expect(launches()[1]).toMatchObject({ runtimeMode: "auto-accept-edits", interactionMode: "plan" });
    expect(created()).toMatchObject({ modelSelection: fake.threadDefaults.modelSelection, messages: [expect.any(String)] });
  });

  it("names the thread when the default model is disabled too", async () => {
    const { fake, start } = await setup();
    fake.disabledInstances.add("caller-instance").add("default-instance");
    await expect(start()).resolves.toEqual({ threadId: "thread-1", unstarted: expect.stringContaining("is disabled") });
  });

  it("does not take a different refusal for a disabled model", async () => {
    const { fake, start, launches } = await setup();
    fake.rpcOutcome = onCall(LAUNCH, 1, new LecturnRpcError("orchestration.launchThread failed: Failed to launch thread"));
    await expect(start()).resolves.toEqual({ threadId: "thread-1", unstarted: expect.stringContaining("Failed to launch thread") });
    expect(launches()).toHaveLength(1);
  });
});

describe("startThreadInProject: what each failure leaves (R1.3)", () => {
  it("rejects when no thread exists: a failed mint for the new project", async () => {
    const { fake, start, newProjectId } = await setup();
    fake.mintFailures.add(newProjectId);
    await expect(start()).rejects.toThrow(/no token for/);
    expect(fake.rpcCalls.map((c) => c.tag)).toEqual([READ]);
  });

  it("rejects when no thread exists: createEmbedThread refused", async () => {
    const { fake, start } = await setup();
    fake.rpcOutcome = onCall(CREATE, 1, new LecturnRpcError("apps.createEmbedThread failed: forbidden"));
    await expect(start()).rejects.toThrow(/forbidden/);
  });

  it("rejects on an answer with no thread id", async () => {
    const { start, link } = await setup({ rpc: async (_o, _b, tag) => (tag === CREATE ? { nope: 1 } : { thread: {} }) });
    await expect(start()).rejects.toThrow(/createEmbedThread answered/);
    expect(link.status.state).toBe("connected");
  });

  it.each([
    ["runtime mode", "thread.runtime-mode.set"],
    ["interaction mode", "thread.interaction-mode.set"],
  ])("does not launch a thread whose %s could not be set", async (_name, type) => {
    const { fake, start, launches } = await setup();
    fake.rpcOutcome = (c) => (c.payload.type === type ? new LecturnRpcError(`${type} refused`) : undefined);
    await expect(start()).resolves.toEqual({ threadId: "thread-1", unstarted: expect.stringContaining("refused") });
    expect(launches()).toEqual([]);
  });

  it("does not launch on the defaults when the cap could not be set", async () => {
    const { fake, start, launches } = await setup();
    fake.rpcOutcome = (c) => (c.payload.type === "thread.runtime-mode.set" ? new LecturnRpcError("refused") : undefined);
    await expect(start({ caller: { threadId: null, projectId: null } })).resolves.toEqual({ threadId: "thread-1", unstarted: expect.stringContaining("refused") });
    expect(launches()).toEqual([]);
  });

  it("does not launch when the defaults cannot be read", async () => {
    const { fake, start, launches } = await setup();
    fake.rpcOutcome = onCall(READ, 1, new LecturnRpcError("read refused"));
    await expect(start({ caller: { threadId: null, projectId: null } })).resolves.toEqual({ threadId: "thread-1", unstarted: expect.stringContaining("read refused") });
    expect(launches()).toEqual([]);
  });

  it("reports a launch Lecturn refused, naming the thread", async () => {
    const { fake, start } = await setup();
    fake.rpcOutcome = onCall(LAUNCH, 1, new LecturnRpcError("orchestration.launchThread failed: no"));
    await expect(start()).resolves.toEqual({ threadId: "thread-1", unstarted: expect.stringContaining("failed: no") });
  });
});

describe("startThreadInProject: a launch whose answer is lost (U38)", () => {
  it("reply lost after the launch was accepted: reads the thread and does not send it again", async () => {
    const { fake, start, launches, created } = await setup();
    fake.rpcOutcome = onCall(LAUNCH, 1, "reply-lost");
    await expect(start()).resolves.toEqual({ threadId: "thread-1" });
    expect(launches()).toHaveLength(1);
    expect(created()!.messages).toHaveLength(1);
    expect(fake.rpcCalls.at(-1)).toMatchObject({ tag: READ, payload: { threadId: "thread-1" } });
  });

  it("request lost before Lecturn saw it: sends it again under the same commandId and threadId", async () => {
    const { fake, start, launches, created } = await setup();
    fake.rpcOutcome = onCall(LAUNCH, 1, "never-arrived");
    await expect(start()).resolves.toEqual({ threadId: "thread-1" });
    expect(launches()).toHaveLength(2);
    expect(launches()[1]).toEqual(launches()[0]);
    expect(created()!.messages).toHaveLength(1);
  });

  it("a stalled launch is cut at its step and reconciled inside the deadline", async () => {
    const { fake, start, launches, created } = await setup({ threadStepMs: 20, threadStartMs: 5_000 });
    fake.rpcOutcome = onCall(LAUNCH, 1, "stall");
    await expect(start()).resolves.toEqual({ threadId: "thread-1" });
    expect(launches()).toHaveLength(2);
    expect(created()!.messages).toHaveLength(1);
  });

  it("a read that also fails is sent again, and the same receipt keeps it to one turn", async () => {
    const { fake, start, launches, created } = await setup();
    let lost = 0;
    fake.rpcOutcome = (c) => (c.tag === LAUNCH && ++lost === 1 ? "reply-lost" : c.tag === READ && c.payload.threadId === "thread-1" ? new LecturnRpcError("read failed") : undefined);
    await expect(start()).resolves.toEqual({ threadId: "thread-1" });
    expect(launches()).toHaveLength(2);
    expect(created()!.messages).toHaveLength(1);
  });

  it("says so when nothing can confirm it", async () => {
    const { fake, start, launches } = await setup();
    fake.rpcOutcome = (c) => (c.tag === LAUNCH ? "never-arrived" : c.tag === READ && c.payload.threadId === "thread-1" ? new LecturnRpcError("read failed") : undefined);
    await expect(start()).resolves.toEqual({ threadId: "thread-1", unstarted: expect.stringMatching(/could not be confirmed: read failed/) });
    expect(launches()).toHaveLength(2);
  });

  it("a refusal on the second try is reported as Lecturn's", async () => {
    const { fake, start } = await setup();
    let n = 0;
    fake.rpcOutcome = (c) => (c.tag === LAUNCH ? (++n === 1 ? "never-arrived" : new LecturnRpcError("orchestration.launchThread failed: gone")) : undefined);
    await expect(start()).resolves.toEqual({ threadId: "thread-1", unstarted: expect.stringContaining("failed: gone") });
  });
});

describe("startThreadInProject: one deadline across every step (U38, D10)", () => {
  const neverFetch = (async () => new Promise(() => undefined)) as unknown as typeof fetch;

  it("the caller's signal ends the start in a step, and no later step runs", async () => {
    const { fake, start } = await setup({ threadStepMs: 60_000 });
    const guard = new AbortController();
    fake.rpcOutcome = (c) => {
      if (c.tag === LAUNCH) {
        setTimeout(() => guard.abort(), 5);
        return "stall";
      }
      return undefined;
    };
    const started = await start({ signal: guard.signal });
    expect(started).toEqual({ threadId: "thread-1", unstarted: expect.stringContaining("could not be confirmed") });
    expect(fake.rpcCalls.filter((c) => c.tag === LAUNCH)).toHaveLength(1);
  });

  it("an aborted signal creates no thread", async () => {
    const { fake, start } = await setup();
    const guard = new AbortController();
    guard.abort();
    await expect(start({ signal: guard.signal })).rejects.toThrow();
    expect(fake.rpcCalls.map((c) => c.tag)).not.toContain(CREATE);
  });

  it("a stalled ticket fetch cannot outlast the deadline", async () => {
    const stalled: typeof lecturnRpc = (origin, bearer, tag, payload, o) => lecturnRpc(origin, bearer, tag, payload, { ...o, fetch: neverFetch });
    const { start } = await setup({ rpc: stalled, threadStepMs: 60_000, threadStartMs: 30 });
    const began = Date.now();
    await expect(start()).rejects.toThrow();
    expect(Date.now() - began).toBeLessThan(2_000);
  });

  it("a new project's mint that never answers rejects inside its step", async () => {
    const { fake, start, newProjectId } = await setup({ threadStepMs: 20 });
    fake.mintStalls.add(newProjectId);
    await expect(start()).rejects.toThrow(/cut short/);
    expect(fake.rpcCalls.map((c) => c.tag)).not.toContain(CREATE);
  });
});

describe("lecturnRpc limits and ambiguity (U38)", () => {
  const okFetch = (async () => new Response(JSON.stringify({ ticket: "tk" }), { status: 200 })) as unknown as typeof fetch;

  class FakeSocket implements SocketLike {
    onopen: SocketLike["onopen"] = null;
    onmessage: SocketLike["onmessage"] = null;
    onerror: SocketLike["onerror"] = null;
    onclose: SocketLike["onclose"] = null;
    readonly sent: string[] = [];
    closed = false;
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      this.closed = true;
    }
  }

  function socketRpc() {
    const ws = new FakeSocket();
    return { ws, opts: { fetch: okFetch, socket: () => ws } };
  }

  const failure = (p: Promise<unknown>): Promise<LecturnRpcError> => p.then(() => expect.fail("expected a rejection"), (e: unknown) => e as LecturnRpcError);
  const opened = () => new Promise((r) => setTimeout(r, 5));

  it("a stalled ticket fetch ends at the time limit and was never sent", async () => {
    const stalled = (async () => new Promise(() => undefined)) as unknown as typeof fetch;
    const e = await failure(lecturnRpc("http://127.0.0.1:9", "b", "x.y", {}, { fetch: stalled, timeoutMs: 10 }));
    expect(e).toBeInstanceOf(LecturnRpcError);
    expect(e).toMatchObject({ ambiguous: false, aborted: true });
    expect(e.message).toContain("no answer within 10 ms");
  });

  it("a stalled ticket fetch ends with the signal", async () => {
    const stalled = (async () => new Promise(() => undefined)) as unknown as typeof fetch;
    const controller = new AbortController();
    const pending = failure(lecturnRpc("http://127.0.0.1:9", "b", "x.y", {}, { fetch: stalled, signal: controller.signal }));
    setTimeout(() => controller.abort(), 5);
    const e = await pending;
    expect(e).toMatchObject({ ambiguous: false, aborted: true });
    expect(e.message).toContain("cut short");
  });

  it("an aborted signal never opens a socket", async () => {
    const { ws, opts } = socketRpc();
    const controller = new AbortController();
    controller.abort();
    const e = await failure(lecturnRpc("http://127.0.0.1:9", "b", "x.y", {}, { ...opts, signal: controller.signal }));
    expect(e).toMatchObject({ ambiguous: false, aborted: true });
    expect(ws.sent).toEqual([]);
  });

  it("a socket that dies before the request went out is not ambiguous", async () => {
    const { ws, opts } = socketRpc();
    const pending = failure(lecturnRpc("http://127.0.0.1:9", "b", "x.y", {}, opts));
    await opened();
    ws.onclose?.({});
    expect(await pending).toMatchObject({ ambiguous: false, aborted: false });
  });

  it("a socket that dies after the request is ambiguous", async () => {
    const { ws, opts } = socketRpc();
    const pending = failure(lecturnRpc("http://127.0.0.1:9", "b", "x.y", {}, opts));
    await opened();
    ws.onopen?.({});
    expect(ws.sent).toHaveLength(1);
    ws.onclose?.({});
    expect(await pending).toMatchObject({ ambiguous: true, aborted: false });
  });

  it("the time limit after the request is ambiguous and closes the socket", async () => {
    const { ws, opts } = socketRpc();
    const pending = failure(lecturnRpc("http://127.0.0.1:9", "b", "x.y", {}, { ...opts, timeoutMs: 15 }));
    await opened();
    ws.onopen?.({});
    expect(await pending).toMatchObject({ ambiguous: true, aborted: true });
    expect(ws.closed).toBe(true);
  });

  it("an answer Lecturn gave is not ambiguous", async () => {
    const { ws, opts } = socketRpc();
    const pending = failure(lecturnRpc("http://127.0.0.1:9", "b", "x.y", {}, opts));
    await opened();
    ws.onopen?.({});
    ws.onmessage?.({ data: JSON.stringify({ _tag: "Exit", requestId: "1", exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: "no" }] } }) });
    expect(await pending).toMatchObject({ ambiguous: false, aborted: false });
  });

  it("passes the signal to fetch", async () => {
    let seen: AbortSignal | null | undefined;
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      seen = init?.signal;
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;
    await expect(lecturnRpc("http://127.0.0.1:9", "b", "x.y", {}, { fetch: fetchImpl })).rejects.toThrow(/refused a socket ticket: 500/);
    expect(seen).toBeInstanceOf(AbortSignal);
  });
});
