/**
 * The rows of the engine editor's cards and feed graph (R3.2): a number, a
 * choice, and the text a field holds until it is written.
 */
import { useEffect, useRef, useState } from "react";
import type { PatchOp } from "@rw/contracts";
import { trackWrite, useDirtyField } from "../../state/dirtyFields.ts";
import type { Units } from "../../state/index.ts";
import { SelectField, SpinField, type FieldDiagnostic } from "../../ui/fields/index.ts";
import { displayNumber, fieldOps, fieldUnit, fieldValue, isExpression, parseFieldText, type EngineField, type EngineSource } from "./engineOps.ts";
import type { EvalEngine } from "./model.ts";

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type Write = (ops: PatchOp[], label: string) => Promise<unknown>;

/**
 * Text a field holds until it is written. Valid text counts as unsaved (D22),
 * so leaving the project writes it; text that fails its check is the field's
 * own to report.
 */
export function useTextEdit(value: string, validate: (text: string) => string | null, write: (text: string) => Promise<unknown>) {
  const typed = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What was written, shown until the model echoes it back, so the field does not flick to the old value.
  const [written, setWritten] = useState<string | null>(null);
  useEffect(() => setWritten(null), [value]);
  const commit = (): string | null => {
    const text = typed.current;
    if (text === null) return null;
    if (text.trim() === value) {
      typed.current = null;
      setError(null);
      return null;
    }
    const invalid = validate(text);
    if (invalid !== null) {
      setError(invalid);
      return invalid;
    }
    typed.current = null;
    setError(null);
    setWritten(text);
    trackWrite(write(text)).catch((e: unknown) => {
      setWritten(null);
      setError(message(e));
    });
    return null;
  };
  useDirtyField({ dirty: () => typed.current !== null && validate(typed.current) === null, commit });
  return {
    value: written ?? value,
    error,
    onChange: (text: string) => {
      typed.current = text;
      setError(validate(text));
    },
    onCommit: () => void commit(),
    onDiscard: () => {
      typed.current = null;
      setError(null);
    },
  };
}

export interface RowContext {
  engineId: string;
  engine: EvalEngine;
  source: EngineSource;
  units: Units;
  write: Write;
  diagnostic: (path: string) => FieldDiagnostic | undefined;
}

export const fieldPath = (engineId: string, key: string) => `/engines/${engineId}/${key.replace(/\./g, "/")}`;

function fieldTitle(f: EngineField, ctx: RowContext): string | undefined {
  return isExpression(f, ctx.source) ? "Computed from other values in the model; typing a number here replaces the formula." : f.doc;
}

export function NumberRow({ field: f, ctx }: { field: EngineField; ctx: RowContext }) {
  const shown = displayNumber(f, fieldValue(f, ctx.engine, ctx.source), ctx.units);
  const edit = useTextEdit(
    shown,
    (text) => parseFieldText(f, text, ctx.units).error ?? null,
    (text) => {
      const parsed = parseFieldText(f, text, ctx.units);
      return parsed.error !== undefined ? Promise.resolve() : ctx.write(fieldOps(ctx.engineId, f, parsed.value, ctx.source), `Edit ${f.label} of ${ctx.engine.name}`);
    },
  );
  return (
    <div className="rw-liq-editor__row">
      <SpinField
        testid="liquid-editor.field"
        field={{ key: f.key, label: f.label }}
        unit={fieldUnit(f, ctx.units)}
        value={edit.value}
        placeholder={f.required === true ? "" : "Not set"}
        step={f.step ?? 0.1}
        title={fieldTitle(f, ctx)}
        byAgent={false}
        error={edit.error}
        diag={ctx.diagnostic(fieldPath(ctx.engineId, f.key))}
        onChange={edit.onChange}
        onCommit={edit.onCommit}
        onDiscard={edit.onDiscard}
      />
      {edit.error !== null && (
        <p className="rw-liq-editor__error" role="alert" data-field={f.key}>
          {edit.error}
        </p>
      )}
    </div>
  );
}

export function SelectRow({ field: f, ctx, onProblem }: { field: EngineField; ctx: RowContext; onProblem: (text: string) => void }) {
  const value = fieldValue(f, ctx.engine, ctx.source);
  const label = `Edit ${f.label} of ${ctx.engine.name}`;
  const send = (next: string | null) => {
    trackWrite(ctx.write(fieldOps(ctx.engineId, f, next, ctx.source), label)).catch((e: unknown) => onProblem(message(e)));
  };
  return (
    <SelectField
      testid="liquid-editor.field"
      field={{ key: f.key, label: f.label }}
      value={typeof value === "string" ? value : ""}
      options={f.options ?? []}
      labels={f.labels}
      placeholder={f.placeholder ?? null}
      title={f.doc}
      byAgent={false}
      diag={ctx.diagnostic(fieldPath(ctx.engineId, f.key))}
      onChange={send}
      onClear={() => send(null)}
    />
  );
}

export function FieldRow({ field, ctx, onProblem }: { field: EngineField; ctx: RowContext; onProblem: (text: string) => void }) {
  return field.kind === "number" ? <NumberRow field={field} ctx={ctx} /> : <SelectRow field={field} ctx={ctx} onProblem={onProblem} />;
}
