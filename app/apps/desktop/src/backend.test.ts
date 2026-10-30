/**
 * M1.52: `pnpm --filter desktop test`. The backend half of the desktop app
 * without Electron: the server spawn (`env -u ELECTRON_RUN_AS_NODE`), URL
 * plumbing, the dev-project fallback, the preload script, and browser mode
 * against the real app server.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { EMBED_RENDERER_IPC_GLOBAL } from "@lecturn/embed/renderer";
import { EMBED_HOST_BRIDGE_CHANNEL, EMBED_PANE_RECT_CHANNEL, PANE_HOST_CHANNEL, PANE_MAIN_CHANNEL, PANE_SEND_CHANNELS } from "@rw/contracts";
import {
  appUrl,
  buildPreload,
  childEnv,
  defaultSidecarBin,
  desktopArg,
  isProjectDir,
  lecturnBaseDirFor,
  parseDesktopArgs,
  parseServerUrls,
  resolveDevProject,
  serverCommand,
  smokeBrowser,
  spawnServer,
  startBackend,
  userDataOverride,
  waitForHttp,
  type ServerHandle,
} from "./backend.ts";

const temps: string[] = [];
const temp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A stand-in server entry: prints its ELECTRON_RUN_AS_NODE and args, then the two URL lines, then waits. */
function fakeCli(body?: string): string {
  const file = join(temp("rw-fakecli-"), "cli.mjs");
  writeFileSync(
    file,
    body ??
      `process.stdout.write(JSON.stringify({ eran: process.env.ELECTRON_RUN_AS_NODE ?? null, args: process.argv.slice(2), sidecar: process.env.RW_SIDECAR_BIN ?? null }) + "\\n");
setTimeout(() => process.stdout.write("RW_SERVER_URL=http://127.0.0.1:1\\nRW_RPC_URL=ws://127.0.0.1:1/rpc\\n"), 20);
setInterval(() => {}, 1000);`,
  );
  return file;
}

/** Runs the stripped preload in a bare context and returns what it exposed. */
function runPreload(argv: string[], ipcRenderer: object = {}): Record<string, unknown> {
  const exposed: Record<string, unknown> = {};
  const electron = { contextBridge: { exposeInMainWorld: (k: string, v: unknown) => (exposed[k] = v) }, ipcRenderer };
  runInNewContext(buildPreload(), {
    require: (m: string) => {
      if (m !== "electron") throw new Error(`preload required ${m}`);
      return electron;
    },
    process: { argv, platform: "darwin", versions: { electron: "44.8.0", chrome: "146" } },
  });
  return exposed;
}

