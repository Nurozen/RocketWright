/**
 * The Components rail's "+": a palette of every part kind in the model, with
 * the part it attaches to. The new part is committed at once and selected, so
 * the editor can size it next; on a project with no parts it becomes the root.
 */
import { useId, useMemo, useState } from "react";
import type { schema } from "@rw/contracts";
import { Icon } from "../../shell/Icon.tsx";
import { componentRef, useAppState, type AppStore, type DeepReadonly } from "../../state/index.ts";
import { addPartOps, PART_KINDS, partLabel, uniquePartName, type PartKind } from "../../state/ops/parts.ts";
import { selectedComponentIds } from "../../state/slices/selection.ts";
import { Banner } from "../../ui/Banner.tsx";
import { Popover } from "../../ui/Popover.tsx";
import { attachmentFor, defaultParent, parentChoices, ROOT_KINDS } from "./attach-targets.ts";
import { kindIcon } from "./ComponentTree.tsx";
import "./assembly.css";

type Part = DeepReadonly<schema.EvalComponent>;

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

/** Why `kind` cannot be added right now, or null when it can. */
export function unavailableReason(kind: PartKind, components: readonly Part[], parent: Part | null): string | null {
  if (components.length === 0) return ROOT_KINDS.includes(kind) ? null : "Start the rocket with a nose cone, body tube or transition.";
  if (kind === "nose_cone") return "A nose cone can only start the rocket.";
  if (parent === null) return "Add a body part first.";
  return attachmentFor(kind, parent) === null ? `A ${partLabel(kind).toLowerCase()} cannot attach to ${parent.name}.` : null;
}

export interface AddPartPaletteProps {
  /** Committed parts; null while the model cannot be evaluated. */
  components: readonly Part[] | null;
  selected: readonly string[];
  onAdd: (kind: PartKind, parent: Part | null) => Promise<unknown>;
  onDone: () => void;
}

export function AddPartPalette({ components, selected, onAdd, onDone }: AddPartPaletteProps) {
  const attachId = useId();
  const choices = useMemo(() => parentChoices(components ?? []), [components]);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parent = choices.find((c) => c.id === picked) ?? defaultParent(components ?? [], selected);
  const empty = components?.length === 0;

  const add = (kind: PartKind): void => {
    setBusy(true);
    setError(null);
    onAdd(kind, empty ? null : parent).then(onDone, (e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    });
  };

  return (
    <div className="rw-add-part" data-testid="add-part">
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
      <div className="rw-add-part__grid">
        {PART_KINDS.map((kind) => {
          const reason = components === null ? "The model cannot be evaluated right now." : unavailableReason(kind, components, parent);
          return (
            <button key={kind} type="button" className="rw-add-part__tile" disabled={busy || reason !== null} title={reason ?? undefined} onClick={() => add(kind)}>
              <Icon name={kindIcon(kind)} size={28} />
              <span>{partLabel(kind)}</span>
            </button>
          );
        })}
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
        <AddPartPalette components={components} selected={selected} onAdd={(kind, parent) => addPart(store, components ?? [], kind, parent)} onDone={() => setAnchor(null)} />
      </Popover>
    </>
  );
}
