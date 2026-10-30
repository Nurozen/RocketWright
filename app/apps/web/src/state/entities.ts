/**
 * Entity references (C §5.1): resolves `rw:` refs against the project mirror
 * to a display name, a thumbnail icon, and a series colour (labels for the
 * embed's `rw:` chips and the host context, the rail, the shell). Runs are
 * addressed per sim (`rw:sim/<id>`, the Results row) until a run id exists
 * (`rw:run/<run_id>`).
 */
import type { PageId, ProjectSnapshot, RwRef } from "@rw/contracts";
import { parseRef } from "@rw/contracts";
import type { IconName } from "../shell/Icon.tsx";
import { SERIES_COLORS, type DeepReadonly } from "../state/types.ts";
import { stepNumber } from "../shell/format.ts";

type Snapshot = DeepReadonly<ProjectSnapshot>;

export type EntityKind = "component" | "run" | "config" | "step" | "revision" | "engine" | "thread" | "other";

export interface EntityView {
  ref: RwRef;
  kind: EntityKind;
  label: string;
  icon: IconName;
  /** Series colour dot (runs that are overlaid on the plots). */
  color?: string;
  /** Rendered part thumbnail (M3.6; components only, once cached). */
  thumb?: string;
}

/**
 * Adds the entity's rendered thumbnail when there is one: a component's
 * (M3.6 `thumbs.urls`, keyed by component id), or an engine feed node's
 * (`rw:eng/<id>/feed/node/<n>`, keyed by `engineNodeThumbKey`).
 */
export function withThumb<E extends EntityView>(e: E, urls: Readonly<Record<string, string>>): E {
  let url: string | undefined;
  if (e.kind === "component" && e.ref.startsWith("rw:c/")) url = urls[e.ref.slice("rw:c/".length)];
  else if (e.kind === "engine") url = engineNodeThumbOf(e.ref, urls);
  return url === undefined ? e : { ...e, thumb: url };
}

/**
 * Thumbnail cache key of an engine feed node's rendered picture: the Visual
 * flow tier (page 06) stores the study tank's section (`thumb.put`) under
 * it, so an `@` chip of that tank shows the render.
 */
export const engineNodeThumbKey = (engine: string, node: string): string => `sim-node--${engine}--${node}`;

/** The cached picture of an engine feed node ref (`rw:eng/<id>/feed/node/<n>`), if any. */
export function engineNodeThumbOf(ref: RwRef, urls: Readonly<Record<string, string>>): string | undefined {
  const parsed = parseRef(ref);
  if (!("ok" in parsed) || parsed.ok.kind !== "eng") return undefined;
  const node = /^\/feed\/node\/([^/]+)$/.exec(parsed.ok.pointer)?.[1];
  return node === undefined ? undefined : urls[engineNodeThumbKey(parsed.ok.id, node)];
}

/**
 * Thumbnail cache key of a visual flow study's section view (page 06): the
 * live cutaway frame the Visual flow tier stores (`thumb.put`).
 */
export const sectionThumbKey = (sim: string): string => `sim-${sim}--section`;

const SHAPE_ICONS: Record<string, IconName> = {
  nose_cone: "nose-cone",
  body_tube: "body-tube",
  transition: "transition",
  trapezoidal_fin_set: "fin-set",
  elliptical_fin_set: "fin-set",
  freeform_fin_set: "fin-set",
  tube_fin_set: "fin-set",
  inner_tube: "inner-tube",
  tube_coupler: "coupler",
  centering_ring: "centering-ring",
  bulkhead: "bulkhead",
  engine_block: "bulkhead",
  parachute: "parachute",
  streamer: "streamer",
  shock_cord: "shock-cord",
  mass_component: "mass",
  launch_lug: "launch-lug",
  rail_button: "rail-button",
};

