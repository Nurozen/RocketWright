/**
 * The Components rail's "+": every part kind in the model and the catalog of
 * built-in parts, with the part a new one attaches to. The new part is
 * committed at once and selected, so the editor can size it next; on a project
 * with no parts it becomes the root.
 */
import { useId, useMemo, useState } from "react";
import type { schema } from "@rw/contracts";
import { Icon } from "../../shell/Icon.tsx";
import { componentRef, useAppState, type AppStore, type DeepReadonly } from "../../state/index.ts";
import { addPartOps, PART_KINDS, partLabel, uniquePartName, type PartKind } from "../../state/ops/parts.ts";
import { selectedComponentIds } from "../../state/slices/selection.ts";
import { Banner } from "../../ui/Banner.tsx";
import { Popover } from "../../ui/Popover.tsx";
import { attachmentFor, defaultParent, onlyStartsRocket, parentChoices, ROOT_KINDS } from "./attach-targets.ts";
import { kindIcon } from "./ComponentTree.tsx";
import { PartsLibrary, type PresetSearch } from "./PartsLibrary.tsx";
import { addPresetOps, presetGeometryOps, presetKind } from "./presets.ts";
import "./assembly.css";

type Part = DeepReadonly<schema.EvalComponent>;
type LibItem = DeepReadonly<schema.LibItem>;

/** Commits a new part of `kind` on `parent` (null: the root of an empty project) and selects it. */
export async function addPart(store: AppStore, components: readonly Part[], kind: PartKind, parent: Part | null): Promise<string> {
  const attach = parent === null ? null : attachmentFor(kind, parent);
  if (parent !== null && attach === null) throw new Error(`A ${partLabel(kind).toLowerCase()} cannot attach to ${parent.name}.`);
  const name = uniquePartName(partLabel(kind), components.map((c) => c.name));
  const { id, ops } = addPartOps({ kind, taken: components.map((c) => c.id), name, ...(attach !== null ? { attach } : {}) });
  await store.getState().draft.mutate(ops, `Add ${name}`);
  store.getState().selection.select([componentRef(id)], "tree");
  return id;
}

/** Commits a catalog part as a new part on `parent` (null: the root of an empty project), with the materials it uses, and selects it. */
export async function addPreset(store: AppStore, components: readonly Part[], materials: Iterable<string>, item: LibItem, parent: Part | null): Promise<string> {
  const kind = presetKind(item);
  if (kind === null) throw new Error(`${item.name} is not a part.`);
  const attach = parent === null ? null : attachmentFor(kind, parent);
  if (parent !== null && attach === null) throw new Error(`A ${partLabel(kind).toLowerCase()} cannot attach to ${parent.name}.`);
  const { id, name, ops } = addPresetOps({ item, takenIds: components.map((c) => c.id), takenNames: components.map((c) => c.name), materials, ...(attach !== null ? { attach } : {}) });
  await store.getState().draft.mutate(ops, `Add ${name}`);
  store.getState().selection.select([componentRef(id)], "tree");
  return id;
}

/** Puts a catalog part's size on `part`. Its name, material and placement stay. */
export async function replaceGeometry(store: AppStore, item: LibItem, part: Part): Promise<void> {
  const ops = presetGeometryOps(item, part);
  if (ops.length === 0) throw new Error(`${item.name} has no ${partLabel(part.shape.type).toLowerCase()} fields to apply.`);
  await store.getState().draft.mutate(ops, `Apply preset ${item.name}`);
}

const ROOT_LIST = ROOT_KINDS.map((k) => partLabel(k).toLowerCase()).join(", ").replace(/, ([^,]*)$/, " or $1");

/** Why `kind` cannot be added right now, or null when it can. */
export function unavailableReason(kind: PartKind, components: readonly Part[], parent: Part | null): string | null {
  if (components.length === 0) return ROOT_KINDS.includes(kind) ? null : `Start the rocket with a ${ROOT_LIST}.`;
  if (onlyStartsRocket(kind)) return `A ${partLabel(kind).toLowerCase()} can only start the rocket.`;
  if (parent === null) return "Add a body part first.";
  return attachmentFor(kind, parent) === null ? `A ${partLabel(kind).toLowerCase()} cannot attach to ${parent.name}.` : null;
}

export interface AddPartPaletteProps {
  /** Committed parts; null while the model cannot be evaluated. */
  components: readonly Part[] | null;
  selected: readonly string[];
  onAdd: (kind: PartKind, parent: Part | null) => Promise<unknown>;
  onDone: () => void;
  library: {
    search: PresetSearch;
    onAdd: (item: LibItem, parent: Part | null) => Promise<unknown>;
    onReplace: (item: LibItem, part: Part) => Promise<unknown>;
  };
}

