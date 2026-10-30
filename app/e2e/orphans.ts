/**
 * Teardown safety net for desktop specs (CPW1R5A): processes a run left
 * behind, found by a path only that run used (its temp project, its Lecturn
 * dirs) in their command line. The desktop's own quit now stops its server
 * and sidecars (`apps/desktop/src/quit.ts`); a leftover means that broke, so
 * it is killed (it would starve the next spec's browser) and reported.
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

/** Kills (SIGKILL) what `processesNaming` finds and returns their command lines. */
export function killOrphans(markers: readonly string[]): string[] {
  let out = "";
  try {
    out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return [];
  }
  const left = processesNaming(markers, parsePs(out));
  for (const p of left) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  return left.map((p) => `${p.pid} ${p.command.slice(0, 200)}`);
}