/** Line-icon thumbnail for a component (by shape type, refined by name for bays and motor tubes). */
export function componentIcon(shapeType: string | undefined, name = ""): IconName {
  const n = name.toLowerCase();
  if (shapeType === "body_tube" && /recovery|payload/.test(n)) return "recovery-bay";
  if ((shapeType === "mass_component" || shapeType === "body_tube") && /electronic|avionic|e-?bay/.test(n)) return "electronics-bay";
  if (shapeType === "inner_tube" && /motor/.test(n)) return "motor";
  return (shapeType !== undefined ? SHAPE_ICONS[shapeType] : undefined) ?? "body-tube";
}

const shapeType = (c: { shape?: unknown }): string | undefined =>
  typeof c.shape === "object" && c.shape !== null && "type" in c.shape && typeof c.shape.type === "string" ? c.shape.type : undefined;

/** Series colour of a sim on the plots (A teal, B sand), if overlaid. */
export function seriesColor(overlay: readonly string[], sim: string): string | undefined {
  const i = overlay.indexOf(sim);
  return i >= 0 ? SERIES_COLORS[i] : undefined;
}

/** Display view of `ref` (unknown ids fall back to the id). */
export function entityOf(snap: Snapshot | null, ref: RwRef, overlay: readonly string[] = [], fallbackLabel?: string): EntityView {
  const parsed = parseRef(ref);
  if (!("ok" in parsed)) return { ref, kind: "other", label: fallbackLabel ?? ref, icon: "thread" };
  const { kind, id } = parsed.ok;
  const ev = snap?.evaluated ?? null;
  switch (kind) {
    case "c": {
      const c = ev?.components.find((x) => x.id === id);
      return { ref, kind: "component", label: c?.name ?? fallbackLabel ?? id, icon: componentIcon(c ? shapeType(c) : undefined, c?.name) };
    }
    case "sim":
    case "run": {
      const runs = snap?.runs.runs ?? [];
      const entry = kind === "sim" ? runs.find((r) => r.sim === id) : runs.find((r) => r.run_id === id);
      const label = entry?.sim_name ?? fallbackLabel ?? id;
      const color = entry ? seriesColor(overlay, entry.sim) : undefined;
      return { ref, kind: "run", label, icon: "run", ...(color ? { color } : {}) };
    }
    case "cfg":
      return { ref, kind: "config", label: ev?.configs[id]?.name ?? fallbackLabel ?? id, icon: "rail-button" };
    case "step": {
      const seq = Number(id);
      const step = snap?.history.steps.find((s) => s.seq === seq);
      return { ref, kind: "step", label: step ? `Step ${stepNumber(seq)} · ${step.title}` : (fallbackLabel ?? `Step ${id}`), icon: "history-step" };
    }
    case "rev": {
      const rev = snap?.history.revisions.find((r) => String(r.number) === id || r.id === id);
      return { ref, kind: "revision", label: rev ? `Rev ${stepNumber(rev.number)} · ${rev.name}` : (fallbackLabel ?? `Rev ${id}`), icon: "history-step" };
    }
    case "eng": {
      // A feed node or line of the engine (`rw:eng/<id>/feed/node/<n>`, `.../feed/edge/<i>`) shows its own icon.
      const ptr = parsed.ok.pointer;
      const node = /^\/feed\/node\/([^/]+)$/.exec(ptr)?.[1];
      const kind = node !== undefined ? ev?.engines?.[id]?.nodes[node]?.kind : undefined;
      const icon = kind === "tank" ? "tank" : kind === "valve" ? "valve" : kind === "sensor" ? "sensor" : /^\/feed(\/edge\/\d+)?$/.test(ptr) ? "line" : "engine";
      return { ref, kind: "engine", label: fallbackLabel ?? ev?.engines?.[id]?.name ?? id, icon };
    }
    case "thread":
      return { ref, kind: "thread", label: fallbackLabel ?? id, icon: "thread" };
  }
}

/** The page an artifact lives on (thread binding, R6.9). */
export function pageOfRef(ref: RwRef): PageId | null {
  const parsed = parseRef(ref);
  if (!("ok" in parsed)) return null;
  switch (parsed.ok.kind) {
    case "c":
      return "assembly";
    case "cfg":
      return "configurations";
    case "sim":
    case "run":
      return "results";
    case "eng":
      return "liquid";
    default:
      return null;
  }
}
