/**
 * Run table (C §4.4): checkbox (plot overlay, at most two: A teal, B sand),
 * colour dot, Run, Status, Apogee (m), Max speed (m/s), Flight time (s), and a
 * row menu. Sortable columns; status is computed (I7). Outdated rows show
 * dashes: only a Complete run's numbers are current. A sim that has never run
 * reads Not run, offers Run in place of its numbers, and opens its conditions
 * from the row (R2.7). A flying row offers Cancel; a cancelled one offers Run
 * again. The row menu's Duplicate copies the sim definition and Delete removes
 * the stored run (`run.delete`).
 */
import { useState } from "react";
import { useAppState, type AppStore } from "../../state/store.ts";
import { fmtNum } from "../../plots/quantities.ts";
import { nextSort, rowRef, type ResultsRow, type SortKey } from "./model.ts";
import { MenuButton } from "../../ui/Menu.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { StatusGlyph, useResultsRows } from "./parts.tsx";
import { ResultsIcon } from "./ResultsIcon.tsx";
import { resultsUiStore, useResultsUi } from "./resultsUi.ts";
import { duplicateSimulation } from "./SimConditionsSheet.tsx";

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: "name", label: "Run" },
  { key: "status", label: "Status" },
  { key: "apogee", label: "Apogee (m)", numeric: true },
  { key: "maxSpeed", label: "Max speed (m/s)", numeric: true },
  { key: "flightTime", label: "Flight time (s)", numeric: true },
];

export const canOverlay = (r: ResultsRow): boolean => r.entry.run_id != null && r.status.kind !== "running" && r.status.kind !== "queued" && r.status.kind !== "not_run";

/** A row with a stored run and no job flying: the sidecar refuses to delete a run under an active job. */
export const canDeleteRun = (r: ResultsRow): boolean => r.entry.run_id != null && r.status.kind !== "running" && r.status.kind !== "queued";

const flying = (r: ResultsRow): boolean => r.status.kind === "running" || r.status.kind === "queued";
const jobIdOf = (r: ResultsRow): string | null => r.job?.job_id ?? r.entry.job_id ?? null;

export function RunTable({ app }: { app: AppStore }) {
  const rows = useResultsRows(app);
  const sort = useResultsUi(app, (u) => u.sort);
  const ui = resultsUiStore(app);
  const st = app.getState();
  const inModel = useAppState(app, (s) => s.project.snapshot?.evaluated?.sims ?? null);
  const hasConditions = (r: ResultsRow) => inModel?.[r.sim] != null;
  const openConditions = (sim: string) => ui.getState().set({ conditions: sim });
  const [deleting, setDeleting] = useState<ResultsRow | null>(null);
  const duplicate = (sim: string) => {
    duplicateSimulation(app, sim).catch((e: unknown) => ui.getState().set({ notice: e instanceof Error ? e.message : String(e) }));
  };
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
              {r.status.kind === "not_run" || r.status.kind === "cancelled" || flying(r) ? (
                <>
                  <td data-testid="runs.apogee">
                    {flying(r) ? (
                      jobIdOf(r) !== null && (
                        <button
                          type="button"
                          className="rw-button rw-runtable__run"
                          aria-label={`Cancel ${r.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void app.getState().runs.cancel(jobIdOf(r)!).catch(() => undefined);
                          }}
                        >
                          Cancel
                        </button>
                      )
                    ) : (
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
                    )}
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
                    { id: "duplicate", label: "Duplicate", disabled: !hasConditions(r), onSelect: () => duplicate(r.sim) },
                    { id: "delete", label: "Delete", danger: true, disabled: !canDeleteRun(r), onSelect: () => setDeleting(r) },
                  ]}
                >
                  <ResultsIcon name="more" size={20} />
                </MenuButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {deleting !== null && <DeleteRunDialog app={app} row={deleting} simExists={hasConditions(deleting)} onClose={() => setDeleting(null)} />}
    </div>
  );
}

function DeleteRunDialog({ app, row, simExists, onClose }: { app: AppStore; row: ResultsRow; simExists: boolean; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const remove = () => {
    setSaving(true);
    app
      .getState()
      .runs.deleteRun({ key: row.key, sim: row.sim, runId: row.entry.run_id! })
      .then(onClose, (e: unknown) => {
        setSaving(false);
        setError(e instanceof Error ? e.message : String(e));
      });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Delete run"
      testId="delete-run"
      dismissOnEscape={!saving}
      dismissOnOutside={!saving}
      footer={
        <>
          <button type="button" className="rw-button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="rw-button rw-button--danger" disabled={saving} onClick={remove}>
            Delete
          </button>
        </>
      }
    >
      <p>{`Delete this run of ${row.name}? Its results are removed and cannot be brought back. ${simExists ? "The simulation stays and can be run again." : "Its simulation is gone, so it cannot be run again."}`}</p>
      {error !== null && (
        <p className="rw-results__error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
