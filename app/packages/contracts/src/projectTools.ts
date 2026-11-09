/**
 * The agent's project tools (R1.3): `project_new` and `project_open` on the
 * live MCP route, and the consent exchange they run with Electron main over
 * the role-bound host channel (`host.request` / `host.respond`, D11). They are
 * not broker ops: no viewport host answers them and the broker's 10 s timeout
 * would kill a waiting dialog, so `PROJECT_TOOLS` is separate from `AGENT_OPS`.
 */
import type { ProjectTool } from "./broker.ts";
import type { ProjectInfo } from "./rpc.ts";

/** `rw init --template` names. */
export const PROJECT_TEMPLATES = ["empty", "minimal", "simple-rocket", "sample"] as const;
export type ProjectTemplate = (typeof PROJECT_TEMPLATES)[number];

/** Display unit per dimension name (`[display_units]`, e.g. `length = "mm"`). */
export type DisplayUnits = Record<string, string>;

/** D13: `request` longer than this is refused, never truncated (native dialogs promise no scrolling). */
export const PROJECT_TOOL_REQUEST_MAX = 2000;

export interface ProjectNewArgs {
  /** One safe path segment: the project's name and its folder's. */
  name: string;
  /** The parent folder; absolute or `~`-expanded (default: `project.defaults`). */
  location?: string;
  template?: ProjectTemplate;
  /** The remaining work, for the new thread (shown in full in the dialog). */
  request?: string;
}

export interface ProjectOpenArgs {
  /** The project's folder; absolute or `~`-expanded. */
  path: string;
  request?: string;
}

/** Tool → arguments. */
export interface ProjectToolArgs {
  project_new: ProjectNewArgs;
  project_open: ProjectOpenArgs;
}

/** What an accepted project tool returns to the agent. */
export interface ProjectToolResult {
  project: ProjectInfo;
  /** The new thread, or null when the project opened but no thread started. */
  threadId: string | null;
}

/** `host.request`: Electron main shows one native consent dialog. */
export interface HostRequest {
  requestId: string;
  tool: ProjectTool;
  /** The folder the action targets, absolute. */
  path: string;
  /** `project_new` only. */
  name?: string;
  template?: ProjectTemplate;
  /** The agent's `request`, verbatim after D13's stripping. */
  request?: string;
}

/** `host.respond`: the user's answer. `displayUnits` is the default-units preference, on an accepted `project_new` (U59). */
export interface HostResponse {
  requestId: string;
  accepted: boolean;
  displayUnits?: DisplayUnits;
}

/** `host.show`: Electron main brings a project (and optionally a thread) to the front. */
export interface HostShow {
  projectId: string;
  threadId?: string;
}
