/**
 * M1.6b: `pnpm --filter @rw/contracts test mock`. Every RPC method answers
 * schema-valid JSON; scripted resources/updated, job states, the broker, and
 * the fake Lecturn connection behave as IF10 describes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_OPS, TEST_HOOK_OPS } from "../src/broker.ts";
import { RPC_METHODS, RPC_PATH, type RpcMethod } from "../src/rpc.ts";
import { loadFixtures } from "./fixtures.ts";
import { makeValidator, schemaMode, TestClient } from "./harness.ts";
import { reg, RESULT_SCHEMAS, TOPIC_SCHEMAS } from "./rpc-schema.ts";
import { COMMIT_URIS, type MockOptions, type MockServer, SEED_PROJECT_ID, startMockServer } from "./server.ts";

const fixtures = loadFixtures();
const validator = makeValidator(fixtures);
const P = { projectId: SEED_PROJECT_ID };
const TICK = 5;

let servers: MockServer[] = [];
let clients: TestClient[] = [];

async function setup(opts: MockOptions = {}): Promise<{ srv: MockServer; c: TestClient }> {
  const srv = await startMockServer({ tickMs: TICK, ...opts });
  servers.push(srv);
  const c = await client(srv);
  return { srv, c };
}

async function client(srv: MockServer): Promise<TestClient> {
  const c = await TestClient.connect(srv.url, validator);
  clients.push(c);
  return c;
}

afterEach(async () => {
  const [cs, ss] = [clients, servers];
  [clients, servers] = [[], []];
  for (const c of cs) c.close();
  await Promise.all(ss.map((s) => s.close()));
  expect(cs.flatMap((c) => c.violations), "schema violations").toEqual([]);
});

describe("mock RPC: every method", () => {
  it(`answers schema-valid JSON (registry schemas: ${schemaMode})`, async () => {
    const { srv, c } = await setup({ testHooks: true });
    const host = await client(srv);
    const ok = new Set<RpcMethod>();
    const call: TestClient["call"] = async (m, p) => {
      const r = await c.call(m, p);
      ok.add(m);
      return r;
    };

    expect((await call("project.list", {})).projects.map((p) => p.projectId)).toContain(SEED_PROJECT_ID);
    const opened = (await call("project.open", { dir: "/tmp/My Rocket" })).project;
    expect(opened).toEqual({ projectId: "my-rocket", dir: "/tmp/My Rocket", name: "My Rocket" });
    expect((await host.push("project.opened", (p) => p.project.projectId === "my-rocket")).project).toEqual(opened);
    expect((await call("project.open", { dir: "/tmp/My Rocket" })).project.projectId).toBe("my-rocket");
    // Reopening an open project pushes nothing new.
    expect(host.pushes("project.opened").map((p) => p.project.projectId)).toEqual(["my-rocket"]);
    const target = await call("embed.target", { ...P, threadId: "assembly-review" });
    expect(target.url).toContain(`-${SEED_PROJECT_ID}/assembly-review`);
    expect(Number.isNaN(Date.parse(target.expiresAt))).toBe(false);
    const refreshed = await call("embed.refreshToken", P);
    expect(refreshed.token).not.toBe(target.token);
    const [lt] = (await host.push("embed.threads", (p) => p.projectId === SEED_PROJECT_ID)).threads;
    expect(await call("embed.setThreadAppData", { ...P, threadId: lt!.threadId, appData: JSON.stringify({ page: "results" }), subtitle: "Apogee 305 m" })).toEqual({});
    const written = await host.push("embed.threads", (p) => p.projectId === SEED_PROJECT_ID && p.threads[0]?.subtitle === "Apogee 305 m");
    expect(written.threads[0]?.appData).toBe('{"page":"results"}');
    expect(await call("embed.setHostContext", { ...P, text: "- Page: assembly" })).toEqual({ applied: true });
    expect(srv.mock.hostContexts.get(SEED_PROJECT_ID)).toBe("- Page: assembly");
    await call("project.close", { projectId: opened.projectId });

    const sub = await call("project.subscribe", P);
    expect(sub.snapshot.project.projectId).toBe(SEED_PROJECT_ID);
    expect(sub.snapshot.sidecar.state).toBe("ready");
    await c.push("project.snapshot", (p) => p.subscriptionId === sub.subscriptionId);

    const patchIn = fixtures.payload<{ ops: never[] }>("tools/model_patch.input");
    const dry = await call("model.patch", { ...P, ops: patchIn.ops, dry_run: true });
    expect(dry.dry_run).toBe(true);
    const mut = await call("model.patch", { ...P, ops: patchIn.ops, label: "Fin span 90 mm" });
    expect(mut.dry_run).toBe(false);
    expect(mut.step).toBe("step:5");

    expect((await call("check.run", { ...P, config: "baseline", strict: true })).model_hash).toBe(mut.model_hash);
    const sim = await call("sim.run", { ...P, sim: "baseline" });
    expect(sim.status).toBe("running");
    const cancelled = await call("job.cancel", { ...P, jobId: String(sim.job_id) });
    expect(cancelled.state).toBe("cancelled");
    expect((await call("history.compare", { ...P, a: "step:4", b: "step:5" })).b).toBe("step:5");
    expect((await call("model.get", { ...P, version: "step:4" })).model_hash).toMatch(/^[0-9a-f]{64}$/);
    const rev = await call("history.tag", { ...P, name: "Wider fins" });
    expect([rev.number, rev.step]).toEqual([8, 5]);
    expect((await call("history.restore", { ...P, version: "rev:07", dry_run: true })).dry_run).toBe(true);
    expect((await call("history.restore", { ...P, version: "rev:07" })).step).toBe("step:6");

    expect(Array.isArray((await call("library.search", { ...P, kind: "preset" })).items)).toBe(true);
    // M3.6 thumbnails: put, then get by model hash.
    const png = "iVBORw0KGgo=";
    expect(await call("thumb.put", { ...P, model_hash: "aaaa0001", id: "nose", png_base64: png })).toEqual({});
    expect((await call("thumb.get", { ...P, model_hash: "aaaa0001" })).thumbs).toEqual({ nose: png });
    expect((await call("engine.design", { ...P, engine: "demo" })).engine).toBe("demo");
    expect((await call("engine.simulate", { ...P, engine: "demo" })).run_id).toMatch(/^[0-9a-f]{12}$/);
    expect((await call("cfd.import", { ...P, path: "fixtures/cfd/tank_t0.5.csv", study: "tank_flow", dry_run: true })).dataset.provenance).toBe("cfd");
    expect((await call("cfd.list", P)).datasets.map((d) => d.id)).toEqual(["tank_flow"]);
    await host.call("broker.hostRegister", { ...P, hostId: "window-1", capabilities: { ops: [...AGENT_OPS, ...TEST_HOOK_OPS], backend: "webgpu" } });
    ok.add("broker.hostRegister");
    const hooked = c.call("test.call", { ...P, op: "app_navigate", args: { page: "results" } });
    const breq = await host.push("broker.request", (r) => r.op === "app_navigate");
    expect(breq).toMatchObject({ projectId: SEED_PROJECT_ID, threadId: null, args: { page: "results" } });
    await host.call("broker.respond", { requestId: breq.requestId, ok: true, result: {} });
    ok.add("broker.respond");
    expect(await hooked).toEqual({});
    ok.add("test.call");

    await call("project.unsubscribe", { subscriptionId: sub.subscriptionId });
    expect([...ok].sort()).toEqual([...RPC_METHODS].sort());
  });

  it("answers errors as schema-valid RpcError frames", async () => {
    const { c } = await setup();
    const err = async (method: string, params: Record<string, unknown>) => {
      const r = await c.request(method as RpcMethod, params);
      expect(r.ok).toBe(false);
      return r.ok ? null : r.error.code;
    };
    expect(await err("nope.nope", {})).toBe("invalid_params");
    expect(await err("check.run", { projectId: "missing" })).toBe("not_found");
    expect(await err("model.patch", { ...P, ops: [] })).toBe("invalid_params");
    expect(await err("sim.run", { ...P })).toBe("invalid_params");
    expect(await err("job.cancel", { ...P, jobId: "job-9999" })).toBe("not_found");
    expect(await err("history.restore", { ...P, version: "step:99" })).toBe("not_found");
    expect(await err("broker.respond", { requestId: "broker-0", ok: true, result: {} })).toBe("not_found");
    expect(await err("project.unsubscribe", { subscriptionId: "sub-0" })).toBe("not_found");
    // I12: hooks are off unless RW_TEST_HOOKS=1.
    expect(await err("test.call", { ...P, op: "app_navigate", args: { page: "results" } })).toBe("hooks_disabled");
    // Malformed frames carry no id and get no answer; the connection survives.
    c.sendRaw("{not json");
    c.sendRaw(JSON.stringify({ kind: "push", id: 1 }));
    expect((await c.call("project.list", {})).projects.length).toBeGreaterThan(0);
  });

  it("rejects test hooks that are not app_* ops, and reports a missing host", async () => {
    const { c } = await setup({ testHooks: true });
    const hello = c.frames[0]!;
    expect(hello).toMatchObject({ kind: "hello", testHooks: true });
    const bad = await c.request("test.call", { ...P, op: "viewport_render", args: {} });
    expect(bad.ok ? null : bad.error.code).toBe("invalid_params");
    const noHost = await c.request("test.call", { ...P, op: "app_navigate", args: { page: "results" } });
    expect(noHost.ok ? null : noHost.error.code).toBe("not_found");
  });
});

describe("mock RPC: scripted resources/updated", () => {
  it("pushes one project.patch with every commit resource after a UI patch", async () => {
    const { c } = await setup();
    const sub = await c.call("project.subscribe", P);
    const before = sub.snapshot;
    const ops = fixtures.payload<{ ops: never[] }>("tools/model_patch.input").ops;

    const mark = c.frames.length;
    const dry = await c.call("model.patch", { ...P, ops, dry_run: true });
    expect(dry.model_hash).not.toBe(before.files.model_hash);
    await c.call("project.list", {});
    expect(c.pushes("project.patch", mark)).toEqual([]);

    const out = await c.call("model.patch", { ...P, ops, label: "Fin span 90 mm" });
    const { patch } = await c.push("project.patch", (p) => p.subscriptionId === sub.subscriptionId, mark);
    expect(Object.keys(patch).sort()).toEqual(["check", "evaluated", "files", "history", "projectId", "runs"]);
    expect(COMMIT_URIS).toHaveLength(5);
    for (const h of [patch.evaluated?.model_hash, patch.check?.model_hash, patch.files?.model_hash, patch.runs?.model_hash]) expect(h).toBe(out.model_hash);
    const head = patch.history!.steps.at(-1)!;
    expect(head).toMatchObject({ seq: 5, title: "Fin span 90 mm", origin: "ui", thread: "ui", model_hash: out.model_hash, prev: before.history.steps.at(-1)!.id });
    // I7: run status is computed from the model hash.
    expect(before.runs.runs.map((r) => r.status)).toEqual(["complete", "outdated", "running", "not_run"]);
    expect(patch.runs!.runs.map((r) => r.status)).toEqual(["outdated", "outdated", "running", "not_run"]);
  });

  it("plays script steps after the first subscribe", async () => {
    const { c } = await setup({
      script: [
        { afterMs: 5, commit: "Edit rocket.rw.toml" },
        { afterMs: 15, sidecar: "restarting" },
        { afterMs: 25, sidecar: "ready" },
        { afterMs: 35, uris: ["rw://project/check"], set: { check: null } },
      ],
    });
    await c.call("project.subscribe", P);
    const edit = await c.push("project.patch", (p) => p.patch.history !== undefined);
    expect(edit.patch.history!.steps.at(-1)).toMatchObject({ origin: "watcher", title: "Edit rocket.rw.toml" });
    expect((await c.push("project.patch", (p) => p.patch.sidecar?.state === "restarting")).patch.sidecar!.version).toBe("0.0.0-mock");
    await c.push("project.patch", (p) => p.patch.sidecar?.state === "ready");
    await c.push("project.patch", (p) => "check" in p.patch && p.patch.check === null);
    const r = await c.request("check.run", P);
    expect(r.ok ? null : r.error.code).toBe("sidecar_unavailable");
  });

  it("pushes patches to every subscriber and none after unsubscribe", async () => {
    const { srv, c } = await setup();
    const other = await client(srv);
    const a = await c.call("project.subscribe", P);
    const b = await other.call("project.subscribe", P);
    await other.call("project.unsubscribe", { subscriptionId: b.subscriptionId });
    const mark = other.frames.length;
    srv.mock.resourcesUpdated(SEED_PROJECT_ID, ["rw://project/check"]);
    const got = await c.push("project.patch", (p) => p.subscriptionId === a.subscriptionId);
    expect(Object.keys(got.patch).sort()).toEqual(["check", "projectId"]);
    await other.call("project.list", {});
    expect(other.pushes("project.patch", mark)).toEqual([]);
  });
});

describe("mock RPC: job states", () => {
  it("runs a job queued -> running -> complete and refreshes runs", async () => {
    const { c } = await setup();
    await c.call("project.subscribe", P);
    // The fixture run is current: a plain run is served from cache.
    const cached = await c.call("sim.run", { ...P, sim: "baseline" });
    expect(cached).toMatchObject({ status: "complete", cached: true });
    expect(cached.job_id).toBeUndefined();

    const mark = c.frames.length;
    const run = await c.call("sim.run", { ...P, sim: "baseline", force: true });
    expect(run).toMatchObject({ status: "running", cached: false });
    const jobId = String(run.job_id);
    const done = await c.push("project.patch", (p) => p.patch.jobs?.find((j) => j.job_id === jobId)?.state === "complete", mark);
    const states = c.pushes("project.patch", mark).flatMap((p) => p.patch.jobs?.filter((j) => j.job_id === jobId).map((j) => j.state) ?? []);
    expect(states).toEqual(["queued", "running", "complete"]);
    const entry = done.patch.runs!.runs.find((r) => r.sim === "baseline")!;
    expect(entry).toMatchObject({ status: "complete", run_id: run.run_id });
    const again = await c.call("sim.run", { ...P, sim: "baseline" });
    expect(again).toMatchObject({ cached: true, run_id: run.run_id });
  });

  it("cancels a running job and restores the run entry", async () => {
    const { c } = await setup({ tickMs: 200 });
    const sub = await c.call("project.subscribe", P);
    const before = sub.snapshot.runs.runs.find((r) => r.sim === "fin_revision")!;
    const run = await c.call("sim.run", { ...P, sim: "fin_revision" });
    await c.push("project.patch", (p) => p.patch.runs?.runs.find((r) => r.sim === "fin_revision")?.status === "running");
    const job = await c.call("job.cancel", { ...P, jobId: String(run.job_id) });
    expect(job.state).toBe("cancelled");
    const { patch } = await c.push("project.patch", (p) => p.patch.jobs?.some((j) => j.state === "cancelled") === true);
    expect(patch.runs!.runs.find((r) => r.sim === "fin_revision")).toEqual(before);
    // Cancelling a finished job is a no-op that returns it.
    expect((await c.call("job.cancel", { ...P, jobId: String(run.job_id) })).state).toBe("cancelled");
  });

  it("adds a run entry for a sim with no runs yet", async () => {
    const { c } = await setup();
    await c.call("project.subscribe", P);
    const run = await c.call("sim.run", { ...P, sim: "windy" });
    const { patch } = await c.push("project.patch", (p) => p.patch.jobs?.some((j) => j.job_id === run.job_id && j.state === "complete") === true);
    expect(patch.runs!.runs.find((r) => r.sim === "windy")).toMatchObject({ status: "complete", run_id: run.run_id });
  });
});

describe("mock RPC: transport", () => {
  it("serves series CSV over HTTP and 404s unknown runs and paths", async () => {
    const { srv } = await setup();
    const ok = await fetch(`${srv.httpUrl}/api/projects/${SEED_PROJECT_ID}/runs/baseline/f8eb21388e28/series.csv`);
    expect(ok.status).toBe(200);
    const [header, ...rows] = (await ok.text()).trim().split("\n");
    expect(header!.split(",")[0]).toBe("t");
    expect(rows.length).toBeGreaterThan(0);
    expect((await fetch(`${srv.httpUrl}/api/projects/${SEED_PROJECT_ID}/runs/baseline/000000000000/series.csv`)).status).toBe(404);
    expect((await fetch(`${srv.httpUrl}/nope`)).status).toBe(404);
    const ws = new WebSocket(srv.url.replace(RPC_PATH, "/other"));
    await new Promise((resolve) => ws.addEventListener("error", resolve, { once: true }));
  });

  it("handles a large frame (16-bit and 64-bit lengths)", async () => {
    const { c } = await setup();
    const label = "x".repeat(70_000);
    const out = await c.call("model.patch", { ...P, ops: [{ op: "replace", path: "/c/fins/span", value: "90 mm" }], label });
    expect(out.step).toBe("step:5");
  });
});

describe("mock RPC: Lecturn (B8)", () => {
  it("sends the Lecturn status and each project's threads after hello", async () => {
    const { c } = await setup();
    expect(await c.push("lecturn.status")).toEqual({ state: "connected", mode: "sidecar", pairing: "none" });
    const threads = (await c.push("embed.threads", (p) => p.projectId === SEED_PROJECT_ID)).threads;
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ workspaceRoot: `/mock/${SEED_PROJECT_ID}`, state: "idle", subtitle: null });
  });

  it("plays a live switch: new ids in lecturn.status, then embed.threads", async () => {
    const { srv, c } = await setup();
    const before = (await c.push("embed.threads", (p) => p.projectId === SEED_PROJECT_ID)).threads[0]!;
    srv.mock.lecturnSwitch();
    const status = await c.push("lecturn.status", (s) => s.switched !== undefined);
    expect(status.mode).toBe("user-server");
    const newProject = status.switched!.projects[SEED_PROJECT_ID]!;
    const newThread = status.switched!.threadIdMap[before.threadId]!;
    expect(newProject).not.toBe(before.projectId);
    const after = await c.push("embed.threads", (p) => p.threads[0]?.threadId === newThread);
    expect(after.threads[0]).toMatchObject({ projectId: newProject, workspaceRoot: before.workspaceRoot });
    expect((await c.call("embed.target", P)).url).toContain(`/${newProject}`);
  });

  it("refuses appData over 1 KB and unknown threads", async () => {
    const { c } = await setup();
    const lt = (await c.push("embed.threads", (p) => p.projectId === SEED_PROJECT_ID)).threads[0]!;
    expect(await c.request("embed.setThreadAppData", { ...P, threadId: lt.threadId, appData: "x".repeat(1025) })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(await c.request("embed.setThreadAppData", { ...P, threadId: "nope", appData: null })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await c.request("embed.setHostContext", { ...P, text: "x".repeat(4097) })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });
});

describe("mock RPC: schemas", () => {
  it("has a result schema per method and a push schema per topic", () => {
    expect(Object.keys(RESULT_SCHEMAS).sort()).toEqual([...RPC_METHODS].sort());
    expect(Object.keys(TOPIC_SCHEMAS).sort()).toEqual(["broker.request", "embed.threads", "lecturn.status", "project.opened", "project.patch", "project.snapshot"]);
  });

  it("every contract fixture validates against its registry schema", () => {
    const bad = fixtures.all.flatMap((f) => validator.validate(reg(f.type), f.payload).map((e) => `${f.file}: ${e}`));
    expect(bad).toEqual([]);
  });
});
