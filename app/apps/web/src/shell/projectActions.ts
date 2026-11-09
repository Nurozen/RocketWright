/**
 * What Welcome and the New project dialog do, apart from drawing it: the name
 * and path rules a person sees before anything is sent, and the RPC sequences
 * for creating and opening. The server repeats every check; a failure it
 * reports is thrown as-is so the caller can show its message.
 */
import { EXPORT_FILE_TYPES, type DisplayUnits, type FileFilter, type ProjectInfo, type ProjectTemplate, type RecentStatus, type schema } from "@rw/contracts";
import type { HostApi } from "../host/HostApi.ts";
import { exportFileName } from "../pages/results/csv.ts";
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
  /** Build it from this `.ork` instead of the template (D17). */
  ork?: string | undefined;
  /** The default-units preference (R3.4). */
  displayUnits?: DisplayUnits | null | undefined;
}

/** The default-units preference, if any. Failing to read it must not stop a project being made. */
export async function defaultUnits(host: Pick<HostApi, "prefs">): Promise<DisplayUnits | null> {
  return host.prefs().then(
    (p) => p.defaultDisplayUnits,
    () => null,
  );
}

const unitsParam = (displayUnits: DisplayUnits | null | undefined): { displayUnits?: DisplayUnits } => (displayUnits === null || displayUnits === undefined ? {} : { displayUnits });

export async function createProject(rpc: ProjectRpc, { name, location, template, ork, displayUnits }: CreateRequest): Promise<ProjectInfo> {
  const from = ork === undefined ? { template } : { source: { ork } };
  const { project } = await rpc.call("project.create", { name: name.trim(), location: location.trim(), ...from, ...unitsParam(displayUnits) });
  return project;
}

export const ORK_FILTERS: FileFilter[] = [{ name: "OpenRocket design", extensions: ["ork"] }];
export const IMPORT_FILTERS: FileFilter[] = [{ name: "Rocket or motor", extensions: ["ork", "eng", "rse"] }, ...ORK_FILTERS, { name: "Motor curve", extensions: ["eng", "rse"] }];

export const IMPORT_UNSUPPORTED = "RocketWright can import .ork, .eng and .rse files.";
export const IMPORT_MOTOR_NEEDS_PROJECT = "Open a project first: a motor file is added to a project.";
export const IMPORT_BUSY = "Could not import that file: finish what is open first, then try again.";
export const DIALOG_OPEN = "Finish or cancel the open dialog first, then try again.";
export const ACTION_BUSY = "Another project action is still running. Try again when it finishes.";

/** How a file is imported, from its extension; null when it cannot be. */
export function importKindOf(path: string): schema.ImportKind | null {
  const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase();
  if (extension === "ork") return "ork";
  return extension === "eng" || extension === "rse" ? "motor" : null;
}

export function fileBase(path: string): string {
  return path.split(/[/\\]/).at(-1) ?? path;
}

/** The file's name without its extension: the New project dialog's first guess at a name. */
export function fileStem(path: string): string {
  return fileBase(path).replace(/\.[^.]*$/, "");
}

export interface Notice {
  tone: "success" | "warning";
  text: string;
}

/** A long list would push the rest of the window away; the count still says how many. */
const MAX_NOTICE_ITEMS = 5;

function itemList(items: readonly string[]): string {
  const shown = items.slice(0, MAX_NOTICE_ITEMS).join(", ");
  return items.length > MAX_NOTICE_ITEMS ? `${shown}, and ${items.length - MAX_NOTICE_ITEMS} more` : shown;
}

/** What the person is told after an import, warnings from the file included. */
export function importedNotice(fileName: string, out: Pick<schema.ImportOut, "diagnostics">): Notice {
  const warnings = (out.diagnostics ?? []).map((d) => d.message);
  if (warnings.length === 0) return { tone: "success", text: `Imported ${fileName}.` };
  return { tone: "warning", text: `Imported ${fileName}, with ${warnings.length === 1 ? "a warning" : `${warnings.length} warnings`}: ${itemList(warnings)}` };
}

/** What the person is told after an export; parts the format cannot hold must not vanish silently (U44). */
export function exportedNotice(out: Pick<schema.ExportOut, "path" | "skipped">): Notice {
  const skipped = out.skipped ?? [];
  if (skipped.length === 0) return { tone: "success", text: `Exported to ${out.path}.` };
  return { tone: "warning", text: `Exported to ${out.path}, leaving out ${skipped.length === 1 ? "a part" : `${skipped.length} parts`} this format cannot hold: ${itemList(skipped)}.` };
}

/** The file name a save dialog starts from. */
export function exportDefaultName(projectName: string, format: schema.ExportFormat, sim?: string): string {
  if (format === "csv") return exportFileName(sim === undefined ? [] : [{ sim }]);
  const stem = projectName.trim().replace(/[/\\:]+/g, "-") || "rocket";
  return `${stem}${format === "rasp" ? "-motors" : ""}.${EXPORT_FILE_TYPES[format].extension}`;
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
export async function openSample(rpc: ProjectRpc, displayUnits?: DisplayUnits | null): Promise<ProjectInfo> {
  const { project } = await rpc.call("project.create", { name: SAMPLE_NAME, template: "sample", ...unitsParam(displayUnits) });
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
