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
/** The same for line count: blank lines would otherwise push the rest of the request out of the dialog. */
export const PROJECT_TOOL_REQUEST_MAX_LINES = 40;

/**
 * Code points that change what a dialog shows without being shown themselves:
 * controls, text-direction marks, and everything Unicode calls default-ignorable
 * (zero-width characters, variation selectors, tag characters).
 */
const DIALOG_INVISIBLE = String.raw`\p{Bidi_Control}|\p{Default_Ignorable_Code_Point}|[\u2028\u2029]`;
/** Refused in a name or path: anything here could make the path on screen differ from the path acted on. */
export const DIALOG_UNSAFE_NAME = new RegExp(String.raw`\p{Cc}|${DIALOG_INVISIBLE}`, "u");
/** Refused or stripped in `request`, where a newline is real content. */
export const DIALOG_UNSAFE_TEXT = new RegExp(String.raw`[^\P{Cc}\n]|${DIALOG_INVISIBLE}`, "u");

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

/** Why a request was not accepted; only `cancelled` means the person said no. */
export const HOST_DECLINES = ["cancelled", "timeout", "unavailable", "refused"] as const;
export type HostDecline = (typeof HOST_DECLINES)[number];

/** `host.respond`: the user's answer. `displayUnits` is the default-units preference, on an accepted `project_new` (U59). */
export interface HostResponse {
  requestId: string;
  accepted: boolean;
  /** Set when `accepted` is false; absent reads as `cancelled`. */
  declined?: HostDecline;
  displayUnits?: DisplayUnits;
}

/** `host.show`: Electron main brings a project (and optionally a thread) to the front. */
export interface HostShow {
  projectId: string;
  threadId?: string;
}
