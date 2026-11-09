import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RecentsFile } from "@rw/contracts";
import { createRecents, LAST_ACTIVE_TIMEOUT_MS, parseRecents, pidAlive, PROBE_TIMEOUT_MS, type Recents, type RecentsOptions } from "./recents.ts";
import { REOPEN_TIMEOUT_MS } from "./reopen.ts";

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) {
    try {
      chmodSync(d, 0o755);
    } catch {
      /* already gone */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

/** Under `/tmp` and already a realpath, so stored dirs compare equal to it. */
function root(): string {
  const d = realpathSync(mkdtempSync("/tmp/rw-recents-"));
  temps.push(d);
  return d;
}

function project(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "rocketwright.toml"), "format = 1\n");
  return dir;
}

function store(file: string, opts: Partial<RecentsOptions> = {}): Recents {
  return createRecents({ file, excluded: [], ...opts });
}

const readFile = (file: string): RecentsFile => JSON.parse(readFileSync(file, "utf8")) as RecentsFile;

describe("what counts as a project", () => {
  it("accepts a JSON manifest, as Rust and Open folder do", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const json = join(dir, "json-project");
    mkdirSync(json);
    writeFileSync(join(json, "rocketwright.json"), "{}");
    await store(file).see({ dir: json, name: "J" });
    expect(await store(file).list()).toMatchObject([{ dir: json, status: "ok" }]);
    expect(await store(file).pickLastActive()).toEqual({ dir: json, status: "ok" });
  });

  it("reads a folder with neither manifest as missing, and a directory named like one too", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const a = project(dir, "a");
    await store(file).see({ dir: a, name: "A" });
    rmSync(join(a, "rocketwright.toml"));
    expect((await store(file).list())[0]?.status).toBe("missing");
    mkdirSync(join(a, "rocketwright.toml"));
    expect((await store(file).list())[0]?.status).toBe("missing");
  });
});

describe("a Recent on a stalled mount", () => {
  const stalled = (dir: string) => join(dir, "stalled");
  /** Every stat under a folder named `stalled…` never answers; everything else is real. */
  function hangingStat(calls: string[] = []): NonNullable<RecentsOptions["stat"]> {
    return (path) => {
      calls.push(path);
      return path.includes("/stalled") ? new Promise(() => undefined) : stat(path);
    };
  }

  it("does not hold up the list, and reads as no access rather than missing", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const a = project(dir, "a");
    const hung = project(dir, "stalled");
    await store(file).see({ dir: a, name: "A" });
    await store(file).see({ dir: hung, name: "H" });
    const list = await store(file, { stat: hangingStat(), probeTimeoutMs: 20 }).list();
    expect(Object.fromEntries(list.map((r) => [r.dir, r.status]))).toEqual({ [a]: "ok", [stalled(dir)]: "denied" });
  });

  it("gives up on the last project too, so a launch never waits on it", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    await store(file).see({ dir: project(dir, "stalled"), name: "H" });
    expect(await store(file, { stat: hangingStat(), lastActiveTimeoutMs: 20 }).pickLastActive()).toEqual({ dir: stalled(dir), status: "denied" });
  });

  it("gives a last project still being answered for (a privacy prompt) longer than a row, inside the reopen deadline", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const a = project(dir, "a");
    await store(file).see({ dir: a, name: "A" });
    const slowStat: NonNullable<RecentsOptions["stat"]> = async (path) => {
      await new Promise((r) => setTimeout(r, 80));
      return stat(path);
    };
    expect(await store(file, { stat: slowStat, probeTimeoutMs: 20 }).pickLastActive()).toEqual({ dir: a, status: "ok" });
    expect((await store(file, { stat: slowStat, probeTimeoutMs: 20 }).list())[0]?.status).toBe("denied");
    expect(LAST_ACTIVE_TIMEOUT_MS).toBeGreaterThan(PROBE_TIMEOUT_MS);
    // What is left has to cover `project.open` once the person has answered.
    expect(LAST_ACTIVE_TIMEOUT_MS).toBeLessThanOrEqual(REOPEN_TIMEOUT_MS - 5000);
  });

  it("reads a healthy row by its own stat when two dead mounts hold the slots", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const a = project(dir, "a");
    // Most recent first: both dead mounts are probed ahead of the healthy row.
    await store(file).see({ dir: a, name: "A" });
    for (const n of ["stalled1", "stalled2"]) await store(file).see({ dir: project(dir, n), name: n });
    const list = await store(file, { stat: hangingStat(), probeTimeoutMs: 20 }).list();
    expect(Object.fromEntries(list.map((r) => [r.dir, r.status]))).toEqual({ [a]: "ok", [join(dir, "stalled1")]: "denied", [join(dir, "stalled2")]: "denied" });
  });

  it("gives a row its full time from when its stat starts, not from when it joined the queue", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const a = project(dir, "a");
    await store(file).see({ dir: a, name: "A" });
    await store(file).see({ dir: project(dir, "b"), name: "B" });
    await store(file).see({ dir: project(dir, "c"), name: "C" });
    // Each stat takes most of the limit, so the third starts well after the limit has passed since the list began.
    const slowStat: NonNullable<RecentsOptions["stat"]> = async (path) => {
      await new Promise((r) => setTimeout(r, 120));
      return stat(path);
    };
    const list = await store(file, { stat: slowStat, probeTimeoutMs: 200 }).list();
    expect(list.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
  });

  it("never waits forever when every thread it may use is stuck", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const a = project(dir, "a");
    await store(file).see({ dir: a, name: "A" });
    for (const n of ["stalled1", "stalled2", "stalled3", "stalled4"]) await store(file).see({ dir: project(dir, n), name: n });
    const list = await store(file, { stat: hangingStat(), probeTimeoutMs: 10 }).list();
    expect(list).toHaveLength(5);
    expect(list.every((r) => r.status === "denied")).toBe(true);
  });

  it("does not pile stalled probes onto the fs thread pool", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    for (const n of ["stalled1", "stalled2", "stalled3", "stalled4"]) await store(file).see({ dir: project(dir, n), name: n });
    const calls: string[] = [];
    const recents = store(file, { stat: hangingStat(calls), probeTimeoutMs: 10 });
    await recents.list();
    await recents.list();
    // Three at most, however many mounts are dead: libuv has four threads, and main needs one for its own files.
    expect(calls.filter((c) => c.endsWith("rocketwright.toml")).length).toBeLessThanOrEqual(3);
  });
});

