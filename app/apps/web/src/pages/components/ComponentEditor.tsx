/**
 * Page 02 component editor (concept 02, lower 40% of the workspace,
 * collapsible): tabs Geometry | Material | Appearance | Mass override, two
 * columns of unit-aware spinner fields from the component-type schema
 * (fields.ts), validation messages (local limits plus the check's
 * diagnostics on the part), the live part profile, Modified status, Parts
 * library, and Revert change.
 *
 * Presentational over callbacks: an edit becomes patch ops on the id-keyed
 * model (a draft previewed by rw-wasm, I4); Enter or leaving the field commits
 * it through `model.patch` (I1, I2); Escape discards it.
 */
import { useEffect, useMemo, useState } from "react";
import type { PatchOp, schema } from "@rw/contracts";
import { Icon } from "../../shell/Icon.tsx";
import type { DeepReadonly, Units } from "../../state/index.ts";
import { displayUnit, fromDisplay, limitsOf, rangeError, sharedFields, tabsFor, toDisplay, toSource, type EditorTab, type FieldSpec } from "./fields.ts";
import { FinOutlineEditor } from "./FinOutlineEditor.tsx";
import { PartProfile } from "./PartProfile.tsx";
import { fieldTarget, type SourceFilesLike } from "./source.ts";

type Comp = DeepReadonly<schema.EvalComponent>;
type LibItem = DeepReadonly<schema.LibItem>;
type Diagnostic = schema.Diagnostic;

export interface EditorStatus {
  /** `modified`: the part differs from its previous revision; `unsaved`: an open draft. */
  kind: "modified" | "unsaved" | "clean";
  /** Second half of the status line (`Simulation needs rerun`). */
  detail: string;
  /** Tooltip: where the change came from. */
  title?: string;
}

export interface ComponentEditorProps {
  comps: readonly Comp[];
  files: SourceFilesLike;
  units: Units;
  materials: readonly string[];
  diagnostics: readonly DeepReadonly<Diagnostic>[];
  status: EditorStatus;
  tab: EditorTab;
  onTab: (t: EditorTab) => void;
  collapsed: boolean;
  onCollapse: (c: boolean) => void;
  canRevert: boolean;
  /** Draft edits (previewed); `label` names the history step. */
  onEdit: (ops: PatchOp[], label: string) => void;
  onCommit: () => void;
  onDiscard: () => void;
  onRevert: () => void;
  /** Parts library (D21): presets from `library.search`. */
  library: { state: "idle" | "loading" | "ready" | "error"; items: readonly LibItem[]; error?: string };
  onOpenLibrary: () => void;
  onApplyPreset: (item: LibItem) => void;
  /** Field keys the agent changed in the shown revision (a `Changed by agent` marker under the label). */
  agentChanged?: readonly string[];
}

/**
 * Tooltip of a field fed by a shared parameter or an expression, in words
 * (never the source path `params.fin_span`).
 */
export function linkTitle(param: { name: string; doc?: string } | null, expression: string | null, doc: string | undefined): string | undefined {
  if (param !== null) {
    const name = param.name.replace(/_/g, " ");
    return `Shared value “${name}”${param.doc ? ` (${param.doc})` : ""}: editing it here changes every part that uses it.`;
  }
  if (expression !== null) return "Computed from other values in the model; typing a number here replaces the formula.";
  return doc;
}

const KIND_LABEL: Record<string, string> = {
  trapezoidal_fin_set: "Trapezoidal fin set",
  elliptical_fin_set: "Elliptical fin set",
  freeform_fin_set: "Freeform fin set",
  tube_fin_set: "Tube fin set",
  nose_cone: "Nose cone",
  body_tube: "Body tube",
  inner_tube: "Inner tube",
  centering_ring: "Centering ring",
  mass_component: "Mass component",
  launch_lug: "Launch lug",
  rail_button: "Rail button",
  shock_cord: "Shock cord",
};
const kindLabel = (t: string) => KIND_LABEL[t] ?? t.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The evaluated value behind a field (SI number, enum text, or null). */
export function evaluatedValue(c: Comp, key: string): number | string | null {
  const parts = key.split(".");
  if (parts[0] === "override") {
    const v = (c.override as Record<string, unknown> | null | undefined)?.[parts[1]!];
    return typeof v === "number" ? v : null;
  }
  if (key === "appearance.preset") return c.appearance?.preset ?? null;
  if (key === "material") return c.material ?? null;
  const v = (c.shape as Record<string, unknown>)[key];
  return typeof v === "number" || typeof v === "string" ? v : null;
}

