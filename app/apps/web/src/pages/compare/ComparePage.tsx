/**
 * The Compare view (M2.7, R2.10; Backplane compare reference): Old and New
 * pickers over steps, named revisions, runs, and the current model; the
 * viewport with removed parts red, changed amber, added green and the rest
 * dimmed; a metric table with units; the changed components and source
 * edits; the legend; and Revert (history_restore to Old).
 *
 * Data comes from the sidecar through the app server: `history.compare`
 * (model diff keyed by id, metric diff, marks) and `model.get` for both
 * evaluated models, which the viewport meshes merged (New plus the removed
 * parts of Old). It never computes a diff itself.
 */
import { useEffect, useMemo, useState } from "react";
import type { CompareOut, EvaluatedModel } from "@rw/contracts";
import { runComparison } from "./comparison.ts";
import { componentRef, useAppState, type AppStore, type CompareSelection, type RpcLike } from "../../state/index.ts";
import { selectedComponentIds } from "../../state/slices/selection.ts";
import { AssemblyViewport } from "../../viewport/AssemblyViewport.tsx";
import type { EngineState } from "../../viewport/engine.ts";
import type { GlbDeps } from "../../viewport/glb-source.ts";
import { compareKey, MARK_COLORS, MARK_ORDER, markCounts, markMap, mergeForCompare, type MarkStatus } from "../../viewport/marks.ts";
import { Icon } from "../../shell/Icon.tsx";
import { canRevertTo, changeRows, editRows, isRunVersion, metricRows, versionLabel, versionOptions, type VersionGroup } from "./model.ts";
import { RunComparePanel } from "./RunComparePanel.tsx";
import "../assembly/assembly.css";
import "./compare.css";

export interface ComparePageProps {
  store: AppStore;
  client: RpcLike | null;
  glbDeps: GlbDeps;
}

/** Width of the right-hand panel (metrics, changes). */
export const COMPARE_PANEL_WIDTH = 340;

const MARK_NAMES: Record<MarkStatus, string> = { removed: "Removed", changed: "Changed", added: "Added" };
const GROUPS: readonly VersionGroup[] = ["Current", "Steps", "Revisions", "Runs"];

