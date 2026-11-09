/**
 * Run table (C §4.4): checkbox (plot overlay, at most two: A teal, B sand),
 * colour dot, Run, Status, Apogee (m), Max speed (m/s), Flight time (s), and a
 * row menu. Sortable columns; status is computed (I7). Outdated rows show
 * dashes: only a Complete run's numbers are current. A sim that has never run
 * reads Not run, offers Run in place of its numbers, and opens its conditions
 * from the row (R2.7).
 */
import { useAppState, type AppStore } from "../../state/store.ts";
import { fmtNum } from "../../plots/quantities.ts";
import { nextSort, rowRef, type ResultsRow, type SortKey } from "./model.ts";
import { MenuButton } from "../../ui/Menu.tsx";
import { StatusGlyph, useResultsRows } from "./parts.tsx";
import { ResultsIcon } from "./ResultsIcon.tsx";
import { resultsUiStore, useResultsUi } from "./resultsUi.ts";

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: "name", label: "Run" },
  { key: "status", label: "Status" },
  { key: "apogee", label: "Apogee (m)", numeric: true },
  { key: "maxSpeed", label: "Max speed (m/s)", numeric: true },
  { key: "flightTime", label: "Flight time (s)", numeric: true },
];

export const canOverlay = (r: ResultsRow): boolean => r.entry.run_id != null && r.status.kind !== "running" && r.status.kind !== "queued" && r.status.kind !== "not_run";

export function RunTable({ app }: { app: AppStore }) {
  const rows = useResultsRows(app);
  const sort = useResultsUi(app, (u) => u.sort);
  const ui = resultsUiStore(app);
  const st = app.getState();
  const inModel = useAppState(app, (s) => s.project.snapshot?.evaluated?.sims ?? null);
  const hasConditions = (r: ResultsRow) => inModel?.[r.sim] != null;
  const openConditions = (sim: string) => ui.getState().set({ conditions: sim });
  return (
    <div className="rw-runtable" data-rw-region="run-table" data-testid="run-table">
      <table>
        <thead>
          <tr data-testid="runs.table-header">
            <th className="rw-runtable__check" scope="col">
              <span className="rw-sr">Plot</span>
            </th>
            <th className="rw-runtable__dot" scope="col">
              <span className="rw-sr">Colour</span>
            </th>
            {COLUMNS.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th key={c.key} scope="col" aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"} data-numeric={c.numeric ? "true" : undefined}>
                  <button type="button" className="rw-runtable__sort" data-testid="runs.sort" data-key={c.key} onClick={() => ui.getState().set({ sort: nextSort(ui.getState().sort, c.key) })}>
                    {c.label}
                    {(c.key === "name" || active) && <ResultsIcon name="sort" size={14} className={active ? "rw-runtable__sort-on" : undefined} />}
                  </button>
                </th>
              );
            })}
            <th className="rw-runtable__menu" scope="col">
              <span className="rw-sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.key}
              data-testid="runs.table-row"
              data-sim={r.sim}
              data-status={r.status.kind}
              data-series={r.series ?? undefined}
              aria-selected={r.selected}
              data-row-key={r.key}
              onClick={() => {
                st.selection.select([rowRef(r)], "table");
                if (r.status.kind === "not_run" && hasConditions(r)) openConditions(r.sim);
              }}
            >
              <td className="rw-runtable__check">
                <input
                  type="checkbox"
                  data-testid="runs.overlay"
                  aria-label={`Plot ${r.name}`}
                  checked={r.series !== null}
                  disabled={!canOverlay(r) && r.series === null}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => app.getState().runs.toggleOverlay(r.key)}
                />
              </td>
              <td className="rw-runtable__dot">
                <span className="rw-dot" data-series={r.series ?? "none"} />
              </td>
              <td className="rw-runtable__name">{r.name}</td>
              <td>
                <span className="rw-runtable__status" data-testid="runs.status">
                  <StatusGlyph status={r.status} />
                  {r.status.label}
                </span>
              </td>
              {r.status.kind === "not_run" ? (
                <>
                  <td data-testid="runs.apogee">
                    <button
                      type="button"
                      className="rw-button rw-runtable__run"
                      onClick={(e) => {
                        e.stopPropagation();
                        void app.getState().runs.run(r.sim).catch(() => undefined);
                      }}
                    >
                      <ResultsIcon name="run" size={16} />
                      Run
                    </button>
                  </td>
                  <td data-testid="runs.max-speed" />
                  <td data-testid="runs.flight-time" />
                </>
              ) : (
                <>
                  <td data-numeric="true" data-testid="runs.apogee">
                    {fmtNum(r.metrics?.apogee_m)}
                  </td>
                  <td data-numeric="true" data-testid="runs.max-speed">
                    {fmtNum(r.metrics?.max_velocity_ms)}
                  </td>
                  <td data-numeric="true" data-testid="runs.flight-time">
                    {fmtNum(r.metrics?.flight_time_s)}
                  </td>
                </>
              )}
              <td className="rw-runtable__menu" onClick={(e) => e.stopPropagation()}>
                <MenuButton
                  testId="runs.row-menu"
                  label={`${r.name} actions`}
                  className="rw-icon-button"
                  align="right"
                  items={[
                    { id: "conditions", label: "Simulation conditions", disabled: !hasConditions(r), onSelect: () => openConditions(r.sim) },
                    { id: "edit", label: "Edit configuration", onSelect: () => app.getState().ui.navigate("configurations") },
                    { id: "duplicate", label: "Duplicate", disabled: true },
                    { id: "delete", label: "Delete", disabled: true },
                    { id: "dispersion", label: "Landing dispersion", disabled: true },
                  ]}
                >
                  <ResultsIcon name="more" size={20} />
                </MenuButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
