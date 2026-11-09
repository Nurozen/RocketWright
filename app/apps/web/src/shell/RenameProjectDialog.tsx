/**
 * Rename project (R0.7). The name is part of the model hash, so a rename
 * outdates every run; the dialog says so before it happens. The folder and all
 * ids stay as they are.
 */
import { useId, useRef, useState, type FormEvent } from "react";
import type { ProjectInfo } from "@rw/contracts";
import { Banner } from "../ui/Banner.tsx";
import { Modal } from "../ui/Modal.tsx";
import { TextField } from "../ui/TextField.tsx";
import { errorText, renameProblem, renameProject, type ProjectRpc } from "./projectActions.ts";

export const RENAME_OUTDATES_RUNS = "Renaming changes the design, so any runs you have flown become outdated and need flying again.";

export interface RenameProjectDialogProps {
  client: ProjectRpc;
  project: ProjectInfo;
  onClose: () => void;
}

export function RenameProjectDialog({ client, project, onClose }: RenameProjectDialogProps) {
  const [name, setName] = useState(project.name);
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
    if (name.trim() === project.name) return onClose();
    setSaving(true);
    renameProject(client, project.projectId, name).then(onClose, (err: unknown) => {
      setSaving(false);
      setError(errorText(err));
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Rename project"
      testId="rename-project"
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
        <TextField ref={nameRef} label="Name" value={name} onChange={setName} hint="The folder keeps its name." error={name !== "" || attempted ? problem : null} autoComplete="off" spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
        <Banner tone="warning" testId="rename-project.warning">
          {RENAME_OUTDATES_RUNS}
        </Banner>
        {error !== null && (
          <Banner tone="danger" testId="rename-project.error">
            {error}
          </Banner>
        )}
      </form>
    </Modal>
  );
}
