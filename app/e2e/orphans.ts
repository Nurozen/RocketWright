/**
 * Teardown safety net for desktop specs (CPW1R5A): processes a run left
 * behind, found by a path only that run used (its temp project, its Lecturn
 * dirs) in their command line. The desktop's own quit now stops its server
 * and sidecars (`apps/desktop/src/quit.ts`); a leftover means that broke, so
 * it is killed (it would starve the next spec's browser) and reported.
 *
 * B1 kills more narrowly: only processes it saw descend from its own Electron
 * (`processTreeOf`, `killStarted`), matched by pid and command, so a pid the
 * system reused is safe and a path match alone never kills anything.
 */
import { execFileSync } from "node:child_process";

export interface Proc {
  pid: number;
  command: string;
}

/** `ps -axo pid=,command=` rows. */
export function parsePs(out: string): Proc[] {
  const rows: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m !== null) rows.push({ pid: Number(m[1]), command: m[2]! });
  }
  return rows;
}

/** The processes (never this one or its parent) whose command line names any of `markers`. */
export function processesNaming(markers: readonly string[], rows: readonly Proc[], self: readonly number[] = [process.pid, process.ppid]): Proc[] {
  const ms = markers.filter((m) => m.length > 4);
  if (ms.length === 0) return [];
  return rows.filter((p) => !self.includes(p.pid) && ms.some((m) => p.command.includes(m)));
}

function ps(columns: string): string | null {
  try {
    return execFileSync("ps", ["-axo", columns], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** Every process on this machine now; empty if `ps` fails. */
export function currentProcs(): Proc[] {
  return parsePs(ps("pid=,command=") ?? "");
}

/** What `processesNaming` finds on this machine now; empty if `ps` fails. */
export function findOrphans(markers: readonly string[]): Proc[] {
  return processesNaming(markers, currentProcs());
}

export interface TreeProc extends Proc {
  ppid: number;
}

/** `ps -axo pid=,ppid=,command=` rows. */
export function parsePsTree(out: string): TreeProc[] {
  const rows: TreeProc[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m !== null) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! });
  }
  return rows;
}

/** `root` and everything below it in `rows`. */
export function withDescendants(root: number, rows: readonly TreeProc[]): TreeProc[] {
  const found = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of rows) {
      if (found.has(p.ppid) && !found.has(p.pid)) {
        found.add(p.pid);
        grew = true;
      }
    }
  }
  return rows.filter((p) => found.has(p.pid));
}

/** The process `root` and its descendants now; empty if `ps` fails. */
export function processTreeOf(root: number): Proc[] {
  return withDescendants(root, parsePsTree(ps("pid=,ppid=,command=") ?? ""));
}

/** Pid to the command it had when this run saw it start. */
export type StartedProcs = ReadonlyMap<number, string>;

/** The rows that are still the processes in `started`: a reused pid has another command. */
export function stillRunning(started: StartedProcs, rows: readonly Proc[]): Proc[] {
  return rows.filter((p) => started.get(p.pid) === p.command);
}

/** Kills (SIGKILL) only what is still running from `started` and returns their command lines. */
export function killStarted(started: StartedProcs, rows: readonly Proc[] = currentProcs()): string[] {
  const left = stillRunning(started, rows);
  for (const p of left) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  return left.map((p) => `${p.pid} ${p.command.slice(0, 200)}`);
}

/** Kills (SIGKILL) what `findOrphans` finds and returns their command lines. */
export function killOrphans(markers: readonly string[]): string[] {
  const left = findOrphans(markers);
  for (const p of left) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  return left.map((p) => `${p.pid} ${p.command.slice(0, 200)}`);
}
