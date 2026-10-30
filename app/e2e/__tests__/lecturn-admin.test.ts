/**
 * B16: the W-B2 admin side (`scripts/bar/lecturn-admin.ts`) on fakes: the
 * streamed thread subscription (Effect RPC chunks and acks), the admin
 * session's calls, the approval answerer, the user server's env and args,
 * and the copy ledger's and the switch's pure checks.
 */
import { describe, expect, it } from "vitest";
import type { SocketLike } from "../../apps/server/src/lecturn/appsRpc.ts";
import { RW_APP_ID as REGISTERED_APP_ID } from "../../apps/server/src/lecturn/registration.ts";
import { railKey } from "../../apps/web/src/embed/threads.ts";
import type { EmbedThread } from "../../packages/contracts/src/rpc.ts";
import {
  answerApprovals,
  pendingProviderApprovals,
  continuedLink,
  copiesOf,
  copiesUnchanged,
  copyMark,
  LecturnAdminSession,
  lecturnStream,
  modeAfter,
  switchAfter,
  onlyCopy,
  pendingAppApprovals,
  railKeyOf,
  RUNTIME_MODE_LABEL,
  RW_APP_ID,
  scriptedMessage,
  threadsAfter,
  userServerArgs,
  userServerEnv,
  type AdminProjection,
} from "../../../scripts/bar/lecturn-admin.ts";
import { scriptProblems } from "../capture/scripted.ts";

const ticketFetch = (async () => new Response(JSON.stringify({ ticket: "tk" }), { status: 200 })) as unknown as typeof fetch;

/** A socket the test drives: what the client sent, and `deliver` for server frames. */
class FakeSocket implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  url = "";
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe("lecturnStream (orchestration.subscribeThread)", () => {
  it("sends the request, hands over each chunk, acks it, and ends on the Exit", async () => {
    const ws = new FakeSocket();
    const got: unknown[][] = [];
    const s = await lecturnStream("http://127.0.0.1:9", "bearer", "orchestration.subscribeThread", { threadId: "t1" }, (v) => got.push([...v]), {
      fetch: ticketFetch,
      socket: (url) => ((ws.url = url), ws),
    });
    expect(ws.url).toBe("ws://127.0.0.1:9/ws?orchestrationProtocol=2&wsTicket=tk");
    ws.onopen?.({});
    expect(ws.sent[0]).toEqual({ _tag: "Request", id: "1", tag: "orchestration.subscribeThread", payload: { threadId: "t1" }, headers: [] });
    ws.deliver([{ _tag: "Chunk", requestId: "1", values: [{ kind: "snapshot" }, { kind: "synchronized" }] }]);
    ws.deliver({ _tag: "Chunk", requestId: "2", values: [{ kind: "other request" }] });
    ws.deliver({ _tag: "Chunk", requestId: "1", values: [{ kind: "event" }] });
    expect(got).toEqual([[{ kind: "snapshot" }, { kind: "synchronized" }], [{ kind: "event" }]]);
    expect(ws.sent.filter((m) => m["_tag"] === "Ack")).toEqual([
      { _tag: "Ack", requestId: "1" },
      { _tag: "Ack", requestId: "1" },
    ]);
    ws.deliver({ _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: null } });
    await expect(s.done).resolves.toBeUndefined();
    expect(ws.closed).toBe(true);
  });

  it("rejects on a failed Exit or a dropped socket, and close() interrupts quietly", async () => {
    const failing = new FakeSocket();
    const a = await lecturnStream("http://127.0.0.1:9", "b", "orchestration.subscribeThread", {}, () => undefined, { fetch: ticketFetch, socket: () => failing });
    failing.deliver({ _tag: "Exit", requestId: "1", exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: "nope" }] } });
    await expect(a.done).rejects.toThrow(/subscribeThread failed: .*nope/);
    const dropped = new FakeSocket();
    const b = await lecturnStream("http://127.0.0.1:9", "b", "x", {}, () => undefined, { fetch: ticketFetch, socket: () => dropped });
    dropped.onclose?.({});
    await expect(b.done).rejects.toThrow(/closed before the stream ended/);
    const open = new FakeSocket();
    const c = await lecturnStream("http://127.0.0.1:9", "b", "x", {}, () => undefined, { fetch: ticketFetch, socket: () => open });
    c.close();
    await expect(c.done).resolves.toBeUndefined();
    expect(open.sent.at(-1)).toEqual({ _tag: "Interrupt", requestId: "1", interruptors: [] });
  });
});

/** The admin session with its transport recorded. */
class RecordingAdmin extends LecturnAdminSession {
  readonly calls: { tag: string; payload: Record<string, unknown> }[] = [];
  answer: unknown = {};
  override call(tag: string, payload: unknown): Promise<unknown> {
    this.calls.push({ tag, payload: payload as Record<string, unknown> });
    return Promise.resolve(this.answer);
  }
}

