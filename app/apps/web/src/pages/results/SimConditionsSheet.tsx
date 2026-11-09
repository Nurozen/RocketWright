/**
 * Simulation conditions (R2.5): rail, site, wind, atmosphere and solver of one
 * sim, on a side sheet over Results. Save commits the conditions and flies
 * nothing; Save and run commits and flies once. A value the engine refuses
 * (RW-E067) comes back from a dry run and is shown at its field, so a Save
 * that would break the sim writes nothing. The sheet is a dialog, so the agent
 * pane freezes to a snapshot while it is open (D11).
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { schema } from "@rw/contracts";
import { trackWrite, useDirtyField } from "../../state/dirtyFields.ts";
import type { DeepReadonly } from "../../state/index.ts";
import { deleteSimOps, duplicateSimOps, newSimOps, renameSimOps } from "../../state/ops/sims.ts";
import { useAppState, type AppStore } from "../../state/store.ts";
import { Banner } from "../../ui/Banner.tsx";
import { FieldGroupFrame, SelectField, SpinField } from "../../ui/fields/index.ts";
import { MenuButton } from "../../ui/Menu.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { SideSheet } from "../../ui/SideSheet.tsx";
import { TextField } from "../../ui/TextField.tsx";
import { ResultsIcon } from "./ResultsIcon.tsx";
import { resultsUiStore, useResultsUi } from "./resultsUi.ts";
import { appliesToModel, conditionsOps, copySimName, fieldProblems, fieldUnit, formFromSim, isFormDirty, nextSimName, SIM_FIELDS, SIM_GROUPS, validateForm, type SimField, type SimForm } from "./simFields.ts";

type EvalSim = DeepReadonly<schema.EvalSim>;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Creates a flight sim of the project's first configuration and opens its sheet. */
export async function newSimulation(app: AppStore): Promise<void> {
  const st = app.getState();
  const ui = resultsUiStore(app).getState();
  const model = st.project.snapshot?.evaluated;
  const config = Object.keys(model?.configs ?? {}).sort()[0];
  if (model == null || config === undefined) {
    ui.set({ notice: "Add a configuration first: a simulation flies one." });
    return;
  }
  const name = nextSimName(Object.values(model.sims).flatMap((s) => (s == null ? [] : [s])));
  const { id, ops } = newSimOps(name, config, Object.keys(model.sims));
  try {
    await st.draft.mutate(ops, `Add simulation ${name}`);
    ui.set({ conditions: id, notice: null });
  } catch (e) {
    ui.set({ notice: message(e) });
  }
}

/**
 * Copies a sim's definition as a new, not-yet-run sim and opens its sheet (its
 * runs stay with the source). Rejects with the sidecar's refusal.
 */
export async function duplicateSimulation(app: AppStore, simId: string): Promise<void> {
  const st = app.getState();
  const sims = st.project.snapshot?.evaluated?.sims ?? {};
  const source = sims[simId];
  if (source == null) throw new Error(`Simulation ${simId} is no longer in the model.`);
  const name = copySimName(source.name, Object.values(sims).flatMap((s) => (s == null ? [] : [s])));
  const { id, ops } = duplicateSimOps(simId, name, Object.keys(sims));
  await st.draft.mutate(ops, `Duplicate ${source.name}`);
  resultsUiStore(app).getState().set({ conditions: id, notice: null });
}

export function SimConditionsSheet({ app }: { app: AppStore }) {
  const open = useResultsUi(app, (u) => u.conditions);
  const sim = useAppState(app, (s) => (open === null ? null : (s.project.snapshot?.evaluated?.sims[open] ?? null))) as EvalSim | null;
  const ui = resultsUiStore(app);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (open === null) return;
    if (sim !== null) seen.current = open;
    // Deleted while open (an undo, the agent). A sim just created is not in the mirror yet: keep waiting.
    else if (seen.current === open) ui.getState().set({ conditions: null });
  }, [open, sim, ui]);
  // Leaving Results leaves the sheet: it is not state to return to.
  useEffect(() => () => ui.getState().set({ conditions: null }), [ui]);
  if (open === null || sim === null) return null;
  return <Sheet key={open} app={app} sim={sim} />;
}