describe("server spawn", () => {
  it("strips ELECTRON_RUN_AS_NODE from the child env and runs through env -u", () => {
    const env = childEnv({ ELECTRON_RUN_AS_NODE: "1", PATH: "/bin", UNSET: undefined }, { RW_X: "y" });
    expect(env).toEqual({ PATH: "/bin", RW_X: "y" });
    const { cmd, args } = serverCommand("node", "/srv/cli.ts", ["/tmp/p"]);
    if (process.platform !== "win32") {
      expect(cmd).toBe("env");
      expect(args).toEqual(["-u", "ELECTRON_RUN_AS_NODE", "node", "/srv/cli.ts", "--project", "/tmp/p"]);
    }
  });

  it("passes main's Lecturn base dir and the Lecturn env, never ELECTRON_RUN_AS_NODE (B8, D3)", () => {
    const { args } = serverCommand("node", "/srv/cli.ts", ["/tmp/p"], "/tmp/userdata/lecturn");
    expect(args.slice(-2)).toEqual(["--lecturn-base-dir", "/tmp/userdata/lecturn"]);
    const env = childEnv({ ELECTRON_RUN_AS_NODE: "1", LECTURN_HOME: "/tmp/lh", RW_LECTURN_BASE_DIR: "/tmp/lb", LECTURN_TEST_PROVIDERS: "1" });
    expect(env).toEqual({ LECTURN_HOME: "/tmp/lh", RW_LECTURN_BASE_DIR: "/tmp/lb", LECTURN_TEST_PROVIDERS: "1" });
  });

  it("takes the run's profile from RW_USER_DATA_DIR and names the base dir the server really uses (CPW2B)", () => {
    expect(userDataOverride({})).toBeUndefined();
    expect(userDataOverride({ RW_USER_DATA_DIR: "" })).toBeUndefined();
    expect(userDataOverride({ RW_USER_DATA_DIR: "/tmp/rw-b4b/electron" })).toBe("/tmp/rw-b4b/electron");
    // The --rehearse leak: the arg named <real userData>/lecturn while the server used RW_LECTURN_BASE_DIR.
    const real = "/Users/u/Library/Application Support/Electron";
    expect(lecturnBaseDirFor(real, { RW_LECTURN_BASE_DIR: "/tmp/rw-b4b/base" })).toBe("/tmp/rw-b4b/base");
    expect(lecturnBaseDirFor("/tmp/rw-render-x", {})).toBe("/tmp/rw-render-x/lecturn");
    const { args } = serverCommand("node", "/srv/cli.ts", ["/tmp/p"], lecturnBaseDirFor(real, { RW_LECTURN_BASE_DIR: "/tmp/rw-b4b/base" }));
    expect(args.join(" ")).not.toContain("Application Support");
  });

  it("parses the announced URLs only once both lines are in", () => {
    expect(parseServerUrls("RW_SERVER_URL=http://127.0.0.1:5\n")).toBeNull();
    expect(parseServerUrls("noise\nRW_SERVER_URL=http://127.0.0.1:5\nRW_RPC_URL=ws://127.0.0.1:5/rpc\n")).toEqual({
      serverUrl: "http://127.0.0.1:5",
      rpcUrl: "ws://127.0.0.1:5/rpc",
      liveMcpUrl: null,
    });
  });

  it("parses the optional RW_LIVE_MCP_URL line and never a partial line", () => {
    const head = "RW_SERVER_URL=http://127.0.0.1:5\nRW_LIVE_MCP_URL=http://127.0.0.1:5/mcp/live\n";
    // A chunk boundary inside the last line: not announced yet (no truncated URL).
    expect(parseServerUrls(`${head}RW_RPC_URL=ws://127.0.0.1:5/rp`)).toBeNull();
    expect(parseServerUrls(`${head}RW_RPC_URL=ws://127.0.0.1:5/rpc?token=abc\r\n`)).toEqual({
      serverUrl: "http://127.0.0.1:5",
      rpcUrl: "ws://127.0.0.1:5/rpc?token=abc",
      liveMcpUrl: "http://127.0.0.1:5/mcp/live",
    });
    // A partial live line is ignored, not truncated.
    expect(parseServerUrls("RW_SERVER_URL=http://a\nRW_RPC_URL=ws://a/rpc\nRW_LIVE_MCP_URL=http://a/mc")?.liveMcpUrl).toBeNull();
    // Only a line start counts.
    expect(parseServerUrls("x RW_SERVER_URL=http://a\nRW_RPC_URL=ws://a/rpc\n")).toBeNull();
  });

  it("spawns the server without ELECTRON_RUN_AS_NODE, passes projects, and stops it", async () => {
    const lines: string[] = [];
    const server: ServerHandle = await spawnServer({
      cli: fakeCli(),
      projects: ["/tmp/rw-proj"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", RW_SIDECAR_BIN: "/opt/rw/rocketwright" },
      log: (c) => lines.push(c),
    });
    expect(server).toMatchObject({ serverUrl: "http://127.0.0.1:1", rpcUrl: "ws://127.0.0.1:1/rpc" });
    await server.stop();
    expect(server.child.exitCode !== null || server.child.signalCode !== null).toBe(true);
  });

  it("reports the child's env as seen from inside", async () => {
    let seen = "";
    const cli = fakeCli(
      `process.stdout.write("RW_SERVER_URL=http://127.0.0.1:1\\nRW_RPC_URL=ws://127.0.0.1:1/rpc\\n");
setTimeout(() => process.stdout.write(JSON.stringify({ eran: process.env.ELECTRON_RUN_AS_NODE ?? null, args: process.argv.slice(2), sidecar: process.env.RW_SIDECAR_BIN ?? null }) + "\\n"), 20);
setInterval(() => {}, 1000);`,
    );
    const server = await spawnServer({
      cli,
      projects: ["/tmp/rw-proj"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", RW_SIDECAR_BIN: "/opt/rw/rocketwright" },
      log: (c) => (seen += c),
    });
    try {
      await expect.poll(() => seen, { timeout: 5000 }).toContain("eran");
      expect(JSON.parse(seen.trim())).toEqual({ eran: null, args: ["--project", "/tmp/rw-proj"], sidecar: "/opt/rw/rocketwright" });
    } finally {
      await server.stop();
    }
  });

  it("rejects with the server's stderr when it exits before announcing", async () => {
    const cli = fakeCli(`process.stderr.write("boom: no such project\\n"); process.exit(3);`);
    await expect(spawnServer({ cli, log: () => undefined })).rejects.toThrow(/exited \(3\).*\n.*boom: no such project/s);
  });

  it("finds the workspace's plain sidecar build unless RW_SIDECAR_BIN is set", () => {
    const repo = temp("rw-repo-");
    expect(defaultSidecarBin({}, repo)).toBeUndefined();
    // target/debug may hold the `doubles` test build: never picked.
    mkdirSync(join(repo, "target/debug"), { recursive: true });
    writeFileSync(join(repo, "target/debug/rocketwright"), "");
    expect(defaultSidecarBin({}, repo)).toBeUndefined();
    mkdirSync(join(repo, "target/rw-plain"), { recursive: true });
    writeFileSync(join(repo, "target/rw-plain/rocketwright"), "");
    expect(defaultSidecarBin({}, repo)).toBe(join(repo, "target/rw-plain/rocketwright"));
    expect(defaultSidecarBin({ CARGO_TARGET_DIR: "/nowhere" }, repo)).toBeUndefined();
    expect(defaultSidecarBin({ RW_SIDECAR_BIN: "/x/rocketwright" }, repo)).toBe("/x/rocketwright");
  });
});

describe("page URL and preload", () => {
  it("adds rpc= and http= to the page query", () => {
    const urls = { rpcUrl: "ws://127.0.0.1:9/rpc", serverUrl: "http://127.0.0.1:9" };
    expect(appUrl("http://127.0.0.1:7", null)).toBe("http://127.0.0.1:7/index.html");
    expect(appUrl("http://127.0.0.1:7", null, "mode=render")).toBe("http://127.0.0.1:7/index.html?mode=render");
    expect(appUrl("http://127.0.0.1:7", null, "", "spikes/section.html")).toBe("http://127.0.0.1:7/spikes/section.html");
    expect(() => appUrl("http://127.0.0.1:7", null, "", "../x.html")).toThrow();
    expect(() => appUrl("http://127.0.0.1:7", null, "", "https://e.com/x.html")).toThrow();
    const u = new URL(appUrl("http://127.0.0.1:7", urls, "page=04"));
    expect(u.origin).toBe("http://127.0.0.1:7");
    expect(Object.fromEntries(u.searchParams)).toEqual({ page: "04", rpc: urls.rpcUrl, http: urls.serverUrl });
  });

  it("moves the RPC token out of the page query into the fragment; the preload keeps it (REV-srv)", () => {
    const urls = { rpcUrl: "ws://127.0.0.1:9/rpc?token=s3cr3t-T0k_n", serverUrl: "http://127.0.0.1:9" };
    const u = new URL(appUrl("http://127.0.0.1:7", urls, "page=04"));
    expect(Object.fromEntries(u.searchParams)).toEqual({ page: "04", rpc: "ws://127.0.0.1:9/rpc", http: urls.serverUrl });
    expect(u.hash).toBe("#token=s3cr3t-T0k_n");
    expect(u.search).not.toContain("s3cr3t");
    const arg = desktopArg(urls);
    expect(runPreload(["/Electron", "--type=renderer", arg]).rwDesktop).toMatchObject({ rpcUrl: urls.rpcUrl });
  });

  it("the preload strips to a CommonJS script that exposes window.rwDesktop", () => {
    const src = buildPreload();
    expect(src).not.toMatch(/^\s*(import|export)\s/m);
    const arg = desktopArg({ rpcUrl: "ws://127.0.0.1:9/rpc", serverUrl: "http://127.0.0.1:9" });
    expect(runPreload(["/Electron", "--type=renderer", arg]).rwDesktop).toEqual({
      desktop: true,
      platform: "darwin",
      rpcUrl: "ws://127.0.0.1:9/rpc",
      serverUrl: "http://127.0.0.1:9",
      versions: { electron: "44.8.0", chrome: "146" },
      lecturn: { onMessage: expect.any(Function) },
    });
  });

  it("the preload's embed channel sends only on the pane channels and relays main's messages (B10)", () => {
    const sent: unknown[][] = [];
    const listeners = new Map<string, (e: unknown, m: unknown) => void>();
    const ipc = {
      send: (...a: unknown[]) => sent.push(a),
      on: (ch: string, l: (e: unknown, m: unknown) => void) => listeners.set(ch, l),
      removeListener: (ch: string) => listeners.delete(ch),
    };
    const exposed = runPreload(["/Electron"], ipc);
    const embedIpc = exposed[EMBED_RENDERER_IPC_GLOBAL] as { send(channel: unknown, payload: unknown): void };
    for (const ch of PANE_SEND_CHANNELS) embedIpc.send(ch, { ch });
    embedIpc.send("lecturn-embed:from-guest", { spoof: true });
    embedIpc.send(PANE_MAIN_CHANNEL, { loop: true });
    embedIpc.send("rw-other", {});
    embedIpc.send(7, {});
    expect(sent).toEqual(PANE_SEND_CHANNELS.map((ch) => [ch, { ch }]));
    expect(PANE_SEND_CHANNELS).toEqual([EMBED_PANE_RECT_CHANNEL, EMBED_HOST_BRIDGE_CHANNEL, PANE_HOST_CHANNEL]);
    const lecturn = (exposed.rwDesktop as { lecturn: { onMessage(cb: (m: unknown) => void): () => void } }).lecturn;
    const got: unknown[] = [];
    const off = lecturn.onMessage((m) => got.push(m));
    listeners.get(PANE_MAIN_CHANNEL)?.({}, { type: "snapshot.clear" });
    expect(got).toEqual([{ type: "snapshot.clear" }]);
    off();
    expect(listeners.has(PANE_MAIN_CHANNEL)).toBe(false);
  });

  it("the preload exposes nulls without a config or for non-URL values", () => {
    expect(runPreload(["/Electron"]).rwDesktop).toMatchObject({ rpcUrl: null, serverUrl: null });
    expect(runPreload(["/Electron", "--rw-desktop=%7Bbad"]).rwDesktop).toMatchObject({ rpcUrl: null, serverUrl: null });
    const arg = desktopArg({ rpcUrl: "javascript:alert(1)", serverUrl: "file:///etc" });
    expect(runPreload(["/Electron", arg]).rwDesktop).toMatchObject({ rpcUrl: null, serverUrl: null });
  });
});

describe("dev project", () => {
  it("falls back to an empty temp project under /tmp when the fixture is absent", () => {
    const repo = temp("rw-repo-");
    const p = resolveDevProject(repo);
    temps.push(p.dir);
    expect(p).toMatchObject({ source: "empty", temp: true });
    expect(p.dir.startsWith("/tmp/rw-dev-")).toBe(true);
    expect(readdirSync(p.dir)).toEqual([]);
  });

  it("copies fixtures/research-vehicle without its .rw/ runtime state", () => {
    const repo = temp("rw-repo-");
    const fx = join(repo, "fixtures/research-vehicle");
    mkdirSync(join(fx, "parts"), { recursive: true });
    mkdirSync(join(fx, ".rw/threads"), { recursive: true });
    writeFileSync(join(fx, "rocket.rw.toml"), 'name = "Research vehicle"\n');
    writeFileSync(join(fx, "parts/nose.rw.toml"), "");
    writeFileSync(join(fx, ".rw/threads/t.jsonl"), "{}\n");
    expect(isProjectDir(fx)).toBe(true);
    const p = resolveDevProject(repo);
    temps.push(p.dir);
    expect(p.source).toBe("fixture");
    expect(readdirSync(p.dir).sort()).toEqual(["parts", "rocket.rw.toml"]);
    expect(readdirSync(join(p.dir, "parts"))).toEqual(["nose.rw.toml"]);
  });
});

describe("CLI flags", () => {
  it("parses projects, modes, and implies --hidden from --smoke", () => {
    const a = parseDesktopArgs(["--project", "/a", "--project", "/b", "--smoke", "--page", "04", "--render-out", "x.png"]);
    expect(a).toMatchObject({ projects: ["/a", "/b"], smoke: true, hidden: true, browser: false, devProject: false, page: "04" });
    expect(parseDesktopArgs(["--dev-project", "--browser", "--open"])).toMatchObject({ projects: [], devProject: true, browser: true, open: true, hidden: false });
  });
});

describe("browser mode against the real app server", () => {
  it("serves the bundle on 127.0.0.1 and the RPC socket says hello", async () => {
    const web = temp("rw-web-");
    writeFileSync(join(web, "index.html"), "<!doctype html><div id=root></div>");
    const b = await startBackend({ projects: [], webRoot: web, query: "page=04", log: () => undefined });
    try {
      expect(b.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/index\.html\?page=04&rpc=ws%3A%2F%2F127\.0\.0\.1%3A\d+%2Frpc&http=/);
      const r = await smokeBrowser(b);
      expect(r.hello).toMatchObject({ kind: "hello", rpc: "rw-rpc/1" });
      expect(r.projects).toEqual([]);
    } finally {
      await b.close();
    }
    expect(b.server?.child.exitCode !== null || b.server?.child.signalCode !== null).toBe(true);
  }, 60_000);
});

describe("waitForHttp", () => {
  it("retries until the origin answers, then resolves", async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      if (calls < 3) throw new TypeError("fetch failed");
      return new Response("ok", { status: 404 });
    }) as typeof fetch;
    await waitForHttp("http://127.0.0.1:1/", Date.now() + 5_000, fake);
    expect(calls).toBe(3);
  });

  it("gives up after the deadline with the last error", async () => {
    const fake = (async () => {
      throw new TypeError("connection refused");
    }) as typeof fetch;
    await expect(waitForHttp("http://127.0.0.1:1/", Date.now() + 150, fake)).rejects.toThrow(/not answering: connection refused/);
  });
});
