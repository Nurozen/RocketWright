/**
 * The window's host context for the Lecturn agent (B12, W3.3).
 *
 * The old chat put per-turn facts in the user message's `<rw-context>`
 * block (B17 removed it). With the embed, the window
 * states them as host context instead: on every selection and page change it
 * sends `embed.setHostContext` (the child calls Lecturn's
 * `updateHostContext` on the project), and Lecturn prefixes the text to each
 * turn. The facts: the current page, the selected parts with their key
 * dimensions (and any other selected refs), the active configuration and the
 * active simulation. The agent resolves `rw:` refs with `rw_model_get`.
 */
import type { RwRef } from "@rw/contracts";
import { parseRef } from "@rw/contracts";
import { entityOf } from "../state/entities.ts";
import type { RpcLike } from "../state/rpc.ts";
import type { AppStore } from "../state/store.ts";
import type { AppState } from "../state/types.ts";

/** Lecturn's cap on host-context text (`apps.updateHostContext`). */
export const HOST_CONTEXT_MAX_BYTES = 4096;

const PAGE_NAMES: Record<AppState["ui"]["page"], string> = {
  assembly: "Design › Assembly",
  components: "Design › Components",
  configurations: "Design › Configurations",
  results: "Results",
  liquid: "Propulsion › Liquid propulsion",
  "propulsion-sim": "Simulate › Propulsion simulation",
};

/** Shape fields that are not lengths (printed as plain numbers). */
const UNITLESS = new Set(["count", "shape_param", "segments", "instances"]);
/** At most this many key dimensions per part. */
const MAX_DIMS = 6;

const num = (v: number): string => String(Number(v.toPrecision(4)));

type Snapshot = NonNullable<AppState["project"]["snapshot"]>;
type Component = NonNullable<Snapshot["evaluated"]>["components"][number];

/** A part's key dimensions: its axial extent, then the shape's numeric fields (SI). */
export function keyDims(c: Component): string[] {
  const dims = [`x ${num(c.x_fore)}–${num(c.x_aft)} m`];
  for (const [k, v] of Object.entries(c.shape as unknown as Record<string, unknown>)) {
    if (dims.length > MAX_DIMS) break;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    dims.push(UNITLESS.has(k) ? `${k} ${num(v)}` : `${k} ${num(v)} m`);
  }
  return dims;
}

/** The configuration the window works with: a selected one, else the model's evaluated one. */
export function activeConfig(s: AppState): string | null {
  for (const r of s.selection.refs) {
    const p = parseRef(r);
    if ("ok" in p && p.ok.kind === "cfg") return p.ok.id;
  }
  return s.project.snapshot?.evaluated?.config ?? null;
}

/** The simulation the window shows: a selected run or sim, else the first one plotted on Results. */
export function activeSim(s: AppState): string | null {
  const runs = s.project.snapshot?.runs.runs ?? [];
  for (const r of s.selection.refs) {
    const p = parseRef(r);
    if (!("ok" in p)) continue;
    if (p.ok.kind === "sim") return p.ok.id;
    if (p.ok.kind === "run") {
      const id = p.ok.id;
      const entry = runs.find((e) => e.run_id === id);
      if (entry !== undefined) return entry.sim;
    }
  }
  const first = s.runs.overlay[0];
  return first === undefined ? null : (first.split("@")[0] ?? null);
}

/** Cuts `text` to `max` UTF-8 bytes on a line break, marking the cut. */
export function clipBytes(text: string, max = HOST_CONTEXT_MAX_BYTES): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= max) return text;
  const marker = "\n… (more selected; read them with rw_model_get)";
  const lines = text.split("\n");
  while (lines.length > 1 && enc.encode(lines.join("\n") + marker).length > max) lines.pop();
  return lines.join("\n") + marker;
}

/** The host-context text for the window's state now (empty without a project). */
export function hostContextText(s: AppState): string {
  const snap = s.project.snapshot;
  if (snap === null) return "";
  const ev = snap.evaluated;
  const lines = ["RocketWright window (refs resolve with rw_model_get):", `- Page: ${s.ui.page} (${PAGE_NAMES[s.ui.page]}${s.ui.tab !== null ? `, tab ${s.ui.tab}` : ""})`];
  const cfg = activeConfig(s);
  if (cfg !== null) lines.push(`- Configuration: rw:cfg/${cfg}${ev?.configs[cfg]?.name ? ` (${ev.configs[cfg]!.name})` : ""}`);
  const sim = activeSim(s);
  if (sim !== null) lines.push(`- Simulation: rw:sim/${sim}${ev?.sims[sim]?.name ? ` (${ev.sims[sim]!.name})` : ""}`);
  const refs = s.selection.refs;
  if (refs.length === 0) lines.push("- Selected: nothing");
  else {
    lines.push("- Selected:");
    for (const ref of refs) lines.push(`  - ${selectedLine(snap, s.runs.overlay, ref)}`);
  }
  return clipBytes(lines.join("\n"));
}

function selectedLine(snap: Snapshot, overlay: readonly string[], ref: RwRef): string {
  const label = entityOf(snap, ref, overlay).label;
  const p = parseRef(ref);
  if ("ok" in p && p.ok.kind === "c" && p.ok.pointer === "") {
    const id = p.ok.id;
    const c = snap.evaluated?.components.find((x) => x.id === id);
    if (c !== undefined) return `[@${label}](${ref}): ${c.shape.type}; ${keyDims(c).join(", ")}`;
  }
  return `[@${label}](${ref})`;
}

export interface HostContextOptions {
  /** Coalesces bursts of changes (a drag selection, a page switch) into one call. */
  delayMs?: number;
  onError?: (e: unknown) => void;
}

/**
 * Keeps the project's host context in step with the window: sends the text
 * now, then again whenever it changes (selection, page, configuration, sim).
 * Returns its stop.
 */
export function startHostContext(store: AppStore, client: Pick<RpcLike, "call">, projectId: string, opts: HostContextOptions = {}): () => void {
  const delay = opts.delayMs ?? 150;
  let sent: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const flush = (): void => {
    timer = null;
    if (stopped) return;
    const s = store.getState();
    if (s.project.projectId !== projectId) return;
    const text = hostContextText(s);
    if (text === sent) return;
    sent = text;
    client.call("embed.setHostContext", { projectId, text }).catch((e: unknown) => {
      if (sent === text) sent = null;
      opts.onError?.(e);
    });
  };
  const schedule = (): void => {
    if (timer === null && !stopped) timer = setTimeout(flush, delay);
  };
  const off = store.subscribe((s, prev) => {
    if (s.selection.refs !== prev.selection.refs || s.ui.page !== prev.ui.page || s.ui.tab !== prev.ui.tab || s.project.snapshot !== prev.project.snapshot || s.runs.overlay !== prev.runs.overlay) schedule();
  });
  flush();
  return () => {
    stopped = true;
    off();
    if (timer !== null) clearTimeout(timer);
  };
}
