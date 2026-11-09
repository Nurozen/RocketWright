/**
 * Page 02 component editor (concept 02, lower 40% of the workspace,
 * collapsible): tabs Geometry | Position | Material | Appearance | Mass override, two
 * columns of unit-aware spinner fields from the component-type schema
 * (ui/fields), validation messages (local limits plus the check's
 * diagnostics on the part), the live part profile, Modified status, Parts
 * library, and Revert change.
 *
 * Presentational over callbacks: an edit becomes patch ops on the id-keyed
 * model (a draft previewed by rw-wasm, I4); Enter or leaving the field commits
 * it through `model.patch` (I1, I2); Escape discards it.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { PatchOp, schema } from "@rw/contracts";
import { Icon } from "../../shell/Icon.tsx";
import { ADD_FIRST_PART, FIRST_PART_HINT, type DeepReadonly, type Units } from "../../state/index.ts";
import { partLabel } from "../../state/ops/parts.ts";
import { BoolField, displayUnit, FieldGroupFrame, fromDisplay, groupsOf, limitsOf, parseLiteral, rangeError, SelectField, sharedFields, SpinField, tabsFor, TextField, toDisplay, toSource, type EditorTab, type FieldDiagnostic, type FieldSpec } from "../../ui/fields/index.ts";
import { fieldValue, fieldWriteOps, groupAddOps, tablePresent } from "./fieldOps.ts";
import { attachChoices, ownAnchorChoices } from "./positionFields.ts";
import { FinOutlineEditor } from "./FinOutlineEditor.tsx";
import { PartProfile } from "./PartProfile.tsx";
import { densityKeyFor, materialChoices } from "./materialFields.ts";
import { fieldTarget, sourceHasTable, type SourceFilesLike } from "./source.ts";
import { RENAME_OUTDATES_RUNS } from "../../shell/RenameProjectDialog.tsx";

type Comp = DeepReadonly<schema.EvalComponent>;
type LibItem = DeepReadonly<schema.LibItem>;
type Diagnostic = schema.Diagnostic;
type EvalMaterials = Readonly<Record<string, DeepReadonly<schema.EvalMaterial> | undefined>>;

/** The project's materials: a tab beside the part's own, because a project with no parts needs them too (R2.4). */
export const MATERIALS_TAB = "Materials";
export type PanelTab = EditorTab | typeof MATERIALS_TAB;

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
  /** Every part of the model: what Attach to can name. */
  allComps?: readonly Comp[];
  /** The project has no parts: there is nothing to select yet (R0.3a). */
  noParts?: boolean;
  files: SourceFilesLike;
  units: Units;
  materials: EvalMaterials;
  /** The Materials tab's content. */
  materialsPanel?: ReactNode;
  diagnostics: readonly DeepReadonly<Diagnostic>[];
  status: EditorStatus;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
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

/** The check's first word on one field of these parts, for the field itself. */
function fieldDiagnostic(diags: readonly DeepReadonly<Diagnostic>[], comps: readonly Comp[], key: string): FieldDiagnostic | undefined {
  const paths = new Set(comps.map((c) => `/c/${c.id}/${key.replace(/\./g, "/")}`));
  return diags.find((d) => paths.has(d.path ?? "")) as FieldDiagnostic | undefined;
}

