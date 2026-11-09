/**
 * The two questions import and export have to ask inside the window. Replacing
 * the open design takes a second, explicit step, and New project is what Return
 * picks (R3.1). Choosing where a file goes is the host's: a native dialog, or a
 * typed path in a browser.
 */
import { useId, useRef, useState } from "react";
import { EXPORT_FILE_TYPES, type schema } from "@rw/contracts";
import type { ExportChoices, ExportRunChoice } from "../state/selectors.ts";
import { Modal } from "../ui/Modal.tsx";
import { RadioCardGroup } from "../ui/RadioCard.tsx";

export interface OrkImportDialogProps {
  fileName: string;
  projectName: string;
  onCancel: () => void;
  onNew: () => void;
  onReplace: () => void;
}

export function OrkImportDialog({ fileName, projectName, onCancel, onNew, onReplace }: OrkImportDialogProps) {
  const [confirming, setConfirming] = useState(false);
  const newRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  // Keyed so each step mounts its own focus scope: the same element would keep the first step's focus.
  if (confirming) {
    return (
      <Modal
        key="confirm"
        open
        onClose={() => setConfirming(false)}
        title={`Replace ${projectName}?`}
        testId="ork-import.confirm"
        initialFocus={keepRef}
        footer={
          <>
            <button ref={keepRef} type="button" className="rw-button" onClick={() => setConfirming(false)}>
              Keep current design
            </button>
            <button type="button" className="rw-button rw-button--primary" onClick={onReplace}>
              Replace design
            </button>
          </>
        }
      >
        <p>
          The parts of {projectName} are replaced by those in {fileName}, and configurations and simulations the file does not have are removed. You can go back to the current design in History.
        </p>
      </Modal>
    );
  }
  return (
    <Modal
      key="choose"
      open
      onClose={onCancel}
      title={`Import ${fileName}`}
      testId="ork-import"
      initialFocus={newRef}
      footer={
        <>
          <button type="button" className="rw-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="rw-button" onClick={() => setConfirming(true)}>
            Replace current design…
          </button>
          <button ref={newRef} type="button" className="rw-button rw-button--primary" onClick={onNew}>
            Create new project
          </button>
        </>
      }
    >
      <p>Create a new project from this file, or replace the design of {projectName} with it?</p>
    </Modal>
  );
}

type ExportFormat = schema.ExportFormat;

export interface ExportDialogProps {
  choices: ExportChoices;
  onCancel: () => void;
  onExport: (format: ExportFormat, run: ExportRunChoice | undefined) => void;
}

const FORMATS = (Object.keys(EXPORT_FILE_TYPES) as ExportFormat[]).map((value) => ({ value, title: EXPORT_FILE_TYPES[value].label, description: EXPORT_FILE_TYPES[value].description }));

export function ExportDialog({ choices, onCancel, onExport }: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>("ork");
  const [runRef, setRunRef] = useState(choices.runs[0]?.ref ?? "");
  const runId = useId();
  const run = choices.runs.find((r) => r.ref === runRef);
  const wantsRun = format === "csv";
  // An Empty project still "exports": a valid file with nothing in it, which reads as a bug later.
  const reason = choices.noParts ? "This project has no parts yet, so there is nothing to export." : wantsRun && run === undefined ? "Fly a simulation first: flight data comes from a run." : null;
  return (
    <Modal
      open
      onClose={onCancel}
      title="Export"
      testId="export-dialog"
      footer={
        <>
          <button type="button" className="rw-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="rw-button rw-button--primary" disabled={reason !== null} onClick={() => onExport(format, wantsRun ? run : undefined)}>
            Export…
          </button>
        </>
      }
    >
      <RadioCardGroup label="Format" value={format} options={FORMATS} onChange={setFormat} />
      {wantsRun && run !== undefined && (
        <p>
          <label htmlFor={runId}>Run </label>
          <select id={runId} value={runRef} onChange={(e) => setRunRef(e.target.value)}>
            {choices.runs.map((r) => (
              <option key={r.ref} value={r.ref}>
                {r.label}
              </option>
            ))}
          </select>
        </p>
      )}
      {reason !== null && <p role="status">{reason}</p>}
    </Modal>
  );
}
