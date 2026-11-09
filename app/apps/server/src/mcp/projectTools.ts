/**
 * The agent's project tools (R1.3): `project_new` and `project_open` on the
 * live route. A thread cannot change projects, so each one asks the person in
 * a native dialog, opens the project, switches the window and starts a new
 * thread there carrying `request`; the calling thread stays where it is.
 *
 * Everything that can be refused is refused before the dialog, so a person is
 * never asked to approve something that cannot happen. Creation stays `rw init`
 * through `ProjectCreator` (I1); nothing here writes a file.
 *
 * Lecturn gives a live call 120 s and reports anything later as a failure, while
 * this code keeps running. An accept after that would make a project the agent
 * believes failed, and it would retry (D10). So the dialog ends first, and past
 * the guard the agent gets a partial success that says not to call again. The
 * work continues behind that answer, and the tools stay busy until it ends:
 * one consent, one project.
 *
 * Starting the thread is `ProjectThreadStarter` (`LecturnLink.startThreadInProject`).
 * The server's "already created" prefix on the first message is added there:
 * `request` here is exactly what the dialog showed.
 */
import { isAbsolute, join, resolve } from "node:path";
import {
  PROJECT_TEMPLATES,
  PROJECT_TOOLS,
  PROJECT_TOOL_REQUEST_MAX,
  type HostRequest,
  type HostResponse,
  type DisplayUnits,
  type HostShow,
  type JsonObject,
  type ProjectInfo,
  type ProjectTemplate,
  type ProjectTool,
  type ProjectToolResult,
} from "@rw/contracts";
import { refuseOverlong, defaultProjectLocation, expandHome, type ProjectCreateArgs } from "../project/create.ts";
import { folderState, holdsProject } from "../project/inspect.ts";
import { RpcFail } from "../rpc/errors.ts";
import { HostChannelError } from "../rpc/HostChannel.ts";
import { projectCreateArgs } from "../rpc/params.ts";
import { META_APPROVAL, type SidecarLike, type SidecarTool } from "../sidecar/SidecarClient.ts";

export type CallResult = Awaited<ReturnType<SidecarLike["callTool"]>>;

/**
 * How long the server waits for the dialog's answer. Main closes its dialog at
 * about 100 s (D10); the extra seconds let that answer, or an accept in the
 * last moment, arrive instead of being lost to this timer.
 */
export const PROJECT_DIALOG_MS = 103_000;
/** When the agent must have an answer: inside Lecturn's 120 s, wherever the work has got to (D10). */
export const PROJECT_CALL_GUARD_MS = 115_000;

/** The calling thread and its Lecturn project, null when the call did not say. */
export interface ProjectToolCaller {
  threadId: string | null;
  projectId: string | null;
}

export interface ProjectThreadStart {
  project: ProjectInfo;
  /** The new thread's work, as the person saw it; null makes an empty thread with no turn. */
  request: string | null;
  /** The call made this project, rather than opening one that was there. */
  created: boolean;
  caller: ProjectToolCaller;
  /** Fires at the overall guard, when the agent is told the thread is not confirmed. */
  signal: AbortSignal;
}

export interface ProjectThreadStarted {
  threadId: string;
  /** Why the thread exists but its first message did not start, or could not be confirmed. */
  unstarted?: string;
}

/** Starts the new thread in a project that is already open. Rejecting reports "opened, no thread". */
export type ProjectThreadStarter = (start: ProjectThreadStart) => Promise<ProjectThreadStarted>;

/** With no Lecturn link: the project still opens, and the agent is told no thread started. */
export const threadLaunchUnavailable: ProjectThreadStarter = () => Promise.reject(new Error("starting a thread in another project is not available in this build"));

export interface ProjectToolsDeps {
  /** One consent dialog (`HostChannel.request`). */
  askHost(request: Omit<HostRequest, "requestId">, signal: AbortSignal): Promise<HostResponse>;
  /** Brings a project, and its thread when there is one, to the front. */
  show(show: HostShow): void;
  create(args: ProjectCreateArgs): Promise<string>;
  /** D3: the files `rw init` would refuse over; empty when it would go ahead. */
  collisions(dir: string): Promise<string[]>;
  open(dir: string): Promise<ProjectInfo>;
  isOpen(dir: string): boolean;
  startThread: ProjectThreadStarter;
  dialogMs?: number;
  guardMs?: number;
}

export function toolError(code: string, message: string): CallResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    _meta: { "rw/error": { code, message } },
  };
}

function success(text: string, structuredContent: Record<string, unknown>): CallResult {
  return { content: [{ type: "text", text }], structuredContent } as CallResult;
}

