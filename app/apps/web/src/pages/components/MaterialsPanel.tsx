/**
 * Design > Components > Materials (R2.4): the project's materials and the
 * library's beside one form. A person never presses Save: a new material is
 * created when it has a name and a density and focus leaves a field, and every
 * later change commits the same way, each as one history step. Because a
 * mistyped name is created at once, a name can be changed afterwards (every
 * part follows it) and a material no part uses can be deleted.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { PatchOp, schema } from "@rw/contracts";
import { Icon } from "../../shell/Icon.tsx";
import { DiagnosticText, diagnosticPlainText } from "../../ui/DiagnosticText.tsx";
import { trackWrite, useDirtyField, windowLostFocus } from "../../state/dirtyFields.ts";
import type { DeepReadonly, Units } from "../../state/index.ts";
import { addMaterialOps, deleteMaterialOps, renameMaterialOps, setMaterialOps } from "../../state/ops/materials.ts";
import { Banner } from "../../ui/Banner.tsx";
import { displayUnit, SpinField } from "../../ui/fields/index.ts";
import { TextField } from "../../ui/TextField.tsx";
import { blankForm, buildMaterial, DENSITY_FIELDS, densitySummary, displayName, formFromEval, formFromLiterals, isDirty, libraryKey, libraryMaterial, renamedTo, validateForm, type DensityKey, type FormErrors, type MaterialForm } from "./materialFields.ts";
import { materialUses, sourceMaterialIds, tableScalars, type SourceFilesLike } from "./source.ts";

type LibItem = DeepReadonly<schema.LibItem>;

export interface MaterialsLibrary {
  state: "idle" | "loading" | "ready" | "error";
  items: readonly LibItem[];
  error?: string;
}

export interface MaterialsPanelProps {
  materials: Readonly<Record<string, DeepReadonly<schema.EvalMaterial> | undefined>>;
  files: SourceFilesLike;
  units: Units;
  diagnostics: readonly DeepReadonly<schema.Diagnostic>[];
  library: MaterialsLibrary;
  onOpenLibrary: () => void;
  /** One committed step (`mutate`). */
  onMutate: (ops: PatchOp[], label: string) => Promise<unknown>;
}