describe("LecturnAdminSession (D16)", () => {
  it("dispatches the user's commands with fresh command ids", async () => {
    const a = new RecordingAdmin("http://127.0.0.1:9", "tok");
    await a.setRuntimeMode("t1", "approval-required");
    await a.sendMessage("t1", "hello", { instanceId: "claudeAgent", model: "claude-fable-5-1" });
    await a.sendMessage("t1", "plain");
    await a.respond("t1", "q1", "accept");
    const [mode, msg, plain, respond] = a.calls;
    expect(a.calls.every((c) => c.tag === "orchestration.dispatchCommand" && String(c.payload["commandId"]).startsWith("rw-bar:"))).toBe(true);
    expect(mode?.payload).toMatchObject({ type: "thread.runtime-mode.set", threadId: "t1", runtimeMode: "approval-required" });
    expect(msg?.payload).toMatchObject({ type: "message.dispatch", createdBy: "user", threadId: "t1", text: "hello", attachments: [], modelSelection: { instanceId: "claudeAgent" }, dispatchMode: { type: "start_immediately" } });
    expect(plain?.payload).not.toHaveProperty("modelSelection");
    expect(respond?.payload).toMatchObject({ type: "runtime-request.respond", threadId: "t1", requestId: "q1", decision: "accept" });
    expect(new Set(a.calls.map((c) => c.payload["commandId"])).size).toBe(4);
  });

  it("finds RocketWright's pairing request in apps.list and grants it", async () => {
    const a = new RecordingAdmin("http://127.0.0.1:9", "tok");
    a.answer = [{ appId: "other" }, { appId: RW_APP_ID, pendingRequest: { requestId: "p1" }, live: null }];
    expect((await a.app())?.pendingRequest?.requestId).toBe("p1");
    await a.decidePairing("p1", "grant");
    expect(a.calls.at(-1)).toEqual({ tag: "apps.decidePairing", payload: { requestId: "p1", decision: "grant" } });
    expect(a.at("http://127.0.0.1:10").origin).toBe("http://127.0.0.1:10");
  });
});

const projection = (requests: AdminProjection["runtimeRequests"]): AdminProjection => ({ runs: [], messages: [], turnItems: [], runtimeRequests: requests });

describe("answerApprovals", () => {
  it("answers each pending app approval once, as decided, after `before`, and logs it", async () => {
    const requests: AdminProjection["runtimeRequests"][number][] = [
      { id: "q1", status: "pending", connectedAppTool: { toolName: "rw_engine_simulate", reason: "Burn duration not set · default 120 s" } },
      { id: "q2", status: "pending" },
      { id: "q3", status: "resolved", connectedAppTool: { toolName: "rw_export_file", reason: null } },
    ];
    const order: string[] = [];
    let onChange: (() => void) | null = null;
    let closed = false;
    const admin = {
      transcript: async () => projection(requests),
      respond: async (_t: string, id: string, d: string) => {
        order.push(`respond ${id} ${d}`);
        const r = requests.find((x) => x.id === id)!;
        Object.assign(r, { status: "resolved", decision: d });
      },
      subscribeThread: async (_t: string, cb: () => void) => {
        onChange = cb;
        return { done: new Promise<void>(() => undefined), close: () => void (closed = true) };
      },
    };
    const lines: string[] = [];
    const ans = await answerApprovals({
      admin,
      threadId: "t1",
      decide: (r) => (r.toolName === "rw_engine_simulate" ? "accept" : "decline"),
      before: async (r) => void order.push(`before ${r.id}`),
      log: (l) => lines.push(l),
      pollMs: 60_000,
    });
    expect(order).toEqual(["before q1", "respond q1 accept"]);
    // A second app approval arrives; the subscription reports the change.
    requests.push({ id: "q4", status: "pending", connectedAppTool: { toolName: "rw_import_file", reason: "Network access to x" } });
    onChange!();
    await ans.tick();
    expect(order).toEqual(["before q1", "respond q1 accept", "before q4", "respond q4 decline"]);
    expect(ans.log.map((e) => [e.requestId, e.toolName, e.decision])).toEqual([
      ["q1", "rw_engine_simulate", "accept"],
      ["q4", "rw_import_file", "decline"],
    ]);
    expect(ans.log[0]).toMatchObject({ threadId: "t1", reason: "Burn duration not set · default 120 s" });
    expect(lines[0]).toMatch(/approval rw_engine_simulate .*: accept/);
    await ans.stop();
    expect(closed).toBe(true);
    expect(ans.errors).toEqual([]);
  });

  it("declines the provider's own approvals (a shell command) once, apart from the app approvals", async () => {
    const requests: AdminProjection["runtimeRequests"][number][] = [
      { id: "c1", kind: "command", status: "pending" },
      { id: "u1", kind: "user_input", status: "pending" },
    ];
    const order: string[] = [];
    const admin = {
      transcript: async () => projection(requests),
      respond: async (_t: string, id: string, d: string) => {
        order.push(`respond ${id} ${d}`);
        Object.assign(requests.find((x) => x.id === id)!, { status: "resolved", decision: d });
      },
    };
    const ans = await answerApprovals({ admin, threadId: "t1", decide: () => "accept", pollMs: 60_000 });
    await ans.tick();
    expect(order).toEqual(["respond c1 decline"]);
    expect(ans.log).toEqual([]);
    expect(ans.provider.map((e) => [e.requestId, e.kind, e.decision])).toEqual([["c1", "command", "decline"]]);
    expect(pendingProviderApprovals(projection(requests))).toEqual([]);
    await ans.stop();
  });

  it("lists only pending connectedAppTool requests not yet answered", () => {
    const p = projection([
      { id: "a", status: "pending", connectedAppTool: { toolName: "rw_x", reason: null } },
      { id: "b", status: "pending" },
      { id: "c", status: "resolved", connectedAppTool: { toolName: "rw_y", reason: null } },
      { id: "d", status: "pending", connectedAppTool: { toolName: "rw_z", reason: "r" } },
    ]);
    expect(pendingAppApprovals(p).map((r) => r.id)).toEqual(["a", "d"]);
    expect(pendingAppApprovals(p, new Set(["a"])).map((r) => r.id)).toEqual(["d"]);
  });
});

