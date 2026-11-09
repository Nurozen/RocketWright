/**
 * A labelled text input. The visible label is the input's accessible name; a
 * unit, hint and error are its description.
 */
import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from "react";
import "./ui.css";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "size" | "children"> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Unit shown inside the field's right edge. */
  unit?: string | undefined;
  /** Help text below the field. */
  hint?: ReactNode;
  /** Error below the field; marks it invalid. */
  error?: ReactNode;
  /** A control beside the input, such as a Choose button. */
  trailing?: ReactNode;
  /** `stacked` puts the label above the input, `inline` beside it. */
  layout?: "stacked" | "inline" | undefined;
  ref?: Ref<HTMLInputElement> | undefined;
}

export function TextField({ label, value, onChange, unit, hint, error, trailing, layout = "stacked", className, id, ref, "aria-describedby": describedBy, ...input }: TextFieldProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const unitId = `${auto}-unit`;
  const hintId = `${auto}-hint`;
  const errorId = `${auto}-error`;
  const invalid = error !== undefined && error !== null && error !== false;
  const hasHint = hint !== undefined && hint !== null && hint !== false;
  const description = [describedBy, unit !== undefined ? unitId : undefined, hasHint ? hintId : undefined, invalid ? errorId : undefined].filter(Boolean).join(" ");
  return (
    <div className={className ? `rw-ui-field ${className}` : "rw-ui-field"} data-layout={layout} data-invalid={invalid ? "true" : undefined}>
      <label className="rw-ui-field__label" htmlFor={inputId}>
        {label}
      </label>
      <div className="rw-ui-field__control">
        <div className="rw-ui-field__box">
          <input {...input} ref={ref} id={inputId} className="rw-ui-field__input" value={value} aria-invalid={invalid ? true : undefined} aria-describedby={description === "" ? undefined : description} onChange={(e) => onChange(e.target.value)} />
          {unit !== undefined && (
            <span id={unitId} className="rw-ui-field__unit">
              {unit}
            </span>
          )}
        </div>
        {trailing}
      </div>
      {hasHint && (
        <p id={hintId} className="rw-ui-field__hint">
          {hint}
        </p>
      )}
      {invalid && (
        <p id={errorId} className="rw-ui-field__error">
          {error}
        </p>
      )}
    </div>
  );
}
