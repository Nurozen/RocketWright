/**
 * The liquid engine editor on Properties (R3.2): New, Duplicate and Delete, a
 * card per group of design inputs, and Compute with its result strip.
 *
 * A field writes when it is committed (Enter, blur, a spinner), so the model
 * always holds what the cards show, and Compute reads saved state. Compute
 * first flushes whatever is still in a field and waits for the mirror: its
 * result is then filed under the engine it actually saw.
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import type { MutationOut } from "@rw/contracts";
import { Icon } from "../../shell/Icon.tsx";
import { flushProject, trackWrite } from "../../state/dirtyFields.ts";
import { useAppState, type AppStore } from "../../state/index.ts";
import { deleteEngineOps, duplicateEngineOps, newEngineOps, renameEngineOps } from "../../state/ops/engines.ts";
import { StatStrip } from "../../ui/StatStrip.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { FieldGroupFrame, SelectField, TextField, type FieldDiagnostic } from "../../ui/fields/index.ts";
import {
  ENGINE_CARDS,
  addInjectorOps,
  cardFields,
  copyEngineName,
  engineSource,
  isModified,
  mirrorAt,
  nextEngineName,
  nextPair,
  propellantChoice,
  propellantLabels,
  propellantOps,
  tankFields,
  tankGroups,
  type DesignEntry,
} from "./engineOps.ts";
import { FieldRow, message, useTextEdit, type RowContext, type Write } from "./EngineFields.tsx";
import { FeedGraphEditor } from "./FeedGraphEditor.tsx";
import { resultStats, type EvalEngine } from "./model.ts";

const engineNames = (app: AppStore): string[] => Object.values(app.getState().project.snapshot?.evaluated?.engines ?? {}).flatMap((e) => (e == null ? [] : [e.name]));
const engineKeys = (app: AppStore): string[] => Object.keys(app.getState().project.snapshot?.evaluated?.engines ?? {});

/** Adds an engine with the schema's required inputs and shows it. Rejects with the sidecar's refusal. */
async function createEngine(app: AppStore, onShow: (id: string) => void): Promise<void> {
  const name = nextEngineName(engineNames(app));
  const { id, ops } = newEngineOps(name, engineKeys(app));
  const out = await app.getState().draft.mutate(ops, `Add engine ${name}`);
  // The page picks an engine from the mirror: until this one is there it would fall back to the first.
  await mirrorAt(app, out?.model_hash ?? null);
  onShow(id);
}