const STOP = "Tell the person and stop; do not call this tool again unless they ask.";
const NOT_RETRY = "Do not call this tool again for this project.";

function definition(name: ProjectTool, title: string, description: string, properties: Record<string, unknown>, required: string[]): SidecarTool {
  return {
    name,
    title,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: { title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    // The native dialog is the consent; a Lecturn prompt too would ask twice.
    _meta: { [META_APPROVAL]: "never" },
  } as SidecarTool;
}

const REQUEST_ARG = {
  type: "string",
  maxLength: PROJECT_TOOL_REQUEST_MAX,
  description: "Only the work left to do after this step; it becomes the new thread's first message. Leave it out when nothing is left.",
} as const;

const AFTER =
  "A thread cannot change projects: this thread stays where it is and a new thread in that project carries `request`. The person confirms in a native dialog. " +
  "If they cancel, or the call is refused, tell them and stop; do not retry. " +
  "Planning and scratch files are welcome in a project; keep them all inside its `artifacts/` folder.";

const DEFINITIONS: readonly SidecarTool[] = [
  definition(
    "project_new",
    "New project",
    `Creates a new RocketWright project and opens it in the app; use this instead of \`rw init\` here. ${AFTER} Refuses a folder that already holds a project; use \`rw_project_open\` for that.`,
    {
      name: { type: "string", description: "The project's name, which is also its folder's: one path segment." },
      location: { type: "string", description: "The parent folder, absolute or starting with ~. Default: the app's projects folder." },
      template: { type: "string", enum: PROJECT_TEMPLATES },
      request: REQUEST_ARG,
    },
    ["name"],
  ),
  definition(
    "project_open",
    "Open project",
    `Opens an existing RocketWright project in the app, even one already open, and switches the window to it. ${AFTER}`,
    {
      path: { type: "string", description: "The project's folder, absolute or starting with ~." },
      request: REQUEST_ARG,
    },
    ["path"],
  ),
];

/** Characters that hide or reorder what a dialog shows. `\n` is kept; `\p{Cc}` includes it. */
const UNSAFE_IN_DIALOG = /[^\P{Cc}\n]|\p{Bidi_Control}|[\u2028\u2029]/gu;

/**
 * D13: the text a person approves and the new thread receives. Newlines and
 * backticks stay for fenced blocks; a tab becomes a space so words stay apart.
 * Null when nothing is left.
 */
export function cleanRequest(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new RpcFail("invalid_params", "request: expected a string");
  const text = raw.replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(UNSAFE_IN_DIALOG, "");
  if (Array.from(text).length > PROJECT_TOOL_REQUEST_MAX) {
    throw new RpcFail("invalid_params", `request: at most ${PROJECT_TOOL_REQUEST_MAX} characters; say only the work left to do`);
  }
  return text.trim() === "" ? null : text;
}

function refuseUnknownArgs(args: JsonObject, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new RpcFail("invalid_params", `${key}: not an argument of this tool`);
  }
}

/** A name or path cannot be cleaned as a request is: that would name another folder. */
function refuseUnsafe(key: string, value: string): void {
  if (value.replace(UNSAFE_IN_DIALOG, "") !== value) throw new RpcFail("invalid_params", `${key}: cannot contain control or text-direction characters`);
}

function absoluteArg(key: string, value: string): string {
  refuseUnsafe(key, value);
  const expanded = expandHome(value);
  if (!isAbsolute(expanded)) throw new RpcFail("invalid_params", `${key}: expected an absolute path or one starting with ~`);
  return resolve(expanded);
}

function stringArg(args: JsonObject, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v === "") throw new RpcFail("invalid_params", `${key}: expected a non-empty string`);
  return v;
}

interface NewProject {
  tool: "project_new";
  target: string;
  name: string;
  template: ProjectTemplate | undefined;
  create: ProjectCreateArgs;
  request: string | null;
}

interface OpenProject {
  tool: "project_open";
  target: string;
  request: string | null;
}

type Plan = NewProject | OpenProject;

/** How far a call has got, for the answer at the guard. */
type Stage = { at: "before" } | { at: "working"; plan: Plan } | { at: "opened"; plan: Plan; project: ProjectInfo };

export class ProjectTools {
  private readonly deps: ProjectToolsDeps;
  private readonly dialogMs: number;
  private readonly guardMs: number;
  /** One at a time, from the dialog until the work behind it has ended (B2: exactly once). */
  private inFlight = false;

  constructor(deps: ProjectToolsDeps) {
    this.deps = deps;
    this.dialogMs = deps.dialogMs ?? PROJECT_DIALOG_MS;
    this.guardMs = deps.guardMs ?? PROJECT_CALL_GUARD_MS;
  }

