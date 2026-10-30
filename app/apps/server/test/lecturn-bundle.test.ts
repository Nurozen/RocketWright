/**
 * B13: `pnpm -C app --filter @rw/server test -- lecturn-bundle`. Thread
 * bundle fixtures: templating and the fixture clock (`lecturn/bundle.ts`),
 * Lecturn's WebSocket RPC (`lecturn/appsRpc.ts`, against a fake Lecturn
 * that speaks the ticket endpoint and Effect RPC's JSON frames),
 * `LecturnLink.importThreads` / `waitForThreads`, and `app_seed_thread
 * {bundle}` through the app server's test hooks (real sidecar, fake Lecturn
 * connection).
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EmbedThread } from "@rw/contracts";
import { TestClient, makeValidator } from "@rw/contracts/mock/harness";
import { acceptUpgrade } from "@rw/contracts/ws";
import { lecturnRpc, readServerOrigin, readSidecarAppSession, socketUrl } from "../src/lecturn/appsRpc.ts";
import { BundleError, FIXTURE_CLOCK, bundleThreadIds, completeRunIds, instantiateBundle, linkThreadSteps, parseThreadBundle, runIdTemplate, threadStepLinks, type BundleThread, type ThreadBundle } from "../src/lecturn/bundle.ts";
import { LecturnLink, LecturnUnavailable, type ImportResult } from "../src/lecturn/connection.ts";
import { RW_APP_ID } from "../src/lecturn/registration.ts";
import { AppServer } from "../src/rpc/AppServer.ts";
import { FakeConnection, connectTo, thread } from "./helpers/fakeLecturn.ts";
import { sidecarBin } from "./helpers/harness.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

const HTML = "<!doctype html><title>card</title>";

function sampleBundle(): ThreadBundle {
  const msg = (id: string, at: string) => ({ id, role: "user", text: "Show {workspaceRoot}", createdAt: at, updatedAt: at });
  return {
    version: 1,
    appId: RW_APP_ID,
    sourceEnvironmentId: "rw-fixtures",
    exportedAt: FIXTURE_CLOCK,
    projects: [
      {
        workspaceRoot: "{workspaceRoot}",
        title: "{projectName}",
        threads: [
          { sourceThreadId: "rw-01-old", title: "Flight comparison", createdAt: "2026-10-24T09:45:00.000Z", updatedAt: "2026-10-24T09:45:00.000Z", historyRevision: 1, appData: '{"page":"assembly"}', subtitle: null, pinned: false, messages: [msg("m1", "2026-10-24T09:45:00.000Z")], turnItems: [] },
          { sourceThreadId: "rw-01-new", title: "Assembly review", createdAt: "2026-10-24T11:56:00.000Z", updatedAt: "2026-10-24T11:56:20.000Z", historyRevision: 1, appData: '{"page":"assembly"}', subtitle: null, pinned: false, messages: [msg("m2", "2026-10-24T11:56:00.000Z")], turnItems: [{ id: "i1", type: "dynamic_tool", startedAt: "2026-10-24T11:56:01.000Z", completedAt: null }] },
        ],
      },
    ],
    assets: [{ sourceAttachmentId: "rw-01-new-card-html", mimeType: "text/html", byteLength: Buffer.byteLength(HTML), sha256: "0".repeat(64), dataBase64: Buffer.from(HTML).toString("base64") }],
  };
}

describe("thread bundle fixtures (bundle.ts)", () => {
  it("substitutes the workspace templates and moves every timestamp to the target clock", () => {
    const b = sampleBundle();
    const now = Date.parse(FIXTURE_CLOCK) + 3_600_000;
    const out = instantiateBundle(b, { workspaceRoot: "/private/tmp/x/Research vehicle", projectName: "Research vehicle", now });
    expect(out.projects[0]).toMatchObject({ workspaceRoot: "/private/tmp/x/Research vehicle", title: "Research vehicle" });
    expect(out.exportedAt).toBe(new Date(now).toISOString());
    const t = out.projects[0]!.threads[1]!;
    expect([t.createdAt, t.updatedAt]).toEqual(["2026-10-24T12:56:00.000Z", "2026-10-24T12:56:20.000Z"]);
    expect(t.messages[0]).toMatchObject({ text: "Show /private/tmp/x/Research vehicle", createdAt: "2026-10-24T12:56:00.000Z" });
    expect(t.turnItems[0]).toMatchObject({ startedAt: "2026-10-24T12:56:01.000Z", completedAt: null });
    // Asset bytes and the input are untouched; rail ages relative to `now` are the fixture's.
    expect(out.assets[0]!.dataBase64).toBe(b.assets[0]!.dataBase64);
    expect(b.projects[0]!.workspaceRoot).toBe("{workspaceRoot}");
    expect(now - Date.parse(t.updatedAt)).toBe(Date.parse(FIXTURE_CLOCK) - Date.parse("2026-10-24T11:56:20.000Z"));
    expect(bundleThreadIds(out)).toEqual(["rw-01-old", "rw-01-new"]);
  });

  it("puts in the sim's complete run for {runId:<sim>} (B14), and refuses a sim without one", () => {
    const b = structuredClone(sampleBundle());
    const result = { sim: "higher_altitude", run_id: runIdTemplate("higher_altitude") };
    b.projects[0]!.threads[1]!.turnItems[0]!["output"] = { result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } };
    const runIds = completeRunIds([
      { sim: "higher_altitude", status: "complete", run_id: "old", superseded_by: "new" },
      { sim: "higher_altitude", status: "complete", run_id: "new", superseded_by: null },
      { sim: "higher_altitude", status: "complete", run_id: "later" },
      { sim: "fin_revision", status: "outdated", run_id: "f" },
      { sim: "recovery", status: "not_run", run_id: null },
    ]);
    expect(runIds).toEqual({ higher_altitude: "new" });
    const out = instantiateBundle(b, { workspaceRoot: "/w", projectName: "P", runIds });
    expect(out.projects[0]!.threads[1]!.turnItems[0]!["output"]).toEqual({ result: { content: [{ type: "text", text: JSON.stringify({ sim: "higher_altitude", run_id: "new" }) }], structuredContent: { sim: "higher_altitude", run_id: "new" } } });
    expect(() => instantiateBundle(b, { workspaceRoot: "/w", projectName: "P" })).toThrow(/run of higher_altitude/);
    // Bundles without the template need no runs.
    expect(() => instantiateBundle(sampleBundle(), { workspaceRoot: "/w", projectName: "P" })).not.toThrow();
  });

  it("checks the V1 shape", () => {
    const fix = (f: (b: ThreadBundle) => void): unknown => {
      const b = structuredClone(sampleBundle());
      b.assets[0]!.sha256 = "a".repeat(64);
      f(b);
      return b;
    };
    expect(() => parseThreadBundle(fix(() => undefined))).not.toThrow();
    expect(() => parseThreadBundle(fix((b) => ((b as { version: number }).version = 2)))).toThrow(BundleError);
    expect(() => parseThreadBundle(fix((b) => (b.projects[0]!.threads[1]!.sourceThreadId = "rw-01-old")))).toThrow(/repeated/);
    expect(() => parseThreadBundle(fix((b) => (b.projects[0]!.threads[0]!.appData = "x".repeat(1025))))).toThrow(/appData/);
    expect(() => parseThreadBundle(fix((b) => (b.projects[0]!.threads[0]!.updatedAt = "yesterday")))).toThrow(/updatedAt/);
    // Lecturn pin8 (FIXM): the source's modes and model, optional and checked when present.
    const t0 = (b: ThreadBundle) => b.projects[0]!.threads[0]!;
    expect(() => parseThreadBundle(fix((b) => Object.assign(t0(b), { runtimeMode: "approval-required", interactionMode: "plan", modelSelection: { instanceId: "codex", model: "gpt-5" } })))).not.toThrow();
    expect(() => parseThreadBundle(fix((b) => Object.assign(t0(b), { runtimeMode: "supervised" })))).toThrow(/runtimeMode/);
    expect(() => parseThreadBundle(fix((b) => Object.assign(t0(b), { interactionMode: "chat" })))).toThrow(/interactionMode/);
    expect(() => parseThreadBundle(fix((b) => Object.assign(t0(b), { modelSelection: { model: "gpt-5" } })))).toThrow(/modelSelection/);
    expect(() => parseThreadBundle(fix((b) => (b.assets[0]!.byteLength = 1)))).toThrow(/byteLength/);
    expect(() => parseThreadBundle(fix((b) => (b.assets[0]!.sourceAttachmentId = "a/b")))).toThrow(/asset id/);
  });
});

describe("thread step links (CPW1R3B: the pane strip's thread history for imported threads)", () => {
  const row = (toolName: string, structuredContent: unknown, extra: Record<string, unknown> = {}) => ({
    id: `i-${toolName}-${JSON.stringify(structuredContent)}`,
    type: "dynamic_tool",
    status: "completed",
    toolName,
    output: { result: { content: [], structuredContent } },
    ...extra,
  });

  it("names the steps of completed RocketWright tool rows (MutationOut step ids and step cards)", () => {
    const t = {
      turnItems: [
        row("mcp__lecturn__rw_model_patch", { step: "step:3" }),
        row("mcp__lecturn__rw_model_patch", { step: "step:3" }),
        row("mcp__lecturn__rw_model_patch", { step: "2", dry_run: false }),
        row("rw_history_show", { step: "rw:step/5" }),
        row("mcp__lecturn__rw_model_patch", { step: "step:7" }, { status: "running" }),
        row("mcp__other__model_patch", { step: "step:8" }),
        row("mcp__lecturn__rw_model_patch", { step: "step:9" }, { output: { result: { isError: true, structuredContent: { step: "step:9" } } } }),
        row("mcp__lecturn__rw_run_list", {}),
        { id: "m", type: "assistant_message", text: "rw:step/6" },
      ],
    } as unknown as Pick<BundleThread, "turnItems">;
    expect(threadStepLinks(t)).toEqual([2, 3, 5]);
  });

  it("names history_show's step object by its seq (CPW1R3A: the step card's tool row, also as the scripted provider's lecturn.rw_ row), and nothing for a malformed one", () => {
    const sha = "a".repeat(40);
    const t = {
      turnItems: [
        row("mcp__lecturn__rw_history_show", { step: { seq: 4, id: sha, ts: "2026-10-25T00:00:00Z", origin: "agent", tool: "model_patch" }, diff: {} }),
        row("lecturn.rw_history_show", { step: { seq: 9, id: sha } }),
        row("rw_history_show", { step: { seq: 0, id: sha } }),
        row("rw_history_show", { step: { seq: "x", id: sha } }),
        row("rw_history_show", { step: { id: sha } }),
        row("rw_history_show", { step: { seq: { seq: 6 } } }),
        row("mcp__lecturn__rw_model_patch", { step: "step:2" }),
      ],
    } as unknown as Pick<BundleThread, "turnItems">;
    expect(threadStepLinks(t)).toEqual([2, 4, 9]);
  });

  it("reads a live row's output: the CallToolResult itself, or a card tool's envelope (CPW1R4A: bundles carry live rows)", () => {
    const meta = { "lecturn/summary": "Step 3" };
    const live = (toolName: string, output: unknown) => ({ id: `l-${JSON.stringify(output)}`, type: "dynamic_tool", status: "completed", toolName, output });
    const t = {
      turnItems: [
        live("lecturn.rw_model_patch", { content: [], structuredContent: { step: "step:3" }, _meta: meta }),
        live("lecturn.rw_history_show", { content: [], _meta: meta, structuredContent: { lecturnMcpApp: { attachmentId: "a-html", server: "lecturn", tool: "rw_history_show", resourceUri: "ui://rw/step-card" }, result: { content: [], structuredContent: { step: { seq: 4 } } } } }),
        live("lecturn.rw_model_patch", { content: [], isError: true, structuredContent: { step: "step:5" }, _meta: meta }),
        live("lecturn.rw_model_patch", { content: [], _meta: meta, structuredContent: { lecturnMcpApp: { attachmentId: "b-html" }, result: { content: [], isError: true, structuredContent: { step: "step:6" } } } }),
        live("lecturn.rw_run_list", { content: [], structuredContent: { runs: [] }, _meta: meta }),
      ],
    } as unknown as Pick<BundleThread, "turnItems">;
    expect(threadStepLinks(t)).toEqual([3, 4]);
  });

  it("writes the links next to the page binding, leaving threads without links and the input as they are", () => {
    const b = structuredClone(sampleBundle());
    b.projects[0]!.threads[1]!.turnItems = [row("mcp__lecturn__rw_model_patch", { step: "step:3" }) as never];
    const linked = linkThreadSteps(b);
    expect(linked.projects[0]!.threads.map((t) => t.appData)).toEqual(['{"page":"assembly"}', '{"page":"assembly","steps":[3]}']);
    expect(b.projects[0]!.threads[1]!.appData).toBe('{"page":"assembly"}');
    const noData = structuredClone(b);
    noData.projects[0]!.threads[1]!.appData = null;
    expect(linkThreadSteps(noData).projects[0]!.threads[1]!.appData).toBe('{"steps":[3]}');
    const notJson = structuredClone(b);
    notJson.projects[0]!.threads[1]!.appData = "plain";
    expect(linkThreadSteps(notJson).projects[0]!.threads[1]!.appData).toBe("plain");
  });

  it("links the committed page bundles' step cards (02 Fin revision → 03; 05 Feed system review → 04, the current step since CPW1R3A)", () => {
    const committed = (page: string): ThreadBundle => parseThreadBundle(JSON.parse(readFileSync(new URL(`../../../../tests/fixtures/lecturn/${page}.bundle.json`, import.meta.url), "utf8")));
    const links = (page: string) => Object.fromEntries(linkThreadSteps(committed(page)).projects[0]!.threads.map((t) => [t.title, JSON.parse(t.appData ?? "null")]));
    expect(links("02")).toEqual({
      "Flight comparison": { page: "components" },
      "Assembly review": { page: "components", steps: [2] },
      "Fin revision": { page: "components", steps: [3] },
    });
    expect(links("05")["Feed system review"]).toEqual({ page: "liquid", steps: [4] });
  });
});

/** A fake Lecturn: the ticket endpoint (bearer `good`) and `/ws` answering Effect RPC requests with `answer`. */
class FakeLecturn {
  readonly server: Server;
  readonly requests: { tag: string; payload: unknown; ticket: string | null }[] = [];
  answer: (tag: string, payload: unknown) => unknown = () => ({ _tag: "Success", value: null });

