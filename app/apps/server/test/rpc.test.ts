/**
 * M1.45: `pnpm --filter server test rpc`.
 *
 * The app server end to end over a real WebSocket against the real
 * `rocketwright mcp --project <tmp> --app` sidecar (built with `doubles`):
 * every server frame is validated against the IF10 schemas and the registry
 * schemas (`TestClient`). Covers the mirror (`resources/updated` → one
 * `project.patch`), UI tool calls (origin `ui`), job tracking, history, the
 * broker, test hooks (I12), series over HTTP, and sidecar restart with
 * backoff. (B17 removed the old chat's `thread.*` and `approval.*` methods.)
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonObject, ProjectInfo, ProjectPatch, ProjectSnapshot, ServerFrame } from "@rw/contracts";
import { TestClient, makeValidator } from "@rw/contracts/mock/harness";
import { request } from "node:http";
import { AppServer, allowedOrigin } from "../src/rpc/AppServer.ts";
import { fixture, sidecarBin, tempProject } from "./helpers/harness.ts";

const validator = makeValidator();

async function startServer(opts: { testHooks?: boolean } = {}): Promise<AppServer> {
  return AppServer.start({
    bin: sidecarBin(),
    stderr: "ignore",
    testHooks: opts.testHooks ?? false,
    jobPollMs: 50,
    backoff: { initialMs: 50, maxMs: 400 },
  });
}

const since = (c: TestClient): number => c.frames.length;
const patches = (c: TestClient, from: number): ProjectPatch[] => c.pushes("project.patch", from).map((p) => p.patch);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("app server RPC (M1.45)", () => {
  let server: AppServer;
  let c: TestClient;
  let dir: string;
  let project: ProjectInfo;
  let snapshot: ProjectSnapshot;

  beforeAll(async () => {
    sidecarBin();
    // Short path: the sidecar's Unix socket path is limited to ~104 bytes on macOS.
    dir = mkdtempSync("/tmp/rwsrv-");
    server = await startServer();
    c = await TestClient.connect(server.rpcUrl, validator);
  }, 600_000);

  afterAll(async () => {
    c?.close();
    await server?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it("says hello with the RPC version and the core version", () => {
    const hello = c.frames[0] as Extract<ServerFrame, { kind: "hello" }>;
    expect(hello).toMatchObject({ kind: "hello", rpc: "rw-rpc/1", schema: "rw/1", testHooks: false });
    expect(hello.coreVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("opens a project, spawning its sidecar, and serves the mirror", async () => {
    project = (await c.call("project.open", { dir })).project;
    expect(project.dir).toBe(dir);
    // Re-opening the same directory returns the same project.
    expect((await c.call("project.open", { dir })).project).toEqual(project);
    expect((await c.call("project.list", {})).projects).toEqual([project]);
    // Every socket hears each newly opened project once (D2: Electron main's client).
    expect(c.pushes("project.opened").map((p) => p.project)).toEqual([project]);
    // IF10 stub until B8.
    expect(await c.request("embed.target", { projectId: project.projectId })).toMatchObject({ ok: false, error: { code: "internal" } });

    const from = since(c);
    const sub = await c.call("project.subscribe", { projectId: project.projectId });
    snapshot = sub.snapshot;
    expect(snapshot.sidecar).toEqual({ state: "ready", version: server.coreVersion });
    expect(snapshot.evaluated?.schema).toBe("rw/1");
    expect(snapshot.check?.schema).toBe("rw/1");
    expect(snapshot.history.steps.length).toBeGreaterThan(0);
    expect(snapshot.runs.runs.length).toBeGreaterThan(0);
    const pushed = await c.push("project.snapshot", (p) => p.subscriptionId === sub.subscriptionId, from);
    expect(pushed.snapshot).toEqual(snapshot);
    // The bad cases.
    expect(await c.request("project.subscribe", { projectId: "nope" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await c.request("project.open", { dir: join(dir, "missing") })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await c.request("project.open", {})).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(await c.request("nope.method" as never, {})).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });

  it("model.patch runs through the sidecar and refreshes the mirror with one patch", async () => {
    const pid = project.projectId;
    const input = fixture("tools/model_patch.input.json") as JsonObject;
    const from = since(c);
    const out = await c.call("model.patch", { projectId: pid, ops: input.ops as never, label: "Fin span 90 mm" });
    expect(out).toEqual(fixture("tools/model_patch.output.json"));
    await c.push("project.patch", (p) => p.patch.evaluated !== undefined, from);
    await c.push("project.patch", (p) => p.patch.history !== undefined, from);
    // The sidecar's notifications usually land in one 15 ms coalescing window (one patch); under load the
    // history one can arrive later (GATE-flake). Either way the patches cover exactly these keys, each once.
    const sent = patches(c, from);
    expect(sent.length).toBeLessThanOrEqual(2);
    const keys = sent.flatMap((p) => Object.keys(p).filter((k) => k !== "projectId"));
    expect(keys.sort()).toEqual(["check", "evaluated", "files", "history"]);
    for (const p of sent) expect(p.projectId).toBe(pid);

    // dry_run writes nothing, so the sidecar sends no resources/updated and the mirror stays put.
    const dry = since(c);
    await c.call("model.patch", { projectId: pid, ops: input.ops as never, dry_run: true });
    await sleep(300);
    expect(patches(c, dry)).toEqual([]);

    // A sidecar ApiError comes back as api_error with the ApiError attached.
    const bad = await c.request("model.patch", { projectId: pid, ops: [{ op: "bogus", path: "/x" }] as never });
    expect(bad).toMatchObject({ ok: false, error: { code: "api_error", api: { code: "invalid_input" } } });
    expect(await c.request("model.patch", { projectId: pid, ops: [] })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });

  it("check.run and history.* proxy the sidecar tools", async () => {
    const pid = project.projectId;
    expect(await c.call("check.run", { projectId: pid })).toEqual(fixture("tools/design_check.output.json"));
    expect(await c.call("history.compare", { projectId: pid, a: "rev:01", b: "HEAD" })).toEqual(fixture("tools/history_compare.output.json"));
    const from = since(c);
    expect(await c.call("history.tag", { projectId: pid, name: "baseline" })).toEqual(fixture("tools/history_tag.output.json"));
    await c.push("project.patch", (p) => p.patch.history !== undefined, from);
    expect(await c.call("history.restore", { projectId: pid, version: "rev:01", dry_run: true })).toEqual(
      fixture("tools/history_restore.output.json"),
    );
    // library.search proxies the read-only library_search tool (page 02 Parts library).
    expect(Array.isArray((await c.call("library.search", { projectId: pid, kind: "preset" })).items)).toBe(true);
    expect(await c.request("library.search", { projectId: pid, kind: "bogus" as never })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(await c.request("library.search", { projectId: pid, limit: 0 })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    // ThrustCurve params are checked before any sidecar (network) call.
    expect(await c.request("motor.thrustcurveSearch", { projectId: pid, limit: 0 })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(await c.request("motor.thrustcurveSearch", { projectId: pid, query: 7 as never })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(await c.request("motor.thrustcurveFetch", { projectId: pid, motor: "" })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(await c.request("motor.thrustcurveFetch", { projectId: pid, motor: "C6", format: "zip" as never })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });

  it("sim.run tracks the job via job_status to a terminal state, then refreshes runs", async () => {
    const pid = project.projectId;
    const from = since(c);
    const out = await c.call("sim.run", { projectId: pid, sim: "baseline" });
    expect(out).toEqual(fixture("tools/simulate.output.json"));
    const jobId = String(out.job_id);
    const done = await c.push("project.patch", (p) => p.patch.jobs?.some((j) => j.job_id === jobId && j.state === "complete") === true, from);
    expect(done.patch.jobs?.find((j) => j.job_id === jobId)).toEqual(fixture("tools/job_status.output.json"));
    await c.push("project.patch", (p) => p.patch.runs !== undefined, from);
    expect(server.project(pid).snapshot().jobs.map((j) => j.job_id)).toContain(jobId);

    const cancelled = await c.call("job.cancel", { projectId: pid, jobId });
    expect(cancelled).toEqual(fixture("tools/job_cancel.output.json"));
  });

  it("broker ops reach the registered viewport host; test hooks are off without RW_TEST_HOOKS", async () => {
    const pid = project.projectId;
    const host = await TestClient.connect(server.rpcUrl, validator);
    try {
      expect((await server.requestBroker(pid, "viewport_select", { refs: ["rw:c/fins"] }, "t-1")).ok).toBe(false);
      await host.call("broker.hostRegister", { projectId: pid, hostId: "win-1", capabilities: { ops: ["viewport_select"], backend: "webgpu" } });
      const pending = server.requestBroker(pid, "viewport_select", { refs: ["rw:c/fins"] }, "t-1");
      const req = await host.push("broker.request", (r) => r.op === "viewport_select");
      expect(req).toMatchObject({ projectId: pid, threadId: "t-1", args: { refs: ["rw:c/fins"] } });
      // Only the host the request went to may answer it.
      expect(await c.request("broker.respond", { requestId: req.requestId, ok: true, result: { selected: [] } })).toMatchObject({ ok: false });
      await host.call("broker.respond", { requestId: req.requestId, ok: true, result: { selected: ["rw:c/fins"] } });
      expect(await pending).toEqual({ requestId: req.requestId, ok: true, result: { selected: ["rw:c/fins"] } });

      expect(await c.request("test.call", { projectId: pid, op: "app_navigate", args: { page: "results" } })).toMatchObject({
        ok: false,
        error: { code: "hooks_disabled" },
      });
    } finally {
      host.close();
    }
  });

  it("serves run series over HTTP and rejects bad paths and bearers", async () => {
    const pid = project.projectId;
    // The test (not the server) writes the run output the sidecar would have written.
    mkdirSync(join(dir, "runs/baseline/f8eb21388e28"), { recursive: true });
    writeFileSync(join(dir, "runs/baseline/f8eb21388e28/series.csv"), "time,altitude\n0,0\n");
    const ok = await fetch(`${server.url}/api/projects/${pid}/runs/baseline/f8eb21388e28/series.csv`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("time,altitude\n0,0\n");
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    // The web bundle on another local origin may read it (CORS); a foreign page may not.
    const url = `${server.url}/api/projects/${pid}/runs/baseline/f8eb21388e28/series.csv`;
    const local = await fetch(url, { headers: { origin: "http://127.0.0.1:5173" } });
    expect(local.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    await local.text();
    const foreign = await fetch(url, { headers: { origin: "https://example.com" } });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    await foreign.text();
    // The run's events sit beside its series; other run files are not served.
    writeFileSync(join(dir, "runs/baseline/f8eb21388e28/events.json"), '{"events":[],"schema":"rw/1"}\n');
    const ev = await fetch(`${server.url}/api/projects/${pid}/runs/baseline/f8eb21388e28/events.json`);
    expect(ev.status).toBe(200);
    expect(ev.headers.get("content-type")).toBe("application/json");
    expect(await ev.json()).toEqual({ events: [], schema: "rw/1" });
    writeFileSync(join(dir, "runs/baseline/f8eb21388e28/manifest.json"), "{}\n");
    expect((await fetch(`${server.url}/api/projects/${pid}/runs/baseline/f8eb21388e28/manifest.json`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/projects/${pid}/runs/baseline/%2E%2E/series.csv`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/projects/nope/runs/baseline/f8eb21388e28/series.csv`)).status).toBe(404);
    // B17: the old thread-scoped /mcp route is gone.
    expect((await fetch(`${server.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  });

  it("requires the per-launch RPC token on the upgrade and refuses foreign origins (REV-srv)", async () => {
    expect(["http://127.0.0.1:5173", "http://localhost:1", "app://rocketwright"].map((o) => allowedOrigin(o))).toEqual([true, true, true]);
    expect(["https://evil.example", "null", "file://", "http://127.0.0.1.evil.example", "", undefined].map((o) => allowedOrigin(o))).toEqual([false, false, false, false, false, false]);
    const u = new URL(server.rpcUrl.replace("ws:", "http:"));
    const token = u.searchParams.get("token");
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(server.rpcToken).toBe(token);
    const status = (origin: string | undefined, query: string): Promise<number> =>
      new Promise((ok, fail) => {
        const req = request({
          host: u.hostname,
          port: u.port,
          path: `${u.pathname}${query}`,
          headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            ...(origin === undefined ? {} : { origin }),
          },
        });
        req.on("upgrade", (res, socket) => {
          socket.destroy();
          ok(res.statusCode ?? 0);
        });
        req.on("response", (res) => ok(res.statusCode ?? 0));
        req.on("error", fail);
        req.end();
      });
    const good = `?token=${token!}`;
    // No credential: refused whatever the Origin (a same-uid process sends none; another localhost page sends its own).
    expect(await status(undefined, "")).toBe(401);
    expect(await status("http://127.0.0.1:9", "")).toBe(401);
    expect(await status(undefined, "?token=nope")).toBe(401);
    expect(await status(undefined, `?token=${token!.slice(0, -1)}`)).toBe(401);
    // A foreign page is refused even if it learned the token.
    expect(await status("https://evil.example", good)).toBe(403);
    expect(await status("null", good)).toBe(403);
    // The app's own pages and local clients holding the token get in.
    expect(await status("http://127.0.0.1:9", good)).toBe(101);
    expect(await status("app://rocketwright", good)).toBe(101);
    expect(await status(undefined, good)).toBe(101);
  });

  it("keeps unauthenticated sockets out of the push set (REV-srv)", async () => {
    // Every socket in `conns` passed the token check; an unauthenticated one never joins.
    const before = (server as unknown as { conns: Set<unknown> }).conns.size;
    const bare = new WebSocket(server.rpcUrl.split("?")[0]!);
    const closed = await new Promise<boolean>((ok) => {
      bare.addEventListener("error", () => ok(true));
      bare.addEventListener("open", () => ok(false));
    });
    expect(closed).toBe(true);
    // At most `before`: an earlier test's socket may finish closing meanwhile.
    expect((server as unknown as { conns: Set<{ authed: boolean }> }).conns.size).toBeLessThanOrEqual(before);
    for (const conn of (server as unknown as { conns: Set<{ authed: boolean }> }).conns) expect(conn.authed).toBe(true);
  });

  it("restarts a crashed sidecar with backoff and resyncs the mirror", async () => {
    const pid = project.projectId;
    const host = server.project(pid);
    const old = host.sidecar.pid();
    expect(old).not.toBeNull();
    const from = since(c);
    process.kill(old!, "SIGKILL");
    await c.push("project.patch", (p) => p.patch.sidecar?.state === "restarting", from, 10_000);
    await c.push("project.patch", (p) => p.patch.sidecar?.state === "ready", from, 20_000);
    // The resync re-reads every mirrored resource.
    await c.push("project.patch", (p) => p.patch.evaluated !== undefined, from, 10_000);
    expect(host.sidecar.pid()).not.toBe(old);
    expect(host.sidecar.starts).toBe(2);
    // Subscriptions were re-established: a mutation notifies again.
    const after = since(c);
    const input = fixture("tools/model_patch.input.json") as JsonObject;
    await c.call("model.patch", { projectId: pid, ops: input.ops as never });
    await c.push("project.patch", (p) => p.patch.evaluated !== undefined, after, 10_000);
  }, 60_000);

  it("closes the project (stopping the sidecar) and reopens it on another server", async () => {
    await c.call("project.close", { projectId: project.projectId });
    expect((await c.call("project.list", {})).projects).toEqual([]);

    const second = await startServer();
    const c2 = await TestClient.connect(second.rpcUrl, validator);
    try {
      const p = (await c2.call("project.open", { dir })).project;
      expect((await c2.call("project.subscribe", { projectId: p.projectId })).snapshot.project.dir).toBe(dir);
      expect(c2.violations).toEqual([]);
    } finally {
      c2.close();
      await second.close();
    }
  }, 60_000);

  it("every frame matched the IF10 schemas", () => {
    expect(c.violations).toEqual([]);
  });
});

describe("test hooks (I12)", () => {
  it("test.call reaches the viewport host only with test hooks on", async () => {
    const dir = mkdtempSync("/tmp/rwsrv-");
    const server = await startServer({ testHooks: true });
    const c = await TestClient.connect(server.rpcUrl, validator);
    try {
      expect((c.frames[0] as { testHooks: boolean }).testHooks).toBe(true);
      const pid = (await c.call("project.open", { dir })).project.projectId;
      expect(await c.request("test.call", { projectId: pid, op: "app_navigate", args: { page: "results" } })).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
      expect(await c.request("test.call", { projectId: pid, op: "viewport_render" as never, args: {} })).toMatchObject({
        ok: false,
        error: { code: "invalid_params" },
      });
      await c.call("broker.hostRegister", { projectId: pid, hostId: "w", capabilities: { ops: ["app_navigate"], backend: "webgl2" } });
      const from = since(c);
      const call = c.call("test.call", { projectId: pid, op: "app_navigate", args: { page: "results" } });
      const req = await c.push("broker.request", (r) => r.op === "app_navigate", from);
      expect(req.threadId).toBeNull();
      await c.call("broker.respond", { requestId: req.requestId, ok: true, result: {} });
      expect(await call).toEqual({});
      expect(c.violations).toEqual([]);
    } finally {
      c.close();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("app server RPC over a real project Session (M1.26 x M1.40 x M1.45)", () => {
  let server: AppServer;
  let c: TestClient;
  let dir: string;

  beforeAll(async () => {
    sidecarBin();
    dir = tempProject("rwreal", "fixtures/simple");
    server = await startServer();
    c = await TestClient.connect(server.rpcUrl, validator);
  }, 600_000);

  afterAll(async () => {
    c?.close();
    await server?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it("the mirror carries the real model and check, and model.patch refreshes it with the real delta", async () => {
    const pid = (await c.call("project.open", { dir })).project.projectId;
    const { snapshot } = await c.call("project.subscribe", { projectId: pid });
    expect(snapshot.sidecar.state).toBe("ready");
    const check = snapshot.check as unknown as { status: string; mass: { liftoff: number }; stability: { liftoff: number } };
    expect(check.status).toBe("clean");
    expect(check.mass.liftoff).toBeGreaterThan(0.05);
    expect(snapshot.history.steps.map((s) => s.title)).toEqual(["Initial snapshot"]);
    expect(await c.call("check.run", { projectId: pid })).toEqual(snapshot.check);

    const from = since(c);
    const out = await c.call("model.patch", {
      projectId: pid,
      ops: [{ op: "replace", path: "/params/fin_span/value", value: "70 mm" }] as never,
      label: "Fin span 70 mm",
    });
    const delta = out.delta as { changed: Record<string, [number, number]> };
    expect(delta.changed["stability.liftoff"]![0]).toBeCloseTo(check.stability.liftoff, 4);
    expect(delta.changed["stability.liftoff"]![1]).toBeGreaterThan(check.stability.liftoff);
    const patch = (await c.push("project.patch", (p) => p.patch.check !== undefined, from)).patch;
    const after = patch.check as unknown as { stability: { liftoff: number } };
    expect(after.stability.liftoff).toBe(delta.changed["stability.liftoff"]![1]);
    expect(readFileSync(join(dir, "rocket.rw.toml"), "utf8")).toContain('value = "70 mm"');
  }, 60_000);
});
