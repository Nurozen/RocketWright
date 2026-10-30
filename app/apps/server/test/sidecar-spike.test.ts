/**
 * M1.8 spike: `pnpm --filter server test sidecar-spike`.
 *
 * The app's MCP v2 client (`@modelcontextprotocol/client`, R6.1) talks to the
 * Rust sidecar `rocketwright mcp --project <dir>` over stdio: protocol pinned
 * to 2025-11-25, the registry's tools with their schemas, a contract-fixture
 * double round trip with `_meta`, resources, `resources/subscribe` →
 * `notifications/resources/updated`, and CLI forwarding over
 * `.rw/sidecar.sock` (D4) notifying the stdio client.
 *
 * The sidecar is built with the `doubles` feature (test-only bodies). Set
 * `RW_SIDECAR_BIN` to use a prebuilt binary instead.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { APP_ONLY_TOOLS } from "./helpers/harness.ts";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObj = { [k: string]: Json };
/** The JSON-RPC message shape the client's `Transport` exchanges. */
type Message = Parameters<StdioClientTransport["send"]>[0];

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const PINNED = "2025-11-25";

function cargo(): string {
  const local = join(homedir(), ".cargo/bin/cargo");
  return existsSync(local) ? local : "cargo";
}

/** Builds `rocketwright` with doubles and returns its path. */
function sidecarBin(): string {
  const prebuilt = process.env.RW_SIDECAR_BIN;
  if (prebuilt !== undefined && prebuilt !== "") return prebuilt;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(cargo(), ["build", "-q", "-p", "rw-cli", "--features", "doubles", "--bin", "rocketwright"], {
    cwd: REPO,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const meta = JSON.parse(
    execFileSync(cargo(), ["metadata", "--no-deps", "--format-version", "1"], { cwd: REPO, env, encoding: "utf8" }),
  ) as { target_directory: string };
  return join(meta.target_directory, "debug", "rocketwright");
}

function readJson(rel: string): JsonObj {
  return JSON.parse(readFileSync(join(REPO, rel), "utf8")) as JsonObj;
}

function fixture(rel: string): JsonObj {
  return readJson(`fixtures/contracts/${rel}`).payload as JsonObj;
}

/** Newline-delimited JSON-RPC over `.rw/sidecar.sock` (what `rw` forwarding speaks). */
class SocketTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: Message) => void;
  private socket?: Socket;
  private buffer = "";

  constructor(private readonly path: string) {}

  start(): Promise<void> {
    return new Promise((ok, fail) => {
      const s = connect(this.path, () => ok());
      s.setEncoding("utf8");
      s.on("error", (e) => {
        this.onerror?.(e);
        fail(e);
      });
      s.on("close", () => this.onclose?.());
      s.on("data", (chunk: string) => {
        this.buffer += chunk;
        let nl = this.buffer.indexOf("\n");
        while (nl >= 0) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (line !== "") this.onmessage?.(JSON.parse(line) as Message);
          nl = this.buffer.indexOf("\n");
        }
      });
      this.socket = s;
    });
  }

  send(message: Message): Promise<void> {
    return new Promise((ok, fail) => this.socket?.write(`${JSON.stringify(message)}\n`, (e) => (e ? fail(e) : ok())));
  }

  close(): Promise<void> {
    this.socket?.end();
    return Promise.resolve();
  }
}

/** Resolves with the next `resources/updated` URI from `client`. */
function nextUpdate(client: Client, timeoutMs = 10_000): Promise<string> {
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("no notifications/resources/updated")), timeoutMs);
    client.setNotificationHandler("notifications/resources/updated", (n) => {
      clearTimeout(timer);
      ok(n.params.uri);
    });
  });
}