  constructor() {
    this.server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/auth/websocket-ticket") {
        if (req.headers.authorization !== "Bearer good") {
          res.writeHead(401).end("no");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ticket: "tk-1", expiresAt: "2026-10-24T12:00:00.000Z" }));
        return;
      }
      res.writeHead(404).end();
    });
    this.server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
      const url = new URL(req.url ?? "/", "http://x");
      acceptUpgrade(req, socket, (conn) => ({
        message: (text) => {
          const m = JSON.parse(text) as { _tag: string; id: string; tag: string; payload: unknown };
          if (m._tag !== "Request") return;
          this.requests.push({ tag: m.tag, payload: m.payload, ticket: url.searchParams.get("wsTicket") });
          // Effect RPC may batch: answer as an array frame.
          conn.send(JSON.stringify([{ _tag: "Exit", requestId: m.id, exit: this.answer(m.tag, m.payload) }]));
        },
        close: () => undefined,
      }));
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((ok) => this.server.listen(0, "127.0.0.1", ok));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((ok) => this.server.close(() => ok()));
  }
}

describe("Lecturn WebSocket RPC (appsRpc.ts)", () => {
  const fake = new FakeLecturn();
  let origin = "";
  beforeAll(async () => {
    origin = await fake.listen();
  });
  afterAll(() => fake.close());

  it("trades the bearer for a ticket and answers with the Exit value", async () => {
    fake.answer = (_tag, payload) => ({ _tag: "Success", value: { echoed: payload } });
    expect(await lecturnRpc(origin, "good", "orchestration.getThreadProjection", { threadId: "t1" })).toEqual({ echoed: { threadId: "t1" } });
    expect(fake.requests.at(-1)).toEqual({ tag: "orchestration.getThreadProjection", payload: { threadId: "t1" }, ticket: "tk-1" });
    expect(socketUrl("http://127.0.0.1:5", "tk")).toBe("ws://127.0.0.1:5/ws?orchestrationProtocol=2&wsTicket=tk");
  });

  it("reports a failed call with its error, and a refused bearer", async () => {
    fake.answer = () => ({ _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "AppsError", code: "forbidden", message: "not yours" } }] });
    await expect(lecturnRpc(origin, "good", "apps.importThreads", {})).rejects.toThrow(/apps.importThreads failed: .*not yours/);
    await expect(lecturnRpc(origin, "bad", "apps.importThreads", {})).rejects.toThrow(/refused a socket ticket: 401/);
  });

  it("reads the sidecar's app session and runtime origin from its base dir", () => {
    const base = temp("rw-lb-");
    expect(readSidecarAppSession(base)).toBeNull();
    expect(readServerOrigin(base)).toBeNull();
    mkdirSync(join(base, "userdata"));
    writeFileSync(join(base, "embed-app-session.json"), JSON.stringify({ appId: RW_APP_ID, environmentId: "env-s", accessToken: "good" }));
    writeFileSync(join(base, "userdata", "server-runtime.json"), JSON.stringify({ version: 1, pid: 1, port: 5, origin: "http://127.0.0.1:5", startedAt: "x" }));
    expect(readSidecarAppSession(base)).toEqual({ appId: RW_APP_ID, environmentId: "env-s", accessToken: "good" });
    expect(readServerOrigin(base)).toBe("http://127.0.0.1:5");
  });
});

