/**
 * `project.create` (R0.3, R0.8, D17): spawns the real `rw init` or
 * `rw import ork`, which take the project lock and write everything. This
 * file makes no directory and writes no file (I1).
 *
 * The check for an existing project runs here, before any process, for every
 * source: on a folder that holds a project, `rw import ork` would replace its
 * model instead of refusing. The check and the spawn are one step per target
 * (`gated`), so two callers cannot both pass the check.
 *
 * D1, U03: a long path is not refused for its socket (`socket_path` falls back
 * to a short one under `$TMPDIR`). What fails is the deepest file a new project
 * writes: past `MAX_PROJECT_REALPATH`, `rw init` stops midway and leaves a
 * partial project, so the limit is enforced first.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DisplayUnits, ProjectTemplate } from "@rw/contracts";
import { RpcFail } from "../rpc/errors.ts";
import { sidecarBinary, sidecarEnv } from "../sidecar/SidecarClient.ts";
import { folderState } from "./inspect.ts";

/** "Open sample rocket" (R0.8): only this name takes a number instead of a refusal. */
export const SAMPLE_PROJECT_NAME = "Sample rocket";

const PATH_MAX = process.platform === "linux" ? 4096 : 1024;
/** The longest path `rw init` writes under the project: `/.rw/history.git/objects/xx/<38 hex>`. */
const DEEPEST_PROJECT_FILE = 66;
/** Bytes of a project's realpath: `PATH_MAX` counts the NUL (U03 measured 957 on macOS). */
export const MAX_PROJECT_REALPATH = PATH_MAX - 1 - DEEPEST_PROJECT_FILE;

/** `rw init` is quick, but an `.ork` import can take a while on a slow disk. */
const RW_TIMEOUT_MS = 120_000;
/** `rw --json` prints a whole check report for a new project. */
const RW_MAX_OUTPUT = 64 * 1024 * 1024;

const OS_ERRORS_DENIED = /os error (1|13|30)\)/; // EPERM, EACCES, EROFS
const OS_ERRORS_BAD_PATH = /os error (20|36|63)\)/; // ENOTDIR, ENAMETOOLONG (Linux, macOS)
const OS_ERROR_MISSING = /os error 2\)/; // ENOENT: the `.ork` to import

export interface ProjectCreateArgs {
  name: string;
  location?: string;
  template?: ProjectTemplate;
  ork?: string;
  /** The default-units preference (R3.4); `rw init` only, since `rw import ork` has no such flag and the file's own units apply. */
  displayUnits?: DisplayUnits;
}

interface RwOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** Electron main sets `RW_DOCUMENTS_DIR`; browser mode has no such folder to ask for, so it uses home. */
export function defaultProjectLocation(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.RW_DOCUMENTS_DIR || homedir(), "RocketWright");
}

function absolutePath(key: string, path: string): string {
  const expanded = expandHome(path);
  if (!isAbsolute(expanded)) throw new RpcFail("invalid_params", `${key}: expected an absolute path or one starting with ~`);
  return resolve(expanded);
}

/** `,` and `=` are this flag's own separators, so a unit containing one would become another entry. */
const UNIT_KEY = /^[a-z_]+$/;
const UNIT_SYMBOL = /^[^,=\p{Cc}]+$/u;

/** `rw init`'s flag for these units, in sorted key order; no flag for none. */
export function displayUnitsFlag(units: DisplayUnits | undefined): string[] {
  if (units === undefined) return [];
  const entries = Object.entries(units).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, unit] of entries) {
    if (!UNIT_KEY.test(key) || !UNIT_SYMBOL.test(unit)) throw new RpcFail("invalid_params", `displayUnits: cannot use ${key} = ${JSON.stringify(unit)}`);
  }
  return entries.length === 0 ? [] : [`--display-units=${entries.map(([key, unit]) => `${key}=${unit}`).join(",")}`];
}

/** The realpath of the nearest ancestor that resolves, plus the rest: what `path` will be once created. */
export function projectedRealpath(path: string): string {
  for (let at = path; ; at = dirname(at)) {
    try {
      return join(realpathSync(at), relative(at, path));
    } catch {
      if (dirname(at) === at) return path;
    }
  }
}

export function refuseOverlong(target: string): void {
  const bytes = Buffer.byteLength(projectedRealpath(target));
  if (bytes > MAX_PROJECT_REALPATH) throw new RpcFail("invalid_params", `${target}: the path is ${bytes} bytes; a project's path can be at most ${MAX_PROJECT_REALPATH}`);
}

