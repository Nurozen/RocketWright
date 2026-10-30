/**
 * B8: `pnpm -C app --filter @rw/server test -- lecturn registration`.
 * The child's Lecturn link against a fake connection: connect options from
 * the env, `ensureWorkspace` by realpath (a symlinked `/tmp` project), the
 * embed calls, thread pushes, and the D25 live switch (every open project
 * re-indexed from `projectIdsByWorkspaceRoot`, routing by root still works),
 * and B7b's lifetime: `close()` while `connect()` still starts the sidecar
 * aborts it and waits for the process to stop.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { EmbedThread, LecturnStatus, ProjectInfo } from "@rw/contracts";
import { afterAll, describe, expect, it } from "vitest";
import {
  createLecturnLink,
  LecturnLink,
  lecturnConnectOptions,
  lecturnServerEntry,
  type LecturnConnectionLike,
} from "./connection.ts";
import { connectTo, FakeConnection, StartingSidecar, thread } from "../../test/helpers/fakeLecturn.ts";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function tempDir(root: string, prefix: string): string {
  const d = mkdtempSync(join(root, prefix));
  temps.push(d);
  return d;
}

function setup(conn: LecturnConnectionLike | Error = new FakeConnection()) {
  const statuses: LecturnStatus[] = [];
  const threads: { projectId: string; threads: EmbedThread[] }[] = [];
  const logs: string[] = [];
  const link = new LecturnLink(connectTo(conn), {
    status: (s) => statuses.push(s),
    threads: (projectId, list) => threads.push({ projectId, threads: list }),
    log: (l) => logs.push(l),
  });
  return { link, statuses, threads, logs };
}

/** A project dir reached through a symlink (`/tmp` itself is one on macOS). */
function symlinkedProject(name: string): { info: ProjectInfo; real: string } {
  const base = tempDir("/tmp", "rw-lecturn-");
  const realDir = join(base, `real-${name}`);
  mkdirSync(realDir);
  const link = join(base, name);
  symlinkSync(realDir, link);
  return { info: { projectId: name, dir: link, name: `Project ${name}` }, real: realpathSync(realDir) };
}

describe("lecturnConnectOptions (B8)", () => {
  it("is null without a base dir: the child then runs without Lecturn", () => {
    expect(lecturnConnectOptions({ env: {} })).toBeNull();
    expect(createLecturnLink({ env: {} }, { status: () => undefined, threads: () => undefined })).toBeNull();
  });

  it("takes LECTURN_HOME, RW_LECTURN_BASE_DIR over main's base dir, and RW_NODE", () => {
    const opts = lecturnConnectOptions({ env: { LECTURN_HOME: "/tmp/lh", RW_LECTURN_BASE_DIR: "/tmp/lb", RW_NODE: "/opt/node/bin/node" }, baseDir: "/tmp/userdata/lecturn", bin: "/opt/rw/rocketwright" })!;
    expect(opts.lecturnHome).toBe("/tmp/lh");
    expect(opts.sidecar).toEqual({ serverEntry: lecturnServerEntry(), baseDir: "/tmp/lb", nodePath: "/opt/node/bin/node" });
    expect(opts.registration.headlessTools?.command).toBe("/opt/rw/rocketwright");
  });

  it("defaults to main's base dir and this process's Node, with no lecturnHome", () => {
    const opts = lecturnConnectOptions({ env: {}, baseDir: "/tmp/userdata/lecturn", bin: "/opt/rw/rocketwright" })!;
    expect(opts.sidecar.baseDir).toBe("/tmp/userdata/lecturn");
    expect(opts.sidecar.nodePath).toBe(process.execPath);
    expect("lecturnHome" in opts).toBe(false);
  });

  it("points the sidecar at the vendored server entry", () => {
    expect(lecturnServerEntry()).toMatch(/[\\/]lecturn[\\/]dist[\\/]bin\.mjs$/);
    expect(existsSync(lecturnServerEntry())).toBe(true);
  });
});

