/**
 * B9: `pnpm -C app --filter @rw/server test -- live-tools`. The live tools
 * route (`/mcp/live`, D20) on a running app server with a fake sidecar and a
 * fake Lecturn connection:
 *
 * - the lease: `setLiveTools({url, bearer})` once connected, cleared on close;
 * - guards: localhost Host/Origin, the static bearer and its 401 shape (the
 *   old `/mcp` route is gone, B17);
 * - `tools/list` is exactly `broker.tools()`, and `viewport_render` /
 *   `plot_render` declare `ui://rw/render-card`, which the route serves;
 * - routing by `realpath(_meta["lecturn/context"].workspaceRoot)` (a symlinked
 *   project, either spelling) with the thread from the same meta; a closed
 *   project, an unknown root or no window answers "project not open in
 *   RocketWright".
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AGENT_OPS, type BrokerRequest, type ProjectInfo } from "@rw/contracts";
import { BROKER_TOOLS, PROJECT_NOT_OPEN, RENDER_CARD_URI, ViewportBroker, lecturnContextOf } from "../src/broker/ViewportBroker.ts";
import { LecturnLink } from "../src/lecturn/connection.ts";
import { LIVE_MCP_PATH, RENDER_CARD_PATH, UI_MIME } from "../src/mcp/http.ts";
import { LiveToolsBearer } from "../src/mcp/session-registry.ts";
import { AppServer } from "../src/rpc/AppServer.ts";
import type { SidecarConnection } from "../src/sidecar/SidecarSupervisor.ts";
import { connectTo, FakeConnection } from "./helpers/fakeLecturn.ts";

const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

/** A sidecar that starts, lists no tools and answers every read with `{}`; it stores window renders (`render_store`, CPW2B). */
class FakeSidecar implements SidecarConnection {
  calls: string[] = [];
  stored: { kind: unknown; png_base64: unknown }[] = [];
  start(): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
  onClose(): () => void {
    return () => undefined;
  }
  onResourceUpdated(): () => void {
    return () => undefined;
  }
  subscribe(): Promise<unknown> {
    return Promise.resolve({});
  }
  unsubscribe(): Promise<unknown> {
    return Promise.resolve({});
  }
  readJson(): Promise<unknown> {
    return Promise.resolve({});
  }
  serverVersion(): { name: string; version: string } {
    return { name: "rocketwright", version: "0.0.0-test" };
  }
  pid(): number {
    return 1;
  }
  listTools(): Promise<never[]> {
    return Promise.resolve([]);
  }
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: []; structuredContent?: Record<string, unknown> }> {
    this.calls.push(name);
    if (name === "render_store") {
      this.stored.push({ kind: args.kind, png_base64: args.png_base64 });
      return Promise.resolve({ content: [], structuredContent: { path: `renders/window/${String(args.kind)}.0123456789abcdef.png`, bytes: 8 } });
    }
    return Promise.resolve({ content: [] });
  }
}

async function connect(url: string, bearer: string): Promise<Client> {
  const c = new Client({ name: "lecturn-live-test", version: "0" }, { capabilities: {} });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  return c;
}

/** A raw POST of an `initialize` to the live route (status, headers, body). */
function rawPost(url: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const u = new URL(url);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } });
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** A fake web host for `projectId`: records requests and answers each with a PNG. */
function fakeHost(broker: ViewportBroker, projectId: string): BrokerRequest[] {
  const seen: BrokerRequest[] = [];
  const owner = { name: `window-${projectId}` };
  broker.register(projectId, {
    owner,
    hostId: `win-${projectId}`,
    capabilities: { ops: broker.ops(), backend: "webgpu" },
    send: (req) => {
      seen.push(req);
      queueMicrotask(() => broker.respond(owner, { requestId: req.requestId, ok: true, result: { png_base64: PNG, width: 64, height: 64, backend: "webgpu", adapter: "fake" } } as never));
    },
  });
  return seen;
}

const text = (r: unknown): string => ((r as { content: { type: string; text?: string }[] }).content.find((c) => c.type === "text")?.text ?? "");

