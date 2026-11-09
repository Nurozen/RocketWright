/**
 * Recents and last-active (R0.5), Electron-free: `recents.json` in userData,
 * read and written by main alone. `rwDesktop.setActiveProject` feeds it, never
 * `project.opened`, whose dedupe would miss a reopened project.
 *
 * - Keyed by realpath, so `/tmp/a` and `/private/tmp/a` are one entry.
 * - Write-through with temp-plus-rename (D5): a crash skips `shutdown`.
 * - Excludes this launch's automatic copy and `--project` paths by realpath,
 *   not by a `rw-dev-*` name (D4): Open folder is the only way back to an old
 *   temp copy, so one opened that way must stay listed.
 * - Nothing here throws to its caller: an unreadable or corrupt file reads as
 *   empty, and a failed write is only logged, because losing Recents must
 *   never stop a project opening.
 */
import type { RecentEntry, RecentProject, RecentsFile, RecentStatus } from "@rw/contracts";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const MAX_RECENTS = 30;
/** What makes a folder a project, by Rust's rule (`isProjectDir` is looser). */
const MANIFEST = "rocketwright.toml";
/** `{pid, …}` of the project's live owner (`rw-project` `lock.rs`). */
const LOCK_FILE = ".rw/lock";

export interface RecentsOptions {
  /** `<userData>/recents.json`. */
  file: string;
  /** This launch's `dev.dir` and `desk.projects` (D4), resolved at each use: one may not exist yet. */
  excluded: readonly string[];
  /** Hidden runs record nothing, so captures stay reproducible. */
  readOnly?: boolean;
  /** Projects this app has open: their lock is our own sidecar's, not another process's. */
  openDirs?: () => readonly string[];
  now?: () => Date;
  pidAlive?: (pid: number) => boolean;
  log?: (line: string) => void;
}

export interface LastActive {
  dir: string;
  status: RecentStatus;
}

export interface Recents {
  list(): Promise<RecentProject[]>;
  /** Records what the page is showing; null on Welcome. */
  see(project: { dir: string; name: string } | null): Promise<void>;
  remove(dir: string): Promise<void>;
  /** The project to reopen with its status, or null; the caller opens it only when `ok`. */
  pickLastActive(): Promise<LastActive | null>;
}

const emptyFile = (): RecentsFile => ({ version: 1, recents: [], lastActive: null });

function isEntry(v: unknown): v is RecentEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Partial<RecentEntry>;
  return typeof e.dir === "string" && isAbsolute(e.dir) && typeof e.name === "string" && typeof e.lastOpened === "string";
}

/** The file's contents, tolerating anything: hand edits, a future version, a partial write from an older build. */
export function parseRecents(text: string): RecentsFile {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return emptyFile();
  }
  if (typeof v !== "object" || v === null) return emptyFile();
  const f = v as Partial<RecentsFile>;
  if (f.version !== 1 || !Array.isArray(f.recents)) return emptyFile();
  return { version: 1, recents: f.recents.filter(isEntry), lastActive: typeof f.lastActive === "string" ? f.lastActive : null };
}

/** True when `pid` names a live process. Signal 0 only checks; nothing is sent. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const errorCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

/** A path that no longer exists keeps its spelling, so it still matches its stored entry. */
async function canon(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch {
    return resolve(dir);
  }
}

async function lockOwner(dir: string): Promise<number | null> {
  try {
    const { pid } = JSON.parse(await readFile(join(dir, LOCK_FILE), "utf8")) as { pid?: unknown };
    return typeof pid === "number" ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Stats the manifest, not the folder: TCC denies a folder's contents, and a
 * folder that lost its manifest cannot be reopened either. D5: only a path
 * that is really gone is `missing` (ENOTDIR: a file now sits where the folder
 * was). Any other failure leaves the project intact, so it reads `denied` and
 * never invites removing it.
 */
async function probeStatus(dir: string, openHere: ReadonlySet<string>, alive: (pid: number) => boolean): Promise<RecentStatus> {
  try {
    await stat(join(dir, MANIFEST));
  } catch (e) {
    const code = errorCode(e);
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "denied";
  }
  if (openHere.has(dir)) return "ok";
  const owner = await lockOwner(dir);
  return owner !== null && alive(owner) ? "locked" : "ok";
}

export function createRecents(options: RecentsOptions): Recents {
  const { file, excluded, readOnly = false, openDirs = () => [], now = () => new Date(), log = () => undefined } = options;
  const alive = options.pidAlive ?? pidAlive;
  // Read-modify-write runs one at a time: page calls overlap, and the last one sent must win.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const run = queue.then(op);
    queue = run.catch(() => undefined);
    return run;
  };
  // Welcome clears only a project this launch showed: after a failed reopen
  // (denied, locked) the page reports Welcome too, and that must not forget
  // the project, nor may an explicit `--project` run forget the real one.
  let shownThisLaunch = false;

  const read = async (): Promise<RecentsFile> => {
    try {
      return parseRecents(await readFile(file, "utf8"));
    } catch {
      return emptyFile();
    }
  };
  const write = async (next: RecentsFile): Promise<void> => {
    const temp = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`);
      await rename(temp, file);
    } catch (e) {
      log(`recents: cannot write ${file}: ${e instanceof Error ? e.message : String(e)}`);
      await rm(temp, { force: true }).catch(() => undefined);
    }
  };
  const canonSet = async (dirs: readonly string[]): Promise<Set<string>> => new Set(await Promise.all(dirs.map(canon)));

  return {
    // Status probes run outside the queue: a stalled network mount must not hold up the next write.
    list: async () => {
      const { recents } = await enqueue(read);
      const [skip, openHere] = await Promise.all([canonSet(excluded), canonSet(openDirs())]);
      // A project open here is in the header's open list; Recent is for reaching the others.
      return Promise.all(recents.filter((e) => !skip.has(e.dir) && !openHere.has(e.dir)).map(async (e) => ({ ...e, status: await probeStatus(e.dir, openHere, alive) })));
    },
    see: (project) =>
      enqueue(async () => {
        if (readOnly) return;
        if (project === null) {
          if (!shownThisLaunch) return;
          shownThisLaunch = false;
          await write({ ...(await read()), lastActive: null });
          return;
        }
        const dir = await canon(project.dir);
        if ((await canonSet(excluded)).has(dir)) return;
        const { recents } = await read();
        const entry: RecentEntry = { dir, name: project.name, lastOpened: now().toISOString() };
        await write({ version: 1, recents: [entry, ...recents.filter((e) => e.dir !== dir)].slice(0, MAX_RECENTS), lastActive: dir });
        shownThisLaunch = true;
      }),
    remove: (dir) =>
      enqueue(async () => {
        if (readOnly) return;
        const real = await canon(dir);
        const gone = (d: string | null): boolean => d === dir || d === real;
        const s = await read();
        await write({ version: 1, recents: s.recents.filter((e) => !gone(e.dir)), lastActive: gone(s.lastActive) ? null : s.lastActive });
      }),
    pickLastActive: async () => {
      const { lastActive } = await enqueue(read);
      if (lastActive === null) return null;
      const [skip, openHere] = await Promise.all([canonSet(excluded), canonSet(openDirs())]);
      if (skip.has(lastActive)) return null;
      return { dir: lastActive, status: await probeStatus(lastActive, openHere, alive) };
    },
  };
}
