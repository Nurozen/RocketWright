/**
 * Components tree for the left rail (concept 01): one row per evaluated
 * component, nested under the body it mounts in (the airframe stack is the
 * top level), with a part icon, an eye toggle, and a disclosure toggle on
 * rows with children. Rows share the store selection with the viewport and
 * inspector.
 */
import type { schema } from "@rw/contracts";
import { Icon, type IconName } from "../../shell/Icon.tsx";
import { PartThumb } from "../../render/PartThumb.tsx";
import type { DeepReadonly } from "../../state/index.ts";

type EvalComponent = schema.EvalComponent;

export interface TreeRow {
  id: string;
  label: string;
  icon: IconName;
  hidden: boolean;
  selected: boolean;
  /** Nesting level (0 = airframe stack). */
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  /** Rendered part thumbnail (M3.6), when cached; the line icon otherwise. */
  thumb?: string;
}

/** Part icon for a component (by kind, refined by name and look). */
export function iconFor(c: DeepReadonly<EvalComponent>): IconName {
  const kind = c.shape.type;
  const name = c.name.toLowerCase();
  switch (kind) {
    case "nose_cone":
      return "nose-cone";
    case "body_tube":
      return /recovery|payload/.test(name) || c.appearance?.preset === "clear_polycarbonate" ? "recovery-bay" : "body-tube";
    case "transition":
      return "transition";
    case "coupler":
      return "coupler";
    case "inner_tube":
      return /motor|casing/.test(name) ? "motor" : "inner-tube";
    case "centering_ring":
      return "centering-ring";
    case "bulkhead":
      return "bulkhead";
    case "parachute":
      return "parachute";
    case "streamer":
      return "streamer";
    case "shock_cord":
      return "shock-cord";
    case "mass_component":
      return /electronic|avionic|altimeter/.test(name) || c.appearance?.preset === "pcb_green" ? "electronics-bay" : "mass";
    case "launch_lug":
      return "launch-lug";
    case "rail_button":
      return "rail-button";
    case "tank":
      return "tank";
    case "engine_block":
      return "motor";
    default:
      return kind.endsWith("fin_set") ? "fin-set" : "body-tube";
  }
}

/**
 * Tree label: the name, with the instance count of an instanced part
 * (`Fins (4)`, concept 01) unless the name already ends in a parenthetical.
 */
export function treeLabel(c: DeepReadonly<EvalComponent>): string {
  const n = c.instances?.length ?? 0;
  return n > 1 && !/\)\s*$/.test(c.name) ? `${c.name} (${n})` : c.name;
}

/** Airframe-stack kinds: top-level rows (each continues the previous one, so their `parent` chain is not nesting). */
const STACK_KINDS = new Set(["nose_cone", "body_tube", "transition"]);

/**
 * Tree parent of a component: none for the airframe stack, else its attach
 * parent (fins, rings, and contents nest under the body they mount in).
 */
export function treeParent(c: DeepReadonly<EvalComponent>, ids: ReadonlySet<string>): string | null {
  if (STACK_KINDS.has(c.shape.type)) return null;
  const p = c.parent ?? null;
  return p !== null && p !== c.id && ids.has(p) ? p : null;
}

/**
 * Rows in depth-first model order, every component once (C §4.1: nested
 * parts). Children of a `collapsed` row are omitted unless one of them is
 * selected (the selection is always visible).
 */