type Loaded = { key: string; cmp: CompareOut; old: EvaluatedModel; new: EvaluatedModel };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function ComparePage({ store, client, glbDeps }: ComparePageProps) {
  const sel = useAppState(store, (s) => s.ui.compare);
  const projectId = useAppState(store, (s) => s.project.projectId);
  const snap = useAppState(store, (s) => s.project.snapshot);
  const units = useAppState(store, (s) => s.ui.units);
  const view = useAppState(store, (s) => s.ui.view);
  const refs = useAppState(store, (s) => s.selection.refs);
  const modelHash = snap?.evaluated?.model_hash ?? null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reverting, setReverting] = useState(false);

  const key = sel === null ? null : `${sel.old}|${sel.new}`;
  useEffect(() => {
    if (sel === null || client === null || projectId === null) return;
    let alive = true;
    setError(null);
    const k = `${sel.old}|${sel.new}`;
    // `live` follows the current model: refetch when it changes.
    Promise.all([
      client.call("history.compare", { projectId, a: sel.old, b: sel.new }),
      client.call("model.get", { projectId, version: sel.old }),
      client.call("model.get", { projectId, version: sel.new }),
    ]).then(
      ([cmp, a, b]) => {
        if (!alive) return;
        if (!a.model || !b.model) throw new Error("model.get returned no model");
        setLoaded({ key: k, cmp, old: a.model, new: b.model });
      },
      (e: unknown) => alive && setError(message(e)),
    );
    return () => {
      alive = false;
    };
  }, [client, projectId, key, modelHash]);

  const current = loaded !== null && loaded.key === key ? loaded : null;
  // The viewport keeps the last scene while the next pair loads (never a placeholder model).
  const shown = current ?? loaded;
  const marks = useMemo(() => markMap(shown?.cmp.marks ?? []), [shown]);
  const merged = useMemo(() => (shown ? mergeForCompare(shown.old, shown.new, marks) : null), [shown, marks]);
  const sceneKey = compareKey(shown?.old ?? null, shown?.new ?? null);
  const labelled = useMemo(() => new Set(Object.keys(marks)), [marks]);
  const selected = useMemo(() => selectedComponentIds(refs), [refs]);
  const state: EngineState = useMemo(
    () => ({ view, explode: 0, section: false, showInternals: false, shadows: true, hidden: [], selected, marks }),
    [view, selected, marks],
  );
  const counts = markCounts(marks);
  const options = useMemo(() => versionOptions(snap), [snap]);
  const metrics = useMemo(() => metricRows(current?.cmp ?? null, units), [current, units]);
  const changes = useMemo(() => changeRows(current?.cmp ?? null, units), [current, units]);
  const edits = useMemo(() => editRows(current?.cmp ?? null), [current]);
  if (sel === null) return null;

  const set = (patch: Partial<CompareSelection>) => store.getState().ui.setCompare({ ...sel, ...patch });
  const close = () => store.getState().ui.setCompare(null);
  const runs = isRunVersion(sel.old) && isRunVersion(sel.new) ? runComparison(snap, [sel.old, sel.new].map((v) => ({ ref: `rw:run/${v.slice(4)}` as const, label: versionLabel(v, snap) }))) : null;
  const oldLabel = versionLabel(sel.old, snap);
  const newLabel = versionLabel(sel.new, snap);
  const revert = () => {
    if (client === null || projectId === null) return;
    setReverting(true);
    client
      .call("history.restore", { projectId, version: sel.old })
      .then(close, (e: unknown) => setError(message(e)))
      .finally(() => setReverting(false));
  };
  const status = error !== null ? "error" : current === null ? "loading" : "ready";

  const picker = (which: "old" | "new", value: string) => (
    <label className="rw-cmp__pick">
      <span className="rw-cmp__pick-label">{which === "old" ? "Old:" : "New:"}</span>
      <select data-testid={`compare.${which}`} value={value} onChange={(e) => set({ [which]: e.target.value })} aria-label={which === "old" ? "Old version" : "New version"}>
        {options.some((o) => o.value === value) ? null : <option value={value}>{versionLabel(value, snap)}</option>}
        {GROUPS.map((g) => {
          const items = options.filter((o) => o.group === g);
          if (items.length === 0) return null;
          return (
            <optgroup key={g} label={g}>
              {items.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </label>
  );

  return (
    <div className="rw-cmp" data-testid="compare" data-old={sel.old} data-new={sel.new} data-state={status} data-scene={current ? sceneKey : ""}>
      <div className="rw-cmp__stage">
        {merged === null ? (
          <div className="rw-viewport" data-rw-region="viewport" data-testid="viewport" data-ready="false" />
        ) : (
          <AssemblyViewport
            state={state}
            evaluated={merged}
            glbDeps={glbDeps}
            modelKey={sceneKey}
            labelOnly={labelled}
            insetRight={COMPARE_PANEL_WIDTH + 8}
            ariaLabel={`Compare ${oldLabel} with ${newLabel}`}
            onPick={(id) => store.getState().selection.select(id === null ? [] : [componentRef(id)], "viewport")}
          />
        )}
        <aside className="rw-cmp__panel" data-testid="compare.panel" style={{ width: COMPARE_PANEL_WIDTH }}>
          <header className="rw-cmp__head">
            <h2 className="rw-cmp__title" data-testid="compare.title">
              {oldLabel} → {newLabel}
            </h2>
            <p className="rw-cmp__summary">
              {MARK_ORDER.map((m) => (
                <span key={m} className="rw-cmp__count" data-mark={m}>
                  {counts[m]} {MARK_NAMES[m].toLowerCase()}
                </span>
              ))}
            </p>
          </header>
          {error !== null && (
            <p className="rw-cmp__error" role="alert" data-testid="compare.error">
              {error}
            </p>
          )}
          {runs && <RunComparePanel view={runs} />}
          <section className="rw-cmp__section" aria-label="Metrics">
            <h3 className="rw-cmp__section-title">Metrics</h3>
            <table className="rw-cmp__metrics" data-testid="compare.metrics">
              <colgroup>
                <col className="rw-cmp__col-metric" />
                <col className="rw-cmp__col-value" />
                <col className="rw-cmp__col-value" />
                <col className="rw-cmp__col-delta" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  <th scope="col">Old</th>
                  <th scope="col">New</th>
                  <th scope="col">Δ</th>
                </tr>
              </thead>
              <tbody>
                {metrics.map((r) => (
                  <tr key={r.key} data-metric={r.key} data-tone={r.tone}>
                    <th scope="row" title={r.key}>
                      {r.label}
                    </th>
                    <td>{r.old}</td>
                    <td>{r.new}</td>
                    <td className="rw-cmp__delta">{r.delta}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="rw-cmp__section" aria-label="Components">
            <h3 className="rw-cmp__section-title">Components</h3>
            {changes.length === 0 ? (
              <p className="rw-cmp__empty">{current ? "No component differs." : "Comparing…"}</p>
            ) : (
              <ul className="rw-cmp__changes" data-testid="compare.changes">
                {changes.map((c) => (
                  <li key={c.id} className="rw-cmp__change" data-part={c.id} data-mark={c.status}>
                    <button type="button" className="rw-cmp__change-name" onClick={() => store.getState().selection.select([componentRef(c.id)], "viewport")}>
                      <i className="rw-cmp__swatch" data-mark={c.status} aria-hidden />
                      {c.name}
                      <span className="rw-cmp__change-kind">{MARK_NAMES[c.status]}</span>
                    </button>
                    {c.fields.length > 0 && (
                      <dl className="rw-cmp__fields">
                        {c.fields.map((f) => (
                          <div key={f.path} data-path={f.path}>
                            <dt>{f.label}</dt>
                            <dd>
                              {f.old} → {f.new}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {edits.length > 0 && (
            <section className="rw-cmp__section" aria-label="Edits">
              <h3 className="rw-cmp__section-title">Edits</h3>
              <ul className="rw-cmp__edits" data-testid="compare.edits">
                {edits.map((e) => (
                  <li key={e.path} data-path={e.path}>
                    <code>{e.path}</code>
                    <span>
                      {e.old} → {e.new}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
      <footer className="rw-cmp__bar" data-testid="compare.bar">
        <div className="rw-cmp__row">
          {picker("old", sel.old)}
          {picker("new", sel.new)}
          <button type="button" className="rw-icon-button" data-testid="compare.swap" aria-label="Swap Old and New" title="Swap Old and New" onClick={() => set({ old: sel.new, new: sel.old })}>
            <Icon name="compare" size={18} />
          </button>
          <span className="rw-cmp__spacer" />
          <button
            type="button"
            className="rw-button"
            data-testid="compare.revert"
            disabled={!canRevertTo(sel.old) || reverting || client === null}
            title={`Restore the model to ${oldLabel} as a new step`}
            onClick={revert}
          >
            Revert to {oldLabel}
          </button>
          <button type="button" className="rw-button" data-testid="compare.close" onClick={close}>
            Close
          </button>
        </div>
        <div className="rw-cmp__legend" data-testid="compare.legend">
          {MARK_ORDER.map((m) => (
            <span key={m} className="rw-cmp__legend-item" data-mark={m}>
              <i className="rw-cmp__swatch" data-mark={m} style={{ background: MARK_COLORS[m] }} aria-hidden />
              {MARK_NAMES[m]}
            </span>
          ))}
          <span className="rw-cmp__legend-item rw-cmp__legend-item--dim">Unchanged parts dimmed</span>
        </div>
      </footer>
    </div>
  );
}
