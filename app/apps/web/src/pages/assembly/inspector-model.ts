/**
 * Inspector cards for page 01 (concepts.md §4.1): Attachment, Mass, and
 * Clearance for one component, derived only from the evaluated model (attach
 * graph, joints) and the CheckReport (dims, mass rows, clearance results,
 * clearance diagnostics). The same numbers `rw check --json` emits
 * (concepts.md §5.6, headless parity); nothing is computed here but unit
 * conversion and labels.
 */
import type { CheckReport, EvaluatedModel, schema } from "@rw/contracts";
import type { DeepReadonly, Units } from "../../state/index.ts";

type Clearance = schema.Clearance;
type ComponentDims = schema.ComponentDims;
type EvalComponent = schema.EvalComponent;
type Joint = schema.Joint;

export interface InspectorRow {
  key: string;
  label: string;
  value: string;
  /** Clearance rows: the rule's pass state. */
  pass?: boolean;
  severity?: "warning" | "error";
}

export interface InspectorView {
  id: string;
  title: string;
  attachment: InspectorRow[];
  mass: InspectorRow[];
  clearance: InspectorRow[];
}

export const UNITS: readonly Units[] = ["mm", "cm", "m", "in"];

const LENGTH: Record<Units, { per: number; digits: number }> = {
  mm: { per: 1000, digits: 1 },
  cm: { per: 100, digits: 2 },
  m: { per: 1, digits: 4 },
  in: { per: 1 / 0.0254, digits: 2 },
};

const DASH = "—";