/** Diagnostics on these parts' source paths (or on params their fields reference). */
export function partDiagnostics(diags: readonly DeepReadonly<Diagnostic>[], ids: readonly string[], paramPaths: readonly string[]): DeepReadonly<Diagnostic>[] {
  const seen = new Set<string>();
  return diags.filter((d) => {
    const p = d.path ?? "";
    const hit = ids.some((id) => p === `/c/${id}` || p.startsWith(`/c/${id}/`)) || paramPaths.some((pp) => p === pp || p.startsWith(pp.replace(/\/value$/, "")));
    const key = `${d.code}|${p}|${d.message}`;
    if (!hit || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function ComponentEditor(props: ComponentEditorProps) {
  const { comps, files, units, status, tab, onTab, collapsed, onCollapse } = props;
  const types = comps.map((c) => c.shape.type);
  const tabs = tabsFor(types);
  const active: EditorTab = tabs.includes(tab) ? tab : (tabs[0] ?? "Geometry");
  const all = useMemo(() => sharedFields(types).filter((f) => f.tab === active), [types.join(","), active]);
  const first = comps[0];
  const [libOpen, setLibOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => setErrors({}), [comps.map((c) => c.id).join(","), active]);
  if (first === undefined) {
    return (
      <section className="rw-editor" data-rw-region="editor" data-testid="editor" data-empty="true">
        <p className="rw-editor__empty">Select a part in the tree or the view to edit it.</p>
      </section>
    );
  }
  const ids = comps.map((c) => c.id);
  // Required fields fill the two-column grid; optional ones show when the source sets them.
  const fields = all.filter((f) => f.tab !== "Geometry" || f.required || comps.some((c) => fieldTarget(files, c.id, f.key).written !== undefined));
  const primary = fields.filter((f) => f.tab !== "Geometry" || f.required);
  const extra = fields.filter((f) => !primary.includes(f));
  const title = comps.length > 1 ? `${comps.length} parts` : first.name;
  const paramPaths = fields.map((f) => fieldTarget(files, first.id, f.key)).filter((t) => t.param !== null).map((t) => t.path);
  // A single freeform fin set edits its outline on Geometry (its RW-E061 outline messages show there).
  const outline = active === "Geometry" && comps.length === 1 && first.shape.type === "freeform_fin_set";
  const onOutline = (d: DeepReadonly<Diagnostic>) => outline && (d.path === `/c/${first.id}/points` || (d.path ?? "").startsWith(`/c/${first.id}/points/`));
  const diags = partDiagnostics(props.diagnostics, ids, paramPaths).filter((d) => !onOutline(d));
  return (
    <section className="rw-editor" data-rw-region="editor" data-testid="editor" data-part={ids.join(",")} data-collapsed={collapsed ? "true" : "false"}>
      <header className="rw-editor__head">
        <h2 className="rw-editor__title" data-testid="editor.title">
          {title}
        </h2>
        <span className="rw-editor__kind">{comps.length > 1 && new Set(types).size > 1 ? "Mixed selection" : kindLabel(first.shape.type)}</span>
        <button
          type="button"
          className="rw-icon-button rw-editor__collapse"
          data-testid="editor.collapse"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand the editor" : "Collapse the editor"}
          onClick={() => onCollapse(!collapsed)}
        >
          <Icon name={collapsed ? "chevron-down" : "chevron-up"} size={18} />
        </button>
      </header>
      {!collapsed && (
        <>
          <nav className="rw-editor__tabs" role="tablist" aria-label="Editor">
            {tabs.map((t) => (
              <button key={t} type="button" role="tab" className="rw-tab rw-tab--editor" data-testid="editor.tab" aria-selected={t === active} onClick={() => onTab(t)}>
                {t}
              </button>
            ))}
          </nav>
          <div className="rw-editor__body">
            <div className="rw-editor__main">
              <div className="rw-editor__fields" data-tab={active} style={active === "Geometry" ? { gridTemplateRows: `repeat(${Math.max(1, Math.ceil(primary.length / 2))}, auto)` } : undefined}>
                {primary.map((f) => (
                  <FieldRow
                    key={`${ids.join(",")}:${f.key}`}
                    field={f}
                    comps={comps}
                    files={files}
                    units={units}
                    materials={props.materials}
                    error={errors[f.key] ?? null}
                    setError={(e) => setErrors((x) => ({ ...x, [f.key]: e ?? "" }))}
                    onEdit={props.onEdit}
                    onCommit={props.onCommit}
                    onDiscard={props.onDiscard}
                    byAgent={props.agentChanged?.includes(f.key) ?? false}
                  />
                ))}
              </div>
              {extra.length > 0 && (
                <div className="rw-editor__fields rw-editor__fields--extra" data-tab={active}>
                  {extra.map((f) => (
                    <FieldRow
                      key={`${ids.join(",")}:${f.key}`}
                      field={f}
                      comps={comps}
                      files={files}
                      units={units}
                      materials={props.materials}
                      error={errors[f.key] ?? null}
                      setError={(e) => setErrors((x) => ({ ...x, [f.key]: e ?? "" }))}
                      onEdit={props.onEdit}
                      onCommit={props.onCommit}
                      onDiscard={props.onDiscard}
                      byAgent={props.agentChanged?.includes(f.key) ?? false}
                    />
                  ))}
                </div>
              )}
              {outline && <FinOutlineEditor comp={first} units={units} diagnostics={props.diagnostics} onEdit={props.onEdit} onCommit={props.onCommit} onDiscard={props.onDiscard} />}
              <div className="rw-editor__notes">
                {active === "Mass override" && <p className="rw-editor__note">Leave a field empty to use the value derived from the geometry and material.</p>}
              </div>
              {(diags.length > 0 || Object.values(errors).some((e) => e)) && (
                <ul className="rw-editor__diags" data-testid="editor.validation">
                  {Object.entries(errors)
                    .filter(([, e]) => e)
                    .map(([k, e]) => (
                      <li key={`local-${k}`} data-severity="error" data-field={k}>
                        <Icon name="alert" size={14} /> {e}
                      </li>
                    ))}
                  {diags.map((d, i) => (
                    <li key={`${d.code}-${i}`} data-severity={d.severity} data-code={d.code} title={d.hint ?? d.code}>
                      <Icon name="alert" size={14} /> {d.message}
                    </li>
                  ))}
                </ul>
              )}
              <div className="rw-editor__status" data-testid="editor.status" data-kind={status.kind} title={status.title}>
                <span className="rw-editor__status-dot" data-testid="editor.status-dot" aria-hidden />
                <span>{status.kind === "clean" ? "No changes" : status.kind === "unsaved" ? "Modified · Not saved" : "Modified"}</span>
                {status.detail !== "" && <span className="rw-editor__status-detail"> · {status.detail}</span>}
              </div>
              <div className="rw-editor__actions">
                <div className="rw-editor__lib-wrap">
                  <button
                    type="button"
                    className="rw-button"
                    data-testid="editor.parts-library"
                    aria-expanded={libOpen}
                    onClick={() => {
                      if (!libOpen) props.onOpenLibrary();
                      setLibOpen(!libOpen);
                    }}
                  >
                    <Icon name="folder-open" size={18} />
                    Parts library
                  </button>
                  {libOpen && <PartsLibrary lib={props.library} kind={first.shape.type} onApply={(i) => (props.onApplyPreset(i), setLibOpen(false))} onClose={() => setLibOpen(false)} />}
                </div>
                <button type="button" className="rw-button" data-testid="editor.revert" disabled={!props.canRevert} onClick={props.onRevert} title={props.canRevert ? "Step back to the previous revision of this part" : "No change to revert"}>
                  <Icon name="undo" size={18} />
                  Revert change
                </button>
              </div>
            </div>
            {comps.length === 1 && <PartProfile comp={first} units={units} />}
          </div>
        </>
      )}
    </section>
  );
}

function FieldRow({
  field: f,
  comps,
  files,
  units,
  materials,
  error,
  setError,
  onEdit,
  onCommit,
  onDiscard,
  byAgent,
}: {
  field: FieldSpec;
  byAgent: boolean;
  comps: readonly Comp[];
  files: SourceFilesLike;
  units: Units;
  materials: readonly string[];
  error: string | null;
  setError: (e: string | null) => void;
  onEdit: (ops: PatchOp[], label: string) => void;
  onCommit: () => void;
  onDiscard: () => void;
}) {
  const first = comps[0]!;
  const target = fieldTarget(files, first.id, f.key);
  const values = comps.map((c) => evaluatedValue(c, f.key));
  const mixed = values.some((v) => v !== values[0]);
  const value = values[0] ?? null;
  const lim = limitsOf(f, target.param, units);
  const u = displayUnit(f.dim, units);
  const label = comps.length > 1 ? `Set ${f.label.toLowerCase()} on ${comps.length} parts` : `Set ${first.name} ${f.label.toLowerCase()}`;
  // One op per distinct target (a shared param is written once).
  const opsFor = (v: string | number | null): PatchOp[] => {
    const seen = new Set<string>();
    const ops: PatchOp[] = [];
    for (const c of comps) {
      const t = fieldTarget(files, c.id, f.key);
      if (seen.has(t.path)) continue;
      seen.add(t.path);
      const parts = f.key.split(".");
      // A nested field whose table the part does not have yet (`override`, `appearance`): add the table.
      const parentMissing = parts.length > 1 && t.param === null && (c as unknown as Record<string, unknown>)[parts[0]!] == null;
      if (v === null) {
        if (t.written !== undefined) ops.push({ op: "remove", path: t.path });
      } else if (parentMissing) ops.push({ op: "add", path: `/c/${c.id}/${parts[0]}`, value: { [parts[1]!]: v } as never });
      else ops.push({ op: t.written === undefined && !t.param ? "add" : "replace", path: t.path, value: v as never });
    }
    return ops;
  };
  const linked = linkTitle(target.param !== null ? { name: target.param.name, ...(target.param.doc !== undefined ? { doc: target.param.doc } : {}) } : null, target.expression, f.doc);
  const testid = "editor.field";
  if (f.kind === "enum") {
    const options = f.key === "material" ? materials : (f.options ?? []);
    return (
      <label className="rw-field" data-testid={testid} data-field={f.key} title={linked}>
        <span className="rw-field__label">
          {f.label}
          {byAgent && <AgentMarker />}
        </span>
        <span className="rw-select rw-select--native rw-field__select">
          <select
            value={mixed || value === null ? "" : String(value)}
            aria-label={f.label}
            onChange={(e) => {
              const v = e.currentTarget.value;
              if (v === "") return;
              onEdit(opsFor(v), label);
              onCommit();
            }}
          >
            {(mixed || value === null) && <option value="">{mixed ? "Mixed" : "—"}</option>}
            {options.map((o) => (
              <option key={o} value={o}>
                {o.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <Icon name="chevron-down" size={16} />
        </span>
      </label>
    );
  }
  const shown = mixed ? "" : typeof value === "number" ? (f.kind === "quantity" ? toDisplay(value, f.dim, units) : String(Number(value.toPrecision(6)))) : "";
  return (
    <SpinField
      testid={testid}
      field={f}
      unit={u.unit}
      value={shown}
      placeholder={mixed ? "Mixed" : f.tab === "Mass override" ? "Derived" : ""}
      step={lim.step}
      title={linked}
      byAgent={byAgent}
      error={error}
      onChange={(text) => {
        const t = text.trim();
        if (t === "") {
          if (f.tab === "Mass override") {
            setError(null);
            const ops = opsFor(null);
            if (ops.length > 0) onEdit(ops, label);
            return;
          }
          setError(`${f.label} needs a value.`);
          return;
        }
        const n = Number(t);
        if (!Number.isFinite(n)) {
          setError(`${f.label} needs a number.`);
          return;
        }
        const si = f.kind === "quantity" ? fromDisplay(n, f.dim, units) : n;
        const err = rangeError(si, f, lim, units);
        setError(err);
        if (err !== null) return;
        onEdit(opsFor(f.kind === "quantity" ? toSource(n, f.dim, units) : n), label);
      }}
      onCommit={onCommit}
      onDiscard={() => {
        setError(null);
        onDiscard();
      }}
    />
  );
}

/** A spinner field: typed number, ▲▼ steps, unit suffix; Enter or blur commits, Escape discards. */
function SpinField({
  testid,
  field,
  unit,
  value,
  placeholder,
  step,
  title,
  byAgent,
  error,
  onChange,
  onCommit,
  onDiscard,
}: {
  testid: string;
  field: FieldSpec;
  unit: string;
  value: string;
  placeholder: string;
  step: number;
  /** Tooltip (shared parameter or formula, in words; else the field's doc). */
  title: string | undefined;
  byAgent: boolean;
  error: string | null;
  onChange: (text: string) => void;
  onCommit: () => void;
  onDiscard: () => void;
}) {
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);
  const bump = (dir: 1 | -1) => {
    const cur = Number(text === "" ? value || "0" : text);
    const next = Number(((Number.isFinite(cur) ? cur : 0) + dir * step).toPrecision(10));
    const s = String(next);
    setText(s);
    onChange(s);
    onCommit();
  };
  return (
    <label className="rw-field" data-testid={testid} data-field={field.key} data-invalid={error ? "true" : undefined} data-by-agent={byAgent ? "true" : undefined} title={title}>
      <span className="rw-field__label">
        {field.label}
        {byAgent && <AgentMarker />}
      </span>
      <span className="rw-spinbox">
        <input
          className="rw-spinbox__input"
          inputMode="decimal"
          value={text}
          placeholder={placeholder}
          aria-label={field.label}
          aria-invalid={error ? true : undefined}
          onFocus={() => setEditing(true)}
          onChange={(e) => {
            setText(e.currentTarget.value);
            onChange(e.currentTarget.value);
          }}
          onBlur={() => {
            setEditing(false);
            if (!error) onCommit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !error) {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setText(value);
              onDiscard();
              e.currentTarget.blur();
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              bump(1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              bump(-1);
            }
          }}
        />
        <span className="rw-spinbox__arrows">
          <button type="button" tabIndex={-1} aria-label={`Increase ${field.label}`} data-testid="editor.spin-up" onMouseDown={(e) => e.preventDefault()} onClick={() => bump(1)}>
            <Icon name="chevron-up" size={12} />
          </button>
          <button type="button" tabIndex={-1} aria-label={`Decrease ${field.label}`} data-testid="editor.spin-down" onMouseDown={(e) => e.preventDefault()} onClick={() => bump(-1)}>
            <Icon name="chevron-down" size={12} />
          </button>
        </span>
      </span>
      <span className="rw-field__unit">{unit}</span>
    </label>
  );
}

/** Under a field label: the agent changed this value in the shown revision. */
function AgentMarker() {
  return (
    <span className="rw-field__agent" data-testid="editor.field-changed">
      Changed by agent
    </span>
  );
}

function PartsLibrary({
  lib,
  kind,
  onApply,
  onClose,
}: {
  lib: ComponentEditorProps["library"];
  kind: string;
  onApply: (item: LibItem) => void;
  onClose: () => void;
}) {
  const fits = (i: LibItem) => {
    const t = i.data["type"];
    return typeof t !== "string" || t === kind;
  };
  return (
    <div className="rw-library" role="dialog" aria-label="Parts library" data-testid="editor.library" data-state={lib.state}>
      <header className="rw-library__head">
        <span>Parts library</span>
        <button type="button" className="rw-icon-button" aria-label="Close the parts library" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </header>
      {lib.state === "loading" && <p className="rw-library__empty">Loading presets…</p>}
      {lib.state === "error" && <p className="rw-library__empty">{lib.error ?? "The library is unavailable."}</p>}
      {lib.state === "ready" && lib.items.length === 0 && (
        <p className="rw-library__empty" data-testid="editor.library-empty">
          No presets in the library yet. Presets come only from the Apache-2.0 openrocket-database once they are imported.
        </p>
      )}
      {lib.state === "ready" && lib.items.length > 0 && (
        <ul className="rw-library__list">
          {lib.items.map((i) => (
            <li key={i.id}>
              <button type="button" className="rw-library__item" data-testid="editor.library-item" data-id={i.id} disabled={!fits(i)} onClick={() => onApply(i)}>
                <span className="rw-library__name">{i.name}</span>
                <span className="rw-library__source">{i.source}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