  serves(name: string): name is ProjectTool {
    return (PROJECT_TOOLS as readonly string[]).includes(name);
  }

  tools(): SidecarTool[] {
    return [...DEFINITIONS];
  }

  /** Answers one tool call; never rejects. */
  async call(tool: ProjectTool, args: JsonObject, caller: ProjectToolCaller): Promise<CallResult> {
    if (this.inFlight) return toolError("busy", `Another project request is still waiting for the person or finishing. ${STOP}`);
    this.inFlight = true;
    const guard = new AbortController();
    const timer = setTimeout(() => guard.abort(), this.guardMs);
    const stage: { now: Stage } = { now: { at: "before" } };
    const work = this.run(tool, args, caller, guard.signal, stage)
      .catch((e: unknown) => toolError("internal", e instanceof Error ? e.message : String(e)))
      .finally(() => {
        clearTimeout(timer);
        this.inFlight = false;
      });
    const overrun = new Promise<CallResult>((answer) => {
      guard.signal.addEventListener("abort", () => answer(overrunResult(stage.now, tool)), { once: true });
    });
    return Promise.race([work, overrun]);
  }

  private async run(tool: ProjectTool, args: JsonObject, caller: ProjectToolCaller, guard: AbortSignal, stage: { now: Stage }): Promise<CallResult> {
    let plan: Plan;
    try {
      plan = tool === "project_new" ? await this.planNew(args) : this.planOpen(args);
    } catch (e) {
      return refusal(e);
    }
    if (guard.aborted) return overrunResult(stage.now, tool);

    const consent = await this.ask(plan, guard);
    if ("refused" in consent) return consent.refused;

    stage.now = { at: "working", plan };
    let project: ProjectInfo;
    try {
      project = await this.bringUp(plan, consent.displayUnits);
    } catch (e) {
      return plan.tool === "project_new" ? creationFailure(e, plan) : refusal(e);
    }
    stage.now = { at: "opened", plan, project };
    this.deps.show({ projectId: project.projectId });

    // The guard has already told the agent no thread started, so none may appear now.
    if (guard.aborted) return openedWithoutThread(project, "the call ran out of time");
    const started = await this.startThread(plan, project, caller, guard);
    if ("why" in started) return openedWithoutThread(project, started.why);
    this.deps.show({ projectId: project.projectId, threadId: started.threadId });
    const result: ProjectToolResult = { project, threadId: started.threadId };
    if (started.unstarted !== undefined) {
      return success(`Project "${project.name}" is open at ${project.dir} and thread ${started.threadId} exists there, but it did not start as asked (${started.unstarted}). ${NOT_RETRY} Tell the person so they can continue in that thread.`, { ...result });
    }
    return success(`Project "${project.name}" is open at ${project.dir}, and thread ${started.threadId} was started there. This thread stays in its own project. ${NOT_RETRY}`, { ...result });
  }

  private async planNew(args: JsonObject): Promise<NewProject> {
    refuseUnknownArgs(args, ["name", "location", "template", "request"]);
    const create = projectCreateArgs({ name: args.name, location: args.location, template: args.template } as JsonObject);
    const location = absoluteArg("location", create.location ?? defaultProjectLocation());
    refuseUnsafe("name", create.name);
    const request = cleanRequest(args.request);
    const target = join(location, create.name);
    refuseOverlong(target);
    const state = folderState(target);
    if (state === "project") throw alreadyProject(target);
    if (state === "file") throw new RpcFail("conflict", `${target} is a file, so a project cannot be created there`);
    if (state === "folder") {
      const clashes = await this.deps.collisions(target);
      if (clashes.length > 0) throw new RpcFail("conflict", `${target} holds files a new project would replace: ${clashes.join(", ")}`);
    }
    return { tool: "project_new", target, name: create.name, template: create.template, create: { ...create, location }, request };
  }

  private planOpen(args: JsonObject): OpenProject {
    refuseUnknownArgs(args, ["path", "request"]);
    const target = absoluteArg("path", stringArg(args, "path"));
    const request = cleanRequest(args.request);
    if (!this.deps.isOpen(target)) {
      const state = folderState(target);
      if (state === "missing") throw new RpcFail("not_found", `no such folder ${target}`);
      if (state === "file") throw new RpcFail("invalid_params", `${target} is a file, not a project folder`);
      if (state !== "project") throw new RpcFail("not_a_project", `${target} holds no RocketWright project; use rw_project_new to create one`);
    }
    return { tool: "project_open", target, request };
  }

