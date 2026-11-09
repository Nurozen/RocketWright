/**
 * What Welcome and the New project dialog do, apart from drawing it: the name
 * and path rules a person sees before anything is sent, and the RPC sequences
 * for creating and opening. The server repeats every check; a failure it
 * reports is thrown as-is so the caller can show its message.
 */
import type { ProjectInfo, ProjectTemplate, RecentStatus } from "@rw/contracts";
import type { RpcLike } from "../state/rpc.ts";
import type { RadioCardOption } from "../ui/RadioCard.tsx";
import { formatDate } from "./format.ts";

export type ProjectRpc = Pick<RpcLike, "call">;

export type NewProjectTemplate = Extract<ProjectTemplate, "empty" | "minimal" | "simple-rocket">;

export const DEFAULT_TEMPLATE: NewProjectTemplate = "minimal";

export const TEMPLATE_CARDS: readonly RadioCardOption<NewProjectTemplate>[] = [
  { value: "empty", title: "Empty", description: "No parts yet. Start from scratch." },
  { value: "minimal", title: "Minimal", description: "Nose, tube, fins, motor mount, and streamer." },
  { value: "simple-rocket", title: "Simple rocket", description: "A complete rocket ready to simulate." },
];

/** The server numbers this one name instead of refusing it (R0.8, `S/project/create.ts`). */
const SAMPLE_NAME = "Sample rocket";

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// oxlint-disable-next-line no-control-regex -- the server refuses control characters in a folder name
const UNSAFE_NAME = /[/\\\u0000-\u001f\u007f]/;

/** Why this name cannot be a project folder, or null. The server's rule (`projectName`), said in advance. */
export function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Enter a name.";
  if (trimmed.startsWith(".")) return "A name cannot start with a dot.";
  if (UNSAFE_NAME.test(trimmed)) return "A name cannot contain a slash, a backslash or a control character.";
  return null;
}

// oxlint-disable-next-line no-control-regex -- the session refuses control characters in a project name
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** Why this cannot be a project's name, or null. The session's rule (`checked_project_name`), said in advance; the folder is not involved. */
export function renameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Enter a name.";
  if (new TextEncoder().encode(trimmed).length > 255) return "A name can be at most 255 bytes.";
  if (CONTROL_CHARS.test(trimmed)) return "A name cannot contain a control character.";
  return null;
}

export function locationProblem(location: string): string | null {
  return location.trim() === "" ? "Enter a location." : null;
}

/** The line under Location: it names the folder even before there is a project name. */
export function targetPreview(location: string, name: string): string {
  const parent = location.trim();
  if (parent === "") return "Choose where to create it.";
  const trimmed = name.trim();
  return trimmed === "" ? `Creates a folder in ${parent}` : `Creates ${parent.replace(/\/+$/, "")}/${trimmed}`;
}

export interface CreateRequest {
  name: string;
  location: string;
  template: NewProjectTemplate;
}

export async function createProject(rpc: ProjectRpc, { name, location, template }: CreateRequest): Promise<ProjectInfo> {
  const { project } = await rpc.call("project.create", { name: name.trim(), location: location.trim(), template });
  return project;
}

export async function renameProject(rpc: ProjectRpc, projectId: string, name: string): Promise<ProjectInfo> {
  const { project } = await rpc.call("project.rename", { projectId, name: name.trim() });
  return project;
}

/** The next open project after `closed` goes, or null for Welcome. */
export async function nextOpen(rpc: ProjectRpc, closed: string): Promise<string | null> {
  try {
    const { projects } = await rpc.call("project.list", {});
    return projects.find((p) => p.projectId !== closed)?.projectId ?? null;
  } catch {
    return null;
  }
}

/** A durable copy in the default location, numbered if one is already there (R0.8). */
export async function openSample(rpc: ProjectRpc): Promise<ProjectInfo> {
  const { project } = await rpc.call("project.create", { name: SAMPLE_NAME, template: "sample" });
  return project;
}

export async function openRecent(rpc: ProjectRpc, dir: string): Promise<ProjectInfo> {
  const { project } = await rpc.call("project.open", { dir });
  return project;
}

/** `project.create` takes a parent and a name, so a folder is offered as those two. */
export function splitFolder(dir: string): { location: string; name: string } {
  const at = dir.lastIndexOf("/");
  return { location: at <= 0 ? "/" : dir.slice(0, at), name: dir.slice(at + 1) };
}

export type FolderOutcome =
  | { kind: "opened"; project: ProjectInfo }
  /** No project there, and creating one would overwrite nothing. */
  | { kind: "offer"; location: string; name: string; message: string }
  /** No project there, and `rw init` would refuse over these files (D3). */
  | { kind: "blocked"; message: string };

/** R0.4: opens the project in `dir`, or says what can be done with a folder that has none. */
export async function openFolder(rpc: ProjectRpc, dir: string): Promise<FolderOutcome> {
  const found = await rpc.call("project.inspect", { dir });
  if (found.state === "project") {
    const { project } = await rpc.call("project.open", { dir: found.dir });
    return { kind: "opened", project };
  }
  if (found.collisions.length > 0) {
    return { kind: "blocked", message: `${found.dir} has no RocketWright project, and creating one there would replace: ${found.collisions.join(", ")}. Move those files or choose another folder.` };
  }
  const message = found.state === "missing" ? `${found.dir} does not exist yet. Create a project there?` : `${found.dir} has no RocketWright project. Create one there?`;
  return { kind: "offer", ...splitFolder(found.dir), message };
}

/** What a Recent row says instead of its age. Only `missing` invites removal (D5). */
export const RECENT_STATUS_TEXT: Partial<Record<RecentStatus, string>> = {
  missing: "Missing",
  denied: "No access",
  locked: "In use",
};

/** `2 hours ago`, `Yesterday`, then a date. */
export function recentAge(iso: string, now: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  const count = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (minutes < 1) return "Just now";
  if (minutes < 60) return count(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return count(hours, "hour");
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  return days < 7 ? count(days, "day") : formatDate(iso);
}