/** A fake connection that imports: each bundle thread shows up as a copy (`copiedFrom`) in the project's subscription. */
class ImportingConnection extends FakeConnection {
  readonly imports: unknown[] = [];

  async importThreads(bundle: unknown): Promise<ImportResult> {
    this.imports.push(bundle);
    const b = bundle as ThreadBundle;
    for (const p of b.projects) {
      const projectId = this.idFor(p.workspaceRoot);
      for (const t of p.threads) {
        const copy: EmbedThread = thread(projectId, p.workspaceRoot, `copy:${b.sourceEnvironmentId}:${t.sourceThreadId}`, t.updatedAt, {
          title: t.title,
          appData: t.appData,
          copiedFrom: { appId: b.appId, sourceEnvironmentId: b.sourceEnvironmentId, sourceThreadId: t.sourceThreadId, copiedAt: t.updatedAt, sourceHistoryRevision: t.historyRevision },
        });
        setTimeout(() => this.threadListeners.get(projectId)?.({ type: "upsert", thread: copy }), 20);
      }
    }
    return { imported: b.projects.reduce((n, p) => n + p.threads.length, 0), skipped: 0 };
  }
}

const project = (dir: string) => ({ projectId: "research-vehicle", dir, name: "Research vehicle" });

describe("LecturnLink.importThreads and waitForThreads (B13)", () => {
  it("imports through the connection, then names the copies by source thread", async () => {
    const dir = temp("rw-lk-");
    const conn = new ImportingConnection();
    const link = new LecturnLink(connectTo(conn), { status: () => undefined, threads: () => undefined });
    await link.addProject(project(dir));
    // Lecturn knows the project by its realpath (D13), as the app server substitutes it.
    const b = instantiateBundle(sampleBundle(), { workspaceRoot: realpathSync(dir), projectName: "Research vehicle" });
    expect(await link.importThreads("research-vehicle", b)).toEqual({ imported: 2, skipped: 0 });
    expect(await link.waitForThreads("research-vehicle", bundleThreadIds(b), 5_000)).toEqual(["copy:rw-fixtures:rw-01-old", "copy:rw-fixtures:rw-01-new"]);
    await expect(link.waitForThreads("research-vehicle", ["rw-01-missing"], 300)).rejects.toThrow(/rw-01-missing never appeared/);
    await link.close();
  });

  it("without the helper's import, calls apps.importThreads with the sidecar's app session", async () => {
    const lecturn = new FakeLecturn();
    lecturn.answer = (tag) => (tag === "apps.importThreads" ? { _tag: "Success", value: { imported: 2, skipped: 0 } } : { _tag: "Success", value: null });
    const origin = await lecturn.listen();
    try {
      const base = temp("rw-lb-");
      writeFileSync(join(base, "embed-app-session.json"), JSON.stringify({ appId: RW_APP_ID, environmentId: "env-s", accessToken: "good" }));
      const conn = Object.assign(new FakeConnection(), { origin });
      const link = new LecturnLink(connectTo(conn), { status: () => undefined, threads: () => undefined }, { baseDir: base });
      await link.addProject(project(temp("rw-lk-")));
      expect(await link.importThreads("research-vehicle", { version: 1 })).toEqual({ imported: 2, skipped: 0 });
      expect(lecturn.requests).toEqual([{ tag: "apps.importThreads", payload: { bundle: { version: 1 } }, ticket: "tk-1" }]);
      // A user server's app credential is not reachable this way.
      conn.mode = "user-server";
      await expect(link.importThreads("research-vehicle", {})).rejects.toThrow(LecturnUnavailable);
      await link.close();
    } finally {
      await lecturn.close();
    }
  });
});