describe("a corrupt file", () => {
  it.each([["not json", "{nope"], ["wrong version", '{"version":2,"recents":[],"lastActive":null}'], ["not an object", "[1,2]"], ["no list", '{"version":1,"lastActive":"/a"}'], ["empty", ""]])("reads as empty (%s)", async (_label, content) => {
    const dir = root();
    const file = join(dir, "recents.json");
    writeFileSync(file, content);
    const r = store(file);
    await expect(r.list()).resolves.toEqual([]);
    await expect(r.pickLastActive()).resolves.toBeNull();
  });

  it("keeps the good entries and drops the bad ones", () => {
    const good = { dir: "/a", name: "A", lastOpened: "2026-01-01T00:00:00.000Z" };
    expect(parseRecents(JSON.stringify({ version: 1, recents: [good, { dir: 7 }, { dir: "relative", name: "x", lastOpened: "t" }, null], lastActive: 3 }))).toEqual({ version: 1, recents: [good], lastActive: null });
  });

  it("is replaced by the next write", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    writeFileSync(file, "{nope");
    const p = project(dir, "a");
    await store(file).see({ dir: p, name: "A" });
    expect(readFile(file).lastActive).toBe(p);
  });
});

describe("writing", () => {
  it("is on disk as soon as the call returns, with no temp file left", async () => {
    const dir = root();
    const file = join(dir, "nested/recents.json");
    const p = project(dir, "a");
    await store(file, { now: () => new Date("2026-03-04T05:06:07.000Z") }).see({ dir: p, name: "Alpha" });
    expect(readFile(file)).toEqual({ version: 1, recents: [{ dir: p, name: "Alpha", lastOpened: "2026-03-04T05:06:07.000Z" }], lastActive: p });
    expect(readdirSync(join(dir, "nested"))).toEqual(["recents.json"]);
  });

  it("never throws when it cannot write", async () => {
    const dir = root();
    const blocker = join(dir, "file");
    writeFileSync(blocker, "");
    const logs: string[] = [];
    const r = store(join(blocker, "recents.json"), { log: (l) => logs.push(l) });
    await expect(r.see({ dir: project(dir, "a"), name: "A" })).resolves.toBeUndefined();
    await expect(r.list()).resolves.toEqual([]);
    expect(logs.join("\n")).toContain("cannot write");
  });

  it("keys by realpath and moves a reopened project to the front", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const a = project(dir, "a");
    const b = project(dir, "b");
    const link = join(dir, "link-to-a");
    symlinkSync(a, link);
    const r = store(file);
    await r.see({ dir: a, name: "A" });
    await r.see({ dir: b, name: "B" });
    await r.see({ dir: link, name: "A renamed" });
    expect((await r.list()).map((e) => [e.dir, e.name])).toEqual([
      [a, "A renamed"],
      [b, "B"],
    ]);
  });

  it("applies overlapping calls in the order they were made", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const r = store(file);
    const names = ["a", "b", "c", "d"];
    await Promise.all(names.map((n) => r.see({ dir: project(dir, n), name: n })));
    expect((await r.list()).map((e) => e.name)).toEqual(["d", "c", "b", "a"]);
    expect(readFile(file).lastActive).toBe(join(dir, "d"));
  });

  it("keeps a bounded list", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const r = store(file);
    for (let i = 0; i < 35; i++) await r.see({ dir: project(dir, `p${i}`), name: `p${i}` });
    const list = await r.list();
    expect(list).toHaveLength(30);
    expect(list[0]!.name).toBe("p34");
  });

  it("records nothing on a read-only run but still reads", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const a = project(dir, "a");
    await store(file).see({ dir: a, name: "A" });
    const before = readFileSync(file, "utf8");
    const r = store(file, { readOnly: true });
    await r.see({ dir: project(dir, "b"), name: "B" });
    await r.see(null);
    await r.remove(a);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect((await r.list()).map((e) => e.name)).toEqual(["A"]);
  });
});

