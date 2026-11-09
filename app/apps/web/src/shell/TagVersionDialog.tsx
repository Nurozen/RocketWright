/**
 * Names a design step as a revision (`history_tag`, R3.8). The dialog stays
 * open on a failure so the typed name survives and the reason can be read.
 */
import { useId, useState, type FormEvent } from "react";
import { Modal } from "../ui/Modal.tsx";
import { TextField } from "../ui/TextField.tsx";

export interface TagVersionDialogProps {
  /** The step's words: `Step 04`. */
  versionLabel: string;
  onTag: (name: string) => Promise<unknown>;
  onClose: () => void;
}

export function TagVersionDialog({ versionLabel, onTag, onClose }: TagVersionDialogProps) {
  const formId = useId();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setError(null);
    onTag(trimmed).then(onClose, (err: unknown) => {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Tag ${versionLabel}`}
      testId="history.tag-dialog"
      dismissOnEscape={!busy}
      dismissOnOutside={!busy}
      footer={
        <>
          <button type="button" className="rw-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={formId} className="rw-button rw-button--primary" disabled={trimmed === "" || busy} aria-busy={busy || undefined}>
            Tag
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        <TextField label="Revision name" value={name} onChange={setName} error={error} hint="Saved as the next revision number. The design does not change." />
      </form>
    </Modal>
  );
}