function Sheet({ app, sim }: { app: AppStore; sim: EvalSim }) {
  const ui = resultsUiStore(app);
  const configs = useAppState(app, (s) => s.project.snapshot?.evaluated?.configs ?? null);
  const simFile = useAppState(app, (s) => s.project.snapshot?.files.files[`sims/${sim.id}.rw.toml`] ?? "");
  const diagnostics = useAppState(app, (s) => s.project.snapshot?.evaluated?.diagnostics ?? null);
  const [form, setFormState] = useState<SimForm>(() => formFromSim(sim));
  const formRef = useRef(form);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);

  const setForm = (next: SimForm) => {
    formRef.current = next;
    setFormState(next);
  };
  const close = () => ui.getState().set({ conditions: null });

  // The model moved (an undo, the agent): follow it, unless the person is mid-edit.
  useEffect(() => {
    if (!isFormDirty(formRef.current)) setForm(formFromSim(sim));
  }, [sim]);

  const edit = (next: SimForm) => {
    setForm(next);
    setTyped(validateForm(next));
    setRefused({});
    setFailure(null);
  };
  const setValue = (key: string, text: string) => {
    const cur = formRef.current;
    edit({ ...cur, values: { ...cur.values, [key]: text } });
  };

  /** Resolves to why nothing was saved, or null. */
  const write = async (run: boolean): Promise<string | null> => {
    const f = formRef.current;
    const problems = validateForm(f);
    setTyped(problems);
    const typedProblem = Object.values(problems)[0];
    if (typedProblem !== undefined) return typedProblem;
    const st = app.getState();
    const ops = conditionsOps(f, simFile);
    setSaving(true);
    setFailure(null);
    setRefused({});
    try {
      if (ops.length > 0) {
        const preview = await st.draft.dryRun(ops);
        const found = fieldProblems(f.sim, preview.delta.new_diagnostics);
        const reason = Object.values(found.fields)[0] ?? found.other[0];
        if (reason !== undefined) {
          setRefused(found.fields);
          if (found.other.length > 0) setFailure(found.other.join(" "));
          return reason;
        }
        await st.draft.mutate(ops, `Edit conditions of ${sim.name}`);
      }
      close();
      // The page shows a run that could not start (`runs.error`); the conditions are saved either way.
      if (run) await st.runs.run(f.sim).catch(() => undefined);
      return null;
    } catch (e) {
      setFailure(message(e));
      return message(e);
    } finally {
      setSaving(false);
    }
  };

  const save = (run: boolean): void => {
    if (!saving) void trackWrite(write(run), (reason) => reason);
  };

  // D22: text typed here is not in the model until Save, and leaving the project may not blur.
  useDirtyField({
    dirty: () => isFormDirty(formRef.current),
    commit: () => {
      const first = Object.values(validateForm(formRef.current))[0];
      if (first !== undefined) return first;
      save(false);
      return null;
    },
  });

  const revert = () => edit({ ...formRef.current, values: { ...formRef.current.baseline }, config: formRef.current.baseConfig });

  const duplicate = () => {
    duplicateSimulation(app, sim.id).catch((e: unknown) => setFailure(message(e)));
  };

  const known = fieldProblems(sim.id, diagnostics ?? []);
  const errorOf = (key: string): string | null => typed[key] ?? refused[key] ?? known.fields[key] ?? null;
  const configIds = Object.keys(configs ?? {}).sort();
  const model = form.values["atmosphere.model"] ?? "";

  const renderField = (f: SimField) => {
    const error = errorOf(f.key);
    const off = !appliesToModel(f.key, model);
    return (
      <div key={f.key} className="rw-simcond__cell" data-invalid={error !== null ? "true" : undefined}>
        {f.kind === "number" ? (
          <SpinField
            testid="sim-conditions.field"
            field={{ key: f.key, label: f.label }}
            unit={fieldUnit(f)}
            value={form.values[f.key] ?? ""}
            placeholder=""
            step={f.step}
            title={off ? "Set by USSA 1976. Choose ISA (custom base) to change it." : f.title}
            byAgent={false}
            error={typed[f.key] ?? null}
            disabled={off}
            onChange={(text) => setValue(f.key, text)}
            onCommit={() => undefined}
            onDiscard={() => setValue(f.key, formRef.current.baseline[f.key] ?? "")}
          />
        ) : (
          <SelectField
            testid="sim-conditions.field"
            field={{ key: f.key, label: f.label }}
            value={form.values[f.key] ?? ""}
            options={f.options}
            labels={f.labels}
            placeholder={null}
            title={f.title}
            byAgent={false}
            onChange={(v) => setValue(f.key, v)}
          />
        )}
        {error !== null && (
          <p className="rw-simcond__error" role="alert" data-field={f.key}>
            {error}
          </p>
        )}
      </div>
    );
  };

  return (
    <>
      <SideSheet
        open
        onClose={close}
        title={`Simulation conditions: ${sim.name}`}
        testId="sim-conditions"
        className="rw-simcond"
        footer={
          <>
            <MenuButton
              testId="sim-conditions.more"
              label="Simulation actions"
              className="rw-icon-button"
              items={[
                { id: "rename", label: "Rename", onSelect: () => setDialog("rename") },
                { id: "duplicate", label: "Duplicate", onSelect: duplicate },
                { id: "delete", label: "Delete", danger: true, onSelect: () => setDialog("delete") },
              ]}
            >
              <ResultsIcon name="more" size={20} />
            </MenuButton>
            <button type="button" className="rw-button rw-simcond__action" disabled={saving || !isFormDirty(form)} onClick={revert}>
              Revert
            </button>
            <button type="button" className="rw-button rw-simcond__action" disabled={saving} onClick={() => save(false)}>
              Save
            </button>
            <button type="button" className="rw-button rw-button--primary rw-simcond__run" disabled={saving} aria-busy={saving} onClick={() => save(true)}>
              <ResultsIcon name="run" size={18} />
              Save and run
            </button>
          </>
        }
      >
        {failure !== null && (
          <Banner tone="danger" onDismiss={() => setFailure(null)} testId="sim-conditions.error">
            {failure}
          </Banner>
        )}
        {SIM_GROUPS.map((group) => (
          <FieldGroupFrame key={group} heading={group} group={group}>
            <div className="rw-simcond__grid">
              {SIM_FIELDS.filter((f) => f.group === group).map(renderField)}
              {group === "Launch" && configIds.length > 1 && (
                <div className="rw-simcond__cell">
                  <SelectField
                    testid="sim-conditions.field"
                    field={{ key: "config", label: "Configuration" }}
                    value={form.config}
                    options={configIds}
                    labels={Object.fromEntries(configIds.map((id) => [id, configs?.[id]?.name ?? id]))}
                    placeholder={null}
                    title="The configuration this simulation flies"
                    byAgent={false}
                    onChange={(config) => edit({ ...formRef.current, config })}
                  />
                </div>
              )}
            </div>
          </FieldGroupFrame>
        ))}
      </SideSheet>
      {dialog === "rename" && <RenameDialog app={app} sim={sim} onClose={() => setDialog(null)} />}
      {dialog === "delete" && <DeleteDialog app={app} sim={sim} onClose={() => setDialog(null)} />}
    </>
  );
}