describe("the user's Lecturn server (W-B2.4)", () => {
  it("drops inherited LECTURN_* and Electron node mode, and enables the scripted provider on request", () => {
    const env = { HOME: "/h", PATH: "/p", LECTURN_HOME: "/x", LECTURN_SCRIPTED_PROVIDER_SCRIPTS: "/s", ELECTRON_RUN_AS_NODE: "1", VITE_DEV_SERVER_URL: "u", RW_LIVE: "1" };
    expect(userServerEnv(env, false)).toEqual({ HOME: "/h", PATH: "/p", RW_LIVE: "1" });
    expect(userServerEnv(env, true)).toEqual({ HOME: "/h", PATH: "/p", RW_LIVE: "1", LECTURN_TEST_PROVIDERS: "1" });
    expect(userServerArgs("/l/bin.mjs", "/tmp/home")).toEqual(["/l/bin.mjs", "serve", "--base-dir", "/tmp/home", "--host", "127.0.0.1", "--no-browser"]);
  });
});

const thread = (threadId: string, o: Partial<EmbedThread> = {}): EmbedThread => ({
  threadId,
  projectId: "lp",
  workspaceRoot: "/private/tmp/p",
  title: threadId,
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
  historyRevision: 3,
  state: "idle",
  appData: null,
  subtitle: null,
  ...o,
});
const from = (src: string, rev: number, env = "side") => ({ appId: RW_APP_ID, sourceEnvironmentId: env, sourceThreadId: src, copiedAt: `2026-10-25T00:00:0${rev}.000Z`, sourceHistoryRevision: rev });

describe("the copy ledger (decisions 7, 13)", () => {
  it("groups copies by source thread and compares what a re-copy would change", () => {
    const before = copiesOf([thread("c1", { copiedFrom: from("s1", 3) }), thread("c2", { copiedFrom: from("s2", 5) }), thread("x", { copiedFrom: from("s3", 1, "elsewhere") }), thread("own")], "side");
    expect([...before.keys()]).toEqual(["s1", "s2"]);
    expect(copiesOf([thread("x", { copiedFrom: from("s3", 1, "elsewhere") })]).has("s3")).toBe(true);
    expect(copyMark(before.get("s1")![0]!)).toEqual({ threadId: "c1", copiedAt: "2026-10-25T00:00:03.000Z", sourceHistoryRevision: 3, historyRevision: 3 });
    // A visit moves updatedAt only: unchanged.
    const visited = copiesOf([thread("c1", { copiedFrom: from("s1", 3), updatedAt: "2026-10-26T00:00:00.000Z" }), thread("c2", { copiedFrom: from("s2", 5) })], "side");
    expect(copiesUnchanged(before, visited, "visit")).toEqual([]);
    const recopied = copiesOf([thread("c1", { copiedFrom: from("s1", 4) }), thread("c2", { copiedFrom: from("s2", 5) })], "side");
    expect(copiesUnchanged(before, recopied, "attach")).toEqual([expect.stringMatching(/^attach: the copy of s1 changed/)]);
    expect(copiesUnchanged(before, new Map(), "gone")).toHaveLength(2);
    expect(onlyCopy(before, "s1")).toMatchObject({ threadId: "c1" });
    expect(onlyCopy(copiesOf([thread("a", { copiedFrom: from("s1", 1) }), thread("b", { copiedFrom: from("s1", 2) })]), "s1")).toBe("2 copies of s1, want exactly 1");
    expect(onlyCopy(before, "nope")).toBe("0 copies of nope, want exactly 1");
  });

  it("writes the script as a ```scripted block Lecturn's scripted provider reads", () => {
    const steps = [{ toolCall: { name: "rw_simulate", arguments: { sim: "baseline" } } }, { hold: { until: "/tmp/release" } }, { assistantText: "done" }];
    const text = scriptedMessage("Fly it.", steps);
    // Lecturn scriptedScript.ts FENCE.
    const m = /```scripted[^\S\n]*\r?\n([\s\S]*?)```/u.exec(text);
    expect(text.startsWith("Fly it.\n")).toBe(true);
    expect(JSON.parse(m![1]!)).toEqual(steps);
    expect(scriptProblems(JSON.parse(m![1]!))).toEqual([]);
  });
});