const humanize = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function ComponentEditor(props: ComponentEditorProps) {
  const { comps, files, units, status, tab, onTab, collapsed, onCollapse } = props;
  const types = comps.map((c) => c.shape.type);
  const partTabs = tabsFor(types);
  // Not on a mixed selection, which edits only Appearance; and not while the model has not been evaluated.
  const tabs: PanelTab[] = (comps.length > 0 && new Set(types).size === 1) || props.noParts === true ? [...partTabs, MATERIALS_TAB] : partTabs;
  const active: PanelTab | null = tabs.includes(tab) ? tab : (partTabs[0] ?? null);
  const all = useMemo(() => sharedFields(types).filter((f) => f.tab === active), [types.join(","), active]);
  const first = comps[0];
  const [libOpen, setLibOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Fields asked for through Add field, until the selection moves on.
  const [added, setAdded] = useState<readonly string[]>([]);
  const selectionKey = comps.map((c) => c.id).join(",");
  useEffect(() => setErrors({}), [selectionKey, active]);
  useEffect(() => setAdded([]), [selectionKey]);
  if (first === undefined) {
    return (
      <section className="rw-editor" data-rw-region="editor" data-testid="editor" data-empty="true">
        {tabs.length > 0 && <EditorTabs tabs={tabs} active={active} onTab={onTab} />}
        {active === MATERIALS_TAB ? <div className="rw-editor__body">{props.materialsPanel}</div> : <p className="rw-editor__empty">{props.noParts ? `${ADD_FIRST_PART}. ${FIRST_PART_HINT}` : "Select a part in the tree or the view to edit it."}</p>}
      </section>
    );
  }
  const ids = comps.map((c) => c.id);
  const multi = comps.length > 1;
  // Nothing to place until the part is attached somewhere; the first part of a rocket has no attachment.
  const attached = comps.every((c) => c.attach != null || sourceHasTable(files, c.id, ["attach"]));
  const isWritten = (f: FieldSpec) => comps.some((c) => fieldTarget(files, c.id, f.key).written !== undefined);
  const custom = comps.every((c) => sourceHasTable(files, c.id, ["finish"]));
  const flat = all.filter((f) => {
    if (f.parent !== undefined || (multi && f.key === "name")) return false;
    if (f.key.startsWith("attach.") && f.key !== "attach.to" && !attached) return false;
    if (f.key === "finish" && custom) return false;
    return true;
  });
  const groups = groupsOf(all);
  const shown = (f: FieldSpec) => f.advanced !== true || isWritten(f) || added.includes(f.key);
  const fields = flat.filter((f) => f.key !== "name" && f.section === undefined && shown(f));
  // Required fields fill the two-column grid; optional ones follow.
  const primary = fields.filter((f) => f.tab !== "Geometry" || f.required);
  const extra = fields.filter((f) => !primary.includes(f));
  const nameField = flat.find((f) => f.key === "name");
  const sections = [...new Set(flat.flatMap((f) => (f.section !== undefined && shown(f) ? [f.section] : [])))];
  const addable = flat.filter((f) => !shown(f));
  const title = comps.length > 1 ? `${comps.length} parts` : first.name;
  const paramPaths = [...fields, ...groups.flatMap((g) => g.fields)].map((f) => fieldTarget(files, first.id, f.key)).filter((t) => t.param !== null).map((t) => t.path);
  // A single freeform fin set edits its outline on Geometry (its RW-E061 outline messages show there).
  const outline = active === "Geometry" && comps.length === 1 && first.shape.type === "freeform_fin_set";
  const onOutline = (d: DeepReadonly<Diagnostic>) => outline && (d.path === `/c/${first.id}/points` || (d.path ?? "").startsWith(`/c/${first.id}/points/`));
  const diags = partDiagnostics(props.diagnostics, ids, paramPaths).filter((d) => !onOutline(d));
  const row = (f: FieldSpec) => (
    <FieldRow
      key={`${ids.join(",")}:${f.key}`}
      field={f}
      comps={comps}
      files={files}
      units={units}
      materials={props.materials}
      allComps={props.allComps ?? comps}
      diag={fieldDiagnostic(props.diagnostics, comps, f.key)}
      error={errors[f.key] ?? null}
      setError={(e) => setErrors((x) => ({ ...x, [f.key]: e ?? "" }))}
      onEdit={props.onEdit}
      onCommit={props.onCommit}
      onDiscard={props.onDiscard}
      byAgent={props.agentChanged?.includes(f.key) ?? false}
    />
  );
  return (
    <section className="rw-editor" data-rw-region="editor" data-testid="editor" data-part={ids.join(",")} data-collapsed={collapsed ? "true" : "false"}>
      <header className="rw-editor__head">
        <h2 className="rw-editor__title" data-testid="editor.title">
          {title}
        </h2>
        <span className="rw-editor__kind">{comps.length > 1 && new Set(types).size > 1 ? "Mixed selection" : partLabel(first.shape.type)}</span>
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
          <EditorTabs tabs={tabs} active={active} onTab={onTab} />
          {active === MATERIALS_TAB ? (
            <div className="rw-editor__body">{props.materialsPanel}</div>
          ) : (
          <div className="rw-editor__body">
            <div className="rw-editor__main">
              {nameField !== undefined && <div className="rw-editor__fields rw-editor__fields--name" data-tab={active}>{row(nameField)}</div>}
              <div className="rw-editor__fields" data-tab={active} style={active === "Geometry" ? { gridTemplateRows: `repeat(${Math.max(1, Math.ceil(primary.length / 2))}, auto)` } : undefined}>
                {primary.map(row)}
              </div>
              {extra.length > 0 && (
                <div className="rw-editor__fields rw-editor__fields--extra" data-tab={active}>
                  {extra.map(row)}
                </div>
              )}
              {sections.map((section) => (
                <FieldGroupFrame key={section} heading={section} group={section.toLowerCase()}>
                  <div className="rw-editor__fields rw-editor__fields--extra" data-tab={active}>
                    {flat.filter((f) => f.section === section && shown(f)).map(row)}
                  </div>
                </FieldGroupFrame>
              ))}
              {groups.map((g) =>
                comps.every((c) => tablePresent(files, c, [g.key])) ? (
                  <FieldGroupFrame key={g.key} heading={g.heading} group={g.key}>
                    <div className="rw-editor__fields rw-editor__fields--extra" data-tab={active}>
                      {g.fields.map(row)}
                    </div>
                    {g.key === "finish" && (
                      <button
                        type="button"
                        className="rw-link"
                        data-testid="editor.finish-preset"
                        onClick={() => {
                          props.onEdit(comps.map((c) => ({ op: "remove", path: `/c/${c.id}/finish` })), `Use a finish preset on ${title}`);
                          props.onCommit();
                        }}
                      >
                        Use a preset
                      </button>
                    )}
                  </FieldGroupFrame>
                ) : (
                  <button
                    key={g.key}
                    type="button"
                    className="rw-button rw-editor__add-group"
                    data-testid="editor.add-group"
                    data-group={g.key}
                    onClick={() => {
                      props.onEdit(groupAddOps(comps, files, g, units), `${g.add} to ${title}`);
                      props.onCommit();
                    }}
                  >
                    <Icon name="plus" size={18} />
                    {g.add}
                  </button>
                ),
              )}
              {addable.length > 0 && (
                <div className="rw-editor__fields rw-editor__fields--extra" data-tab={active}>
                  <SelectField
                    testid="editor.add-field"
                    field={{ key: "add-field", label: "Add field" }}
                    value=""
                    options={addable.map((f) => f.key)}
                    labels={Object.fromEntries(addable.map((f) => [f.key, f.label]))}
                    placeholder="Choose a field"
                    title="Add an optional field this part does not set yet"
                    byAgent={false}
                    onChange={(key) => setAdded((cur) => [...cur, key])}
                  />
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
          )}
        </>
      )}
    </section>
  );
}

function EditorTabs({ tabs, active, onTab }: { tabs: readonly PanelTab[]; active: PanelTab | null; onTab: (t: PanelTab) => void }) {
  return (
    <nav className="rw-editor__tabs" role="tablist" aria-label="Editor">
      {tabs.map((t) => (
        <button key={t} type="button" role="tab" className="rw-tab rw-tab--editor" data-testid="editor.tab" aria-selected={t === active} onClick={() => onTab(t)}>
          {t}
        </button>
      ))}
    </nav>
  );
}

function FieldRow({
  field: f,
  comps,
  files,
  units,
  materials,
  allComps,
  diag,
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
  materials: EvalMaterials;
  allComps: readonly Comp[];
  diag: FieldDiagnostic | undefined;
  error: string | null;
  setError: (e: string | null) => void;
  onEdit: (ops: PatchOp[], label: string) => void;
  onCommit: () => void;
  onDiscard: () => void;
}) {
  const first = comps[0]!;
  const target = fieldTarget(files, first.id, f.key);
  const values = comps.map((c) => fieldValue(c, files, f));
  const mixed = values.some((v) => v !== values[0]);
  const value = values[0] ?? null;
  const lim = limitsOf(f, target.param, units);
  const u = displayUnit(f.dim, units);
  const label = comps.length > 1 ? `Set ${f.label.toLowerCase()} on ${comps.length} parts` : `Set ${first.name} ${f.label.toLowerCase()}`;
  const opsFor = (v: string | number | boolean | null): PatchOp[] => fieldWriteOps(comps, files, f, v);
  const linked = linkTitle(target.param !== null ? { name: target.param.name, ...(target.param.doc !== undefined ? { doc: target.param.doc } : {}) } : null, target.expression, f.doc);
  const testid = "editor.field";
  const pick = (v: string | number | boolean | null) => {
    onEdit(opsFor(v), label);
    onCommit();
  };
  if (f.key === "attach.radial") {
    return <RadialField field={f} comps={comps} files={files} units={units} title={linked} byAgent={byAgent} diag={diag} error={error} setError={setError} onEdit={onEdit} onCommit={onCommit} onDiscard={onDiscard} />;
  }
  if (f.kind === "bool") {
    return <BoolField testid={testid} field={f} checked={mixed ? null : value === true} title={linked} byAgent={byAgent} diag={diag} onChange={pick} />;
  }
  if (f.kind === "text") {
    return (
      <TextField
        testid={testid}
        field={f}
        value={mixed || value === null ? "" : String(value)}
        placeholder={mixed ? "Mixed" : ""}
        title={linked}
        byAgent={byAgent}
        error={error}
        note={f.key === "name" ? RENAME_OUTDATES_RUNS : undefined}
        diag={diag}
        onChange={(text) => {
          const t = text.trim();
          if (t === "") {
            if (f.key === "name" || f.required) {
              setError(`${f.label} needs a value.`);
              return;
            }
            setError(null);
            const ops = opsFor(null);
            if (ops.length > 0) onEdit(ops, label);
            return;
          }
          const message = f.key === "appearance.color" && !/^#[0-9a-fA-F]{6}$/.test(t) ? "Color needs the form #rrggbb." : null;
          setError(message);
          if (message === null) onEdit(opsFor(t), label);
        }}
        onCommit={onCommit}
        onDiscard={() => {
          setError(null);
          onDiscard();
        }}
      />
    );
  }
  if (f.kind === "enum") {
    const current = mixed || typeof value !== "string" ? null : value;
    const material = f.key === "material" || f.key === "line_material";
    const choices =
      f.key === "attach.to"
        ? attachChoices(allComps, comps, current)
        : f.key === "attach.at"
          ? ownAnchorChoices(first)
          : material
            ? { options: materialChoices(materials, f.key === "line_material" ? "line_density" : densityKeyFor(first.shape.type), current), labels: undefined }
            : { options: f.options ?? [], labels: Object.fromEntries((f.options ?? []).map((o) => [o, humanize(o)])) };
    // `attach.to` always has a value once attached; clearing it would orphan the part.
    const clearable = !f.required && f.key !== "attach.to";
    return (
      <SelectField
        testid={testid}
        field={f}
        value={mixed || value === null ? "" : String(value)}
        options={choices.options}
        labels={choices.labels}
        placeholder={mixed ? "Mixed" : value === null || clearable ? (f.key === "attach.at" ? "Automatic" : "—") : null}
        title={linked}
        byAgent={byAgent}
        diag={diag}
        onChange={pick}
        onClear={clearable ? () => pick(null) : undefined}
      />
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
      diag={diag}
      onChange={(text) => {
        const t = text.trim();
        if (t === "") {
          // An optional field left empty is not written: the model's own default or derived value stands.
          if (!f.required) {
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

/**
 * `attach.radial`: the keyword choices, or a typed radius. The model takes
 * either in one field, so the radius input appears only once it is chosen.
 */
function RadialField({
  field: f,
  comps,
  files,
  units,
  title,
  byAgent,
  diag,
  error,
  setError,
  onEdit,
  onCommit,
  onDiscard,
}: {
  field: FieldSpec;
  comps: readonly Comp[];
  files: SourceFilesLike;
  units: Units;
  title: string | undefined;
  byAgent: boolean;
  diag: FieldDiagnostic | undefined;
  error: string | null;
  setError: (e: string | null) => void;
  onEdit: (ops: PatchOp[], label: string) => void;
  onCommit: () => void;
  onDiscard: () => void;
}) {
  const first = comps[0]!;
  const written = fieldTarget(files, first.id, f.key).written;
  const radius = typeof written === "string" ? parseLiteral(written) : typeof written === "number" ? written : null;
  const [custom, setCustom] = useState(radius !== null);
  const write = (v: string | null) => {
    onEdit(fieldWriteOps(comps, files, f, v), `Set ${first.name} radial placement`);
    onCommit();
  };
  const keywords = f.options ?? [];
  const RADIUS = "radius";
  const u = displayUnit("length", units);
  return (
    <>
      <SelectField
        testid="editor.field"
        field={f}
        value={custom ? RADIUS : typeof written === "string" && keywords.includes(written) ? written : ""}
        options={[...keywords, RADIUS]}
        labels={{ ...Object.fromEntries(keywords.map((k) => [k, humanize(k)])), [RADIUS]: "At a radius" }}
        placeholder="Automatic"
        title={title}
        byAgent={byAgent}
        diag={diag}
        onChange={(v) => {
          if (v === RADIUS) {
            setCustom(true);
            return;
          }
          setCustom(false);
          write(v);
        }}
        onClear={() => {
          setCustom(false);
          write(null);
        }}
      />
      {custom && (
        <SpinField
          testid="editor.field"
          field={{ key: "attach.radial.radius", label: "Radius" }}
          unit={u.unit}
          value={radius === null ? "" : toDisplay(radius, "length", units)}
          placeholder=""
          step={limitsOf({ ...f, dim: "length", kind: "quantity" }, null, units).step}
          title={title}
          byAgent={false}
          error={error}
          onChange={(text) => {
            const t = text.trim();
            const n = Number(t);
            if (t === "" || !Number.isFinite(n) || n < 0) {
              setError("Radius needs a distance of 0 or more.");
              return;
            }
            setError(null);
            onEdit(fieldWriteOps(comps, files, f, toSource(n, "length", units)), `Set ${first.name} radial placement`);
          }}
          onCommit={onCommit}
          onDiscard={() => {
            setError(null);
            onDiscard();
          }}
        />
      )}
    </>
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
