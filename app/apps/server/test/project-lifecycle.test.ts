/**
 * U14: the project lifecycle against the real `rw init` (and `rw import ork`).
 * `bin` is a wrapper that logs each invocation and execs the real binary, so a
 * test can tell that no process was spawned. Projects stay under `/tmp`.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TestClient, makeValidator } from "@rw/contracts/mock/harness";
import { LecturnLink } from "../src/lecturn/connection.ts";
import { AppServer } from "../src/rpc/AppServer.ts";
import { MAX_PROJECT_REALPATH, projectedRealpath } from "../src/project/create.ts";
import { displayName, readProjectName } from "../src/project/inspect.ts";
import { FakeConnection, connectTo } from "./helpers/fakeLecturn.ts";
import { sidecarBin, tempProject } from "./helpers/harness.ts";

const validator = makeValidator();

describe("project lifecycle (U14)", () => {
  let base: string;
  let log: string;
  let server: AppServer;
  let c: TestClient;

  /** The `init` and `import` runs the wrapper saw (the server also spawns `--version` and `mcp`). */
  const creations = (): string[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => /^(init|import) /.test(l)) : []);
  const freshLocation = (name: string): string => {
    const dir = join(base, name);
    mkdirSync(dir);
    return dir;
  };
  const closeAll = async (): Promise<void> => {
    for (const p of server.listProjects()) await server.closeProject(p.projectId);
  };

  beforeAll(async () => {
    base = mkdtempSync("/tmp/rwu14-");
    log = join(base, "spawned.log");
    const wrapper = join(base, "rw-wrapper");
    writeFileSync(wrapper, `#!/bin/sh\necho "$*" >> "${log}"\nexec "${sidecarBin()}" "$@"\n`, { mode: 0o755 });
    server = await AppServer.start({ bin: wrapper, stderr: "ignore", jobPollMs: 50, backoff: { initialMs: 50, maxMs: 400 } });
    c = await TestClient.connect(server.rpcUrl, validator);
  }, 600_000);

  afterEach(closeAll);

  afterAll(async () => {
    c?.close();
    await server?.close();
    if (base !== undefined) rmSync(base, { recursive: true, force: true });
  });

  it("creates a project with the name in both manifests, then opens it", async () => {
    const location = freshLocation("named");
    const { project } = await c.call("project.create", { name: "  solstice-rocket ", location, template: "empty" });
    expect(project.dir).toBe(join(location, "solstice-rocket"));
    expect(project.name).toBe("solstice-rocket");
    expect((await c.call("project.list", {})).projects).toEqual([project]);
    for (const f of ["rocketwright.toml", "rocket.rw.toml"]) expect(readFileSync(join(project.dir, f), "utf8")).toMatch(/^name = "solstice-rocket"$/m);
    await c.push("project.opened", (p) => p.project.projectId === project.projectId);
    expect(await c.call("project.inspect", { dir: project.dir })).toEqual({ dir: project.dir, state: "project", name: "solstice-rocket", collisions: [] });
  });

  it("renames a project: both manifests, the folder unchanged, and a push for every window", async () => {
    const location = freshLocation("renamed");
    const { project } = await c.call("project.create", { name: "rename-me", location, template: "empty" });
    const { project: renamed } = await c.call("project.rename", { projectId: project.projectId, name: "  Solstice II " });
    expect(renamed).toEqual({ ...project, name: "Solstice II" });
    expect((await c.push("project.updated", (p) => p.project.projectId === project.projectId)).project.name).toBe("Solstice II");
    for (const f of ["rocketwright.toml", "rocket.rw.toml"]) expect(readFileSync(join(project.dir, f), "utf8")).toMatch(/^name = "Solstice II"$/m);
    expect((await c.call("project.list", {})).projects.find((p) => p.projectId === project.projectId)?.name).toBe("Solstice II");
    expect(existsSync(project.dir)).toBe(true);
    expect(await c.request("project.rename", { projectId: project.projectId, name: "a\nb" })).toMatchObject({ ok: false, error: { code: "api_error" } });
    await c.call("project.close", { projectId: project.projectId });
  });

  it("creates missing parent folders through rw init and expands ~", async () => {
    const home = freshLocation("home");
    vi.stubEnv("HOME", home);
    try {
      const { project } = await c.call("project.create", { name: "Tilde", location: "~/deep/er" });
      expect(project.dir).toBe(join(home, "deep/er/Tilde"));
      expect(existsSync(join(project.dir, "rocketwright.toml"))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("passes a name that looks like a flag, and quotes, through to the manifest", async () => {
    const location = freshLocation("odd");
    const name = `-x "y" 'z'`;
    const { project } = await c.call("project.create", { name, location });
    expect(basename(project.dir)).toBe(name);
    expect(project.name).toBe(name);
    expect(readProjectName(project.dir)).toBe(name);
  });

  it("refuses a target that holds a project before any process is spawned, for every source", async () => {
    const location = freshLocation("exists");
    const made = await c.call("project.create", { name: "Taken", location });
    await server.closeProject(made.project.projectId);
    const before = creations().length;
    for (const params of [
      { name: "Taken", location },
      { name: "Taken", location, source: { ork: join(base, "never-read.ork") } },
    ]) {
      expect(await c.request("project.create", params)).toMatchObject({ ok: false, error: { code: "conflict" } });
    }
    expect(creations().length).toBe(before);
  });

  it("creates from an .ork through rw import ork", async () => {
    const seed = tempProject("rwu14s", "fixtures/research-vehicle");
    try {
      const open = await c.call("project.open", { dir: seed });
      const ork = join(seed, (await c.call("export.file", { projectId: open.project.projectId, format: "ork", path: "exports/rocket.ork" })).path);
      const location = freshLocation("ork");
      const { project } = await c.call("project.create", { name: "From ork", location, source: { ork } });
      expect(project.dir).toBe(join(location, "From ork"));
      expect(existsSync(join(project.dir, "rocketwright.toml"))).toBe(true);
      expect(creations().at(-1)).toMatch(/^import ork /);
      expect(await c.request("project.create", { name: "Missing", location, source: { ork: join(base, "no-such.ork") } })).toMatchObject({ ok: false, error: { code: "not_found" } });
    } finally {
      await closeAll();
      rmSync(seed, { recursive: true, force: true });
    }
  }, 60_000);

  it("lets only one of two identical creates through", async () => {
    const location = freshLocation("race");
    const before = creations().length;
    const params = { name: "Once", location };
    const results = await Promise.all([c.request("project.create", params), c.request("project.create", params)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(creations().length).toBe(before + 1);
  });

  it("refuses files a new project would replace, and leaves them alone", async () => {
    const location = freshLocation("collide");
    const target = join(location, "Busy");
    mkdirSync(target);
    writeFileSync(join(target, "rocket.rw.toml"), "mine\n");
    writeFileSync(join(target, "notes.txt"), "keep\n");
    expect(await c.call("project.inspect", { dir: target })).toEqual({ dir: target, state: "folder", name: null, collisions: ["rocket.rw.toml"] });
    expect(await c.request("project.create", { name: "Busy", location })).toMatchObject({ ok: false, error: { code: "conflict", message: expect.stringContaining("rocket.rw.toml") } });
    expect(readFileSync(join(target, "rocket.rw.toml"), "utf8")).toBe("mine\n");
    expect(existsSync(join(target, ".rw"))).toBe(false);
  });

  it("creates in a folder whose files do not collide", async () => {
    const location = freshLocation("alongside");
    const target = join(location, "Notes");
    mkdirSync(target);
    writeFileSync(join(target, "notes.txt"), "keep\n");
    expect(await c.call("project.inspect", { dir: target })).toEqual({ dir: target, state: "folder", name: null, collisions: [] });
    expect((await c.call("project.create", { name: "Notes", location })).project.dir).toBe(target);
    expect(readFileSync(join(target, "notes.txt"), "utf8")).toBe("keep\n");
  });

  it("answers permission_denied for a location it cannot write", async () => {
    const location = freshLocation("readonly");
    chmodSync(location, 0o555);
    try {
      expect(await c.request("project.create", { name: "Nope", location })).toMatchObject({ ok: false, error: { code: "permission_denied" } });
      expect(existsSync(join(location, "Nope"))).toBe(false);
    } finally {
      chmodSync(location, 0o755);
    }
  });

  it("refuses bad names before spawning", async () => {
    const location = freshLocation("names");
    const before = creations().length;
    for (const name of ["a/b", "..", ".hidden", "a\\b", "a\nb", "   ", "x".repeat(256), "é".repeat(128)]) {
      expect(await c.request("project.create", { name, location }), JSON.stringify(name)).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    }
    expect(await c.request("project.create", { name: "ok", location: "relative/path" })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(await c.request("project.create", { name: "ok", location, template: "nope" as never })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(creations().length).toBe(before);
  });

  it("refuses a location that is a file, without leaving anything", async () => {
    const location = join(base, "plain-file");
    writeFileSync(location, "x");
    expect(await c.request("project.create", { name: "Under", location })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(readFileSync(location, "utf8")).toBe("x");
  });

  it("accepts a 255-byte name", async () => {
    const location = freshLocation("long-name");
    const name = "n".repeat(255);
    expect((await c.call("project.create", { name, location })).project.dir).toBe(join(location, name));
  }, 30_000);

  /** A location whose realpath is exactly `bytes` long. */
  function locationOfRealpath(bytes: number, label: string): string {
    const root = realpathSync(freshLocation(label));
    let at = root;
    while (Buffer.byteLength(at) + 201 <= bytes) at = join(at, "d".repeat(200));
    const left = bytes - Buffer.byteLength(at) - 1;
    if (left > 0) at = join(at, "e".repeat(left));
    mkdirSync(at, { recursive: true });
    expect(Buffer.byteLength(at)).toBe(bytes);
    return at;
  }

  it("refuses a path over the ceiling before spawning, counted on the realpath", async () => {
    const name = "over";
    const location = locationOfRealpath(MAX_PROJECT_REALPATH - name.length, "ceiling-over"); // one byte past, with the slash
    const before = creations().length;
    const r = await c.request("project.create", { name, location });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_params", message: expect.stringContaining(String(MAX_PROJECT_REALPATH)) } });
    expect(creations().length).toBe(before);
    expect(existsSync(join(location, name))).toBe(false);
  });

  it("accepts a path exactly at the ceiling, and it works", async () => {
    const name = "fits";
    const location = locationOfRealpath(MAX_PROJECT_REALPATH - name.length - 1, "ceiling-fits");
    const target = join(location, name);
    expect(Buffer.byteLength(projectedRealpath(target))).toBe(MAX_PROJECT_REALPATH);
    const { project } = await c.call("project.create", { name, location });
    expect(project.dir).toBe(target);
    expect((await c.call("check.run", { projectId: project.projectId })).status).toBeDefined();
  }, 30_000);

  it("counts a symlinked location by what it resolves to", () => {
    const real = freshLocation("linked-real");
    const link = join(base, "linked");
    symlinkSync(real, link);
    expect(projectedRealpath(join(link, "a/b"))).toBe(join(realpathSync(real), "a/b"));
  });

  it("numbers a second sample rocket, including when two arrive at once", async () => {
    const location = freshLocation("samples");
    const params = { name: "Sample rocket", location, template: "sample" as const };
    const [a, b] = await Promise.all([c.call("project.create", params), c.call("project.create", params)]);
    expect([a.project.dir, b.project.dir].sort()).toEqual([join(location, "Sample rocket"), join(location, "Sample rocket 2")]);
    expect([a.project.name, b.project.name].sort()).toEqual(["Sample rocket", "Sample rocket 2"]);
    const third = await c.call("project.create", params);
    expect(third.project.dir).toBe(join(location, "Sample rocket 3"));
    // The durable copy is a real project with the sample's design.
    expect(existsSync(join(third.project.dir, "parts/fin_can.rw.toml"))).toBe(true);
  }, 60_000);

  it("does not number other names, even with the sample template", async () => {
    const location = freshLocation("not-samples");
    await c.call("project.create", { name: "Mine", location, template: "sample" });
    expect(await c.request("project.create", { name: "Mine", location, template: "sample" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  }, 30_000);

  it("refuses to open a folder that holds no project, by Rust's rule", async () => {
    const empty = freshLocation("bare");
    const cargo = freshLocation("cargo");
    writeFileSync(join(cargo, "Cargo.toml"), "[package]\n");
    for (const dir of [empty, cargo]) {
      expect(await c.request("project.open", { dir })).toMatchObject({ ok: false, error: { code: "not_a_project" } });
      expect(existsSync(join(dir, ".rw"))).toBe(false);
    }
    expect((await c.call("project.list", {})).projects).toEqual([]);
    expect(await c.call("project.inspect", { dir: empty })).toEqual({ dir: empty, state: "empty", name: null, collisions: [] });
    expect((await c.call("project.inspect", { dir: join(empty, "nothing") })).state).toBe("missing");
    expect(await c.request("project.inspect", { dir: join(cargo, "Cargo.toml") })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });

  it("still opens a bare folder through the server-side path", async () => {
    const dir = freshLocation("dash-project");
    expect((await server.openProject(dir)).dir).toBe(dir);
  });

  it("reports an unreadable folder as denied, not as missing", async () => {
    const parent = freshLocation("locked");
    const inner = join(parent, "inner");
    mkdirSync(inner);
    chmodSync(parent, 0o000);
    try {
      expect(await c.request("project.inspect", { dir: inner })).toMatchObject({ ok: false, error: { code: "permission_denied" } });
      expect(await c.request("project.open", { dir: inner })).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    } finally {
      chmodSync(parent, 0o755);
    }
  });

  it("falls back to the folder name for an empty or template-default name", async () => {
    const location = freshLocation("fallback");
    const { project } = await c.call("project.create", { name: "Keep", location });
    const manifest = join(project.dir, "rocketwright.toml");
    const text = readFileSync(manifest, "utf8");
    await server.closeProject(project.projectId);
    for (const line of ['name = "Rocket"', 'name = ""']) {
      writeFileSync(manifest, text.replace(/^name = .*$/m, line));
      expect(displayName(project.dir)).toBe("Keep");
    }
    writeFileSync(manifest, text.replace(/^name = .*$/m, `name = 'Lit "eral' # a comment`));
    expect(displayName(project.dir)).toBe('Lit "eral');
    writeFileSync(manifest, text.replace(/^name = .*$/m, 'name = "Esc \\"aped\\""'));
    expect(displayName(project.dir)).toBe('Esc "aped"');
    writeFileSync(manifest, text.replace(/^name = .*$/m, 'name = "Rocket"'));
    expect((await c.call("project.open", { dir: project.dir })).project.name).toBe("Keep");
  });

  it("reads the name from a JSON manifest", () => {
    const dir = freshLocation("json-manifest");
    writeFileSync(join(dir, "rocketwright.json"), JSON.stringify({ name: "From json" }));
    expect(displayName(dir)).toBe("From json");
  });

  it("uses RW_DOCUMENTS_DIR for the default location and home without it", async () => {
    vi.stubEnv("RW_DOCUMENTS_DIR", "/Users/x/Documents");
    expect(await c.call("project.defaults", {})).toEqual({ location: "/Users/x/Documents/RocketWright" });
    vi.stubEnv("RW_DOCUMENTS_DIR", "");
    vi.stubEnv("HOME", "/Users/y");
    expect(await c.call("project.defaults", {})).toEqual({ location: "/Users/y/RocketWright" });
    vi.unstubAllEnvs();
  });

  it("pushes project.closed, and reopening fires project.opened again", async () => {
    const location = freshLocation("reopen");
    const { project } = await c.call("project.create", { name: "Again", location });
    const opens = (): number => c.frames.filter((f) => f.kind === "push" && f.topic === "project.opened" && (f.payload as { project: { dir: string } }).project.dir === project.dir).length;
    expect(opens()).toBe(1);
    await c.call("project.subscribe", { projectId: project.projectId });
    await c.call("project.close", { projectId: project.projectId });
    await c.push("project.closed", (p) => p.projectId === project.projectId);
    expect((await c.call("project.list", {})).projects).toEqual([]);
    const again = (await c.call("project.open", { dir: project.dir })).project;
    expect(again.projectId).toBe(project.projectId);
    await c.push("project.opened", (p) => p.project.dir === project.dir);
    expect(opens()).toBe(2);
  });

  it("opens one project for two spellings at once (keyed by realpath)", async () => {
    const location = freshLocation("spellings");
    const made = await c.call("project.create", { name: "One", location });
    await server.closeProject(made.project.projectId);
    const link = join(base, "spelling-link");
    symlinkSync(made.project.dir, link);
    const [a, b] = await Promise.all([c.call("project.open", { dir: made.project.dir }), c.call("project.open", { dir: link })]);
    expect(a.project.projectId).toBe(b.project.projectId);
    expect((await c.call("project.list", {})).projects).toHaveLength(1);
  });

  it("pushes project.updated when the manifest's name changes", async () => {
    const location = freshLocation("rename");
    const { project } = await c.call("project.create", { name: "Before", location });
    await c.call("model.patch", { projectId: project.projectId, ops: [{ op: "replace", path: "/project/name", value: "After" }] });
    const updated = await c.push("project.updated", (p) => p.project.projectId === project.projectId);
    expect(updated.project.name).toBe("After");
    expect((await c.call("project.list", {})).projects[0]?.name).toBe("After");
  });

  it("every frame matched the IF10 schemas", () => {
    expect(c.violations).toEqual([]);
  });
});

describe("project rename reaches Lecturn (R0.7)", () => {
  const conn = new FakeConnection();
  let base: string;
  let server: AppServer;
  let c: TestClient;

  beforeAll(async () => {
    base = mkdtempSync("/tmp/rwu32-");
    server = await AppServer.start({ bin: sidecarBin(), stderr: "ignore", log: () => undefined, lecturn: (events) => new LecturnLink(connectTo(conn), events) });
    c = await TestClient.connect(server.rpcUrl, validator);
  }, 600_000);

  afterAll(async () => {
    c?.close();
    await server?.close();
    if (base !== undefined) rmSync(base, { recursive: true, force: true });
  });

  it("retitles the workspace from project.rename and from a manifest edit", async () => {
    const { project } = await c.call("project.create", { name: "Before", location: base });
    const root = realpathSync(project.dir);
    await vi.waitFor(() => expect(conn.ensured).toContainEqual([root, "Before"]));

    await c.call("project.rename", { projectId: project.projectId, name: "Renamed" });
    await vi.waitFor(() => expect(conn.ensured.at(-1)).toEqual([root, "Renamed"]));

    await c.call("model.patch", { projectId: project.projectId, ops: [{ op: "replace", path: "/project/name", value: "Patched" }] });
    await vi.waitFor(() => expect(conn.ensured.at(-1)).toEqual([root, "Patched"]));
  });
});
