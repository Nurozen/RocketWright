/**
 * What a folder holds (R0.4), by Rust's rule (`rw_project::layout::is_project`:
 * a `rocketwright.toml` or `rocketwright.json` file). `isProjectDir` in the
 * desktop backend accepts any top-level `*.toml`, so a folder with a
 * `Cargo.toml` would pass it; it is not used here.
 *
 * Reads only: the single writer is the Rust session (I1).
 */
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProjectFolderState, ProjectInspection } from "@rw/contracts";
import { RpcFail } from "../rpc/errors.ts";

const MANIFEST = "rocketwright.toml";
const MANIFEST_JSON = "rocketwright.json";
/** The name `rw init` writes when it is given none (R0.7). */
const TEMPLATE_DEFAULT_NAME = "Rocket";
/** Finder drops this in any folder it has shown; it does not make the folder hold anything. */
const IGNORED_ENTRIES = new Set([".DS_Store"]);

function isDenied(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}

/** D5: a denied folder is not a missing one, so it never invites removing a healthy project. */
function denied(path: string): RpcFail {
  return new RpcFail("permission_denied", `${path}: permission denied`);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (e) {
    if (isDenied(e)) throw denied(path);
    return false;
  }
}

/** True when `dir` holds a RocketWright manifest. */
export function holdsProject(dir: string): boolean {
  return isFile(join(dir, MANIFEST)) || isFile(join(dir, MANIFEST_JSON));
}

/** `file` is internal: the wire's states are the folders a target can be. */
export type TargetState = ProjectFolderState | "file";

export function folderState(dir: string): TargetState {
  let st;
  try {
    st = statSync(dir);
  } catch (e) {
    if (isDenied(e)) throw denied(dir);
    // A dangling symlink is something there: `rw init` could not use the name.
    try {
      lstatSync(dir);
      return "file";
    } catch {
      return "missing";
    }
  }
  if (!st.isDirectory()) return "file";
  if (holdsProject(dir)) return "project";
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    if (isDenied(e)) throw denied(dir);
    return "folder";
  }
  return entries.some((n) => !IGNORED_ENTRIES.has(n)) ? "folder" : "empty";
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** TOML's basic-string escapes. An unknown escape is invalid TOML, which Rust refuses, so it stays as written. */
function unescapeBasic(body: string): string {
  const short: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\x1b", '"': '"', "\\": "\\" };
  return body.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (all, esc: string) => {
    if (esc.length > 1) return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
    return short[esc] ?? all;
  });
}

/**
 * The top-level `name` key of a TOML manifest. Not a TOML parser: the server
 * has no TOML dependency and needs this one key, on one line. All four string
 * forms occur (`toml_edit` picks `'''` or `"""` for a name holding quotes); a
 * value spread over lines gives null, and the folder name shows.
 */
function tomlName(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) return null; // the first table ends the top level
    const m = /^name\s*=\s*(?:"""(.*?)"""|'''(.*?)'''|"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (m === null) continue;
    return m[2] ?? m[4] ?? unescapeBasic((m[1] ?? m[3])!);
  }
  return null;
}

function jsonName(text: string): string | null {
  try {
    const name = (JSON.parse(text) as { name?: unknown }).name;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

/** The manifest's `name`, or null when there is none to read. */
export function readProjectName(dir: string): string | null {
  const toml = readText(join(dir, MANIFEST));
  if (toml !== null) return tomlName(toml);
  const json = readText(join(dir, MANIFEST_JSON));
  return json === null ? null : jsonName(json);
}

/** R0.7: the manifest's name, or the folder's when that is empty or the template's `Rocket`. */
export function displayName(dir: string): string {
  const name = readProjectName(dir)?.trim();
  return name === undefined || name === "" || name === TEMPLATE_DEFAULT_NAME ? basename(dir) : name;
}

/** `project.inspect`. `collisions` is asked only of a folder with files and no project. */
export async function inspectFolder(dir: string, collisions: (dir: string) => Promise<string[]>): Promise<ProjectInspection> {
  const state = folderState(dir);
  if (state === "file") throw new RpcFail("invalid_params", `${dir} is a file, not a folder`);
  return { dir, state, name: state === "project" ? displayName(dir) : null, collisions: state === "folder" ? await collisions(dir) : [] };
}