function RenameDialog({ app, sim, onClose }: { app: AppStore; sim: EvalSim; onClose: () => void }) {
  const [name, setName] = useState(sim.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = name.trim();
    if (saving) return;
    if (next === "") {
      setError("Give the simulation a name.");
      return;
    }
    if (next === sim.name) return onClose();
    setSaving(true);
    app
      .getState()
      .draft.mutate(renameSimOps(sim.id, next), `Rename ${sim.name}`)
      .then(onClose, (err: unknown) => {
        setSaving(false);
        setError(message(err));
      });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Rename simulation"
      testId="rename-simulation"
      dismissOnEscape={!saving}
      dismissOnOutside={!saving}
      footer={
        <>
          <button type="button" className="rw-button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="rw-simcond-rename" className="rw-button rw-button--primary" disabled={saving} aria-busy={saving}>
            Rename
          </button>
        </>
      }
    >
      <form id="rw-simcond-rename" onSubmit={submit}>
        <TextField label="Name" value={name} onChange={setName} error={error ?? undefined} />
      </form>
    </Modal>
  );
}

function DeleteDialog({ app, sim, onClose }: { app: AppStore; sim: EvalSim; onClose: () => void }) {
  const ui = resultsUiStore(app);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const sims = useAppState(app, (s) => s.project.snapshot?.evaluated?.sims ?? null);
  const replayedBy = Object.values(sims ?? {}).flatMap((s) => (s != null && s.visual_flow?.replay === sim.id ? [s.name] : []));
  const remove = () => {
    setSaving(true);
    app
      .getState()
      .draft.mutate(deleteSimOps(sim.id), `Delete ${sim.name}`)
      .then(
        () => {
          onClose();
          ui.getState().set({ conditions: null });
        },
        (err: unknown) => {
          setSaving(false);
          setError(message(err));
        },
      );
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Delete simulation"
      testId="delete-simulation"
      dismissOnEscape={!saving}
      dismissOnOutside={!saving}
      footer={
        <>
          <button type="button" className="rw-button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="rw-button rw-button--danger" disabled={saving || replayedBy.length > 0} onClick={remove}>
            Delete
          </button>
        </>
      }
    >
      {replayedBy.length > 0 ? (
        <p>{`${replayedBy.join(", ")} replays this flight. Change that study before deleting ${sim.name}.`}</p>
      ) : (
        <p>{`Delete ${sim.name}? Runs it has flown stay listed as Outdated until you delete them from the run table.`}</p>
      )}
      {error !== null && <p className="rw-simcond__error" role="alert">{error}</p>}
    </Modal>
  );
}