describe("status", () => {
  it("marks a missing folder, and a removed one is gone", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const a = project(dir, "a");
    const r = store(file);
    await r.see({ dir: a, name: "A" });
    rmSync(a, { recursive: true });
    expect((await r.list()).map((e) => e.status)).toEqual(["missing"]);
    await expect(r.pickLastActive()).resolves.toEqual({ dir: a, status: "missing" });
    await r.remove(a);
    await expect(r.list()).resolves.toEqual([]);
    expect(readFile(file).lastActive).toBeNull();
  });

  it("marks a folder that lost its manifest, or became a file, as missing", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const a = project(dir, "a");
    const b = project(dir, "b");
    const r = store(file);
    await r.see({ dir: a, name: "A" });
    await r.see({ dir: b, name: "B" });
    rmSync(join(a, "rocketwright.toml"));
    rmSync(b, { recursive: true });
    writeFileSync(b, "");
    expect((await r.list()).map((e) => e.status)).toEqual(["missing", "missing"]);
  });

  it.skipIf(process.getuid?.() === 0)("reports a denied folder as denied, never missing (D5)", async () => {
    const dir = root();
    const a = project(dir, "a");
    const r = store(join(dir, "recents.json"));
    await r.see({ dir: a, name: "A" });
    chmodSync(a, 0o000);
    try {
      expect((await r.list()).map((e) => e.status)).toEqual(["denied"]);
    } finally {
      chmodSync(a, 0o755);
    }
  });

  it("reports a project another live process holds, but not a stale record or our own", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const a = project(dir, "a");
    mkdirSync(join(a, ".rw"));
    writeFileSync(join(a, ".rw/lock"), `${JSON.stringify({ pid: 4242, started: "" })}\n`);
    await store(file).see({ dir: a, name: "A" });
    const status = async (opts: Partial<RecentsOptions>): Promise<string | undefined> => (await store(file, opts).list())[0]?.status;
    expect(await status({ pidAlive: () => true })).toBe("locked");
    expect(await status({ pidAlive: () => false })).toBe("ok");
    expect(await store(file, { pidAlive: () => true, openDirs: () => [a] }).list()).toMatchObject([{ dir: a, status: "ok", open: true }]);
    writeFileSync(join(a, ".rw/lock"), "garbage");
    expect(await status({ pidAlive: () => true })).toBe("ok");
    // Held only for an agent's tool process: not open in another app or terminal, even with a live owner.
    writeFileSync(join(a, ".rw/lock"), `${JSON.stringify({ pid: 4242, started: "", agent_only: true })}\n`);
    expect(await status({ pidAlive: () => true })).toBe("ok");
    // Anything else about the record still reads as held.
    writeFileSync(join(a, ".rw/lock"), `${JSON.stringify({ pid: 4242, started: "", agent_only: false })}\n`);
    expect(await status({ pidAlive: () => true })).toBe("locked");
  });

  it("does not read a dead owner's record as locked just because its pid was reused", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const a = project(dir, "a");
    mkdirSync(join(a, ".rw"));
    await store(file).see({ dir: a, name: "A" });
    const lock = (body: unknown): void => writeFileSync(join(a, ".rw/lock"), JSON.stringify(body));
    const status = async (opts: Partial<RecentsOptions>): Promise<string | undefined> => (await store(file, opts).list())[0]?.status;

    // A socket that refuses the connection: the owner is gone, whoever has its pid now.
    lock({ pid: 4242, socket: join(dir, "dead.sock"), started: "2026-01-01T00:00:00Z" });
    expect(await status({ pidAlive: () => true })).toBe("ok");

    // A real listener: held.
    const sock = join(dir, "live.sock");
    const server = createServer();
    await new Promise<void>((ok) => server.listen(sock, ok));
    try {
      lock({ pid: 4242, socket: sock, started: "2026-01-01T00:00:00Z" });
      expect(await status({ pidAlive: () => true })).toBe("locked");
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }

    // No socket recorded: a pid that started after the record cannot be the owner.
    lock({ pid: 4242, started: "2026-01-01T00:00:00Z" });
    expect(await status({ pidAlive: () => true, pidStartedAt: async () => new Date("2026-06-01T00:00:00Z") })).toBe("ok");
    expect(await status({ pidAlive: () => true, pidStartedAt: async () => new Date("2025-06-01T00:00:00Z") })).toBe("locked");
    // Cannot tell: a project in use must not read as free.
    expect(await status({ pidAlive: () => true, pidStartedAt: async () => null })).toBe("locked");
  });

  it("checks a pid without signalling it", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(2 ** 22 + 7)).toBe(false);
  });
});