describe("LecturnLink (B8)", () => {
  it("ensures each project's workspace by realpath, through a /tmp symlink", async () => {
    const fake = new FakeConnection();
    const { link, statuses } = setup(fake);
    await link.start();
    expect(statuses.at(-1)).toEqual({ state: "connected", mode: "sidecar", pairing: "none" });
    const tmpProject = { projectId: "tmpdir", dir: tempDir("/tmp", "rw-lecturn-tmp-"), name: "Tmp" };
    const { info, real } = symlinkedProject("alpha");
    expect(await link.addProject(info)).toEqual({ projectId: fake.idFor(real) });
    await link.addProject(tmpProject);
    expect(fake.ensured).toEqual([
      [real, "Project alpha"],
      [realpathSync(tmpProject.dir), "Tmp"],
    ]);
    // Lecturn echoes the root verbatim; any spelling of the project resolves.
    expect(link.projectForWorkspaceRoot(real)).toBe("alpha");
    expect(link.projectForWorkspaceRoot(info.dir)).toBe("alpha");
    expect(link.projectForWorkspaceRoot(tmpProject.dir)).toBe("tmpdir");
    // Adding it again does not ensure again.
    await link.addProject(info);
    expect(fake.ensured).toHaveLength(2);
    await link.close();
    expect(fake.closed).toBe(true);
  });

  it("answers embed calls with the current Lecturn project id", async () => {
    const fake = new FakeConnection();
    const { link } = setup(fake);
    void link.start();
    const { info, real } = symlinkedProject("beta");
    // A call before the workspace settles waits for it.
    const [target] = await Promise.all([link.embedTarget("beta", "th-1").catch((e: unknown) => e), link.addProject(info)]);
    expect(target).toEqual({ url: `http://127.0.0.1:9/embed/env-a/${fake.idFor(real)}/th-1`, token: "t", expiresAt: "2026-10-25T00:00:00.000Z" });
    expect((await link.refreshToken("beta")).token).toBe("t2");
    await expect(link.embedTarget("nope")).rejects.toThrow(/no Lecturn workspace/);
    await link.close();
  });

  it("pushes the project's whole thread list on every change, newest first", async () => {
    const fake = new FakeConnection();
    const { link, threads } = setup(fake);
    await link.start();
    const { info, real } = symlinkedProject("gamma");
    await link.addProject(info);
    const pid = fake.idFor(real);
    const listener = fake.threadListeners.get(pid)!;
    listener({ type: "snapshot", threads: [thread(pid, real, "a", "2026-10-24T10:00:00.000Z")] });
    listener({ type: "upsert", thread: thread(pid, real, "b", "2026-10-24T11:00:00.000Z", { state: "running" }) });
    expect(threads.at(-1)).toEqual({ projectId: "gamma", threads: [thread(pid, real, "b", "2026-10-24T11:00:00.000Z", { state: "running" }), thread(pid, real, "a", "2026-10-24T10:00:00.000Z")] });
    listener({ type: "remove", threadId: "b" });
    expect(threads.at(-1)?.threads.map((t) => t.threadId)).toEqual(["a"]);
    expect(link.threadLists()).toEqual([{ projectId: "gamma", threads: [thread(pid, real, "a", "2026-10-24T10:00:00.000Z")] }]);

    await link.setThreadAppData("gamma", "a", '{"page":"results"}', "Apogee 305 m");
    await link.setThreadAppData("gamma", "a", null);
    expect(fake.appData).toEqual([
      ["a", '{"page":"results"}', "Apogee 305 m"],
      ["a", null, undefined],
    ]);
    await expect(link.setThreadAppData("gamma", "zzz", null)).rejects.toThrow(/no Lecturn thread/);
    // A closed project stops following its threads.
    link.removeProject("gamma");
    expect(fake.threadListeners.size).toBe(0);
    await link.close();
  });

  it("follows a live switch: every open project re-indexed, routing by root still resolves (D25)", async () => {
    const fake = new FakeConnection();
    const { link, statuses } = setup(fake);
    await link.start();
    const a = symlinkedProject("one");
    const b = symlinkedProject("two");
    await link.addProject(a.info);
    await link.addProject(b.info);
    const oldA = fake.idFor(a.real);
    expect(link.resolveContext({ projectId: oldA })).toBe("one");

    fake.switchTo("env-b", [a.real, b.real], { "old-thread": "new-thread" });
    await new Promise((r) => setTimeout(r, 0));
    const pushed = statuses.at(-1)!;
    expect(pushed).toEqual({
      state: "connected",
      mode: "user-server",
      pairing: "none",
      switched: { environmentId: "env-b", projects: { one: fake.idFor(a.real), two: fake.idFor(b.real) }, threadIdMap: { "old-thread": "new-thread" } },
    });
    // No new ensure was needed: the ids came from the event.
    expect(fake.ensured).toHaveLength(2);
    // Live routing: the root and the new id resolve, and so does the old
    // server's id (the helper's workspaceRootOf: a turn draining on the sidecar).
    expect(link.resolveContext({ workspaceRoot: a.real })).toBe("one");
    expect(link.resolveContext({ workspaceRoot: b.info.dir })).toBe("two");
    expect(link.resolveContext({ projectId: fake.idFor(b.real) })).toBe("two");
    expect(link.resolveContext({ projectId: oldA })).toBe("one");
    expect(link.resolveContext({ projectId: "env-z:/nowhere" })).toBeUndefined();
    expect((await link.embedTarget("one")).url).toBe(`http://127.0.0.1:9/embed/env-b/${fake.idFor(a.real)}`);
    expect(await link.lecturnProjectId("two")).toBe(fake.idFor(b.real));
    await link.close();
  });

  it("keeps following the threads on the new server after a live switch; a copy keeps its source (B12, D25)", async () => {
    const fake = new FakeConnection();
    const { link, threads } = setup(fake);
    await link.start();
    const a = symlinkedProject("five");
    await link.addProject(a.info);
    const oldId = fake.idFor(a.real);
    fake.threadListeners.get(oldId)!({ type: "snapshot", threads: [thread(oldId, a.real, "side-1", "2026-10-25T00:00:01.000Z")] });
    fake.switchTo("env-b", [a.real], { "side-1": "user-1" });
    await new Promise((r) => setTimeout(r, 0));
    const newId = fake.idFor(a.real);
    expect([...fake.threadListeners.keys()]).toEqual([newId]);
    const copiedFrom = { appId: "dev.rocketwright.app", sourceEnvironmentId: "env-a", sourceThreadId: "side-1", copiedAt: "2026-10-25T00:00:02.000Z", sourceHistoryRevision: 1 };
    fake.threadListeners.get(newId)!({ type: "snapshot", threads: [thread(newId, a.real, "user-1", "2026-10-25T00:00:02.000Z", { copiedFrom })] });
    const last = threads.at(-1)!;
    expect(last.projectId).toBe("five");
    expect(last.threads.map((t) => [t.threadId, t.copiedFrom?.sourceThreadId])).toEqual([["user-1", "side-1"]]);
    await link.close();
  });

  it("sets the host context on the Lecturn project; the helper carries it across a switch (B12)", async () => {
    const fake = new FakeConnection();
    const { link } = setup(fake);
    await link.start();
    const a = symlinkedProject("six");
    await link.addProject(a.info);
    await link.updateHostContext("six", "Current page: assembly");
    expect(fake.hostContexts).toEqual([[{ projectId: fake.idFor(a.real) }, "Current page: assembly"]]);
    fake.switchTo("env-b", [a.real]);
    await new Promise((r) => setTimeout(r, 0));
    // Carried once by the helper; the link does not send it again.
    expect(fake.hostContexts).toEqual([
      [{ projectId: "env-a:" + a.real }, "Current page: assembly"],
      [{ projectId: fake.idFor(a.real) }, "Current page: assembly"],
    ]);
    await expect(link.updateHostContext("nope", "x")).rejects.toThrow(/no Lecturn workspace/);
    await link.close();
  });

  it("re-sends the host context of a workspace the switch did not map, once ensured again", async () => {
    const fake = new FakeConnection();
    const { link } = setup(fake);
    await link.start();
    const a = symlinkedProject("seven");
    await link.addProject(a.info);
    await link.updateHostContext("seven", "Current page: results");
    fake.switchTo("env-b", []);
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.hostContexts.at(-1)).toEqual([{ projectId: fake.idFor(a.real) }, "Current page: results"]);
    // And it follows the threads there.
    expect([...fake.threadListeners.keys()]).toEqual([fake.idFor(a.real)]);
    await link.close();
  });

  it("ensures again a project the switch did not map", async () => {
    const fake = new FakeConnection();
    const { link, statuses } = setup(fake);
    await link.start();
    const a = symlinkedProject("three");
    await link.addProject(a.info);
    fake.switchTo("env-c", []);
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.ensured).toEqual([
      [a.real, "Project three"],
      [a.real, "Project three"],
    ]);
    expect(statuses.at(-1)?.switched?.projects).toEqual({ three: fake.idFor(a.real) });
    await link.close();
  });

  it("forwards pairing changes as status pushes", async () => {
    const fake = new FakeConnection();
    const { link, statuses } = setup(fake);
    await link.start();
    fake.setPairing("pending");
    fake.setPairing("pending");
    expect(statuses.filter((s) => s.pairing === "pending")).toHaveLength(1);
    expect(link.status).toEqual({ state: "connected", mode: "sidecar", pairing: "pending" });
    await link.close();
  });

  it("stops a Lecturn sidecar that is still starting when closed (B7b: no orphan)", async () => {
    const sidecar = new StartingSidecar();
    const statuses: LecturnStatus[] = [];
    const link = new LecturnLink(sidecar.connect, { status: (s) => statuses.push(s), threads: () => undefined });
    const started = link.start();
    expect(sidecar.running).toBe(true);
    await link.close();
    // close() resolved only once the starting process was stopped.
    expect(sidecar.signal?.aborted).toBe(true);
    expect(sidecar.stopped).toBe(true);
    expect(sidecar.running).toBe(false);
    await started;
    await expect(link.embedTarget("x")).rejects.toThrow(/closed/);
  });

  it("closes the connection through the pending connect once ready, the helper clearing the live lease", async () => {
    const fake = new FakeConnection();
    const { link } = setup(fake);
    await link.start();
    await link.publishLiveTools({ url: "http://127.0.0.1:9/mcp/live", bearer: "b" });
    await link.close();
    expect(fake.closed).toBe(true);
    expect(fake.liveTools).toEqual([{ url: "http://127.0.0.1:9/mcp/live", bearer: "b" }, null]);
  });

  it("reports a failed connect as unavailable, and embed calls fail", async () => {
    const { link, statuses } = setup(new Error("sidecar exited (78)"));
    await link.start();
    expect(statuses.at(-1)).toEqual({ state: "unavailable", mode: null, pairing: "none", message: "Lecturn did not start: sidecar exited (78)" });
    const p = symlinkedProject("five");
    await expect(link.addProject(p.info)).rejects.toThrow(/sidecar exited/);
    await expect(link.embedTarget("five")).rejects.toThrow(/sidecar exited/);
    await link.close();
  });

  it("refuses calls after close", async () => {
    const fake = new FakeConnection();
    const { link } = setup(fake);
    await link.start();
    const p = symlinkedProject("six");
    await link.addProject(p.info);
    await link.close();
    await expect(link.embedTarget("six")).rejects.toThrow();
    expect(fake.closed).toBe(true);
  });
});
