/**
 * Page 06 visual flow side column (M5.3): the Study list (the project's
 * `kind = "visual_flow"` sims) and the Layers checkboxes (Shell, Section,
 * Flow, Labels). The Section layer and the transport's Section view switch
 * are one state.
 */
import type { StageLayers } from "../../fluid/stage.ts";

export interface StudyRow {
  id: string;
  name: string;
}

export const LAYER_ROWS: { id: keyof StageLayers; label: string }[] = [
  { id: "shell", label: "Shell" },
  { id: "section", label: "Section" },
  { id: "flow", label: "Flow" },
  { id: "labels", label: "Labels" },
];

/** Studies in list order: numbered "Study NN" first, then by name. */
export function orderStudies(rows: readonly StudyRow[]): StudyRow[] {
  const num = (n: string) => /^Study\s+(\d+)/i.exec(n)?.[1];
  return [...rows].sort((a, b) => {
    const na = num(a.name);
    const nb = num(b.name);
    if (na !== undefined && nb !== undefined) return Number(na) - Number(nb);
    if (na !== undefined) return -1;
    if (nb !== undefined) return 1;
    return a.name.localeCompare(b.name);
  });
}

export function StudyList({ studies, selected, onSelect }: { studies: readonly StudyRow[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <section className="rw-vis-side__group" aria-label="Study">
      <h2 className="rw-vis-side__title">Study</h2>
      <ul className="rw-list rw-vis-studies" role="listbox" aria-label="Studies" data-testid="visual.studies">
        {studies.map((s) => (
          <li key={s.id} role="option" className="rw-vis-studies__row" data-testid="visual.study" data-study={s.id} aria-selected={s.id === selected} onClick={() => onSelect(s.id)}>
            {s.name}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LayersPanel({ layers, onChange }: { layers: StageLayers; onChange: (l: StageLayers) => void }) {
  return (
    <section className="rw-vis-side__group" aria-label="Layers">
      <h2 className="rw-vis-side__title">Layers</h2>
      <ul className="rw-list rw-vis-layers" data-testid="visual.layers">
        {LAYER_ROWS.map((r) => (
          <li key={r.id}>
            <label className="rw-check rw-vis-layers__row">
              <input type="checkbox" data-testid="visual.layer" data-layer={r.id} checked={layers[r.id]} onChange={(e) => onChange({ ...layers, [r.id]: e.target.checked })} />
              <span>{r.label}</span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