describe("exclusions (D4)", () => {
  it("never records this launch's temp copy or --project path", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const dev = project(dir, "rw-dev-abc123");
    const explicit = project(dir, "explicit");
    const r = store(file, { excluded: [dev, explicit] });
    await r.see({ dir: dev, name: "Dev" });
    await r.see({ dir: explicit, name: "Explicit" });
    expect(existsSync(file)).toBe(false);
    await expect(r.list()).resolves.toEqual([]);
  });

  it("matches however the path was spelled, even if it did not exist when the store was made", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const link = join(dir, "link");
    const target = join(dir, "real");
    const r = store(file, { excluded: [join(link, "late")] });
    mkdirSync(target);
    symlinkSync(target, link);
    await r.see({ dir: project(target, "late"), name: "Late" });
    expect(existsSync(file)).toBe(false);
  });

  it("keeps an old rw-dev-* copy the person opened themselves", async () => {
    const dir = root();
    const old = project(dir, "rw-dev-old");
    const r = store(join(dir, "recents.json"), { excluded: [project(dir, "rw-dev-new")] });
    await r.see({ dir: old, name: "Rescued" });
    expect((await r.list()).map((e) => e.name)).toEqual(["Rescued"]);
  });

  it("hides an earlier entry during a --project launch without erasing it", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const a = project(dir, "a");
    await store(file).see({ dir: a, name: "A" });
    const launch = store(file, { excluded: [a] });
    await expect(launch.list()).resolves.toEqual([]);
    await expect(launch.pickLastActive()).resolves.toBeNull();
    expect((await store(file).list()).map((e) => e.name)).toEqual(["A"]);
  });
});

describe("last active", () => {
  it("is null on first run", async () => {
    await expect(store(join(root(), "recents.json")).pickLastActive()).resolves.toBeNull();
  });

  it("follows the project last shown, across launches", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const a = project(dir, "a");
    const b = project(dir, "b");
    const r = store(file);
    await r.see({ dir: a, name: "A" });
    await r.see({ dir: b, name: "B" });
    await r.see({ dir: a, name: "A" });
    await expect(store(file).pickLastActive()).resolves.toEqual({ dir: a, status: "ok" });
  });

  it("is cleared when the person closes to Welcome, keeping the Recents entry", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const a = project(dir, "a");
    const r = store(file);
    await r.see({ dir: a, name: "A" });
    await r.see(null);
    await expect(store(file).pickLastActive()).resolves.toBeNull();
    expect((await store(file).list()).map((e) => e.name)).toEqual(["A"]);
  });

  it("survives a Welcome this launch did not cause, so a failed reopen can retry", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const a = project(dir, "a");
    await store(file).see({ dir: a, name: "A" });
    await store(file).see(null);
    await expect(store(file).pickLastActive()).resolves.toEqual({ dir: a, status: "ok" });
  });

  it("is forgotten when its entry is removed, but not when another one is", async () => {
    const dir = root();
    const file = join(dir, "recents.json");
    const a = project(dir, "a");
    const b = project(dir, "b");
    const r = store(file);
    await r.see({ dir: b, name: "B" });
    await r.see({ dir: a, name: "A" });
    await r.remove(b);
    await expect(r.pickLastActive()).resolves.toEqual({ dir: a, status: "ok" });
    await r.remove(a);
    await expect(r.pickLastActive()).resolves.toBeNull();
  });
});
