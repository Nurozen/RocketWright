/**
 * Page 01 toolbar controls (concepts §4.1 Toolbar) inside the shell's
 * viewport toolbar row: View chips and Units come from `ViewportToolbar`;
 * this adds the Exploded view slider, the Section switch, Show internals, and
 * Shadows. Pure presentation over `ui` state.
 */
import type { ViewId } from "@rw/contracts";
import { ViewportToolbar, type ViewChip } from "../../shell/ViewportToolbar.tsx";
import type { Units } from "../../state/index.ts";
import { VIEW_IDS, VIEW_LABELS } from "../../viewport/views.ts";
import { UNITS } from "./inspector-model.ts";

export interface AssemblyToolbarProps {
  view: ViewId;
  explode: number;
  section: boolean;
  showInternals: boolean;
  shadows: boolean;
  units: Units;
  onView(view: ViewId): void;
  /** `animate`: the Assembled/Exploded end buttons ease the change (M3.2); slider drags jump. */
  onExplode(explode: number, animate?: boolean): void;
  onSection(on: boolean): void;
  onShowInternals(on: boolean): void;
  onShadows(on: boolean): void;
  onUnits(units: Units): void;
}

const chipToView = (chip: ViewChip): ViewId => VIEW_IDS.find((v) => VIEW_LABELS[v] === chip) ?? "iso";

export function AssemblyToolbar(p: AssemblyToolbarProps) {
  const pct = Math.round(p.explode * 100);
  return (
    <ViewportToolbar
      view={VIEW_LABELS[p.view] as ViewChip}
      units={p.units}
      unitOptions={UNITS}
      onViewChange={(chip) => p.onView(chipToView(chip))}
      onUnitsChange={(u) => p.onUnits(u as Units)}
    >
      <span className="rw-toolbar__sep" aria-hidden />
      <label className="rw-explode">
        <span className="rw-explode__label">Exploded view</span>
        <span className="rw-explode__track">
          <input
            type="range"
            className="rw-explode__input"
            data-testid="toolbar.explode"
            min={0}
            max={100}
            step={1}
            value={pct}
            aria-valuetext={`${pct}% exploded`}
            style={{ ["--rw-explode-pct" as string]: `${pct}%` }}
            onChange={(e) => p.onExplode(Number(e.currentTarget.value) / 100)}
          />
          <span className="rw-explode__ends">
            <button type="button" className="rw-explode__end" data-testid="toolbar.explode-assembled" aria-label="Animate to assembled" onClick={() => p.onExplode(0, true)}>
              Assembled
            </button>
            <button type="button" className="rw-explode__end" data-testid="toolbar.explode-exploded" aria-label="Animate to exploded" onClick={() => p.onExplode(1, true)}>
              Exploded
            </button>
          </span>
        </span>
      </label>
      <span className="rw-toolbar__sep" aria-hidden />
      <button
        type="button"
        role="switch"
        className="rw-switch"
        data-testid="toolbar.section"
        aria-checked={p.section}
        onClick={() => p.onSection(!p.section)}
      >
        <span className="rw-switch__track" aria-hidden>
          <span className="rw-switch__thumb" />
        </span>
        Section
      </button>
      <span className="rw-toolbar__sep" aria-hidden />
      <label className="rw-check">
        <input type="checkbox" data-testid="toolbar.show-internals" checked={p.showInternals} onChange={(e) => p.onShowInternals(e.currentTarget.checked)} />
        <span>Show internals</span>
      </label>
      <label className="rw-check">
        <input type="checkbox" data-testid="toolbar.shadows" checked={p.shadows} onChange={(e) => p.onShadows(e.currentTarget.checked)} />
        <span>Shadows</span>
      </label>
      <span className="rw-toolbar__sep" aria-hidden />
    </ViewportToolbar>
  );
}