describe("the app's view of a live switch (D25)", () => {
  it("finds the connected mode push and the project's latest thread list after a mark", () => {
    const pushes = [
      { topic: "lecturn.status", payload: { state: "connected", mode: "sidecar", pairing: "none" } },
      { topic: "embed.threads", payload: { projectId: "p1", threads: [thread("s1")] } },
      { topic: "lecturn.status", payload: { state: "connecting", mode: "user-server", pairing: "none" } },
      { topic: "lecturn.status", payload: { state: "connected", mode: "user-server", pairing: "none", switched: { environmentId: "u", projects: {}, threadIdMap: { s1: "c1" } } } },
      { topic: "embed.threads", payload: { projectId: "other", threads: [] } },
      { topic: "embed.threads", payload: { projectId: "p1", threads: [thread("c1", { copiedFrom: from("s1", 3) })] } },
    ];
    expect(modeAfter(pushes, 0, "sidecar")?.index).toBe(0);
    expect(modeAfter(pushes, 1, "sidecar")).toBeNull();
    const sw = modeAfter(pushes, 1, "user-server");
    expect(sw?.index).toBe(3);
    expect(sw?.status.switched?.threadIdMap["s1"]).toBe("c1");
    expect(threadsAfter(pushes, 0, "p1")?.threads.map((t) => t.threadId)).toEqual(["c1"]);
    expect(threadsAfter(pushes, 0, "p1")?.index).toBe(5);
    expect(threadsAfter(pushes, 6, "p1")).toBeNull();
  });

  it("takes the switch from the push that carries `switched`, which a plain user-server status and the new thread list can precede", () => {
    const pushes = [
      { topic: "lecturn.status", payload: { state: "connected", mode: "sidecar", pairing: "none" } },
      { topic: "embed.threads", payload: { projectId: "p1", threads: [thread("c1", { copiedFrom: from("s1", 3) })] } },
      { topic: "lecturn.status", payload: { state: "connected", mode: "user-server", pairing: "none" } },
      { topic: "lecturn.status", payload: { state: "connected", mode: "user-server", pairing: "none", switched: { environmentId: "u", projects: {}, threadIdMap: { s1: "c1" } } } },
    ];
    expect(modeAfter(pushes, 1, "user-server")?.status.switched).toBeUndefined();
    expect(switchAfter(pushes, 1)?.index).toBe(3);
    expect(switchAfter(pushes, 4)).toBeNull();
    // The copy's list came before the switch: read lists from the mark taken before the server started.
    expect(threadsAfter(pushes, 3, "p1")).toBeNull();
    expect(threadsAfter(pushes, 0, "p1")?.threads.map((t) => t.threadId)).toEqual(["c1"]);
  });

  it("keys the rail as the web app does, links the copy, and names RocketWright's app id", () => {
    const copy = thread("c1", { copiedFrom: from("s1", 3) });
    expect(railKeyOf(copy.workspaceRoot, "s1")).toBe(railKey(copy));
    expect(railKeyOf("/r", "s1")).toBe(railKey(thread("s1", { workspaceRoot: "/r" })));
    expect(continuedLink("env-u", "copy:env-s:s1")).toBe("lecturn://apps/dev.rocketwright.app/threads/env-u/copy:env-s:s1");
    expect(RW_APP_ID).toBe(REGISTERED_APP_ID);
    expect(RUNTIME_MODE_LABEL).toEqual({ "approval-required": "Supervised", "full-access": "Full access", auto: "Auto" });
  });
});
