/**
 * Run data for the plots, trajectory, and CSV export. Series are fetched over
 * HTTP at `SERIES_PATH` and the run's flight events at `EVENTS_PATH` (IF10;
 * never over RPC). A run's files are immutable
 * (`run_id` is the hash of its inputs, I7), so results are cached per run.
 */
import { useEffect, useState } from "react";
import { EVENTS_PATH, SERIES_PATH, type schema } from "@rw/contracts";
import type { FlightEvent } from "../../plots/events.ts";
import { parseSeriesCsv, type Series } from "../../plots/series.ts";

export interface RunData {
  series: Series;
  /** `events.json`; `null` when the source could not serve it (the plots then omit event lines that need it). */
  events?: FlightEvent[] | null;
  /** The run's own diagnostics, when the source has them. */
  diagnostics?: schema.Diagnostic[] | null;
}

export interface RunKey {
  sim: string;
  runId: string;
}

export interface RunDataSource {
  load(projectId: string, key: RunKey): Promise<RunData>;
}

export const runKey = (k: RunKey): string => `${k.sim}/${k.runId}`;

function runFileUrl(pattern: string, baseUrl: string, projectId: string, key: RunKey): string {
  const path = pattern.replace(":projectId", encodeURIComponent(projectId))
    .replace(":sim", encodeURIComponent(key.sim))
    .replace(":runId", encodeURIComponent(key.runId));
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** `<base>/api/projects/<p>/runs/<sim>/<runId>/series.csv` */
export function seriesUrl(baseUrl: string, projectId: string, key: RunKey): string {
  return runFileUrl(SERIES_PATH, baseUrl, projectId, key);
}

/** `<base>/api/projects/<p>/runs/<sim>/<runId>/events.json` */
export function eventsUrl(baseUrl: string, projectId: string, key: RunKey): string {
  return runFileUrl(EVENTS_PATH, baseUrl, projectId, key);
}

/** The events of an `events.json` body (`RunEvents`), or `null` when it is not one. */
export function parseRunEvents(text: string): FlightEvent[] | null {
  try {
    const v = JSON.parse(text) as { events?: unknown };
    return Array.isArray(v.events) ? (v.events as FlightEvent[]) : null;
  } catch {
    return null;
  }
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * The server's run endpoints (`baseUrl` = `http://127.0.0.1:<port>`, or `""`
 * for same origin). The series is required; missing events are `null`.
 */
export function httpRunSource(baseUrl: string, fetchFn: FetchLike = (u) => fetch(u)): RunDataSource {
  const events = async (projectId: string, key: RunKey): Promise<FlightEvent[] | null> => {
    try {
      const res = await fetchFn(eventsUrl(baseUrl, projectId, key));
      return res.ok ? parseRunEvents(await res.text()) : null;
    } catch {
      return null;
    }
  };
  return {
    async load(projectId, key) {
      const [res, ev] = await Promise.all([fetchFn(seriesUrl(baseUrl, projectId, key)), events(projectId, key)]);
      if (!res.ok) throw new Error(`series ${runKey(key)}: HTTP ${res.status}`);
      return { series: parseSeriesCsv(await res.text()), events: ev };
    },
  };
}

/** Memoizes `load` per project and run (failed loads are retried on the next call). */
export function cachedSource(inner: RunDataSource): RunDataSource {
  const cache = new Map<string, Promise<RunData>>();
  return {
    load(projectId, key) {
      const k = `${projectId}|${runKey(key)}`;
      let p = cache.get(k);
      if (p === undefined) {
        p = inner.load(projectId, key);
        cache.set(k, p);
        p.catch(() => cache.delete(k));
      }
      return p;
    },
  };
}

export type RunDataState = { status: "loading" } | { status: "ready"; data: RunData } | { status: "error"; error: string };

/** Loads every keyed run; the map is keyed by `runKey`. */
export function useRunData(source: RunDataSource | null, projectId: string | null, keys: readonly RunKey[]): Record<string, RunDataState> {
  const [state, setState] = useState<Record<string, RunDataState>>({});
  const sig = keys.map(runKey).join("|");
  useEffect(() => {
    if (source === null || projectId === null) return;
    let live = true;
    for (const key of keys) {
      const k = runKey(key);
      setState((s) => (s[k]?.status === "ready" ? s : { ...s, [k]: { status: "loading" } }));
      source.load(projectId, key).then(
        (data) => live && setState((s) => ({ ...s, [k]: { status: "ready", data } })),
        (e: unknown) => live && setState((s) => ({ ...s, [k]: { status: "error", error: e instanceof Error ? e.message : String(e) } })),
      );
    }
    return () => {
      live = false;
    };
    // `sig` captures `keys` by value.
  }, [source, projectId, sig]);
  return state;
}
