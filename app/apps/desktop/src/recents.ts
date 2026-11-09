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
import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";

const MAX_RECENTS = 30;
/** What makes a folder a project, by Rust's rule (`layout.rs`); `isProjectDir` is looser. */
const MANIFESTS = ["rocketwright.toml", "rocketwright.json"];
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
  /** Test seam: whether the owner's recorded socket answers. */
  socketAnswers?: (path: string) => Promise<boolean>;
  /** Test seam: when `pid`'s process started, or null when that cannot be told. */
  pidStartedAt?: (pid: number) => Promise<Date | null>;
  log?: (line: string) => void;
  /** Test seam for a mount that never answers. */
  stat?: (path: string) => Promise<Pick<Stats, "isFile">>;
  probeTimeoutMs?: number;
  /** How long the launch's own last-active probe may take; test seam. */
  lastActiveTimeoutMs?: number;
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

/** How long one Recent may take once its stat has started; a network mount that stops answering must not hold up a list. */
export const PROBE_TIMEOUT_MS = 1500;
/**
 * The same limit for the one project a launch reopens: a privacy prompt on
 * `~/Documents` blocks the stat until the person answers, and that project is
 * healthy. Short of `REOPEN_TIMEOUT_MS`, which has to cover `project.open` too.
 */
export const LAST_ACTIVE_TIMEOUT_MS = 12_000;
/** How many probes may run at once. */
const PROBE_SLOTS = 2;
/**
 * A stat on a dead mount holds one of libuv's four fs threads until the mount
 * answers, so counting only running probes would let dead mounts take them
 * all. A probe past its limit gives its slot up, or two dead mounts would
 * starve every healthy row, but stays counted here until its stat returns.
 * Three leaves one thread for main's own files.
 */
const MAX_STATS_OUT = 3;

