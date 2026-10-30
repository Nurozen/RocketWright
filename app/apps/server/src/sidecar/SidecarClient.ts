/**
 * MCP v2 stdio client for the `rocketwright mcp --project <dir> --app` sidecar
 * (R6.1: the sidecar is the only writer). The app HTTP MCP re-exposes the
 * sidecar's tools verbatim (R6.11) and forwards every call here with the
 * thread context in `_meta`.
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";

/** A tool exactly as the sidecar lists it (schemas, annotations, `_meta`). */
export type SidecarTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
export type SidecarCallResult = Awaited<ReturnType<Client["callTool"]>>;

/** `_meta` keys the sidecar maps to its `CallCtx` (`crates/rw-cli/src/mcp/meta.rs`). */
export const META_THREAD = "rw/thread";
export const META_TOOL_CALL = "rw/tool_call";
export const META_LABEL = "rw/label";
/** Tool `_meta`: approval policy, `never | conditional | always` (I16). */
export const META_APPROVAL = "rw/approval";
/** Tool `_meta`: `always_ask` on gated tools (I16). */
export const META_PERMISSION_POLICY = "rw/permission_policy";
/**
 * Sent by the sidecar's relay front after it reconnected to a new project
 * owner or promoted itself (D4, B1b): state read before may be stale.
 */
export const UPSTREAM_CHANGED = "notifications/rw/upstream-changed";
const upstreamChangedParams = z.looseObject({ role: z.string().optional() }).optional();

/** The child's environment: the parent's, minus `ELECTRON_RUN_AS_NODE` (`env -u`, so an Electron parent never leaks node mode). */
export function sidecarEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** `rocketwright` binary: explicit, then `$RW_SIDECAR_BIN`, then `rocketwright` on PATH. */
export function sidecarBinary(bin?: string): string {
  return bin ?? (process.env.RW_SIDECAR_BIN || "rocketwright");
}

export interface SidecarStartOptions {
  projectDir: string;
  /** `rocketwright` binary; defaults to `$RW_SIDECAR_BIN`, then `rocketwright` on PATH. */
  bin?: string;
  /** Pass `--app` (the app-hosted mode). Default true. */
  app?: boolean;
  stderr?: "inherit" | "ignore" | "pipe";
}

/** Narrow surface the HTTP MCP proxy needs (lets tests wrap or count calls). */
export interface SidecarLike {
  listTools(): Promise<SidecarTool[]>;
  callTool(name: string, args: Record<string, unknown>, meta: Record<string, unknown>): Promise<SidecarCallResult>;
}

export class SidecarClient implements SidecarLike {
  private client: Client | undefined;
  private tools: SidecarTool[] | undefined;
  private transport: StdioClientTransport | undefined;
  private stopping = false;
  private readonly updateListeners = new Set<(uri: string) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly upstreamListeners = new Set<() => void>();

  /** Spawns the sidecar and completes the MCP handshake. */
  async start(opts: SidecarStartOptions): Promise<void> {
    if (this.client !== undefined) throw new Error("sidecar already started");
    const bin = sidecarBinary(opts.bin);
    const env = sidecarEnv();
    const args = ["mcp", "--project", opts.projectDir];
    if (opts.app ?? true) args.push("--app");
    const transport = new StdioClientTransport({ command: bin, args, env, stderr: opts.stderr ?? "inherit" });
    const client = new Client({ name: "rocketwright-app", version: "0.1.0" }, { capabilities: {} });
    client.setNotificationHandler("notifications/resources/updated", (n) => {
      for (const l of this.updateListeners) l(n.params.uri);
    });
    client.setNotificationHandler(UPSTREAM_CHANGED, { params: upstreamChangedParams }, () => {
      for (const l of this.upstreamListeners) l();
    });
    client.onclose = () => {
      const unexpected = !this.stopping && this.client === client;
      this.client = undefined;
      this.transport = undefined;
      this.tools = undefined;
      if (unexpected) for (const l of this.closeListeners) l();
    };
    this.stopping = false;
    await client.connect(transport);
    this.client = client;
    this.transport = transport;
  }

  /** True between a successful `start()` and the connection closing. */
  get connected(): boolean {
    return this.client !== undefined;
  }

  /** The child's pid (tests kill it to exercise restarts). */
  pid(): number | null {
    return this.transport?.pid ?? null;
  }

  /** `serverInfo` from the handshake. */
  serverVersion(): { name: string; version: string } | undefined {
    return this.client?.getServerVersion();
  }

  /** Called when the sidecar goes away without `stop()` (crash, kill, EOF); returns an unsubscribe. */
  onClose(cb: () => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  private get c(): Client {
    if (this.client === undefined) throw new Error("sidecar not started");
    return this.client;
  }

  /** The sidecar's tools, cached after the first listing (the registry is static per binary). */
  async listTools(): Promise<SidecarTool[]> {
    if (this.tools !== undefined) return this.tools;
    const out: SidecarTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.c.listTools(cursor === undefined ? undefined : { cursor });
      out.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    this.tools = out;
    return out;
  }

  callTool(name: string, args: Record<string, unknown>, meta: Record<string, unknown>): Promise<SidecarCallResult> {
    return this.c.callTool({ name, arguments: args, _meta: meta });
  }

  subscribe(uri: string): Promise<unknown> {
    return this.c.subscribeResource({ uri });
  }

  unsubscribe(uri: string): Promise<unknown> {
    return this.c.unsubscribeResource({ uri });
  }

  /** Reads a JSON resource, always from the sidecar (the client cache is bypassed: the mirror must be fresh). */
  async readJson(uri: string): Promise<unknown> {
    const r = await this.c.readResource({ uri }, { cacheMode: "bypass" });
    const first = r.contents[0];
    if (first === undefined || !("text" in first)) throw new Error(`${uri}: no text contents`);
    return JSON.parse(first.text) as unknown;
  }

  /** `notifications/resources/updated` from the sidecar; returns an unsubscribe. */
  onResourceUpdated(cb: (uri: string) => void): () => void {
    this.updateListeners.add(cb);
    return () => this.updateListeners.delete(cb);
  }

  /** `notifications/rw/upstream-changed` from the sidecar's relay front; returns an unsubscribe. */
  onUpstreamChanged(cb: () => void): () => void {
    this.upstreamListeners.add(cb);
    return () => this.upstreamListeners.delete(cb);
  }

  negotiatedProtocolVersion(): string | undefined {
    return this.c.getNegotiatedProtocolVersion();
  }

  async stop(): Promise<void> {
    const c = this.client;
    this.stopping = true;
    this.client = undefined;
    this.transport = undefined;
    this.tools = undefined;
    if (c !== undefined) await c.close();
  }
}