/** The Propulsion system rail's "+": the same add as New engine. */
export function AddEngineRailButton({ app, onShow }: { app: AppStore; onShow: (id: string) => void }) {
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const hasProject = useAppState(app, (s) => s.project.snapshot !== null);
  const add = () => {
    setSaving(true);
    setProblem(null);
    createEngine(app, onShow)
      .catch((e: unknown) => setProblem(message(e)))
      .finally(() => setSaving(false));
  };
  return (
    <>
      <button type="button" className="rw-icon-button" aria-label="Add engine" title="Add engine" data-testid="rail.add-engine" disabled={saving || !hasProject} aria-busy={saving} onClick={add}>
        <Icon name="plus" size={18} />
      </button>
      {problem !== null && (
        <p className="rw-rail__empty rw-rail__alert" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}

/** New engine, on the toolbar and in the empty state. */
export function NewEngineButton({ app, onShow, primary = false }: { app: AppStore; onShow: (id: string) => void; primary?: boolean }) {
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const add = () => {
    setSaving(true);
    setProblem(null);
    createEngine(app, onShow)
      .catch((e: unknown) => setProblem(message(e)))
      .finally(() => setSaving(false));
  };
  return (
    <>
      <button type="button" className={primary ? "rw-button rw-button--primary" : "rw-button"} data-testid="liquid.new-engine" disabled={saving} aria-busy={saving} onClick={add}>
        <Icon name="plus" size={18} />
        New engine
      </button>
      {problem !== null && (
        <p className="rw-liq-editor__error" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}

function NameRow({ ctx }: { ctx: RowContext }) {
  const edit = useTextEdit(
    ctx.engine.name,
    (text) => (text.trim() === "" ? "Give the engine a name." : null),
    (text) => ctx.write(renameEngineOps(ctx.engineId, text.trim()), `Rename ${ctx.engine.name}`),
  );
  return (
    <div className="rw-liq-editor__row">
      <TextField
        testid="liquid-editor.field"
        field={{ key: "name", label: "Engine name" }}
        value={edit.value}
        placeholder=""
        title="The name shown in the engine list and in reports."
        byAgent={false}
        error={edit.error}
        onChange={edit.onChange}
        onCommit={edit.onCommit}
        onDiscard={edit.onDiscard}
      />
      {edit.error !== null && (
        <p className="rw-liq-editor__error" role="alert" data-field="name">
          {edit.error}
        </p>
      )}
    </div>
  );
}

function PropellantRows({ ctx, onProblem }: { ctx: RowContext; onProblem: (text: string) => void }) {
  const { oxidizer, fuel } = ctx.engine;
  const choice = propellantChoice(oxidizer, fuel);
  const choose = (change: { oxidizer?: string; fuel?: string }) => {
    const next = nextPair({ oxidizer, fuel }, change);
    if (next.oxidizer === oxidizer && next.fuel === fuel) return;
    const ops = propellantOps(ctx.engineId, ctx.engine, ctx.source, next);
    trackWrite(ctx.write(ops, `Edit propellants of ${ctx.engine.name}`)).catch((e: unknown) => onProblem(message(e)));
  };
  return (
    <>
      <SelectField
        testid="liquid-editor.field"
        field={{ key: "oxidizer", label: "Oxidizer" }}
        value={oxidizer}
        options={choice.oxidizers}
        labels={propellantLabels(choice.oxidizers)}
        placeholder={null}
        title="Only propellant pairs with shipped thermochemistry tables are offered."
        byAgent={false}
        onChange={(v) => choose({ oxidizer: v })}
      />
      <SelectField
        testid="liquid-editor.field"
        field={{ key: "fuel", label: "Fuel" }}
        value={fuel}
        options={choice.fuels}
        labels={propellantLabels(choice.fuels)}
        placeholder={null}
        title="Only propellant pairs with shipped thermochemistry tables are offered."
        byAgent={false}
        onChange={(v) => choose({ fuel: v })}
      />
    </>
  );
}

function DeleteEngineDialog({ app, engineId, engine, onClose, onDeleted }: { app: AppStore; engineId: string; engine: EvalEngine; onClose: () => void; onDeleted: (id: string) => void }) {
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const model = useAppState(app, (s) => s.project.snapshot?.evaluated ?? null);
  const ops = model === null ? [] : deleteEngineOps(model, engineId);
  const motors = ops.filter((o) => o.path.startsWith("/configs/")).length;
  const studies = ops.filter((o) => o.path.startsWith("/sims/")).length;
  const also = [motors > 0 ? `${motors} motor assignment${motors === 1 ? "" : "s"}` : null, studies > 0 ? `${studies} visual stud${studies === 1 ? "y" : "ies"}` : null].filter((x) => x !== null);
  const remove = () => {
    setSaving(true);
    setProblem(null);
    app
      .getState()
      .draft.mutate(ops, `Delete ${engine.name}`)
      .then(async (out) => {
        await mirrorAt(app, out?.model_hash ?? null);
        onDeleted(engineId);
        onClose();
      })
      .catch((e: unknown) => {
        setSaving(false);
        setProblem(message(e));
      });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Delete engine"
      testId="delete-engine"
      dismissOnEscape={!saving}
      dismissOnOutside={!saving}
      footer={
        <>
          <button type="button" className="rw-button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="rw-button rw-button--danger" disabled={saving || model === null} aria-busy={saving} onClick={remove}>
            Delete
          </button>
        </>
      }
    >
      <p>{`Delete ${engine.name}?${also.length > 0 ? ` This also removes ${also.join(" and ")} that use it.` : ""}`}</p>
      {problem !== null && (
        <p className="rw-liq-editor__error" role="alert">
          {problem}
        </p>
      )}
    </Modal>
  );
}

export interface EngineEditorProps {
  app: AppStore;
  engineId: string;
  engine: EvalEngine;
  entry: DesignEntry | null;
  canCompute: boolean;
  /** Computes the saved engine; resolves when the result has landed. */
  onCompute: () => Promise<void>;
  onShow: (id: string) => void;
  onDeleted: (id: string) => void;
  /** The computed tables: they scroll with the cards, above the pinned result strip. */
  children?: ReactNode;
}

export function EngineEditor({ app, engineId, engine, entry, canCompute, onCompute, onShow, onDeleted, children }: EngineEditorProps) {
  const text = useAppState(app, (s) => s.project.snapshot?.files.files[`engines/${engineId}.rw.toml`]);
  const units = useAppState(app, (s) => s.ui.units);
  const check = useAppState(app, (s) => s.project.snapshot?.check?.diagnostics ?? s.project.snapshot?.evaluated?.diagnostics ?? null);
  const source = useMemo(() => engineSource(text), [text]);
  const [problem, setProblem] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [computing, setComputing] = useState(false);
  const lastWrite = useRef<string | null>(null);

  const write: Write = (ops, label) =>
    app
      .getState()
      .draft.mutate(ops, label)
      .then((out: MutationOut | null) => {
        if (out !== null) lastWrite.current = out.model_hash;
        return out;
      });

  const ctx: RowContext = {
    engineId,
    engine,
    source,
    units,
    write,
    diagnostic: (path) => (check ?? []).find((d) => d.path === path) as FieldDiagnostic | undefined,
  };

  const compute = async () => {
    setComputing(true);
    setProblem(null);
    try {
      const unsaved = await flushProject(app);
      if (unsaved[0] !== undefined) {
        setProblem(unsaved[0]);
        return;
      }
      await mirrorAt(app, lastWrite.current);
      await onCompute();
    } catch (e) {
      setProblem(message(e));
    } finally {
      setComputing(false);
    }
  };

  const duplicate = () => {
    setDuplicating(true);
    setProblem(null);
    const { id, ops } = duplicateEngineOps(engineId, copyEngineName(engine.name, engineNames(app)), engineKeys(app));
    app
      .getState()
      .draft.mutate(ops, `Duplicate ${engine.name}`)
      .then(async (out) => {
        await mirrorAt(app, out?.model_hash ?? null);
        onShow(id);
      })
      .catch((e: unknown) => setProblem(message(e)))
      .finally(() => setDuplicating(false));
  };

  const tanks = tankGroups(engine);
  const modified = isModified(entry, engineId, engine);
  const busy = computing || entry?.state === "loading";

  return (
    <>
      <div className="rw-liq-props__scroll">
        <div className="rw-liq-editor" data-testid="liquid.editor">
          <div className="rw-liq-editor__toolbar">
            {modified ? (
              <p className="rw-liq-editor__modified" role="status" data-testid="liquid.modified">
                <Icon name="alert" size={18} />
                Modified, needs recompute
              </p>
            ) : (
              <span />
            )}
            <div className="rw-liq-editor__actions">
              <NewEngineButton app={app} onShow={onShow} />
              <button type="button" className="rw-button" data-testid="liquid.duplicate-engine" disabled={duplicating} aria-busy={duplicating} onClick={duplicate}>
                <Icon name="copy" size={18} />
                Duplicate
              </button>
              <button type="button" className="rw-button" data-testid="liquid.delete-engine" onClick={() => setDeleting(true)}>
                <Icon name="trash" size={18} />
                Delete
              </button>
            </div>
          </div>
          {problem !== null && (
            <p className="rw-liq-editor__error" role="alert" data-testid="liquid.editor-problem">
              {problem}
            </p>
          )}
          {entry?.state === "error" && (
            <p className="rw-liq-editor__error" role="alert" data-testid="liquid.design-error">
              Compute failed: {entry.error}
            </p>
          )}
          <div className="rw-liq-editor__grid">
            {ENGINE_CARDS.map((card) => (
              <FieldGroupFrame key={card} heading={card} group={card}>
                <div className="rw-liq-editor__fields">
                  {card === "Propellants" && (
                    <>
                      <NameRow ctx={ctx} />
                      <PropellantRows ctx={ctx} onProblem={setProblem} />
                    </>
                  )}
                  {card === "Injector" && !source.hasTable("injector") ? (
                    <button
                      type="button"
                      className="rw-button"
                      data-testid="liquid.add-injector"
                      onClick={() => {
                        trackWrite(write(addInjectorOps(engineId), `Add injector to ${engine.name}`)).catch((e: unknown) => setProblem(message(e)));
                      }}
                    >
                      Add injector
                    </button>
                  ) : (
                    cardFields(card).map((f) => <FieldRow key={f.key} field={f} ctx={ctx} onProblem={setProblem} />)
                  )}
                </div>
              </FieldGroupFrame>
            ))}
            <FieldGroupFrame heading="Tanks" group="Tanks">
              {tanks.length === 0 ? (
                <p className="rw-liq-editor__empty">No tanks in this engine's feed system yet.</p>
              ) : (
                <div className="rw-liq-editor__tanks">
                  {tanks.map((t) => (
                    <FieldGroupFrame key={t.id} heading={t.heading} group={`tank:${t.id}`}>
                      <div className="rw-liq-editor__fields">
                        {tankFields(t.id).map((f) => (
                          <FieldRow key={f.key} field={f} ctx={ctx} onProblem={setProblem} />
                        ))}
                      </div>
                    </FieldGroupFrame>
                  ))}
                </div>
              )}
            </FieldGroupFrame>
            <FeedGraphEditor app={app} ctx={ctx} onProblem={setProblem} />
          </div>
        </div>
        {children}
      </div>
      <div className="rw-liq-results" data-testid="liquid.results" data-stale={modified ? "true" : undefined}>
        <StatStrip
          label="Engine estimates"
          stats={resultStats(entry?.out ?? null)}
          action={
            <button type="button" className="rw-button rw-button--primary rw-liq-results__compute" data-testid="liquid.compute" disabled={!canCompute || busy} aria-busy={busy} onClick={() => void compute()}>
              Compute
            </button>
          }
        />
      </div>
      {deleting && <DeleteEngineDialog app={app} engineId={engineId} engine={engine} onClose={() => setDeleting(false)} onDeleted={onDeleted} />}
    </>
  );
}
