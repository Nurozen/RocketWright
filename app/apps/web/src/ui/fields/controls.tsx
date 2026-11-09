/**
 * The field controls: a number with spinner and unit, a select, a checkbox, and
 * the frame that names a nested group. Each input's accessible name is its
 * visible label, and a unit is the input's accessible description, so a person
 * and the e2e drive find a control the same way (D27). Grouped fields repeat
 * labels such as Length; the group's `role="group"`, named by its visible
 * heading, tells them apart.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../shell/Icon.tsx";
import { useDirtyField } from "../../state/dirtyFields.ts";
import type { FieldSpec } from "./spec.ts";
import "./fields.css";

type ControlField = Pick<FieldSpec, "key" | "label">;

/** Under a field label: the agent changed this value in the shown revision. */
export function AgentMarker() {
  return (
    <span className="rw-field__agent" data-testid="editor.field-changed">
      Changed by agent
    </span>
  );
}

/** A nested group: its visible heading is its accessible name. */
export function FieldGroupFrame({ heading, group, children }: { heading: string; group: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="rw-field-group" role="group" aria-labelledby={id} data-group={group}>
      <h3 id={id} className="rw-field-group__title">
        {heading}
      </h3>
      {children}
    </div>
  );
}

/** A checkbox; `null` is a mixed selection. */
export function BoolField({
  testid,
  field,
  checked,
  title,
  byAgent,
  onChange,
}: {
  testid: string;
  field: ControlField;
  checked: boolean | null;
  title: string | undefined;
  byAgent: boolean;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = checked === null;
  }, [checked]);
  return (
    <label className="rw-field rw-field--bool" data-testid={testid} data-field={field.key} data-by-agent={byAgent ? "true" : undefined} title={title}>
      <span className="rw-field__label">
        {field.label}
        {byAgent && <AgentMarker />}
      </span>
      <input ref={ref} type="checkbox" className="rw-field__check" aria-label={field.label} checked={checked === true} onChange={(e) => onChange(e.currentTarget.checked)} />
    </label>
  );
}

/** A select of fixed options; `placeholder` is the empty choice shown when nothing is chosen. */
export function SelectField({
  testid,
  field,
  value,
  options,
  labels,
  placeholder,
  title,
  byAgent,
  onChange,
}: {
  testid: string;
  field: ControlField;
  value: string;
  options: readonly string[];
  /** Visible text for options whose source spelling is not it (`ussa1976`). */
  labels?: Readonly<Record<string, string>> | undefined;
  placeholder: string | null;
  title: string | undefined;
  byAgent: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="rw-field" data-testid={testid} data-field={field.key} data-by-agent={byAgent ? "true" : undefined} title={title}>
      <span className="rw-field__label">
        {field.label}
        {byAgent && <AgentMarker />}
      </span>
      <span className="rw-select rw-select--native rw-field__select">
        <select
          value={value}
          aria-label={field.label}
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (v !== "") onChange(v);
          }}
        >
          {placeholder !== null && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o} value={o}>
              {labels?.[o] ?? o.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" size={16} />
      </span>
    </label>
  );
}

/** A spinner field: typed number, ▲▼ steps, unit suffix; Enter or blur commits, Escape discards. */
export function SpinField({
  testid,
  field,
  unit,
  value,
  placeholder,
  step,
  title,
  byAgent,
  error,
  disabled,
  onChange,
  onCommit,
  onDiscard,
}: {
  testid: string;
  field: ControlField;
  unit: string;
  value: string;
  placeholder: string;
  step: number;
  /** Tooltip (shared parameter or formula, in words; else the field's doc). */
  title: string | undefined;
  byAgent: boolean;
  error: string | null;
  disabled?: boolean | undefined;
  onChange: (text: string) => void;
  onCommit: () => void;
  onDiscard: () => void;
}) {
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);
  const unitId = useId();
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);
  // Valid text is in the draft from the keystroke on; only text that failed its check has nowhere to go.
  // The error, not the text: a blur puts the model's value back, and the person still has not been told it was dropped.
  useDirtyField({ dirty: () => error !== null && error !== "", commit: () => error });
  const bump = (dir: 1 | -1) => {
    const cur = Number(text === "" ? value || "0" : text);
    const next = Number(((Number.isFinite(cur) ? cur : 0) + dir * step).toPrecision(10));
    const s = String(next);
    setText(s);
    onChange(s);
    onCommit();
  };
  return (
    <label className="rw-field" data-testid={testid} data-field={field.key} data-invalid={error ? "true" : undefined} data-by-agent={byAgent ? "true" : undefined} title={title}>
      <span className="rw-field__label">
        {field.label}
        {byAgent && <AgentMarker />}
      </span>
      <span className="rw-spinbox">
        <input
          className="rw-spinbox__input"
          inputMode="decimal"
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={field.label}
          aria-describedby={unit === "" ? undefined : unitId}
          aria-invalid={error ? true : undefined}
          onFocus={() => setEditing(true)}
          onChange={(e) => {
            setText(e.currentTarget.value);
            onChange(e.currentTarget.value);
          }}
          onBlur={() => {
            setEditing(false);
            if (!error) onCommit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !error) {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setText(value);
              onDiscard();
              e.currentTarget.blur();
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              bump(1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              bump(-1);
            }
          }}
        />
        <span className="rw-spinbox__arrows">
          <button type="button" tabIndex={-1} aria-label={`Increase ${field.label}`} data-testid="editor.spin-up" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => bump(1)}>
            <Icon name="chevron-up" size={12} />
          </button>
          <button type="button" tabIndex={-1} aria-label={`Decrease ${field.label}`} data-testid="editor.spin-down" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => bump(-1)}>
            <Icon name="chevron-down" size={12} />
          </button>
        </span>
      </span>
      <span id={unitId} className="rw-field__unit">
        {unit}
      </span>
    </label>
  );
}