  /** Shows the dialog. `refused` is the agent's answer; otherwise accepted, with main's default units (R3.4). */
  private async ask(plan: Plan, guard: AbortSignal): Promise<{ refused: CallResult } | { displayUnits?: DisplayUnits | undefined }> {
    const nothing = plan.tool === "project_new" ? "Nothing was created." : "Nothing was opened.";
    let answer: HostResponse;
    try {
      answer = await this.deps.askHost(hostRequest(plan), AbortSignal.any([guard, AbortSignal.timeout(this.dialogMs)]));
    } catch (e) {
      if (!(e instanceof HostChannelError)) throw e;
      switch (e.code) {
        case "aborted":
          return { refused: toolError("timeout", `The person did not answer the confirmation in time. ${nothing} ${STOP}`) };
        case "busy":
          return { refused: toolError("busy", `Another confirmation is already on screen. ${nothing} ${STOP}`) };
        case "no_host":
        case "disconnected":
          return { refused: toolError("unavailable", `${plan.tool} needs the RocketWright desktop app, and no desktop window can answer. ${nothing}`) };
      }
    }
    return answer.accepted ? { displayUnits: answer.displayUnits } : { refused: toolError("cancelled", `The person cancelled. ${nothing} ${STOP}`) };
  }

  private async bringUp(plan: Plan, displayUnits: DisplayUnits | undefined): Promise<ProjectInfo> {
    if (plan.tool === "project_open") return this.deps.open(plan.target);
    const dir = await this.deps.create(displayUnits === undefined ? plan.create : { ...plan.create, displayUnits });
    try {
      return await this.deps.open(dir);
    } catch (e) {
      throw new CreatedNotOpened(dir, e);
    }
  }

  /** The thread, or why there is none. The guard ends the wait even if the launch never settles. */
  private async startThread(plan: Plan, project: ProjectInfo, caller: ProjectToolCaller, signal: AbortSignal): Promise<ProjectThreadStarted | { why: string }> {
    const timedOut = new Promise<{ why: string }>((answer) => {
      signal.addEventListener("abort", () => answer({ why: "the thread did not finish starting in time" }), { once: true });
    });
    const launch = this.deps.startThread({ project, request: plan.request, created: plan.tool === "project_new", caller, signal }).catch(
      (e: unknown) => ({ why: e instanceof Error ? e.message : String(e) }),
    );
    return Promise.race([launch, timedOut]);
  }
}

class CreatedNotOpened extends Error {
  readonly dir: string;
  constructor(dir: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.dir = dir;
  }
}

function hostRequest(plan: Plan): Omit<HostRequest, "requestId"> {
  const request = plan.request === null ? {} : { request: plan.request };
  if (plan.tool === "project_open") return { tool: plan.tool, path: plan.target, ...request };
  return { tool: plan.tool, path: plan.target, name: plan.name, ...(plan.template === undefined ? {} : { template: plan.template }), ...request };
}

function alreadyProject(target: string): RpcFail {
  return new RpcFail("conflict", `${target} already holds a project; use rw_project_open to open it`);
}

/** The agent's words for an argument are `invalid_args`, as on every other live tool. */
function refusal(e: unknown): CallResult {
  if (e instanceof RpcFail) return toolError(e.code === "invalid_params" ? "invalid_args" : e.code, e.message);
  return toolError("internal", e instanceof Error ? e.message : String(e));
}

function creationFailure(e: unknown, plan: NewProject): CallResult {
  if (e instanceof CreatedNotOpened) {
    return toolError("open_failed", `The project was created at ${e.dir} but could not be opened: ${e.message}. Do not create it again; rw_project_open can open it.`);
  }
  // Something else made the folder a project between the check and the accept.
  if (e instanceof RpcFail && e.code === "conflict" && holdsProject(plan.target)) return refusal(alreadyProject(plan.target));
  return refusal(e);
}

function openedWithoutThread(project: ProjectInfo, why: string): CallResult {
  const result: ProjectToolResult = { project, threadId: null };
  return success(`Project "${project.name}" is open at ${project.dir}, but no new thread was started there (${why}). ${NOT_RETRY} Tell the person so they can continue in that project.`, { ...result });
}

/** The answer at the guard. Past the accept this is a partial success: the agent must not retry. */
function overrunResult(stage: Stage, tool: ProjectTool): CallResult {
  switch (stage.at) {
    case "before":
      return toolError("timeout", `The ${tool} call ran out of time before anything changed. ${STOP}`);
    case "working":
      return success(`The person accepted, and ${stage.plan.target} is still being set up. It will open in the app when ready, and no new thread will start. ${NOT_RETRY} Tell the person.`, { status: "pending", path: stage.plan.target, threadId: null });
    case "opened":
      return openedWithoutThread(stage.project, "the call ran out of time");
  }
}
