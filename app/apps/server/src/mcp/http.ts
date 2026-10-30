/**
 * The app server's MCP route for Lecturn's live tier, `/mcp/live` (B9, D20):
 * what Lecturn calls with `setLiveTools({url, bearer})`. It lists only the
 * `ViewportBroker` tools (`viewport_*`, `plot_render`; `app_*` only with
 * `RW_TEST_HOOKS=1`) and serves the `ui://rw/render-card` resource the render
 * tools declare. MCP v2 (`createMcpHandler`, one low-level `Server` per
 * request), bound to 127.0.0.1, with localhost Host/Origin guards (DNS
 * rebinding) and one static per-launch bearer (`LiveToolsBearer`); each call
 * is routed by `realpath(_meta["lecturn/context"].workspaceRoot)`.
 *
 * B17 removed the old chat's thread-scoped `/mcp` route (the sidecar tools
 * proxied with its approval check): Lecturn reaches the CLI tools through
 * `rocketwright mcp` and decides approvals with the CLI (D6).
 *
 * Ported from Lecturn (MIT) apps/server/src/mcp/McpHttpServer.ts (design
 * only; rewritten in plain TS on the MCP v2 SDK).
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { ResourceNotFoundError, Server, createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
  type NodeIncomingMessageLike,
} from "@modelcontextprotocol/node";
import { RENDER_CARD_URI, brokerToolResult, lecturnContextOf, type ViewportBroker } from "../broker/ViewportBroker.ts";
import type { SidecarLike } from "../sidecar/SidecarClient.ts";
import { bearerToken, type LiveToolsBearer } from "./session-registry.ts";

/** The live tools route published to Lecturn (B9). */
export const LIVE_MCP_PATH = "/mcp/live";

type CallResult = Awaited<ReturnType<SidecarLike["callTool"]>>;

function toolError(code: string, message: string): CallResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    _meta: { "rw/error": { code, message } },
  };
}

/** The 401 the route answers without a valid bearer. */
export function unauthorized(res: ServerResponse, message: string): void {
  res
    .writeHead(401, { "content-type": "application/json", "cache-control": "no-store", "www-authenticate": "Bearer" })
    .end(JSON.stringify({ error: "invalid_mcp_credential", message }));
}

// ---- the live route (B9) ----------------------------------------------------------

/** The MCP Apps card mime type (Lecturn accepts only this exact string; the CLI's `UI_MIME`). */
export const UI_MIME = "text/html;profile=mcp-app";
/** The card's source, shared with the CLI (`crates/rw-cli/src/mcp/cards/`; this file is `app/apps/server/src/mcp/`). */
export const RENDER_CARD_PATH = resolve(import.meta.dirname, "../../../../../crates/rw-cli/src/mcp/cards/render-card.html");

let renderCardCache: string | undefined;
/** `ui://rw/render-card`'s HTML (read once). */
export function renderCardHtml(): string {
  renderCardCache ??= readFileSync(RENDER_CARD_PATH, "utf8");
  return renderCardCache;
}

export interface LiveMcpDeps {
  broker: ViewportBroker;
  bearer: LiveToolsBearer;
  /** The open RocketWright project whose directory's realpath is `workspaceRoot`. */
  projectOf(workspaceRoot: string): string | undefined;
  /** The render card's HTML (default `renderCardHtml`). */
  renderCard?: () => string;
}

const RENDER_CARD_RESOURCE = {
  uri: RENDER_CARD_URI,
  name: "render-card",
  description: "A live viewport capture or Results plot: the picture from the result's image content and its caption.",
  mimeType: UI_MIME,
};

function buildLiveServer(deps: LiveMcpDeps): Server {
  const server = new Server({ name: "rocketwright-live", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });

  server.setRequestHandler("tools/list", async () => ({ tools: deps.broker.tools() }));

  server.setRequestHandler("tools/call", async (req) => {
    const { name } = req.params;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (!deps.broker.serves(name)) return toolError("not_found", `no tool named ${name}`);
    const context = lecturnContextOf(req.params._meta as Record<string, unknown> | undefined);
    if (context === undefined) return toolError("invalid_args", `${name} needs _meta["lecturn/context"].workspaceRoot`);
    const r = await deps.broker.requestForWorkspace(context, name, args as never, deps.projectOf);
    return brokerToolResult(name, r, args) as CallResult;
  });

  server.setRequestHandler("resources/list", async () => ({ resources: [RENDER_CARD_RESOURCE] }));

  server.setRequestHandler("resources/read", async (req) => {
    const { uri } = req.params;
    if (uri !== RENDER_CARD_URI) throw new ResourceNotFoundError(uri, `unknown resource \`${uri}\``);
    return {
      contents: [
        {
          uri,
          mimeType: UI_MIME,
          text: (deps.renderCard ?? renderCardHtml)(),
          // As the CLI serves its cards: no network, a host border.
          _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } },
        },
      ],
    };
  });

  return server;
}

/** The Node request handler for `/mcp/live` (guards → the static bearer → MCP). */
export function createLiveMcpRequestHandler(deps: LiveMcpDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const node = toNodeHandler(createMcpHandler(() => buildLiveServer(deps)));
  const validHost = localhostHostValidation();
  const validOrigin = localhostOriginValidation();

  return (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== LIVE_MCP_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (!validHost(req, res) || !validOrigin(req, res)) return;
    const token = bearerToken(req.headers.authorization);
    if (!deps.bearer.verify(token)) {
      unauthorized(res, "A valid RocketWright live-tools bearer token is required.");
      return;
    }
    const auth: AuthInfo = { token, clientId: "lecturn", scopes: [] };
    (req as IncomingMessage & { auth?: AuthInfo }).auth = auth;
    void node(req as unknown as NodeIncomingMessageLike, res);
  };
}
