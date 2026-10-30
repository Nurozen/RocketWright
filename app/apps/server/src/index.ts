/** App server: ProjectHost per project, WebSocket RPC, the live tools route Lecturn calls, and the Lecturn connection. */
export const PACKAGE_NAME = "@rw/server";

export {
  BROKER_TOOLS,
  META_LECTURN_CONTEXT,
  PROJECT_NOT_OPEN,
  RENDER_CARD_URI,
  ViewportBroker,
  brokerToolResult,
  lecturnContextOf,
  testHooksFromEnv,
  type BrokerHost,
  type LecturnCallContext,
} from "./broker/ViewportBroker.ts";
export {
  LecturnLink,
  LecturnUnavailable,
  createLecturnLink,
  lecturnConnectOptions,
  lecturnServerEntry,
  workspaceRootOf,
  type LecturnConnectionLike,
  type LecturnLinkEvents,
  type LiveTools,
} from "./lecturn/connection.ts";
export { RW_APP_ID, RW_LECTURN_INSTRUCTIONS, rocketwrightRegistration, type AppRegistration } from "./lecturn/registration.ts";
export { LIVE_MCP_PATH, createLiveMcpRequestHandler, renderCardHtml, type LiveMcpDeps } from "./mcp/http.ts";
export { LiveToolsBearer, bearerToken } from "./mcp/session-registry.ts";
export { SidecarClient, sidecarBinary, sidecarEnv, type SidecarLike, type SidecarTool } from "./sidecar/SidecarClient.ts";
export { SidecarSupervisor, SidecarUnavailable, backoffDelay, type BackoffOptions, type SidecarConnection } from "./sidecar/SidecarSupervisor.ts";
export { ProjectHost, UI_THREAD, type ProjectHostOptions } from "./project/ProjectHost.ts";
export { MIRROR_RESOURCES, mirrorKeysFor } from "./project/mirror.ts";
export { AppServer, probeCoreVersion, type AppServerOptions } from "./rpc/AppServer.ts";
export { RpcFail } from "./rpc/errors.ts";
