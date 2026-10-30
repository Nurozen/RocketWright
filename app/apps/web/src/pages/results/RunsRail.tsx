/**
 * Left rail `Runs` section (C §4.4): one row per sim with an eye toggle (show
 * in the table and plots), the computed status glyph, the name, and the status
 * text. Selecting a row selects the run everywhere (`rw:sim/<id>`).
 */
import { useState } from "react";
import type { AppStore } from "../../state/store.ts";
import { Icon } from "../../shell/Icon.tsx";
import { primaryRow, rowRef } from "./model.ts";
import { StatusGlyph, useResultsRows } from "./parts.tsx";
import { resultsUiStore } from "./resultsUi.ts";

export interface RunsRailProps {
  app: AppStore;
  /** Also called on row click (the live shell opens the run's bound thread, R6.9). */
  onOpenRun?: (sim: string, name: string) => void;
}

export function RunsRail({ app, onOpenRun }: RunsRailProps) {
  const rows = useResultsRows(app, { sorted: false, includeHidden: true });
  const [query, setQuery] = useState<string | null>(null);
  const q = query?.trim().toLowerCase() ?? "";
  const shown = q === "" ? rows : rows.filter((r) => r.name.toLowerCase().includes(q));
  // One highlighted row: the selected one (a never-run sim too, so it can be
  // run), else the run the page describes (series A).
  const primary = (rows.find((r) => r.selected) ?? primaryRow(rows.filter((r) => !r.hidden)))?.key ?? null;
  return (
    <section className="rw-rail__nav rw-runs-rail" aria-label="Runs" data-testid="rail.runs">
      <div className="rw-rail__nav-head">
        <h2 className="rw-section-title" data-testid="rail.nav-title">
          Runs
        </h2>
        <button type="button" className="rw-icon-button" aria-label="Search Runs" aria-pressed={query !== null} onClick={() => setQuery((v) => (v === null ? "" : null))}>
          <Icon name="search" size={18} />
        </button>
        <span className="rw-header__sep" aria-hidden />
        <button type="button" className="rw-icon-button" aria-label="Add to Runs" title="New simulations are added in the model (sims/*.rw.toml)" disabled>
          <Icon name="plus" size={18} />
        </button>
      </div>
      {query !== null && (
        <input className="rw-runs-rail__search" type="search" placeholder="Filter runs" aria-label="Filter runs" value={query} autoFocus onChange={(e) => setQuery(e.target.value)} />
      )}
      <ul className="rw-list" role="listbox" aria-label="Runs">
        {shown.map((r) => (
          <li
            key={r.key}
            className="rw-nav-row rw-run-row"
            role="option"
            data-testid="rail.nav-row"
            data-sim={r.sim}
            data-status={r.status.kind}
            data-series={r.series ?? undefined}
            data-hidden={r.hidden ? "true" : undefined}
            aria-selected={r.key === primary}
            data-row-key={r.key}
            onClick={() => {
              app.getState().selection.select([rowRef(r)], "table");
              onOpenRun?.(r.sim, r.name);
            }}
          >
            <button
              type="button"
              className="rw-run-row__eye"
              data-testid="rail.eye"
              aria-label={r.hidden ? `Show ${r.name}` : `Hide ${r.name}`}
              aria-pressed={!r.hidden}
              onClick={(e) => {
                e.stopPropagation();
                resultsUiStore(app).getState().toggleHidden(r.key);
              }}
            >
              <Icon name={r.hidden ? "eye-off" : "eye"} size={18} />
            </button>
            <StatusGlyph status={r.status} />
            <span className="rw-run-row__name">{r.name}</span>
            <span className="rw-run-row__status" data-tone={r.status.tone} data-series={r.series ?? undefined}>
              {r.status.label}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