function trim(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Metres -> display length in `units` (`120 mm`, `5.18 cm`, `2.13 in`). */
export function formatLength(m: number | null | undefined, units: Units): string {
  if (m == null || !Number.isFinite(m)) return DASH;
  const u = LENGTH[units];
  return `${trim((m * u.per).toFixed(u.digits))} ${units}`;
}

/** Kilograms with three significant figures (`0.054 kg`, `1.25 kg`). */
export function formatMass(kg: number | null | undefined): string {
  if (kg == null || !Number.isFinite(kg)) return DASH;
  if (kg === 0) return "0 kg";
  return `${trim(kg < 1 ? Number(kg.toPrecision(3)).toString() : kg.toFixed(2))} kg`;
}

/** Cubic metres -> cm³ (metric) or in³. */
export function formatVolume(m3: number, units: Units): string {
  if (!Number.isFinite(m3)) return DASH;
  if (units === "in") return `${trim((m3 / 0.0254 ** 3).toFixed(1))} in³`;
  if (units === "m") return `${trim((m3 * 1000).toFixed(3))} L`;
  return `${trim((m3 * 1e6).toFixed(0))} cm³`;
}

function formatDim(v: number, dim: string, units: Units): string {
  if (dim === "volume") return formatVolume(v, units);
  if (dim === "length") return formatLength(v, units);
  if (dim === "mass") return formatMass(v);
  return trim(v.toPrecision(3));
}

/**
 * `actual / ≥ required` with the unit written once when both share it
 * (`253 / ≥ 127 cm³`, `40.4 / ≥ 40.2 mm`), so a rule row fits one line.
 */
export function formatPair(actual: number, required: number, dim: string, units: Units): string {
  const a = formatDim(actual, dim, units);
  const r = formatDim(required, dim, units);
  const sa = a.lastIndexOf(" ");
  const sr = r.lastIndexOf(" ");
  if (sa > 0 && sr > 0 && a.slice(sa) === r.slice(sr)) return `${a.slice(0, sa)} / ≥ ${r}`;
  return `${a} / ≥ ${r}`;
}

const RULE_LABELS: Record<string, string> = {
  coupler_fit: "Coupler fit",
  motor_fit: "Motor fit",
  fin_tab_wall: "Fin tab wall",
  fin_across_joint: "Fin across joint",
  recovery_volume: "Recovery volume",
  rail_button_alignment: "Rail button alignment",
  centering_ring_fit: "Centering ring fit",
};

const JOINT_LABELS: Record<string, string> = {
  friction: "Friction fit",
  twist_lock: "Twist lock",
  shear_pin: "Shear pins",
  screw: "Screws",
};

export function jointLabel(j: DeepReadonly<Joint> | null | undefined): string {
  if (!j) return "None";
  const base = JOINT_LABELS[j.type] ?? j.type.replace(/_/g, " ");
  return j.count != null && j.count > 0 ? `${base} (${j.count}×)` : base;
}

function anchorLabel(name: string): string {
  return name.replace(/_(fore|aft)$/, "").replace(/_/g, " ");
}

type Comp = DeepReadonly<EvalComponent>;

/** `<id>.<anchor>` -> "To <Name> (<anchor>)". */
function attachTarget(to: string, byId: Map<string, Comp>, prep = "To"): string {
  const dot = to.lastIndexOf(".");
  const id = dot < 0 ? to : to.slice(0, dot);
  const anchor = dot < 0 ? "" : to.slice(dot + 1);
  const name = byId.get(id)?.name ?? id;
  return anchor ? `${prep} ${name} (${anchorLabel(anchor)})` : `${prep} ${name}`;
}

function attachmentRows(c: Comp, model: DeepReadonly<EvaluatedModel>, byId: Map<string, Comp>, units: Units): InspectorRow[] {
  const locking: InspectorRow = { key: "locking", label: "Locking", value: jointLabel(c.joint) };
  if (c.containment === "axial") {
    const upper = c.attach ? attachTarget(c.attach.to, byId) : "None (top of stack)";
    const below = model.components.filter((o) => o.attach?.to === `${c.id}.aft` && o.containment === "axial");
    const lower = below.length > 0 ? below.map((o) => `To ${o.name} (${anchorLabel(o.attach!.at)})`).join(", ") : "None";
    return [{ key: "upper", label: "Upper", value: upper }, { key: "lower", label: "Lower", value: lower }, locking];
  }
  const prep = c.containment === "inner" ? "In" : "On";
  const mount = c.attach ? attachTarget(c.attach.to, byId, prep) : DASH;
  const offset = c.attach && c.attach.offset !== 0 ? `${c.attach.offset > 0 ? "+" : "−"}${formatLength(Math.abs(c.attach.offset), units)}` : `0 ${units}`;
  return [{ key: "mount", label: "Mount", value: mount }, { key: "offset", label: "Offset", value: offset }, locking];
}

function dimsOf(check: DeepReadonly<CheckReport> | null, id: string): DeepReadonly<ComponentDims> | undefined {
  return check?.dims.components.find((d) => d.component === id);
}

function massRows(c: Comp, check: DeepReadonly<CheckReport> | null, units: Units): InspectorRow[] {
  const row = check?.mass.components.find((m) => m.component === c.id);
  const d = dimsOf(check, c.id);
  return [
    { key: "mass", label: "Mass", value: row ? `${formatMass(row.mass)}${row.override ? " (override)" : ""}` : DASH },
    { key: "length", label: "Length", value: formatLength(d?.length ?? null, units) },
    { key: "od", label: "Outer dia.", value: formatLength(d?.od ?? null, units) },
  ];
}

function descendants(id: string, byId: Map<string, Comp>): string[] {
  const out: string[] = [];
  const stack = [...(byId.get(id)?.children ?? [])];
  while (stack.length > 0) {
    const k = stack.pop()!;
    const c = byId.get(k);
    if (!c || c.containment === "axial") continue; // the next stack section is not part of this one
    out.push(k);
    stack.push(...c.children);
  }
  return out;
}

function clearanceRows(c: Comp, check: DeepReadonly<CheckReport> | null, byId: Map<string, Comp>, units: Units): InspectorRow[] {
  const own = dimsOf(check, c.id);
  const hostId = c.containment === "axial" ? c.id : (c.parent ?? null);
  const hostDims = hostId === null ? undefined : dimsOf(check, hostId);
  const fits = hostDims?.id != null ? `${formatLength(hostDims.id, units)} (ID)` : DASH;

  const rules = (check?.clearance ?? []).filter((r) => r.a === c.id || r.b === c.id) as readonly DeepReadonly<Clearance>[];
  const lengthRules = rules.filter((r) => r.dim === "length");
  const key = lengthRules.find((r) => !r.pass) ?? lengthRules[0] ?? rules.find((r) => !r.pass) ?? rules[0];
  const required = key ? `≥ ${formatDim(key.required, key.dim, units)}` : DASH;

  let total: string = DASH;
  if (own) {
    const span = [c.id, ...descendants(c.id, byId)].map((id) => dimsOf(check, id)).filter((d) => d !== undefined);
    const lo = Math.min(...span.map((d) => d.x_fore));
    const hi = Math.max(...span.map((d) => d.x_aft));
    total = formatLength(hi - lo, units);
  }

  const rows: InspectorRow[] = [
    { key: "fits", label: "Fits inside", value: fits },
    { key: "required", label: "Required", value: required, ...(key ? { pass: key.pass } : {}) },
    { key: "total", label: "Total length", value: total },
  ];
  // One row per distinct finding: a bay holding two recovery items reports
  // `recovery_volume` once per item with the same numbers; and the key rule
  // is already read off "Fits inside" + "Required" when its actual is the
  // host bore shown there.
  const seen = new Set<string>();
  for (const r of rules) {
    const label = RULE_LABELS[r.rule] ?? r.rule;
    const value = formatPair(r.actual, r.required, r.dim, units);
    if (r === key && r.dim === "length" && hostDims?.id != null && formatLength(r.actual, units) === formatLength(hostDims.id, units)) continue;
    const sig = `${label}\u0000${value}\u0000${String(r.pass)}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    rows.push({ key: `rule:${r.rule}:${r.a}:${r.b ?? ""}`, label, value, pass: r.pass });
  }
  // Clearance-range diagnostics (I9: E150-199 / W150-199) pointing at this component.
  for (const d of check?.diagnostics ?? []) {
    const m = /^RW-[EW](\d{3})$/.exec(d.code);
    const n = m ? Number(m[1]) : NaN;
    if (!(n >= 150 && n <= 199)) continue;
    if (d.path !== `/c/${c.id}` && !d.path?.startsWith(`/c/${c.id}/`)) continue;
    if (rows.some((x) => x.label === d.code && x.value === d.message)) continue;
    const n0 = rows.filter((x) => x.label === d.code).length;
    rows.push({ key: n0 === 0 ? `diag:${d.code}` : `diag:${d.code}:${n0}`, label: d.code, value: d.message, severity: d.severity === "error" ? "error" : "warning", pass: false });
  }
  return rows;
}

/** The inspector for component `id`, or null when the model does not have it. */
export function inspectorView(
  id: string,
  model: DeepReadonly<EvaluatedModel> | null,
  check: DeepReadonly<CheckReport> | null,
  units: Units,
): InspectorView | null {
  if (!model) return null;
  const byId = new Map(model.components.map((c) => [c.id, c] as const));
  const c = byId.get(id);
  if (!c) return null;
  return {
    id,
    title: c.name,
    attachment: attachmentRows(c, model, byId, units),
    mass: massRows(c, check, units),
    clearance: clearanceRows(c, check, byId, units),
  };
}