function runRw(bin: string | undefined, args: string[]): Promise<RwOutput> {
  return new Promise((ok, fail) => {
    execFile(sidecarBinary(bin), args, { env: sidecarEnv(), timeout: RW_TIMEOUT_MS, maxBuffer: RW_MAX_OUTPUT }, (err, stdout, stderr) => {
      if (err === null) ok({ code: 0, stdout, stderr });
      else if (typeof err.code === "number") ok({ code: err.code, stdout, stderr });
      else fail(new RpcFail("internal", `rocketwright did not finish: ${err.message}`));
    });
  });
}

/** The `{"error": {...}}` that `rw --json` prints on stderr, if it did. */
function apiErrorOf(stderr: string): { code?: unknown; message?: unknown } | null {
  try {
    const doc = JSON.parse(stderr.trim().split("\n").at(-1) ?? "") as { error?: { code?: unknown; message?: unknown } };
    return doc.error ?? null;
  } catch {
    return null;
  }
}

/**
 * `rw import ork` exits 1 when its strict check is not clean, with the project
 * written and the result on stdout; a refusal prints `{"error"}` on stderr
 * and nothing on stdout. Treating that exit 1 as a failure would report a
 * created project as not created, and a retry would answer `conflict`.
 */
function created(run: RwOutput): boolean {
  if (run.code === 0) return true;
  try {
    return Array.isArray((JSON.parse(run.stdout) as { files?: unknown }).files);
  } catch {
    return false;
  }
}

function failureOf(run: RwOutput): RpcFail {
  const api = apiErrorOf(run.stderr);
  if (api === null || typeof api.message !== "string") return new RpcFail("internal", `rocketwright exited ${run.code}: ${run.stderr.trim().slice(-500)}`);
  const message = api.message;
  if (api.code === "conflict") return new RpcFail("conflict", message);
  if (api.code === "not_found" || OS_ERROR_MISSING.test(message)) return new RpcFail("not_found", message);
  if (OS_ERRORS_DENIED.test(message)) return new RpcFail("permission_denied", message);
  if (OS_ERRORS_BAD_PATH.test(message)) return new RpcFail("invalid_params", message);
  return new RpcFail("api_error", message);
}

export class ProjectCreator {
  private readonly bin: string | undefined;
  /** Target → the end of its last check-and-spawn. */
  private readonly gates = new Map<string, Promise<void>>();

  constructor(bin: string | undefined) {
    this.bin = bin;
  }

  /** Creates the project and returns its folder; the caller opens it. */
  async create(req: ProjectCreateArgs): Promise<string> {
    const location = absolutePath("location", req.location ?? defaultProjectLocation());
    const ork = req.ork === undefined ? undefined : absolutePath("source.ork", req.ork);
    const units = displayUnitsFlag(req.displayUnits);
    const dedupe = req.template === "sample" && req.name === SAMPLE_PROJECT_NAME;
    for (let n = 1; ; n++) {
      const name = n === 1 ? req.name : `${req.name} ${n}`;
      const target = join(location, name);
      refuseOverlong(target);
      const made = await this.gated(target, () => this.createAt(target, name, req.template, ork, dedupe, units));
      if (made) return target;
    }
  }

  /** False when `dedupe` found the name taken. */
  private async createAt(target: string, name: string, template: ProjectTemplate | undefined, ork: string | undefined, dedupe: boolean, units: string[]): Promise<boolean> {
    const state = folderState(target);
    if (dedupe && state !== "missing") return false;
    if (state === "project") throw new RpcFail("conflict", `${target} already holds a project`);
    if (state === "file") throw new RpcFail("conflict", `${target} is a file, so a project cannot be created there`);
    // `--name=` so that a name starting with `-` is not read as a flag.
    const args = ork === undefined ? ["init", target, `--name=${name}`, ...(template === undefined ? [] : [`--template=${template}`]), ...units, "--json"] : ["import", "ork", ork, target, "--json"];
    const run = await runRw(this.bin, args);
    if (!created(run)) throw failureOf(run);
    return true;
  }

  /** One at a time per target. The key folds case: on a case-insensitive volume `Foo` and `foo` are one folder. */
  private gated<T>(target: string, fn: () => Promise<T>): Promise<T> {
    const key = projectedRealpath(target).normalize("NFC").toLowerCase();
    const run = (this.gates.get(key) ?? Promise.resolve()).then(fn);
    const done = run.then(
      () => undefined,
      () => undefined,
    );
    this.gates.set(key, done);
    void done.then(() => {
      if (this.gates.get(key) === done) this.gates.delete(key);
    });
    return run;
  }

  /** D3: the files `rw init` would refuse over, from `rw init` itself. Empty when it would go ahead. */
  async collisions(dir: string): Promise<string[]> {
    const run = await runRw(this.bin, ["init", dir, "--dry-run", "--json"]);
    if (run.code === 0) return [];
    const message = apiErrorOf(run.stderr)?.message;
    const list = typeof message === "string" ? message.split("would replace: ")[1] : undefined;
    return list === undefined ? [] : list.split(", ");
  }
}