export function treeRows(
  components: readonly DeepReadonly<EvalComponent>[],
  hidden: readonly string[],
  selected: readonly string[],
  collapsed: readonly string[] = [],
): TreeRow[] {
  const h = new Set(hidden);
  const s = new Set(selected);
  const ids = new Set(components.map((c) => c.id));
  const parentOf = new Map(components.map((c) => [c.id, treeParent(c, ids)] as const));
  const kids = new Map<string | null, DeepReadonly<EvalComponent>[]>();
  for (const c of components) {
    const p = parentOf.get(c.id) ?? null;
    kids.set(p, [...(kids.get(p) ?? []), c]);
  }
  // Ancestors of a selected part stay open.
  const open = new Set<string>();
  for (const id of s) for (let p = parentOf.get(id) ?? null; p !== null && !open.has(p); p = parentOf.get(p) ?? null) open.add(p);
  const shut = new Set(collapsed.filter((id) => !open.has(id)));
  const out: TreeRow[] = [];
  const seen = new Set<string>();
  const visit = (c: DeepReadonly<EvalComponent>, depth: number) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    const children = kids.get(c.id) ?? [];
    const isShut = children.length > 0 && shut.has(c.id);
    out.push({
      id: c.id,
      label: treeLabel(c),
      icon: iconFor(c),
      hidden: h.has(c.id),
      selected: s.has(c.id),
      depth,
      hasChildren: children.length > 0,
      collapsed: isShut,
    });
    if (!isShut) for (const k of children) visit(k, depth + 1);
  };
  for (const c of kids.get(null) ?? []) visit(c, 0);
  // Defensive: a parent cycle leaves parts unvisited; list them at the top level.
  for (const c of components) if (!seen.has(c.id) && !isUnder(c.id, shut, parentOf)) visit(c, 0);
  return out;
}

function isUnder(id: string, shut: ReadonlySet<string>, parentOf: ReadonlyMap<string, string | null>): boolean {
  const guard = new Set<string>();
  for (let p = parentOf.get(id) ?? null; p !== null && !guard.has(p); p = parentOf.get(p) ?? null) {
    if (shut.has(p)) return true;
    guard.add(p);
  }
  return false;
}

export interface ComponentTreeProps {
  rows: TreeRow[];
  /** `additive`: Cmd/Ctrl/Shift-click adds or removes the row from a multi-selection. */
  onSelect(id: string, additive?: boolean): void;
  onToggleHidden(id: string): void;
  /** Expands or collapses a row with children. */
  onToggleCollapsed?(id: string): void;
}

export function ComponentTree({ rows, onSelect, onToggleHidden, onToggleCollapsed }: ComponentTreeProps) {
  return (
    <ul className="rw-list rw-asm-tree" role="tree" aria-label="Components" data-testid="tree" data-count={rows.length}>
      {rows.map((r) => (
        <li
          key={r.id}
          className="rw-nav-row rw-asm-tree__row"
          role="treeitem"
          data-testid="rail.nav-row"
          data-part={r.id}
          data-depth={r.depth}
          data-hidden={r.hidden ? "true" : undefined}
          aria-level={r.depth + 1}
          aria-selected={r.selected}
          {...(r.hasChildren ? { "aria-expanded": !r.collapsed } : {})}
          onClick={(e) => onSelect(r.id, e.metaKey || e.ctrlKey || e.shiftKey)}
        >
          <button
            type="button"
            className="rw-asm-tree__eye"
            data-testid="tree.eye"
            aria-pressed={!r.hidden}
            aria-label={r.hidden ? `Show ${r.label}` : `Hide ${r.label}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleHidden(r.id);
            }}
          >
            <Icon name={r.hidden ? "eye-off" : "eye"} size={18} />
          </button>
          <span className="rw-asm-tree__indent" style={{ width: r.depth * 18 }} aria-hidden />
          <PartThumb url={r.thumb} icon={r.icon} size={r.depth > 0 ? 26 : 28} width={r.depth > 0 ? 18 : 20} testId="tree.thumbnail" className="rw-asm-tree__thumb" />
          <span className="rw-asm-tree__label">{r.label}</span>
          {r.hasChildren && (
            <button
              type="button"
              className="rw-asm-tree__twisty"
              data-testid="tree.twisty"
              aria-label={r.collapsed ? `Expand ${r.label}` : `Collapse ${r.label}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleCollapsed?.(r.id);
              }}
            >
              <Icon name={r.collapsed ? "chevron-right" : "chevron-down"} size={16} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
