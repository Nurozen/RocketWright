/**
 * B8: `pnpm -C app --filter @rw/server test -- lecturn`. The app server's
 * IF10 Lecturn surface over a real WebSocket, with the real sidecar (doubles)
 * and a fake Lecturn connection: `lecturn.status` and `embed.threads` after
 * `hello`, `project.open` → `ensureWorkspace(realpath)` (a symlinked `/tmp`
 * project), `embed.target` / `embed.refreshToken` / `embed.setThreadAppData`,
 * and a live switch (D25) that re-indexes the project. Every frame is
 * validated against the IF10 schemas (`TestClient`).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectInfo } from "@rw/contracts";
import { TestClient, makeValidator } from "@rw/contracts/mock/harness";
import { LecturnLink } from "../src/lecturn/connection.ts";
import { AppServer } from "../src/rpc/AppServer.ts";
import { connectTo, FakeConnection, thread } from "./helpers/fakeLecturn.ts";
import { sidecarBin } from "./helpers/harness.ts";

const validator = makeValidator();

describe("app server Lecturn RPC (B8)", () => {
  const fake = new FakeConnection();
  let server: AppServer;
  let c: TestClient;
  let base: string;
  let dir: string;
  let real: string;
  let project: ProjectInfo;

  beforeAll(async () => {
    const bin = sidecarBin();
    // Short path: the sidecar's Unix socket path is limited to ~104 bytes on macOS.
    base = mkdtempSync("/tmp/rwlk-");
    mkdirSync(join(base, "real"));
    dir = join(base, "proj");
    symlinkSync(join(base, "real"), dir);
    real = realpathSync(join(base, "real"));
    server = await AppServer.start({
      bin,
      stderr: "ignore",
      testHooks: false,
      log: () => undefined,
      lecturn: (events) => new LecturnLink(connectTo(fake), events),
    });
    c = await TestClient.connect(server.rpcUrl, validator);
  }, 600_000);

  afterAll(async () => {
    c?.close();
    await server?.close();
    if (base !== undefined) rmSync(base, { recursive: true, force: true });
  });

  it("sends the Lecturn status right after hello", async () => {
    expect(c.frames[0]).toMatchObject({ kind: "hello" });
    const status = await c.push("lecturn.status", (s) => s.state === "connected");
    expect(status).toEqual({ state: "connected", mode: "sidecar", pairing: "none" });
  });

  it("registers an opened project's workspace by realpath and answers embed calls", async () => {
    project = (await c.call("project.open", { dir })).project;
    const lecturnId = fake.idFor(real);
    const target = await c.call("embed.target", { projectId: project.projectId, threadId: "th-1" });
    expect(target.url).toBe(`http://127.0.0.1:9/embed/env-a/${lecturnId}/th-1`);
    expect(fake.ensured).toEqual([[real, project.name]]);
    expect(server.lecturn?.projectForWorkspaceRoot(real)).toBe(project.projectId);
    expect((await c.call("embed.refreshToken", { projectId: project.projectId })).token).toBe("t2");
    // The same directory by its real path is the same project (D13).
    expect((await c.call("project.open", { dir: real })).project).toEqual(project);
  });

  it("pushes thread lists, and a socket that connects later gets them after hello", async () => {
    const lecturnId = fake.idFor(real);
    fake.threadListeners.get(lecturnId)!({ type: "snapshot", threads: [thread(lecturnId, real, "th-1", "2026-10-24T10:00:00.000Z")] });
    const pushed = await c.push("embed.threads", (p) => p.threads.length === 1);
    expect(pushed).toEqual({ projectId: project.projectId, threads: [thread(lecturnId, real, "th-1", "2026-10-24T10:00:00.000Z")] });
    const late = await TestClient.connect(server.rpcUrl, validator);
    try {
      expect((await late.push("embed.threads")).threads.map((t) => t.threadId)).toEqual(["th-1"]);
      expect(await late.push("lecturn.status")).toMatchObject({ state: "connected" });
    } finally {
      late.close();
    }
  });

  it("writes appData through Lecturn and validates it", async () => {
    expect(await c.call("embed.setThreadAppData", { projectId: project.projectId, threadId: "th-1", appData: '{"page":"results"}', subtitle: "Apogee 305 m" })).toEqual({});
    expect(fake.appData.at(-1)).toEqual(["th-1", '{"page":"results"}', "Apogee 305 m"]);
    expect(await c.request("embed.setThreadAppData", { projectId: project.projectId, threadId: "th-1", appData: "x".repeat(1025) })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(await c.request("embed.setThreadAppData", { projectId: project.projectId, threadId: "th-1", appData: null, subtitle: "y".repeat(81) })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(await c.request("embed.setThreadAppData", { projectId: project.projectId, threadId: "missing", appData: null })).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  it("sets the window's host context on the Lecturn project and validates it (B12)", async () => {
    expect(await c.call("embed.setHostContext", { projectId: project.projectId, text: "Current page: assembly" })).toEqual({ applied: true });
    expect(fake.hostContexts.at(-1)).toEqual([{ projectId: fake.idFor(real) }, "Current page: assembly"]);
    expect(await c.request("embed.setHostContext", { projectId: project.projectId, text: "x".repeat(4097) })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(await c.request("embed.setHostContext", { projectId: project.projectId, text: 7 })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });

  it("follows a live switch: lecturn.status carries the new ids, and embed.target uses them (D25)", async () => {
    fake.switchTo("env-b", [real], { "th-1": "th-1b" });
    const status = await c.push("lecturn.status", (s) => s.switched !== undefined);
    expect(status).toEqual({
      state: "connected",
      mode: "user-server",
      pairing: "none",
      switched: { environmentId: "env-b", projects: { [project.projectId]: fake.idFor(real) }, threadIdMap: { "th-1": "th-1b" } },
    });
    expect((await c.call("embed.target", { projectId: project.projectId })).url).toBe(`http://127.0.0.1:9/embed/env-b/${fake.idFor(real)}`);
    expect(server.lecturn?.resolveContext({ workspaceRoot: dir })).toBe(project.projectId);
    expect(fake.ensured).toHaveLength(1);
  });

  it("closes the Lecturn connection with the server", async () => {
    await server.close();
    expect(fake.closed).toBe(true);
  });
});
