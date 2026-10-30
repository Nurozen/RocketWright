/**
 * B12: `pnpm -C app --filter @rw/web test -- navigation hostContext rail`.
 * The left rail's Lecturn threads: appData binding, one entry per source
 * thread (a copy and its sidecar original, D21), selection by rail key
 * through a live switch (D25), rail actions through the pane bridge
 * (open, new with appData, artifact threads, D12), the D12 fallback, the
 * mention chip, the run subtitle and the providers button, against the
 * contracts mock over a real socket.
 */
import type { EmbedThread, EvaluatedModel, PaneEvent, PaneEvents, PatchOp, RpcMethod, RpcParams } from "@rw/contracts";
import { SEED_PROJECT_ID, startMockServer, type MockServer } from "@rw/contracts/mock";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePageThread, navigatePage, newPageThread, openArtifactThread, openThread, railThreads, selectedRailId } from "./rail.ts";
import { MENTION_EVENT } from "./mention.ts";
import { shellModelFrom } from "../shell/connect.ts";
import { RpcClient } from "../state/rpc.ts";
import { createAppStore, type AppStore } from "../state/store.ts";
import type { AppState } from "../state/types.ts";
import type { PreviewCore } from "../state/wasm.ts";
import type { MentionParams, PaneBridge } from "./bridge.ts";
import { appDataOf, embedRailThreads, parseAppData, railKey, setPane } from "./threads.ts";
import { mentionParams, newlyCompleted, runSubtitle, runThread, wirePane } from "./wiring.ts";

const CORE = "0.0.0-mock";
const ROOT = `/mock/${SEED_PROJECT_ID}`;
const core: PreviewCore = { coreVersion: () => CORE, applyAndEval: (_: { ops: readonly PatchOp[] }) => ({}) as EvaluatedModel };

let servers: MockServer[] = [];
let stores: AppStore[] = [];
let clients: RpcClient[] = [];
afterEach(async () => {
  for (const s of stores) s.getState().project.disconnect();
  for (const c of clients) c.close();
  await Promise.all(servers.map((s) => s.close()));
  [servers, stores, clients] = [[], [], []];
});

function lt(threadId: string, updatedAt: string, extra: Partial<EmbedThread> = {}): EmbedThread {
  return { threadId, projectId: "lp", workspaceRoot: ROOT, title: threadId, createdAt: updatedAt, updatedAt, historyRevision: 1, state: "idle", appData: null, subtitle: null, ...extra };
}

/** A recording `PaneBridge` whose guest events the test plays. */
function fakeBridge() {
  const sent: { method: string; params: unknown }[] = [];
  const listeners = new Map<PaneEvent, Set<(p: never) => void>>();
  const bridge: PaneBridge = {
    insertMention: (params: MentionParams) => void sent.push({ method: "insertMention", params }),
    setDraft: (text) => void sent.push({ method: "setDraft", params: { text } }),
    openThread: (threadId) => void sent.push({ method: "openThread", params: { threadId } }),
    newThread: (params = {}) => void sent.push({ method: "newThread", params }),
    openProviders: () => void sent.push({ method: "openProviders", params: {} }),
    on: (event, l) => {
      let set = listeners.get(event);
      if (set === undefined) listeners.set(event, (set = new Set()));
      set.add(l as (p: never) => void);
      return () => void set.delete(l as (p: never) => void);
    },
  };
  const emit = <E extends PaneEvent>(event: E, payload: PaneEvents[E]): void => {
    for (const l of listeners.get(event) ?? []) (l as (p: PaneEvents[E]) => void)(payload);
  };
  return { bridge, sent, emit };
}

/** Records the store's RPC calls (forwarding them to the mock). */
function spyClient(client: RpcClient) {
  const calls: { method: RpcMethod; params: unknown }[] = [];
  return {
    calls,
    call: <M extends RpcMethod>(method: M, params: RpcParams<M>) => {
      calls.push({ method, params });
      return client.call(method, params);
    },
  };
}

