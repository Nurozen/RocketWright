/**
 * M1.46, B17: `pnpm --filter server test mcp`.
 *
 * The `ViewportBroker` tools as Lecturn's live tier calls them: their
 * definitions (annotations, titles, row summaries), and calls over the real
 * app server's `/mcp/live` (the static bearer, routed by
 * `_meta["lecturn/context"].workspaceRoot`) reaching the window over the WS
 * RPC `broker.*` channel with the caller's thread; `app_*` test hooks are
 * absent without `RW_TEST_HOOKS=1` (I12). B17 removed the old thread-scoped
 * `/mcp` proxy these tests used to run against.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AGENT_OPS, TEST_HOOK_OPS, type BrokerResponse } from "@rw/contracts";
import { TestClient, makeValidator } from "@rw/contracts/mock/harness";
import { BROKER_TOOLS, MAX_SUMMARY, brokerSummary, clipSummary } from "../src/broker/ViewportBroker.ts";
import { AppServer } from "../src/rpc/AppServer.ts";
import { REPO, sidecarBin, tempProject } from "./helpers/harness.ts";

async function connect(url: string, token: string): Promise<Client> {
  const c = new Client({ name: "mcp-test", version: "0" }, { capabilities: {} });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}

/** Lecturn's call meta for a thread in the project at `dir`. */
const lecturnMeta = (dir: string, threadId: string) => ({ "lecturn/context": { projectId: "lecturn-project", threadId, workspaceRoot: realpathSync(dir), turnId: "turn-1" }, "lecturn/approval": { approved: true } });

describe("broker tool definitions (M1.46)", () => {
  it("broker tool definitions are agent-ready (annotations, descriptions, object roots)", () => {
    for (const op of [...AGENT_OPS, ...TEST_HOOK_OPS]) {
      const t = BROKER_TOOLS[op];
      expect(t.name).toBe(op);
      expect(t.inputSchema.type).toBe("object");
      expect(t.description?.length ?? 0).toBeGreaterThan(20);
      expect(t.annotations?.destructiveHint).toBe(false);
    }
    expect(BROKER_TOOLS.viewport_render.annotations?.readOnlyHint).toBe(true);
  });

  it("broker tools read as short titles, and each call's row summary is one line within Lecturn's cap (CPW1R4B)", () => {
    expect(AGENT_OPS.map((op) => BROKER_TOOLS[op].title)).toEqual(["Render view", "Select parts", "Move camera", "Plot results"]);
    for (const op of [...AGENT_OPS, ...TEST_HOOK_OPS]) expect(BROKER_TOOLS[op].annotations?.title, op).toBe(BROKER_TOOLS[op].title);
    const ok = (result: unknown): BrokerResponse => ({ requestId: "r", ok: true, result }) as BrokerResponse;
    const fail = (code: "no_host" | "timeout" | "invalid_args" | "failed"): BrokerResponse => ({ requestId: "r", ok: false, error: { code, message: "x\ny" } });
    expect(brokerSummary("viewport_render", { view: "section" }, ok({ png_base64: "", width: 1, height: 1 }))).toBe("Section view");
    expect(brokerSummary("viewport_render", {}, ok({}))).toBe("Current view");
    expect(brokerSummary("viewport_select", { refs: ["rw:c/a", "rw:c/b"] }, ok({ selected: ["rw:c/a", "rw:c/b"] }))).toBe("2 selected");
    expect(brokerSummary("viewport_select", { refs: [] }, ok({ selected: [] }))).toBe("Selection cleared");
    expect(brokerSummary("viewport_set_camera", { view: "iso", explode: 0.6 }, ok({}))).toBe("Iso view · exploded 60%");
    expect(brokerSummary("viewport_set_camera", { position: [1, 2, 3], section: true }, ok({}))).toBe("Custom view · section");
    expect(brokerSummary("plot_render", { plot: "altitude", runs: ["a", "b"] }, ok({}))).toBe("Altitude plot · 2 runs");
    expect(brokerSummary("app_navigate", { page: "results" }, ok({}))).toBe("Done");
    expect([fail("no_host"), fail("timeout"), fail("invalid_args"), fail("failed")].map((r) => brokerSummary("viewport_render", {}, r))).toEqual(["Project not open", "Timed out", "Invalid input", "Failed"]);
    const nasty = `a\nb\t${"x".repeat(300)}\u0007`;
    for (const op of [...AGENT_OPS, ...TEST_HOOK_OPS]) {
      for (const r of [ok({}), ok({ selected: [nasty] }), fail("failed")]) {
        const s = brokerSummary(op, { view: nasty, plot: nasty, runs: [nasty] }, r);
        expect(s.length, op).toBeGreaterThan(0);
        expect(s.length, op).toBeLessThanOrEqual(MAX_SUMMARY);
        expect([...s].some((c) => c.charCodeAt(0) < 0x20), op).toBe(false);
      }
    }
    expect(clipSummary(nasty)).toHaveLength(MAX_SUMMARY);
  });
});