describe("sidecar spike (M1.8)", () => {
  let bin = "";
  let project = "";
  const index = readJson("schema/index.json") as { tools: { name: string }[]; resources: { uri: string }[] };

  beforeAll(() => {
    bin = sidecarBin();
    // Short path: Unix socket paths are limited to ~104 bytes on macOS.
    project = mkdtempSync("/tmp/rwts-");
  }, 600_000);

  afterAll(() => {
    if (project !== "") rmSync(project, { recursive: true, force: true });
  });

  it("round-trips tools, _meta, resources, subscriptions, and socket forwarding", async () => {
    const transport = new StdioClientTransport({ command: bin, args: ["mcp", "--project", project], stderr: "inherit" });
    const app = new Client({ name: "rw-app-spike", version: "0.0.0" }, { capabilities: {} });
    await app.connect(transport);
    try {
      expect(app.getNegotiatedProtocolVersion()).toBe(PINNED);
      expect(app.getServerVersion()?.name).toBe("rocketwright");

      // Tools: exactly the registry, then the app-only tools (B3), with object input roots.
      const { tools } = await app.listTools();
      expect(tools.map((t) => t.name)).toEqual([...index.tools.map((t) => t.name), ...APP_ONLY_TOOLS]);
      for (const t of tools) {
        expect(t.inputSchema.type, t.name).toBe("object");
        expect(t.outputSchema?.type, t.name).toBe("object");
      }
      const gated = tools.find((t) => t.name === "import_file");
      expect(gated?._meta?.["rw/permission_policy"]).toBe("always_ask");

      // A double round trip carrying _meta (rw/thread etc. → CallCtx).
      const got = await app.callTool({
        name: "model_get",
        arguments: fixture("tools/model_get.input.json"),
        _meta: { "rw/thread": "thread-1", "rw/tool_call": "toolu_1", "rw/label": "Read model" },
      });
      expect(got.isError ?? false).toBe(false);
      expect(got.structuredContent).toEqual(fixture("tools/model_get.output.json"));
      expect(got._meta?.["rw/ctx"]).toEqual({
        origin: "mcp",
        thread: "thread-1",
        tool_call: "toolu_1",
        label: "Read model",
      });

      // A gated tool answers like any other (its double here; M2.6 landed its body).
      const gatedCall = await app.callTool({ name: "export_file", arguments: fixture("tools/export_file.input.json") });
      expect(gatedCall.isError ?? false).toBe(false);
      expect(gatedCall.structuredContent).toEqual(fixture("tools/export_file.output.json"));

      // Resources.
      const { resources } = await app.listResources();
      // The registry's resources plus the ui://rw/* MCP Apps cards (B3).
      expect(resources.filter((r) => r.uri.startsWith("ui://")).map((r) => r.uri).sort()).toEqual(["ui://rw/render-card", "ui://rw/run-card", "ui://rw/step-card"]);
      expect(resources.filter((r) => !r.uri.startsWith("ui://")).map((r) => r.uri).sort()).toEqual(
        index.resources.map((r) => r.uri).filter((u) => !u.includes("{")).sort(),
      );
      const model = await app.readResource({ uri: "rw://project/model" });
      const first = model.contents[0];
      expect(first?.mimeType).toBe("application/json");
      const text = first !== undefined && "text" in first ? first.text : "{}";
      expect((JSON.parse(text) as JsonObj).schema).toBe("rw/1");

      // resources/subscribe → notifications/resources/updated after a write.
      await app.subscribeResource({ uri: "rw://project/model" });
      const wet = { ...fixture("tools/model_patch.input.json"), dry_run: false };
      const updated = nextUpdate(app);
      await app.callTool({ name: "model_patch", arguments: wet });
      expect(await updated).toBe("rw://project/model");

      // CLI forwarding over .rw/sidecar.sock (origin=cli) notifies the app.
      const cli = new Client({ name: "rw-cli-forward", version: "0.0.0" }, { capabilities: {} });
      await cli.connect(new SocketTransport(join(project, ".rw/sidecar.sock")));
      try {
        expect(cli.getNegotiatedProtocolVersion()).toBe(PINNED);
        const forwarded = nextUpdate(app);
        const r = await cli.callTool({ name: "model_patch", arguments: wet, _meta: { "rw/origin": "cli" } });
        expect((r._meta?.["rw/ctx"] as JsonObj | undefined)?.origin).toBe("cli");
        expect(r.structuredContent).toEqual(fixture("tools/model_patch.output.json"));
        expect(await forwarded).toBe("rw://project/model");
      } finally {
        await cli.close();
      }
    } finally {
      await app.close();
    }
  }, 60_000);
});
