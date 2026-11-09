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
import { matchesRailSearch } from "../../shell/railSearch.ts";
import type { DeepReadonly } from "../../state/index.ts";
import type { PartKind } from "../../state/ops/parts.ts";

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

const KIND_ICON: Partial<Record<PartKind, IconName>> = {
  nose_cone: "nose-cone",
  body_tube: "body-tube",
  transition: "transition",
  coupler: "coupler",
  inner_tube: "inner-tube",
  centering_ring: "centering-ring",
  bulkhead: "bulkhead",
  parachute: "parachute",
  streamer: "streamer",
  shock_cord: "shock-cord",
  mass_component: "mass",
  launch_lug: "launch-lug",
  rail_button: "rail-button",
  tank: "tank",
  engine_block: "motor",
};

/** The line icon of a part kind (a palette tile; a tree row refines it with `iconFor`). */
export function kindIcon(kind: PartKind): IconName {
  return KIND_ICON[kind] ?? (kind.endsWith("fin_set") ? "fin-set" : "body-tube");
}

/** Part icon for a component (by kind, refined by name and look). */
export function iconFor(c: DeepReadonly<EvalComponent>): IconName {
  const kind = c.shape.type;
  const name = c.name.toLowerCase();
  if (kind === "body_tube" && (/recovery|payload/.test(name) || c.appearance?.preset === "clear_polycarbonate")) return "recovery-bay";
  if (kind === "inner_tube" && /motor|casing/.test(name)) return "motor";
  if (kind === "mass_component" && (/electronic|avionic|altimeter/.test(name) || c.appearance?.preset === "pcb_green")) return "electronics-bay";
  return kindIcon(kind);
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
  /** A right-click on a row, at that window position. */
  onContextMenu?(id: string, at: { x: number; y: number; band: { top: number; bottom: number } }): void;
}

export function ComponentTree({ rows, onSelect, onToggleHidden, onToggleCollapsed, onContextMenu }: ComponentTreeProps) {
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
          onContextMenu={(e) => {
            if (onContextMenu === undefined) return;
            e.preventDefault();
            const row = e.currentTarget.getBoundingClientRect();
            onContextMenu(r.id, { x: e.clientX, y: e.clientY, band: { top: row.top, bottom: row.bottom } });
          }}
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

/** The rows the rail search keeps: the matches and every ancestor, so the tree shape stays readable. */
export function matchingTreeRows(rows: readonly TreeRow[], query: string): TreeRow[] {
  if (query === "") return [...rows];
  const keep = new Set<number>();
  const ancestors: number[] = [];
  rows.forEach((r, i) => {
    ancestors.length = Math.min(ancestors.length, r.depth);
    if (matchesRailSearch(r.label, query)) {
      keep.add(i);
      for (const a of ancestors) keep.add(a);
    }
    ancestors.push(i);
  });
  return rows.filter((_, i) => keep.has(i));
}