describe("live tools route (B9)", () => {
  const fake = new FakeConnection();
  const temps: string[] = [];
  let server: AppServer;
  let base: string;
  let linkDir: string;
  let real: string;
  let project: ProjectInfo;
  const sidecar = new FakeSidecar();

  beforeAll(async () => {
    // A project reached through a symlink (and `/tmp` is one on macOS).
    base = mkdtempSync("/tmp/rwlive-");
    temps.push(base);
    mkdirSync(join(base, "real"));
    linkDir = join(base, "proj");
    symlinkSync(join(base, "real"), linkDir);
    real = realpathSync(join(base, "real"));
    server = await AppServer.start({
      coreVersion: "0.0.0-test",
      stderr: "ignore",
      testHooks: false,
      brokerTimeoutMs: 500,
      connect: () => sidecar,
      lecturn: (events) => new LecturnLink(connectTo(fake), events),
      log: () => undefined,
    });
    project = await server.openProject(linkDir);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    for (const d of temps) rmSync(d, { recursive: true, force: true });
  });

  it("leases the route with setLiveTools once connected: the URL and a static bearer", async () => {
    await expect.poll(() => fake.liveTools.length).toBe(1);
    expect(server.liveMcpUrl).toBe(`${server.url}${LIVE_MCP_PATH}`);
    expect(fake.liveTools[0]).toEqual({ url: server.liveMcpUrl, bearer: server.liveBearer.token });
    expect(server.liveBearer.verify(server.liveBearer.token)).toBe(true);
    expect(server.liveBearer.verify(`${server.liveBearer.token}x`)).toBe(false);
    expect(server.liveBearer.verify("")).toBe(false);
  });

  it("answers 401 without the live bearer; the old thread-scoped /mcp route is gone (B17)", async () => {
    for (const headers of [{}, { authorization: "Bearer nope" }]) {
      const r = await rawPost(server.liveMcpUrl, headers);
      expect(r.status).toBe(401);
      expect(r.headers["www-authenticate"]).toBe("Bearer");
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(JSON.parse(r.body)).toMatchObject({ error: "invalid_mcp_credential" });
    }
    const old = await rawPost(`${server.url}/mcp`, { authorization: `Bearer ${server.liveBearer.token}` });
    expect(old.status).toBe(404);
  });

  it("keeps the localhost Host and Origin guards", async () => {
    const auth = { authorization: `Bearer ${server.liveBearer.token}` };
    const port = new URL(server.url).port;
    expect((await rawPost(server.liveMcpUrl, { ...auth, host: `evil.example:${port}` })).status).toBe(403);
    expect((await rawPost(server.liveMcpUrl, { ...auth, origin: "https://evil.example" })).status).toBe(403);
    expect((await rawPost(server.liveMcpUrl, { ...auth, origin: `http://127.0.0.1:${port}` })).status).toBe(200);
  });

  it("lists exactly broker.tools(); the render tools declare ui://rw/render-card", async () => {
    const c = await connect(server.liveMcpUrl, server.liveBearer.token);
    try {
      const { tools } = await c.listTools();
      expect(tools.map((t) => t.name)).toEqual([...AGENT_OPS]);
      expect(tools).toEqual(server.broker.tools());
      const ui = Object.fromEntries(tools.map((t) => [t.name, (t._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri]));
      expect(ui).toEqual({ viewport_render: RENDER_CARD_URI, viewport_select: undefined, viewport_set_camera: undefined, plot_render: RENDER_CARD_URI });
      expect(BROKER_TOOLS.viewport_render._meta?.["rw/approval"]).toBe("never");
    } finally {
      await c.close();
    }
  });

  it("serves the render card resource (the CLI's HTML, MCP Apps mime)", async () => {
    const c = await connect(server.liveMcpUrl, server.liveBearer.token);
    try {
      const { resources } = await c.listResources();
      expect(resources.map((r) => [r.uri, r.mimeType])).toEqual([[RENDER_CARD_URI, UI_MIME]]);
      const read = await c.readResource({ uri: RENDER_CARD_URI });
      const [card] = read.contents as { uri: string; mimeType?: string; text?: string; _meta?: Record<string, unknown> }[];
      expect(card).toMatchObject({ uri: RENDER_CARD_URI, mimeType: UI_MIME });
      expect(card!.text).toBe(readFileSync(RENDER_CARD_PATH, "utf8"));
      expect(card!.text).toContain('data-testid="rw.render-card"');
      expect(card!._meta).toEqual({ ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } });
      await expect(c.readResource({ uri: "ui://rw/nope" })).rejects.toThrow();
    } finally {
      await c.close();
    }
  });

  it("routes by realpath(workspaceRoot), either spelling, with the thread from the meta", async () => {
    const seen = fakeHost(server.broker, project.projectId);
    const c = await connect(server.liveMcpUrl, server.liveBearer.token);
    try {
      for (const [root, threadId] of [
        [linkDir, "lec-thread-1"],
        [real, "lec-thread-2"],
        [`${linkDir}/.`, "lec-thread-3"],
      ] as const) {
        const r = await c.callTool({
          name: "viewport_render",
          arguments: { view: "iso" },
          _meta: { "lecturn/context": { projectId: "lecturn-project-id", threadId, workspaceRoot: root, turnId: "turn-1" }, "lecturn/approval": { approved: true } },
        });
        expect(r.isError, text(r)).not.toBe(true);
        expect((r.content as { type: string }[])[0]).toEqual({ type: "image", data: PNG, mimeType: "image/png" });
        // CPW2B: the PNG is stored under renders/ (the sidecar's render_store) and the result names it for the card.
        expect(r.structuredContent).toEqual({ width: 64, height: 64, backend: "webgpu", adapter: "fake", path: "renders/window/viewport_render.0123456789abcdef.png" });
        expect(seen.at(-1)).toMatchObject({ projectId: project.projectId, threadId, op: "viewport_render", args: { view: "iso" } });
      }
      // No thread in the meta: the host sees null.
      const plot = await c.callTool({ name: "plot_render", arguments: { plot: "altitude", runs: [] }, _meta: { "lecturn/context": { workspaceRoot: linkDir } } });
      expect(seen.at(-1)).toMatchObject({ op: "plot_render", threadId: null });
      expect((plot.content as { type: string }[])[0]).toEqual({ type: "image", data: PNG, mimeType: "image/png" });
      expect(plot.structuredContent).toMatchObject({ path: "renders/window/plot_render.0123456789abcdef.png" });
      expect(sidecar.stored.at(-1)).toEqual({ kind: "plot_render", png_base64: PNG });
    } finally {
      await c.close();
    }
  });

  it("answers 'project not open in RocketWright' for an unknown root, no window, or a closed project", async () => {
    const other = mkdtempSync("/tmp/rwlive-o-");
    temps.push(other);
    const c = await connect(server.liveMcpUrl, server.liveBearer.token);
    const call = (workspaceRoot: string) => c.callTool({ name: "viewport_select", arguments: { refs: ["rw:c/fins"] }, _meta: { "lecturn/context": { workspaceRoot, threadId: "t" } } });
    const expectNotOpen = (r: Awaited<ReturnType<typeof call>>) => {
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(`no_host: ${PROJECT_NOT_OPEN}`);
      expect(r._meta?.["rw/error"]).toEqual({ code: "no_host", message: PROJECT_NOT_OPEN });
    };
    try {
      expectNotOpen(await call(other));
      expectNotOpen(await call(join(base, "missing")));
      // Open, but no window registered for it.
      const second = await server.openProject(other);
      expectNotOpen(await call(other));
      // Open with a window, then closed.
      const seen = fakeHost(server.broker, second.projectId);
      expect((await call(other)).isError).not.toBe(true);
      expect(seen).toHaveLength(1);
      await server.closeProject(second.projectId);
      expectNotOpen(await call(other));
      // Without the context, or a tool the route does not list.
      const bare = await c.callTool({ name: "viewport_render", arguments: {} });
      expect(bare.isError).toBe(true);
      expect(text(bare)).toMatch(/^invalid_args: /);
      const unknown = await c.callTool({ name: "model_get", arguments: {}, _meta: { "lecturn/context": { workspaceRoot: linkDir } } });
      expect(unknown.isError).toBe(true);
      expect(text(unknown)).toMatch(/^not_found: /);
    } finally {
      await c.close();
    }
  });

  it("clears the lease when the server closes", async () => {
    const lecturn = new FakeConnection();
    const s = await AppServer.start({
      coreVersion: "0.0.0-test",
      stderr: "ignore",
      testHooks: false,
      connect: () => new FakeSidecar(),
      lecturn: (events) => new LecturnLink(connectTo(lecturn), events),
      log: () => undefined,
    });
    await expect.poll(() => lecturn.liveTools.length).toBe(1);
    await s.close();
    expect(lecturn.liveTools).toEqual([{ url: s.liveMcpUrl, bearer: s.liveBearer.token }, null]);
    expect(lecturn.closed).toBe(true);
  });
});

describe("lecturnContextOf / LiveToolsBearer (B9)", () => {
  it("reads the workspace root and thread; anything else is ignored", () => {
    expect(lecturnContextOf({ "lecturn/context": { workspaceRoot: "/w", threadId: "t", projectId: "p", turnId: "u" } })).toEqual({ workspaceRoot: "/w", threadId: "t" });
    expect(lecturnContextOf({ "lecturn/context": { workspaceRoot: "/w" } })).toEqual({ workspaceRoot: "/w", threadId: null });
    expect(lecturnContextOf({ "lecturn/context": { workspaceRoot: "" } })).toBeUndefined();
    expect(lecturnContextOf({ "lecturn/context": "nope" })).toBeUndefined();
    expect(lecturnContextOf(undefined)).toBeUndefined();
  });

  it("generates a fresh bearer per launch and refuses empty ones", () => {
    expect(new LiveToolsBearer().token).not.toBe(new LiveToolsBearer().token);
    expect(() => new LiveToolsBearer("")).toThrow();
    expect(new LiveToolsBearer("abc").verify("abc")).toBe(true);
  });
});
