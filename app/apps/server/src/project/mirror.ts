/**
 * The sidecar resources the project mirror tracks (IF10 `ProjectSnapshot`),
 * and which snapshot keys each `notifications/resources/updated` refreshes.
 */
import type { JobInfo, SnapshotKey } from "@rw/contracts";

/** Mirrored resources, in the order they are first read. */
export const MIRROR_RESOURCES = {
  evaluated: "rw://project/model",
  check: "rw://project/check",
  files: "rw://project/files",
  history: "rw://project/history",
  runs: "rw://runs/index",
} as const satisfies Partial<Record<SnapshotKey, string>>;

export type MirrorKey = keyof typeof MIRROR_RESOURCES;
export const MIRROR_KEYS = Object.keys(MIRROR_RESOURCES) as MirrorKey[];

export const JOB_URI_PREFIX = "rw://jobs/";
export const jobUri = (jobId: string): string => `${JOB_URI_PREFIX}${jobId}`;

/** Snapshot keys a resource URI refreshes (`[]` for URIs the mirror ignores). */
export function mirrorKeysFor(uri: string): MirrorKey[] {
  for (const k of MIRROR_KEYS) if (MIRROR_RESOURCES[k] === uri) return [k];
  if (uri.startsWith("rw://runs/")) return ["runs"];
  return [];
}

/** `rw://jobs/<id>` → `<id>`. */
export function jobIdOf(uri: string): string | undefined {
  return uri.startsWith(JOB_URI_PREFIX) && uri.length > JOB_URI_PREFIX.length ? uri.slice(JOB_URI_PREFIX.length) : undefined;
}

export const isTerminal = (j: Pick<JobInfo, "state">): boolean => j.state === "complete" || j.state === "failed" || j.state === "cancelled";
