/**
 * `target/bar/e2e/b1/progress.json`: the B1 countdown. Apart from the stages
 * because the drive's source scan bans file writes there.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { barOutDir } from "./bar/paths.ts";
import type { BoundRow } from "./case1-script.ts";
import type { RowStatus, StageId } from "./case1-stages.ts";

export interface ProgressRow {
  key: string;
  stage: StageId;
  part: string | null;
  label: string;
  status: RowStatus;
}

export interface Progress {
  counts: Record<RowStatus, number>;
  rows: ProgressRow[];
}

export const progressPath = (): string => join(barOutDir(), "e2e/b1/progress.json");

export function buildProgress(rows: readonly BoundRow[], statuses: ReadonlyMap<string, RowStatus>): Progress {
  const counts: Record<RowStatus, number> = { reached: 0, "not-found": 0, "wrong-unit": 0, pending: 0 };
  const out: ProgressRow[] = rows.map((row) => {
    const status = statuses.get(row.key) ?? "pending";
    counts[status] += 1;
    return { key: row.key, stage: row.stage, part: row.part ?? row.dialog ?? null, label: row.label, status };
  });
  return { counts, rows: out };
}

export function writeProgress(progress: Progress, path: string = progressPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(progress, null, 2)}\n`);
}
