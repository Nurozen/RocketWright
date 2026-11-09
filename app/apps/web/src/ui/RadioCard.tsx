/**
 * Radio buttons drawn as cards with a title and a description, on native
 * inputs so the arrow keys work. The title is the accessible name; the
 * description is the accessible description.
 */
import { useId } from "react";
import "./ui.css";

export interface RadioCardProps {
  name: string;
  title: string;
  description?: string | undefined;
  checked: boolean;
  disabled?: boolean | undefined;
  onSelect: () => void;
}

export function RadioCard({ name, title, description, checked, disabled, onSelect }: RadioCardProps) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <label className="rw-ui-radio-card" data-checked={checked ? "true" : undefined} data-disabled={disabled === true ? "true" : undefined}>
      <input
        className="rw-ui-radio-card__input"
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        onChange={onSelect}
      />
      <span className="rw-ui-radio-card__dot" aria-hidden />
      <span className="rw-ui-radio-card__text">
        <span id={titleId} className="rw-ui-radio-card__title">
          {title}
        </span>
        {description !== undefined && (
          <span id={descriptionId} className="rw-ui-radio-card__description">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

export interface RadioCardOption<T extends string> {
  value: T;
  title: string;
  description?: string | undefined;
  disabled?: boolean | undefined;
}

export interface RadioCardGroupProps<T extends string> {
  /** Visible heading, which also names the group. */
  label: string;
  value: T;
  options: readonly RadioCardOption<T>[];
  onChange: (value: T) => void;
  name?: string | undefined;
}

export function RadioCardGroup<T extends string>({ label, value, options, onChange, name }: RadioCardGroupProps<T>) {
  const auto = useId();
  const headingId = `${auto}-heading`;
  return (
    <div className="rw-ui-radio-group">
      <span id={headingId} className="rw-ui-field__label">
        {label}
      </span>
      <div className="rw-ui-radio-group__cards" role="radiogroup" aria-labelledby={headingId}>
        {options.map((o) => (
          <RadioCard key={o.value} name={name ?? auto} title={o.title} description={o.description} checked={o.value === value} disabled={o.disabled} onSelect={() => onChange(o.value)} />
        ))}
      </div>
    </div>
  );
}