describe("app_seed_thread {bundle} through the test hooks (B13)", () => {
  const conn = new ImportingConnection();
  const validator = makeValidator();
  let server: AppServer;
  let c: TestClient;
  let base: string;

  beforeAll(async () => {
    base = mkdtempSync("/tmp/rwsb-");
    mkdirSync(join(base, "Research vehicle"));
    server = await AppServer.start({
      bin: sidecarBin(),
      stderr: "ignore",
      testHooks: true,
      log: () => undefined,
      lecturn: (events) => new LecturnLink(connectTo(conn), events),
    });
    c = await TestClient.connect(server.rpcUrl, validator);
  }, 600_000);

  afterAll(async () => {
    c?.close();
    await server?.close();
    if (base !== undefined) rmSync(base, { recursive: true, force: true });
  });

  it("imports the bundle for the project's realpath and name, and answers with the copies in bundle order", async () => {
    const { project: p } = await c.call("project.open", { dir: join(base, "Research vehicle") });
    const raw = sampleBundle();
    raw.assets[0]!.sha256 = "b".repeat(64);
    const r = await c.call("test.call", { projectId: p.projectId, op: "app_seed_thread", args: { bundle: raw as never, now: Date.parse(FIXTURE_CLOCK) } });
    expect(r).toEqual({ threadId: "copy:rw-fixtures:rw-01-new", threadIds: ["copy:rw-fixtures:rw-01-old", "copy:rw-fixtures:rw-01-new"] });
    const imported = conn.imports.at(-1) as ThreadBundle;
    // The project's realpath (`/tmp` is `/private/tmp` on macOS) and its name.
    expect(server.lecturn!.projectForWorkspaceRoot(imported.projects[0]!.workspaceRoot)).toBe(p.projectId);
    expect(imported.projects[0]!.workspaceRoot).not.toContain("{");
    expect(imported.projects[0]!.title).toBe("Research vehicle");
    expect(imported.projects[0]!.threads[1]!.updatedAt).toBe("2026-10-24T11:56:20.000Z");
  });

  it("refuses a malformed bundle or another app's bundle as invalid arguments", async () => {
    const projectId = server.listProjects()[0]!.projectId;
    const bad = sampleBundle();
    await expect(c.call("test.call", { projectId, op: "app_seed_thread", args: { bundle: { version: 2 } as never } })).rejects.toMatchObject({ message: expect.stringMatching(/invalid_args: app_seed_thread: thread bundle: version/) });
    bad.assets[0]!.sha256 = "c".repeat(64);
    bad.appId = "dev.other.app";
    await expect(c.call("test.call", { projectId, op: "app_seed_thread", args: { bundle: bad as never } })).rejects.toMatchObject({ message: expect.stringMatching(/belongs to dev.other.app/) });
  });
});