type PaletteTab = "types" | "library";

export function AddPartPalette({ components, selected, onAdd, onDone, library }: AddPartPaletteProps) {
  const attachId = useId();
  const panelId = useId();
  const [tab, setTab] = useState<PaletteTab>("types");
  const choices = useMemo(() => parentChoices(components ?? []), [components]);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parent = choices.find((c) => c.id === picked) ?? defaultParent(components ?? [], selected);
  const empty = components?.length === 0;

  const run = (commit: () => Promise<unknown>): void => {
    setBusy(true);
    setError(null);
    commit().then(onDone, (e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    });
  };
  const add = (kind: PartKind): void => run(() => onAdd(kind, empty ? null : parent));
  const reasonFor = (kind: PartKind): string | null => (components === null ? "The model cannot be evaluated right now." : unavailableReason(kind, components, parent));
  const selectedPart = selected.length === 1 ? ((components ?? []).find((c) => c.id === selected[0]) ?? null) : null;

  const tabButton = (id: PaletteTab, label: string) => (
    <button type="button" role="tab" className="rw-tab" aria-selected={tab === id} aria-controls={panelId} onClick={() => setTab(id)}>
      {label}
    </button>
  );

  return (
    <div className="rw-add-part" data-testid="add-part">
      <div className="rw-add-part__tabs" role="tablist" aria-label="Add part">
        {tabButton("types", "Part types")}
        {tabButton("library", "Parts library")}
      </div>
      {components === null ? (
        <p className="rw-add-part__note">The model cannot be evaluated right now. Fix its errors, then add parts.</p>
      ) : empty ? (
        <p className="rw-add-part__note">The first part starts the rocket.</p>
      ) : (
        choices.length > 0 && (
          <div className="rw-add-part__attach">
            <label htmlFor={attachId}>Attach to</label>
            <span className="rw-select rw-select--native">
              <select id={attachId} value={parent?.id ?? ""} disabled={busy} onChange={(e) => setPicked(e.currentTarget.value)}>
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <Icon name="chevron-down" size={14} />
            </span>
          </div>
        )
      )}
      <div id={panelId} role="tabpanel">
        {tab === "types" ? (
          <div className="rw-add-part__grid">
            {PART_KINDS.map((kind) => {
              const reason = reasonFor(kind);
              return (
                <button key={kind} type="button" className="rw-add-part__tile" disabled={busy || reason !== null} title={reason ?? undefined} onClick={() => add(kind)}>
                  <Icon name={kindIcon(kind)} size={28} />
                  <span>{partLabel(kind)}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <PartsLibrary
            search={library.search}
            reasonFor={reasonFor}
            selected={selectedPart}
            busy={busy}
            onAdd={(item) => run(() => library.onAdd(item, empty ? null : parent))}
            onReplace={(item, part) => run(() => library.onReplace(item, part))}
          />
        )}
      </div>
      {error !== null && (
        <Banner tone="danger" testId="add-part.error">
          {error}
        </Banner>
      )}
    </div>
  );
}

/** The rail's "+". Named by its action, since the icon alone says nothing to a screen reader. */
export function AddPartButton({ store }: { store: AppStore }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const components = useAppState(store, (s) => s.project.snapshot?.evaluated?.components ?? null);
  const materials = useAppState(store, (s) => s.project.snapshot?.evaluated?.materials ?? null);
  const refs = useAppState(store, (s) => s.selection.refs);
  const selected = useMemo(() => selectedComponentIds(refs), [refs]);
  return (
    <>
      <button
        type="button"
        className="rw-icon-button"
        aria-label="Add part"
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        title="Add part"
        onClick={(e) => {
          const button = e.currentTarget;
          setAnchor((cur) => (cur === null ? button : null));
        }}
      >
        <Icon name="plus" size={18} />
      </button>
      <Popover open={anchor !== null} anchor={anchor} onClose={() => setAnchor(null)} title="Add part" side="bottom" align="start" className="rw-add-part__popover" testId="add-part.popover">
        <AddPartPalette
          components={components}
          selected={selected}
          onAdd={(kind, parent) => addPart(store, components ?? [], kind, parent)}
          onDone={() => setAnchor(null)}
          library={{
            search: (query) => store.getState().project.searchLibrary(query),
            onAdd: (item, parent) => addPreset(store, components ?? [], Object.keys(materials ?? {}), item, parent),
            onReplace: (item, part) => replaceGeometry(store, item, part),
          }}
        />
      </Popover>
    </>
  );
}