function until(store: AppStore, pred: (s: AppState) => boolean, ms = 3000): Promise<AppState> {
  if (pred(store.getState())) return Promise.resolve(store.getState());
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      off();
      reject(new Error(`timed out: ${pred.toString().slice(0, 120)}`));
    }, ms);
    const off = store.subscribe((s) => {
      if (!pred(s)) return;
      clearTimeout(t);
      off();
      resolve(s);
    });
  });
}
const waitFor = async (pred: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** A store on the mock's seed project with the embed as the pane and a mounted fake bridge. */
async function setup() {
  const srv = await startMockServer({ tickMs: 5, coreVersion: CORE });
  servers.push(srv);
  const client = await RpcClient.connect(srv.url);
  clients.push(client);
  const store = createAppStore({ loadWasm: async () => core, now: () => Date.UTC(2026, 9, 25, 9) });
  stores.push(store);
  await store.getState().project.connect(client, SEED_PROJECT_ID);
  store.getState().chat.setEmbedded(true);
  const pane = fakeBridge();
  setPane(store, pane.bridge);
  const spy = spyClient(client);
  return { srv, client, store, pane, spy };
}

describe("rail data (B12, pure)", () => {
  it("parses RocketWright appData and nothing else", () => {
    expect(parseAppData('{"page":"results"}')).toEqual({ page: "results" });
    expect(parseAppData('{"artifact":"rw:sim/baseline"}')).toEqual({ artifact: "rw:sim/baseline" });
    for (const bad of [null, "", "nope", '{"page":"nowhere"}', '{"artifact":"http://x"}', "[1]"]) expect(parseAppData(bad), String(bad)).toBeNull();
    expect(parseAppData(appDataOf({ page: "liquid" }))).toEqual({ page: "liquid" });
  });

  it("lists a copy and its sidecar original as one entry keyed by root and source, the live copy shown (D21, D25)", () => {
    const copiedFrom = { appId: "dev.rocketwright.app", sourceEnvironmentId: "side", sourceThreadId: "s-1", copiedAt: "2026-10-25T00:00:03.000Z", sourceHistoryRevision: 4 };
    const original = lt("s-1", "2026-10-25T00:00:01.000Z", { title: "Old title", continuedIn: { environmentId: "user", threadId: "u-1", copiedAt: copiedFrom.copiedAt } });
    const copy = lt("u-1", "2026-10-25T00:00:02.000Z", { title: "Fin sizing", copiedFrom, state: "running", appData: '{"page":"assembly"}' });
    const other = lt("u-2", "2026-10-25T00:00:05.000Z", { title: "Newer" });
    const rail = embedRailThreads([original, copy, other]);
    expect(rail.map((t) => [t.id, t.threadId, t.title, t.busy])).toEqual([
      [`${ROOT}#u-2`, "u-2", "Newer", false],
      [`${ROOT}#s-1`, "u-1", "Fin sizing", true],
    ]);
    expect(railKey(copy)).toBe(railKey(original));
    expect(rail[1]!.binding).toEqual({ page: "assembly" });
  });

  it("formats the run subtitle and picks the thread a run belongs to", () => {
    expect(runSubtitle({ config: "baseline", summary: { apogee_m: 305.2312 } })).toBe("baseline / 305.23 m");
    expect(runSubtitle({ config: "x".repeat(100), summary: { apogee_m: 1 } })!.length).toBe(80);
    expect(runSubtitle({ config: "baseline", summary: null })).toBeNull();
    const a = lt("a", "2026-10-25T00:00:01.000Z");
    const b = lt("b", "2026-10-25T00:00:01.000Z", { state: "running" });
    expect(runThread([a, b], "a")?.threadId).toBe("b");
    expect(runThread([a, { ...b, state: "idle" }], "a")?.threadId).toBe("a");
    const seen = new Set(["r1"]);
    expect(newlyCompleted([{ status: "complete", run_id: "r1" }, { status: "running", run_id: "r2" }, { status: "complete", run_id: "r3" }], seen)).toEqual([{ status: "complete", run_id: "r3" }]);
    expect(newlyCompleted([{ status: "complete", run_id: "r3" }], seen)).toEqual([]);
  });
});

describe("rail threads through the embed (B12, contracts mock)", () => {
  it("keeps the last embed.threads per project for listeners that come later (sticky after hello)", async () => {
    const srv = await startMockServer({ tickMs: 5, coreVersion: CORE });
    servers.push(srv);
    const opened = await (async () => {
      const c = await RpcClient.connect(srv.url);
      clients.push(c);
      return (await c.call("project.open", { dir: "/mock/second" })).project;
    })();
    const client = await RpcClient.connect(srv.url);
    clients.push(client);
    await new Promise((r) => setTimeout(r, 50));
    const got: string[] = [];
    client.on("embed.threads", (p) => void got.push(p.projectId));
    expect(got.sort()).toEqual([SEED_PROJECT_ID, opened.projectId].sort());
  });


  it("reads embed.threads (sticky after hello), binds by appData, and lists unbound threads on every page", async () => {
    const { srv, store } = await setup();
    const s = await until(store, (x) => x.chat.lecturn.threads !== null);
    expect(railThreads(s, "assembly").map((t) => t.title)).toEqual(["Assembly review"]);
    expect(railThreads(s, "results")).toEqual([]);
    srv.mock.setEmbedThreads(SEED_PROJECT_ID, [
      ...srv.mock.embedThreads(),
      lt("lt-1-x-2", "2026-10-25T08:00:00.000Z", { title: "Run review", appData: '{"artifact":"rw:sim/baseline"}' }),
      lt("lt-1-x-3", "2026-10-25T07:00:00.000Z", { title: "Unbound" }),
    ]);
    const next = await until(store, (x) => (x.chat.lecturn.threads?.length ?? 0) === 3);
    expect(railThreads(next, "results").map((t) => t.title)).toEqual(["Run review", "Unbound"]);
    expect(railThreads(next, "assembly").map((t) => t.title)).toEqual(["Unbound", "Assembly review"]);
    expect(shellModelFrom({ ...next, ui: { ...next.ui, page: "results" } }, Date.now(), {}).threads.find((t) => t.title === "Run review")).toMatchObject({ artifact: "rw:sim/baseline" });
  });

  it("routes rail actions through the bridge: open, new thread with page appData, artifact threads (D12)", async () => {
    const { store, pane } = await setup();
    const s = await until(store, (x) => x.chat.lecturn.threads !== null);
    const [seed] = railThreads(s, "assembly");
    await openThread(store, seed!.id);
    expect(pane.sent.at(-1)).toEqual({ method: "openThread", params: { threadId: seed!.threadId } });
    expect(selectedRailId(store.getState())).toBe(seed!.id);

    await navigatePage(store, "results");
    newPageThread(store);
    expect(pane.sent.at(-1)).toEqual({ method: "newThread", params: { title: "New thread", appData: '{"page":"results"}' } });
    await openArtifactThread(store, "rw:sim/baseline");
    expect(pane.sent.at(-1)).toEqual({ method: "newThread", params: { title: "Baseline", appData: '{"artifact":"rw:sim/baseline"}' } });
  });

  it("opens the page's newest thread on a page change, and leaves a just-made thread alone", async () => {
    const { srv, store, pane } = await setup();
    await until(store, (x) => x.chat.lecturn.threads !== null);
    srv.mock.setEmbedThreads(SEED_PROJECT_ID, [...srv.mock.embedThreads(), lt("lt-r", "2026-10-25T08:00:00.000Z", { title: "Results talk", appData: '{"page":"results"}' })]);
    await until(store, (x) => (x.chat.lecturn.threads?.length ?? 0) === 2);
    await navigatePage(store, "results");
    expect(pane.sent.at(-1)).toEqual({ method: "openThread", params: { threadId: "lt-r" } });
    // The guest made a thread the list does not name yet: no switching away from it.
    store.getState().chat.setLecturnThread("lt-new");
    const before = pane.sent.length;
    await navigatePage(store, "assembly");
    await ensurePageThread(store);
    expect(pane.sent.length).toBe(before);
  });

  it("keeps the selected rail entry and its title through a live switch (D25)", async () => {
    const { srv, store, pane, spy } = await setup();
    const s = await until(store, (x) => x.chat.lecturn.threads !== null);
    const stop = wirePane(store, spy, SEED_PROJECT_ID, pane.bridge, { target: new EventTarget() as unknown as Window, hostContextDelayMs: 0 });
    const [seed] = railThreads(s, "assembly");
    pane.emit("lecturn/thread.changed", { threadId: seed!.threadId });
    expect(selectedRailId(store.getState())).toBe(seed!.id);

    srv.mock.lecturnSwitch("user-server");
    // The switch push remaps the shown thread at once; the key holds until the new list names it.
    const moved = await until(store, (x) => x.chat.lecturn.activeThreadId !== seed!.threadId);
    expect(selectedRailId(moved)).toBe(seed!.id);
    const after = await until(store, (x) => x.chat.lecturn.threads?.[0]?.threadId === x.chat.lecturn.activeThreadId);
    const rail = railThreads(after, "assembly");
    expect(rail.map((t) => [t.id, t.title])).toEqual([[seed!.id, "Assembly review"]]);
    expect(rail[0]!.threadId).not.toBe(seed!.threadId);
    expect(selectedRailId(after)).toBe(seed!.id);
    expect(shellModelFrom(after, Date.now(), {}).selectedThreadId).toBe(seed!.id);
    stop();
  });

  it("binds a guest-made thread without appData to the current page (D12 fallback)", async () => {
    const { srv, store, pane, spy } = await setup();
    await until(store, (x) => x.chat.lecturn.threads !== null);
    const stop = wirePane(store, spy, SEED_PROJECT_ID, pane.bridge, { target: new EventTarget() as unknown as Window, hostContextDelayMs: 0 });
    await navigatePage(store, "configurations");
    pane.emit("lecturn/thread.changed", { threadId: "lt-guest" });
    srv.mock.setEmbedThreads(SEED_PROJECT_ID, [...srv.mock.embedThreads(), lt("lt-guest", "2026-10-25T08:00:00.000Z", { title: "From the guest" })]);
    await waitFor(() => spy.calls.some((c) => c.method === "embed.setThreadAppData"));
    expect(spy.calls.filter((c) => c.method === "embed.setThreadAppData")).toEqual([
      { method: "embed.setThreadAppData", params: { projectId: SEED_PROJECT_ID, threadId: "lt-guest", appData: '{"page":"configurations"}' } },
    ]);
    const s = await until(store, (x) => x.chat.lecturn.threads?.find((t) => t.threadId === "lt-guest")?.appData != null);
    expect(railThreads(s, "configurations").map((t) => t.title)).toContain("From the guest");
    expect(railThreads(s, "assembly").map((t) => t.title)).not.toContain("From the guest");
    stop();
  });

  it("sends one insertMention per MENTION_EVENT, with the part thumbnail as the chip icon", async () => {
    const { store, pane, spy } = await setup();
    const target = new EventTarget();
    const stop = wirePane(store, spy, SEED_PROJECT_ID, pane.bridge, { target: target as unknown as Window, hostContextDelayMs: 0 });
    store.setState((s) => ({ thumbs: { ...s.thumbs, urls: { recovery_bay: "data:image/png;base64,AAAA", fins: `data:image/png;base64,${"A".repeat(100 * 1024)}` } } }));
    target.dispatchEvent(new CustomEvent(MENTION_EVENT, { detail: { ref: "rw:c/recovery_bay", label: "Recovery bay" } }));
    target.dispatchEvent(new CustomEvent(MENTION_EVENT, { detail: { ref: "rw:c/fins", label: "Fins" } }));
    target.dispatchEvent(new CustomEvent(MENTION_EVENT, { detail: { label: "no ref" } }));
    expect(pane.sent.filter((m) => m.method === "insertMention").map((m) => m.params)).toEqual([
      { ref: "rw:c/recovery_bay", label: "Recovery bay", iconUrl: "data:image/png;base64,AAAA" },
      { ref: "rw:c/fins", label: "Fins" },
    ]);
    expect(mentionParams(store.getState(), { ref: "rw:sim/baseline", label: "Baseline" })).toEqual({ ref: "rw:sim/baseline", label: "Baseline" });
    stop();
    target.dispatchEvent(new CustomEvent(MENTION_EVENT, { detail: { ref: "rw:c/nose", label: "Nose" } }));
    expect(pane.sent.filter((m) => m.method === "insertMention")).toHaveLength(2);
  });

  it("sets the subtitle '<config> / <apogee>' on the run's thread after each completed run, keeping its appData", async () => {
    const { srv, store, pane, spy } = await setup();
    const s0 = await until(store, (x) => x.chat.lecturn.threads !== null && x.project.snapshot !== null);
    const stop = wirePane(store, spy, SEED_PROJECT_ID, pane.bridge, { target: new EventTarget() as unknown as Window, hostContextDelayMs: 0 });
    const [seed] = srv.mock.embedThreads();
    pane.emit("lecturn/ready", { threadId: seed!.threadId });
    const before = s0.project.snapshot!.runs;
    // Runs on disk when the pane came up are not news; a new completed one is.
    const run = { sim: "baseline", sim_name: "Baseline", config: "baseline", kind: "flight", status: "complete", run_id: "fresh0000001", summary: { ...before.runs.find((r) => r.summary != null)?.summary, apogee_m: 305.231 } };
    store.setState((s) => ({ project: { ...s.project, snapshot: { ...s.project.snapshot!, runs: { ...before, runs: [...before.runs, run] } } as typeof s.project.snapshot } }));
    await waitFor(() => spy.calls.some((c) => c.method === "embed.setThreadAppData"));
    expect(spy.calls.filter((c) => c.method === "embed.setThreadAppData")).toEqual([
      { method: "embed.setThreadAppData", params: { projectId: SEED_PROJECT_ID, threadId: seed!.threadId, appData: seed!.appData, subtitle: "baseline / 305.23 m" } },
    ]);
    const written = await until(store, (x) => x.chat.lecturn.threads?.[0]?.subtitle === "baseline / 305.23 m");
    expect(written.chat.lecturn.threads?.[0]?.appData).toBe('{"page":"assembly"}');
    stop();
  });
});