describe("broker tools over the real app server and WS RPC (M1.46)", () => {
  const validator = makeValidator();
  let server: AppServer;
  let dir: string;

  beforeAll(async () => {
    sidecarBin();
    dir = mkdtempSync("/tmp/rwmcp-");
    server = await AppServer.start({
      bin: sidecarBin(),
      stderr: "ignore",
      testHooks: false,
    });
  }, 600_000);

  afterAll(async () => {
    await server?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it("a live viewport_select reaches the registered window as broker.request and returns its answer", async () => {
    const host = await TestClient.connect(server.rpcUrl, validator);
    try {
      const { project } = await host.call("project.open", { dir });
      await host.call("broker.hostRegister", { projectId: project.projectId, hostId: "win", capabilities: { ops: [...AGENT_OPS], backend: "webgpu" } });
      const c = await connect(server.liveMcpUrl, server.liveBearer.token);
      try {
        const names = (await c.listTools()).tools.map((t) => t.name);
        expect(names).toEqual(expect.arrayContaining([...AGENT_OPS]));
        for (const op of TEST_HOOK_OPS) expect(names).not.toContain(op);
        const call = c.callTool({ name: "viewport_select", arguments: { refs: ["rw:c/nose"] }, _meta: lecturnMeta(dir, "t-ws") });
        const req = await host.push("broker.request", (r) => r.op === "viewport_select");
        expect(req).toMatchObject({ projectId: project.projectId, threadId: "t-ws", args: { refs: ["rw:c/nose"] } });
        await host.call("broker.respond", { requestId: req.requestId, ok: true, result: { selected: ["rw:c/nose"] } });
        expect((await call).structuredContent).toEqual({ selected: ["rw:c/nose"] });
        const hook = await c.callTool({ name: "app_navigate", arguments: { page: "results" }, _meta: lecturnMeta(dir, "t-ws") });
        expect(hook.isError).toBe(true);
      } finally {
        await c.close();
      }
    } finally {
      host.close();
    }
  }, 60_000);
});

describe("window renders stored for the render card (CPW2B)", () => {
  const validator = makeValidator();
  let server: AppServer;
  let dir: string;

  beforeAll(async () => {
    sidecarBin();
    dir = tempProject("rwpic", "fixtures/simple");
    server = await AppServer.start({
      bin: sidecarBin(),
      stderr: "ignore",
      testHooks: false,
    });
  }, 600_000);

  afterAll(async () => {
    await server?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it("viewport_render and plot_render results name the PNG the sidecar stored under renders/window/, which render_picture serves", async () => {
    // A real PNG (the app icon), standing in for the window's capture.
    const png = readFileSync(join(REPO, "app/apps/desktop/assets/app-icon-128.png")).toString("base64");
    const host = await TestClient.connect(server.rpcUrl, validator);
    try {
      const { project } = await host.call("project.open", { dir });
      await host.call("broker.hostRegister", { projectId: project.projectId, hostId: "win", capabilities: { ops: [...AGENT_OPS], backend: "webgpu" } });
      const c = await connect(server.liveMcpUrl, server.liveBearer.token);
      try {
        for (const [op, args, result] of [
          ["viewport_render", { view: "iso" }, { png_base64: png, width: 128, height: 128, backend: "webgpu", adapter: "test" }],
          ["plot_render", { plot: "altitude", runs: [] }, { png_base64: png, width: 128, height: 128, plot: "altitude" }],
        ] as const) {
          const call = c.callTool({ name: op, arguments: args, _meta: lecturnMeta(dir, "t-pic") });
          const req = await host.push("broker.request", (r) => r.op === op);
          await host.call("broker.respond", { requestId: req.requestId, ok: true, result });
          const r = await call;
          expect(r.isError ?? false, JSON.stringify(r.content)).toBe(false);
          expect((r.content as { type: string; data?: string }[])[0]).toEqual({ type: "image", data: png, mimeType: "image/png" });
          const path = (r.structuredContent as { path?: string }).path;
          expect(path, op).toMatch(new RegExp(`^renders/window/${op}\\.[0-9a-f]{16}\\.png$`));
          expect(readFileSync(join(dir, path!)).toString("base64")).toBe(png);
          // The card's read: the sidecar's app-only render_picture returns the same bytes.
          const pic = await server.project(project.projectId).sidecar.callTool("render_picture", { path: path! }, {});
          expect((pic.content as { type: string; data?: string }[]).find((b) => b.type === "image")?.data).toBe(png);
        }
        expect(existsSync(join(dir, "renders/window"))).toBe(true);
      } finally {
        await c.close();
      }
    } finally {
      host.close();
    }
  }, 120_000);
});