const NEEDS_NAME_AND_DENSITY = "Give the material a name and at least one density to create it.";
const STILL_SAVING = "This material is still saving. Try the new name again in a moment.";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function MaterialsPanel({ materials, files, units, diagnostics, library, onOpenLibrary, onMutate }: MaterialsPanelProps) {
  const projectIds = useMemo(() => sourceMaterialIds(files).sort(), [files]);
  const [form, setFormState] = useState<MaterialForm | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // The form is read inside blur handlers and late answers, which must see the newest text.
  const formRef = useRef<MaterialForm | null>(form);
  const session = useRef(0);
  // Created here, not yet in the snapshot: taken already, and not gone.
  const pending = useRef(new Set<string>());
  // Writes reach the model in the order they were made: an edit must not overtake the add it edits.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const formPane = useRef<HTMLDivElement>(null);

  const setForm = (next: MaterialForm | null) => {
    formRef.current = next;
    setFormState(next);
  };
  const taken = () => new Set([...projectIds, ...pending.current]);

  useEffect(() => onOpenLibrary(), []);

  // Stacked in a narrow window the form sits below the lists: bring it into view when one opens.
  const openedSession = form?.session ?? null;
  useEffect(() => {
    if (openedSession !== null) formPane.current?.scrollIntoView?.({ block: "nearest" });
  }, [openedSession]);

  // The model moved (an undo, the agent): follow it, unless the person is mid-edit.
  useEffect(() => {
    for (const id of projectIds) pending.current.delete(id);
    const cur = formRef.current;
    if (cur === null || cur.id === null) return;
    if (!projectIds.includes(cur.id) && !pending.current.has(cur.id)) {
      setForm(null);
      setErrors({});
      return;
    }
    const m = materials[cur.id];
    if (m !== undefined && !isDirty(cur)) setForm(formFromEval(cur.id, m, cur.session, units));
  }, [materials, projectIds, units]);

  const write = (ops: PatchOp[], label: string, undo: () => void) => {
    const next = queue.current.catch(() => undefined).then(() => onMutate(ops, label));
    queue.current = next;
    void trackWrite(next).catch((e: unknown) => {
      undo();
      setFailure(message(e));
    });
  };

  const save = (): string | null => {
    const f = formRef.current;
    if (f === null || !isDirty(f)) return null;
    const problems = validateForm(f, taken());
    setErrors(problems);
    const first = Object.values(problems)[0];
    if (first !== undefined) return first;
    setFailure(null);
    if (f.id === null) {
      const material = buildMaterial(f, {}, units);
      if (f.name.trim() === "" || material === null) return NEEDS_NAME_AND_DENSITY;
      const { id, ops } = addMaterialOps(f.name.trim(), material, taken());
      pending.current.add(id);
      setForm({ ...f, id, name: displayName(id), baseline: { ...f.values } });
      write(ops, `Add material ${displayName(id)}`, () => {
        pending.current.delete(id);
        // Back to an unsaved form, so what was typed can be fixed and saved again.
        if (formRef.current?.session === f.session) setForm(f);
      });
      return null;
    }
    const id = f.id;
    const material = buildMaterial(f, tableScalars(files, ["materials", id]), units);
    if (material === null) return "A material needs at least one density.";
    const to = renamedTo(f);
    if (to !== null) {
      // Until the snapshot has this entry, `files` cannot say which parts name it.
      if (!projectIds.includes(id)) {
        setErrors({ name: STILL_SAVING });
        return STILL_SAVING;
      }
      pending.current.add(to);
      setForm({ ...f, id: to, name: displayName(to), baseline: { ...f.values } });
      const paths = materialUses(files, id).map((u) => u.path);
      write(renameMaterialOps(id, to, material, paths), `Rename material ${displayName(id)} to ${displayName(to)}`, () => {
        pending.current.delete(to);
        if (formRef.current?.session === f.session) setForm(f);
      });
      return null;
    }
    setForm({ ...f, baseline: { ...f.values } });
    write(setMaterialOps(id, material), `Edit material ${displayName(id)}`, () => {
      const cur = formRef.current;
      if (cur?.session === f.session) setForm({ ...cur, baseline: f.baseline });
    });
    return null;
  };

  // D22: text typed here is not in the model until a blur, and leaving the project may not blur.
  useDirtyField({ dirty: () => formRef.current !== null && isDirty(formRef.current), commit: save });

  const edit = (next: MaterialForm) => {
    setForm(next);
    setErrors(validateForm(next, taken()));
  };
  const startNew = () => {
    setFailure(null);
    setErrors({});
    setForm(blankForm(++session.current));
  };
  const open = (id: string) => {
    const m = materials[id];
    if (m === undefined) return;
    setFailure(null);
    setErrors({});
    setForm(formFromEval(id, m, ++session.current, units));
  };
  const copy = (item: LibItem) => {
    const key = libraryKey(item);
    if (taken().has(key)) {
      open(key);
      return;
    }
    const data = libraryMaterial(item);
    const { id, ops } = addMaterialOps(key, data, taken());
    const sess = ++session.current;
    pending.current.add(id);
    setFailure(null);
    setErrors({});
    setForm(formFromLiterals(id, data as Record<string, unknown>, sess, units));
    write(ops, `Copy material ${displayName(id)}`, () => {
      pending.current.delete(id);
      if (formRef.current?.session === sess) setForm(null);
    });
  };

  const remove = () => {
    const f = formRef.current;
    if (f === null || f.id === null) return;
    setFailure(null);
    setErrors({});
    setForm(null);
    write(deleteMaterialOps(f.id), `Delete material ${displayName(f.id)}`, () => {
      if (formRef.current === null) setForm(f);
    });
  };

  const needle = query.trim().toLowerCase();
  const items = needle === "" ? library.items : library.items.filter((i) => i.name.toLowerCase().includes(needle));
  const formDiagnostics = form?.id == null ? [] : diagnostics.filter((d) => d.path === `/materials/${form.id}` || (d.path ?? "").startsWith(`/materials/${form.id}/`));
  const messages = Object.entries(errors).filter(([k]) => k !== "name");
  const usedBy = form?.id == null ? [] : [...new Set(materialUses(files, form.id).map((u) => u.label))];
  // Not in the snapshot yet (just created or renamed): `files` cannot say who uses it.
  const settled = form?.id != null && projectIds.includes(form.id);

  return (
    <div className="rw-mats" data-testid="materials">
      <div className="rw-mats__browse">
        <div className="rw-mats__head">
          <h3 className="rw-mats__title">In this project</h3>
          <button type="button" className="rw-button" data-testid="materials.new" onClick={startNew}>
            <Icon name="plus" size={18} />
            New material
          </button>
        </div>
        {projectIds.length === 0 ? (
          <p className="rw-mats__empty" data-testid="materials.empty">
            No materials yet. Create one, or copy one from the library.
          </p>
        ) : (
          <ul className="rw-mats__list">
            {projectIds.map((id) => (
              <li key={id}>
                <button type="button" className="rw-mats__row" data-testid="materials.item" data-id={id} aria-pressed={form?.id === id} onClick={() => open(id)}>
                  <span>{displayName(id)}</span>
                  <span className="rw-mats__meta">{densitySummary(materials[id] as Record<string, unknown> | undefined, units)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <h3 className="rw-mats__title">Library</h3>
        <TextField label="Search the library" value={query} onChange={setQuery} layout="inline" />
        {library.state === "loading" && <p className="rw-mats__empty">Loading the library…</p>}
        {library.state === "error" && <p className="rw-mats__empty">{library.error ?? "The library is unavailable."}</p>}
        {library.state === "ready" && items.length === 0 && <p className="rw-mats__empty">No library material matches.</p>}
        {library.state === "ready" && items.length > 0 && (
          <ul className="rw-mats__list rw-mats__list--library" data-testid="materials.library">
            {items.map((i) => (
              <li key={i.id}>
                <button type="button" className="rw-mats__row" data-testid="materials.library-item" data-id={i.id} title={`Copy into this project · ${i.source}`} onClick={() => copy(i)}>
                  <span>{i.name}</span>
                  <span className="rw-mats__meta">{densitySummary(i.data as Record<string, unknown>, units)}</span>
                  <span className="rw-mats__copy">Copy</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="rw-mats__form" ref={formPane}>
        {failure !== null && (
          <Banner tone="danger" onDismiss={() => setFailure(null)} testId="materials.error">
            {failure}
          </Banner>
        )}
        {form === null ? (
          <p className="rw-mats__empty">Pick a material to edit it, or press New material.</p>
        ) : (
          <>
            <TextField
              key={`${form.session}:name`}
              label="Name"
              layout="inline"
              value={form.name}
              error={errors.name}
              hint={form.id !== null ? "Renaming updates every part that uses it. Renaming or deleting a material outdates the runs you have flown." : "Created as soon as it has a name and a density."}
              onChange={(name) => edit({ ...formRef.current!, name })}
              onBlur={() => {
                if (!windowLostFocus()) void save();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
            {DENSITY_FIELDS.map((d) => (
              <div key={`${form.session}:${d.key}`} className="rw-mats__field">
                <SpinField
                  testid="materials.field"
                  field={{ key: d.key, label: d.label }}
                  unit={displayUnit(d.dim, units).unit}
                  value={form.values[d.key]}
                  placeholder=""
                  step={displayUnit(d.dim, units).step ?? 1}
                  title={d.usedBy}
                  byAgent={false}
                  error={errors[d.key as DensityKey] ?? null}
                  onChange={(text) => {
                    const cur = formRef.current!;
                    edit({ ...cur, values: { ...cur.values, [d.key]: text } });
                  }}
                  onCommit={() => void save()}
                  onDiscard={() => {
                    const cur = formRef.current!;
                    edit({ ...cur, values: { ...cur.values, [d.key]: cur.baseline[d.key] } });
                  }}
                />
                <p className="rw-mats__used">{d.usedBy}</p>
              </div>
            ))}
            {(messages.length > 0 || formDiagnostics.length > 0) && (
              <ul className="rw-editor__diags" data-testid="materials.validation">
                {messages.map(([k, e]) => (
                  <li key={k} data-severity="error" data-field={k}>
                    <Icon name="alert" size={14} /> {e}
                  </li>
                ))}
                {formDiagnostics.map((d, i) => (
                  <li key={`${d.code}-${i}`} data-severity={d.severity} data-code={d.code} title={diagnosticPlainText(d.hint ?? d.code)}>
                    <Icon name="alert" size={14} /> <DiagnosticText text={d.message} />
                  </li>
                ))}
              </ul>
            )}
            {form.id !== null && (
              <div className="rw-mats__actions">
                <button type="button" className="rw-button" data-testid="materials.delete" disabled={!settled || usedBy.length > 0} onClick={remove}>
                  <Icon name="trash" size={18} />
                  Delete material
                </button>
                {usedBy.length > 0 && (
                  <p className="rw-mats__used" data-testid="materials.used-by">
                    Used by {usedBy.join(", ")}. Pick another material there to delete this one.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
