/**
 * The controls of the part operations (R2.2): the menu the tree and the
 * inspector share, and the dialogs. Dialogs live at the shell, driven by
 * `ui.partDialog`, so all three entry points open the same ones.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { schema } from "@rw/contracts";
import { Icon } from "../../shell/Icon.tsx";
import { errorText, renameProblem } from "../../shell/projectActions.ts";
import { RENAME_OUTDATES_RUNS } from "../../shell/RenameProjectDialog.tsx";
import { useAppState, type AppStore, type DeepReadonly } from "../../state/index.ts";
import { duplicateRefusal } from "../../state/ops/parts.ts";
import { Banner } from "../../ui/Banner.tsx";
import type { MenuEntry } from "../../ui/Menu.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { TextField } from "../../ui/TextField.tsx";
import { attachedParts, deleteAlso, deletePart, duplicatePart, movePart, moveTargets, removalPartsOf, renamePart } from "./partOps.ts";

type Part = DeepReadonly<schema.EvalComponent>;

function report(store: AppStore, title: string, work: Promise<unknown>): void {
  work.catch((e: unknown) => store.getState().ui.setPartDialog({ kind: "error", title, message: errorText(e) }));
}

/** Rename, Duplicate, Move to and Delete for one part. */
export function partMenuItems(store: AppStore, components: readonly Part[], id: string): MenuEntry[] {
  const part = components.find((c) => c.id === id);
  if (part === undefined) return [];
  const targets = moveTargets(components, id);
  const ui = () => store.getState().ui;
  return [
    { id: "rename", label: "Rename", icon: <Icon name="pencil" size={16} />, onSelect: () => ui().setPartDialog({ kind: "rename", id }) },
    { id: "duplicate", label: "Duplicate", icon: <Icon name="copy" size={16} />, disabled: duplicateRefusal(part) !== null, onSelect: () => report(store, "Could not duplicate the part", duplicatePart(store, id)) },
    {
      id: "move",
      label: "Move to",
      icon: <Icon name="folder" size={16} />,
      disabled: targets.length === 0,
      submenu: targets.map((t) => ({ id: t.id, label: t.label, onSelect: () => report(store, "Could not move the part", movePart(store, id, t)) })),
    },
    { kind: "divider", id: "divider" },
    {
      id: "delete",
      label: "Delete",
      icon: <Icon name="trash" size={16} />,
      danger: true,
      onSelect: () => {
        const also = deleteAlso(store.getState(), id);
        ui().setPartDialog(also.length > 0 ? { kind: "delete", id, also } : { kind: "delete", id });
      },
    },
  ];
}

function RenamePartDialog({ store, part, onClose }: { store: AppStore; part: Part; onClose: () => void }) {
  const [name, setName] = useState(part.name);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const problem = renameProblem(name);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setAttempted(true);
    setError(null);
    if (problem !== null) return;
    // The same name would still write a step and outdate every run.
    if (name.trim() === part.name) return onClose();
    setSaving(true);
    renamePart(store, part.id, name).then(onClose, (err: unknown) => {
      setSaving(false);
      setError(errorText(err));
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Rename part"
      testId="rename-part"
      initialFocus={nameRef}
      dismissOnEscape={!saving}
      dismissOnOutside={!saving}
      footer={
        <>
          <button type="button" className="rw-button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={formId} className="rw-button rw-button--primary" disabled={saving} aria-busy={saving}>
            Rename
          </button>
        </>
      }
    >
      <form id={formId} className="rw-new-project" onSubmit={submit} noValidate>
        <TextField ref={nameRef} label="Name" value={name} onChange={setName} error={name !== "" || attempted ? problem : null} autoComplete="off" spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
        <Banner tone="warning" testId="rename-part.warning">
          {RENAME_OUTDATES_RUNS}
        </Banner>
        {error !== null && (
          <Banner tone="danger" testId="rename-part.error">
            {error}
          </Banner>
        )}
      </form>
    </Modal>
  );
}

function DeletePartDialog({ store, part, also, components, onClose }: { store: AppStore; part: Part; also: readonly string[]; components: readonly Part[]; onClose: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // The agent can delete one of these while the dialog is open.
  const others = also.filter((id) => id !== part.id && components.some((c) => c.id === id));
  const many = others.length > 0;
  const attached = many ? removalPartsOf(components, [part.id, ...others]) : attachedParts(components, part.id);

  const confirm = () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    deletePart(store, part.id, others).then(onClose, (err: unknown) => {
      setSaving(false);
      setError(errorText(err));
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={many ? `Delete ${others.length + 1} parts?` : `Delete ${part.name}?`}
      testId="delete-part"
      className="rw-part-dialog"
      initialFocus={cancelRef}
      dismissOnEscape={!saving}
      dismissOnOutside={!saving}
      footer={
        <>
          <button ref={cancelRef} type="button" className="rw-button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="rw-button rw-button--danger" disabled={saving} aria-busy={saving} onClick={confirm}>
            Delete
          </button>
        </>
      }
    >
      {attached.length > 0 && (
        <>
          <p>{many ? "These parts are deleted, with anything attached to them:" : "These parts are attached to it and are deleted with it:"}</p>
          <ul className="rw-part-dialog__list" aria-label={many ? "Parts to delete" : "Parts deleted with it"}>
            {attached.map((c) => (
              <li key={c.id}>{c.name}</li>
            ))}
          </ul>
        </>
      )}
      <p>{many || attached.length > 0 ? "Their" : "Its"} motor assignments and deploy settings are removed from every configuration. Undo brings everything back.</p>
      {error !== null && (
        <Banner tone="danger" testId="delete-part.error">
          {error}
        </Banner>
      )}
    </Modal>
  );
}

export function PartDialogs({ store }: { store: AppStore }) {
  const dialog = useAppState(store, (s) => s.ui.partDialog);
  const components = useAppState(store, (s) => s.project.snapshot?.evaluated?.components ?? null);
  const close = () => store.getState().ui.setPartDialog(null);
  const part = dialog === null || dialog.kind === "error" ? undefined : components?.find((c) => c.id === dialog.id);
  // The agent can delete the part while the dialog is open.
  const gone = dialog !== null && dialog.kind !== "error" && part === undefined;
  useEffect(() => {
    if (gone) store.getState().ui.setPartDialog(null);
  }, [gone, store]);

  if (dialog === null || gone) return null;
  if (dialog.kind === "error") {
    return (
      <Modal
        open
        onClose={close}
        title={dialog.title}
        testId="part-error"
        footer={
          <button type="button" className="rw-button rw-button--primary" onClick={close}>
            OK
          </button>
        }
      >
        <Banner tone="danger" testId="part-error.message">
          {dialog.message}
        </Banner>
      </Modal>
    );
  }
  if (dialog.kind === "rename") return <RenamePartDialog key={part!.id} store={store} part={part!} onClose={close} />;
  return <DeletePartDialog key={part!.id} store={store} part={part!} also={dialog.also ?? []} components={components ?? []} onClose={close} />;
}
