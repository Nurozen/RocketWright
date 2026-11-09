/**
 * The browser's stand-in for a native picker (R0.12): whatever `browserHost`
 * is asking, as a typed path. Mounted once at the window's root, so a prompt
 * from anywhere has a surface and stacks above a dialog that asked for it.
 */
import { useId, useState, useSyncExternalStore, type FormEvent } from "react";
import type { PathPrompts } from "../host/browserHost.ts";
import { Modal } from "../ui/Modal.tsx";
import { TextField } from "../ui/TextField.tsx";

export function PathPromptModal({ prompts }: { prompts: PathPrompts }) {
  const request = useSyncExternalStore(prompts.subscribe, prompts.current);
  const [path, setPath] = useState("");
  const [seen, setSeen] = useState(request);
  const formId = useId();
  // A new question starts from its own default, not the last one's typing.
  if (seen !== request) {
    setSeen(request);
    setPath(request?.defaultPath ?? "");
  }
  if (request === null) return null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    prompts.submit(path);
  };
  return (
    <Modal
      open
      onClose={prompts.cancel}
      title={request.title}
      testId="path-prompt"
      footer={
        <>
          <button type="button" className="rw-button" onClick={prompts.cancel}>
            Cancel
          </button>
          <button type="submit" form={formId} className="rw-button rw-button--primary">
            {request.kind === "save" ? "Save" : "Choose"}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        <TextField label="Path" value={path} onChange={setPath} hint="Type the full path on this computer." autoComplete="off" spellCheck={false} />
      </form>
    </Modal>
  );
}
