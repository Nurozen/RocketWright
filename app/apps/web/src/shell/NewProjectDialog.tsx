/**
 * New project (R0.3). The fields check what they can as they are typed; what
 * only the server can know (a project already there, no permission) comes
 * back from `project.create` and shows at the bottom of the dialog.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { HostApi } from "../host/HostApi.ts";
import { Banner } from "../ui/Banner.tsx";
import { Modal } from "../ui/Modal.tsx";
import { RadioCardGroup } from "../ui/RadioCard.tsx";
import { TextField } from "../ui/TextField.tsx";
import { createProject, DEFAULT_TEMPLATE, errorText, locationProblem, nameProblem, targetPreview, TEMPLATE_CARDS, type NewProjectTemplate, type ProjectRpc } from "./projectActions.ts";

/** A folder Open found empty of projects: the dialog starts on it and says why (R0.4). */
export interface NewProjectOffer {
  name: string;
  location: string;
  message: string;
}

export interface NewProjectDialogProps {
  client: ProjectRpc;
  host: Pick<HostApi, "pickFolder">;
  offer?: NewProjectOffer | undefined;
  onClose: () => void;
  onCreated: (projectId: string) => void;
}

export function NewProjectDialog({ client, host, offer, onClose, onCreated }: NewProjectDialogProps) {
  const [name, setName] = useState(offer?.name ?? "");
  const [location, setLocation] = useState(offer?.location ?? "");
  const [template, setTemplate] = useState<NewProjectTemplate>(DEFAULT_TEMPLATE);
  const [loadingDefaults, setLoadingDefaults] = useState(offer === undefined);
  const [attempted, setAttempted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  const needsDefaults = offer === undefined;
  useEffect(() => {
    if (!needsDefaults) return;
    let live = true;
    client
      .call("project.defaults", {})
      .then(
        (defaults) => {
          // Someone quick may have typed a location already.
          if (live) setLocation((typed) => (typed === "" ? defaults.location : typed));
        },
        (e: unknown) => {
          if (live) setError(`Could not find the default location: ${errorText(e)}`);
        },
      )
      .finally(() => {
        if (live) setLoadingDefaults(false);
      });
    return () => {
      live = false;
    };
  }, [client, needsDefaults]);

  const badName = nameProblem(name);
  const badLocation = locationProblem(location);
  // An empty field is not an error until someone tries to use it.
  const shownNameError = name !== "" || attempted ? badName : null;
  const shownLocationError = attempted && !loadingDefaults ? badLocation : null;

  const choose = () => {
    host.pickFolder({ title: "Choose a location", ...(location.trim() === "" ? {} : { defaultPath: location.trim() }) }).then(
      (picked) => {
        if (picked !== null) setLocation(picked);
      },
      (e: unknown) => setError(errorText(e)),
    );
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (creating || loadingDefaults) return;
    setAttempted(true);
    setError(null);
    if (badName !== null || badLocation !== null) return;
    setCreating(true);
    createProject(client, { name, location, template }).then(
      (project) => onCreated(project.projectId),
      (err: unknown) => {
        setCreating(false);
        setError(errorText(err));
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New project"
      className="rw-new-project-dialog"
      testId="new-project"
      initialFocus={nameRef}
      dismissOnEscape={!creating}
      dismissOnOutside={!creating}
      footer={
        <>
          <button type="button" className="rw-button" disabled={creating} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={formId} className="rw-button rw-button--primary" disabled={creating || loadingDefaults} aria-busy={creating}>
            Create project
          </button>
        </>
      }
    >
      <form id={formId} className="rw-new-project" onSubmit={submit} noValidate>
        {offer !== undefined && <p className="rw-new-project__offer">{offer.message}</p>}
        <TextField ref={nameRef} label="Name" value={name} onChange={setName} error={shownNameError} autoComplete="off" spellCheck={false} />
        <TextField
          label="Location"
          value={location}
          onChange={setLocation}
          hint={targetPreview(location, name)}
          error={shownLocationError}
          autoComplete="off"
          spellCheck={false}
          trailing={
            <button type="button" className="rw-button" disabled={creating} onClick={choose}>
              Choose
            </button>
          }
        />
        <RadioCardGroup label="Template" value={template} options={TEMPLATE_CARDS} onChange={setTemplate} />
        {creating && (
          <p className="rw-new-project__status" role="status">
            Creating the project…
          </p>
        )}
        {error !== null && (
          <Banner tone="danger" testId="new-project.error">
            {error}
          </Banner>
        )}
      </form>
    </Modal>
  );
}
