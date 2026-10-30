/** Viewport toolbar row (concepts.md §3): View chips, page controls slot, Units. */
import type { ReactNode } from "react";
import { Icon } from "./Icon.tsx";

export const VIEW_CHIPS = ["Iso", "Top", "Side", "Front", "Rear"] as const;
export type ViewChip = (typeof VIEW_CHIPS)[number];

export interface ViewportToolbarProps {
  view: ViewChip;
  units: string;
  onViewChange?: (view: ViewChip) => void;
  /** With both set, Units is a working select (M1.50); otherwise a static button. */
  unitOptions?: readonly string[];
  onUnitsChange?: (units: string) => void;
  children?: ReactNode;
}

export function ViewportToolbar({ view, units, onViewChange, unitOptions, onUnitsChange, children }: ViewportToolbarProps) {
  return (
    <div className="rw-toolbar" data-rw-region="viewport-toolbar" data-testid="viewport-toolbar">
      <span className="rw-toolbar__label">View</span>
      <div className="rw-chips" role="radiogroup" aria-label="View">
        {VIEW_CHIPS.map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            className="rw-chip"
            data-testid="toolbar.view-chip"
            aria-checked={v === view}
            onClick={() => onViewChange?.(v)}
          >
            {v}
          </button>
        ))}
      </div>
      <div className="rw-toolbar__controls">{children}</div>
      <span className="rw-toolbar__label">Units</span>
      {unitOptions && onUnitsChange ? (
        <span className="rw-select rw-select--native">
          <select data-testid="toolbar.units" aria-label="Units" value={units} onChange={(e) => onUnitsChange(e.currentTarget.value)}>
            {unitOptions.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <Icon name="chevron-down" size={16} />
        </span>
      ) : (
        <button type="button" className="rw-select" data-testid="toolbar.units" aria-haspopup="listbox">
          {units}
          <Icon name="chevron-down" size={16} />
        </button>
      )}
    </div>
  );
}