/** One folder's probe: `started` settles when its stat begins (false when none could be run). */
interface Run {
  started: Promise<boolean>;
  status: Promise<RecentStatus>;
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

/** `{pid, socket?, started}` of `.rw/lock`, when the file holds one. */
interface LockRecord {
  pid: number;
  socket: string | undefined;
  started: string | undefined;
}

async function lockRecord(dir: string): Promise<LockRecord | null> {
  try {
    const { pid, socket, started } = JSON.parse(await readFile(join(dir, LOCK_FILE), "utf8")) as { pid?: unknown; socket?: unknown; started?: unknown };
    if (typeof pid !== "number") return null;
    return { pid, socket: typeof socket === "string" ? socket : undefined, started: typeof started === "string" ? started : undefined };
  } catch {
    return null;
  }
}

/** The owner's socket accepts a connection; a crashed owner leaves a socket file that refuses one. A socket that stalls reads as held. */
function socketAnswers(path: string, timeoutMs = 300): Promise<boolean> {
  return new Promise((ok) => {
    const s = connect(path);
    const done = (held: boolean): void => {
      clearTimeout(timer);
      s.destroy();
      ok(held);
    };
    const timer = setTimeout(() => done(true), timeoutMs);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** When `pid`'s process started, from `ps`; null when that cannot be told. */
function pidStartedAt(pid: number): Promise<Date | null> {
  return new Promise((ok) => {
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], (err, stdout) => {
      const date = err === null ? new Date(stdout.trim()) : null;
      ok(date !== null && !Number.isNaN(date.getTime()) ? date : null);
    });
  });
}

/**
 * Whether a recorded owner really holds the lock. The record outlives a crash
 * and its pid can be reused, so a live pid alone proves nothing. Node has no
 * flock, so this asks what a real owner would still be doing: answering on its
 * socket, or, with no socket recorded, having started no later than the record.
 * What cannot be told reads as held, so a project in use never reads as free.
 */
async function reallyHeld(record: LockRecord, seams: Required<Pick<RecentsOptions, "pidAlive" | "socketAnswers" | "pidStartedAt">>): Promise<boolean> {
  if (!seams.pidAlive(record.pid)) return false;
  if (record.socket !== undefined) return seams.socketAnswers(record.socket);
  const written = record.started === undefined ? Number.NaN : Date.parse(record.started);
  if (Number.isNaN(written)) return true;
  const started = await seams.pidStartedAt(record.pid);
  // Whole seconds on both sides of this comparison, so allow the same second.
  return started === null || started.getTime() <= written + 1000;
}

/**
 * Stats the manifest, not the folder: TCC denies a folder's contents, and a
 * folder that lost its manifest cannot be reopened either. D5: only a path
 * that is really gone is `missing` (ENOTDIR: a file now sits where the folder
 * was). Any other failure leaves the project intact, so it reads `denied` and
 * never invites removing it.
 */
async function probeStatus(dir: string, openHere: ReadonlySet<string>, seams: Required<Pick<RecentsOptions, "pidAlive" | "socketAnswers" | "pidStartedAt">>, statFile: NonNullable<RecentsOptions["stat"]>): Promise<RecentStatus> {
  let found = false;
  for (const manifest of MANIFESTS) {
    try {
      found = (await statFile(join(dir, manifest))).isFile();
    } catch (e) {
      const code = errorCode(e);
      if (code !== "ENOENT" && code !== "ENOTDIR") return "denied";
    }
    if (found) break;
  }
  if (!found) return "missing";
  if (openHere.has(dir)) return "ok";
  const record = await lockRecord(dir);
  return record !== null && (await reallyHeld(record, seams)) ? "locked" : "ok";
}

export function createRecents(options: RecentsOptions): Recents {
  const { file, excluded, readOnly = false, openDirs = () => [], now = () => new Date(), log = () => undefined } = options;
  const seams = { pidAlive: options.pidAlive ?? pidAlive, socketAnswers: options.socketAnswers ?? socketAnswers, pidStartedAt: options.pidStartedAt ?? pidStartedAt };
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

  const statFile = options.stat ?? stat;
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const lastActiveTimeoutMs = options.lastActiveTimeoutMs ?? LAST_ACTIVE_TIMEOUT_MS;
  // One probe per folder, kept until the stat really returns: a second list must not start another stat on a mount that has not answered the first.
  const probing = new Map<string, Run>();
  let running = 0;
  let stalled = 0;
  const waiting: ((slot: boolean) => void)[] = [];
  const pump = (): void => {
    // Nothing can free a thread but the mounts themselves, so what is still waiting cannot be told now.
    if (stalled >= MAX_STATS_OUT) for (const next of waiting.splice(0)) next(false);
    while (waiting.length > 0 && running < PROBE_SLOTS && running + stalled < MAX_STATS_OUT) {
      running++;
      waiting.shift()!(true);
    }
  };
  const takeSlot = (): Promise<boolean> =>
    new Promise((ok) => {
      waiting.push(ok);
      pump();
    });
  /** Starts the folder's stat once a slot is free; `started` says when, or that no stat could be run. */
  const startRun = (dir: string, openHere: ReadonlySet<string>): Run => {
    let onStarted: (ran: boolean) => void = () => undefined;
    const started = new Promise<boolean>((ok) => {
      onStarted = ok;
    });
    const status = takeSlot()
      .then(async (slot): Promise<RecentStatus> => {
        onStarted(slot);
        if (!slot) return "denied";
        let late = false;
        const timer = setTimeout(() => {
          late = true;
          running--;
          stalled++;
          pump();
        }, probeTimeoutMs);
        try {
          return await probeStatus(dir, openHere, seams, statFile);
        } finally {
          clearTimeout(timer);
          if (late) stalled--;
          else running--;
          pump();
        }
      })
      .finally(() => probing.delete(dir));
    return { started, status };
  };
  /** The status, or `denied` once the folder has taken too long: it may be fine, so it must not read as Missing. */
  const probe = async (dir: string, openHere: ReadonlySet<string>, limitMs: number): Promise<RecentStatus> => {
    let run = probing.get(dir);
    if (run === undefined) {
      run = startRun(dir, openHere);
      probing.set(dir, run);
    }
    // The clock starts with the stat, so time spent queued behind other rows is not held against this one.
    if (!(await Promise.race([run.started, run.status.then(() => false)]))) return run.status;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<RecentStatus>((ok) => {
      timer = setTimeout(() => ok("denied"), limitMs);
    });
    try {
      return await Promise.race([run.status, late]);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    // Status probes run outside the queue: a stalled network mount must not hold up the next write.
    list: async () => {
      const { recents } = await enqueue(read);
      const [skip, openHere] = await Promise.all([canonSet(excluded), canonSet(openDirs())]);
      return Promise.all(
        recents
          .filter((e) => !skip.has(e.dir))
          .map(async (e) => ({
            ...e,
            status: await probe(e.dir, openHere, probeTimeoutMs),
            // Who hides it is the caller's choice: the header lists open projects itself, Welcome has no other way to reach one.
            ...(openHere.has(e.dir) ? { open: true } : {}),
          })),
      );
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
      return { dir: lastActive, status: await probe(lastActive, openHere, lastActiveTimeoutMs) };
    },
  };
}
