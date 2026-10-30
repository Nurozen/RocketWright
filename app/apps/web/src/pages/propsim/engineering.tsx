/**
 * Simulate > Propulsion simulation, Engineering tier (M4.8): the liquid
 * engine's tank blowdown from `engine_simulate` (`engine.simulate` RPC; the
 * run record `engine.json` over HTTP at `ENGINE_RUN_PATH`). Three time plots
 * (tank pressure, mass flow, thrust), the run summary, and the design's
 * assumptions (single-phase propellants: no self-pressurizing N2O). The
 * provenance label is bound to the record's `provenance` (I13).
 */
import { useEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { TimePlot } from "../../plots/TimePlot.tsx";
import type { RpcLike } from "../../state/rpc.ts";
import { useAppState, type AppStore } from "../../state/index.ts";
import { engineRunUrl, engineeringPlots, parseEngineRun, provenanceLabel, runSummary, type EngineRunRecord, type EngineeringPlot } from "./model.ts";

export type FetchText = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface EngineeringUi {
  engine: string | null;
  /** Per engine and model hash: the run and its record. */
  run: { key: string; state: "running" | "ready" | "error"; record: EngineRunRecord | null; runId?: string; error?: string } | null;
}

export type EngineeringStore = StoreApi<EngineeringUi>;

export function createEngineeringUi(): EngineeringStore {
  return createStore<EngineeringUi>()(() => ({ engine: null, run: null }));
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Engines that can fly a blowdown: no liquid missing-input diagnostics
 * (RW-W200-W249) in the check report. Sorted by id.
 */
export function runnableEngines(engines: Readonly<Record<string, unknown>> | null | undefined, diagnostics: readonly { code: string; path?: string | null }[] | null | undefined): string[] {
  const ids = Object.keys(engines ?? {}).sort();
  const blocked = new Set((diagnostics ?? []).filter((d) => /^RW-W2[0-4]\d$/.test(d.code)).map((d) => /^\/engines\/([^/]+)\//.exec(d.path ?? "")?.[1]));
  return ids.filter((id) => !blocked.has(id));
}

export interface EngineeringTabProps {
  store: AppStore;
  client: RpcLike | null;
  ui: EngineeringStore;
  /** The app server's HTTP base (`""` = same origin). */
  httpBase: string;
  fetchText?: FetchText;
}

export function EngineeringTab({ store, client, ui, httpBase, fetchText = (u) => fetch(u) }: EngineeringTabProps) {
  const projectId = useAppState(store, (s) => s.project.projectId);
  const engines = useAppState(store, (s) => s.project.snapshot?.evaluated?.engines ?? null);
  const diagnostics = useAppState(store, (s) => s.project.snapshot?.check?.diagnostics ?? null);
  const hash = useAppState(store, (s) => s.project.snapshot?.evaluated?.model_hash ?? "");
  const all = useMemo(() => Object.keys(engines ?? {}).sort(), [engines]);
  const runnable = useMemo(() => runnableEngines(engines as Record<string, unknown> | null, diagnostics as { code: string; path?: string | null }[] | null), [engines, diagnostics]);
  const chosen = useStore(ui, (s) => s.engine);
  const engine = chosen !== null && all.includes(chosen) ? chosen : (runnable[0] ?? all[0] ?? null);
  const run = useStore(ui, (s) => s.run);
  const key = `${engine ?? ""}@${hash}`;
  const fetchRef = useRef(fetchText);
  fetchRef.current = fetchText;

  useEffect(() => {
    const cur = ui.getState().run;
    if (client === null || projectId === null || engine === null || (cur?.key === key && cur.state !== "error")) return;
    ui.setState({ run: { key, state: "running", record: null } });
    // Only the newest run lands (the key moves on with the engine and the model).
    const mine = () => ui.getState().run?.key === key;
    void (async () => {
      try {
        const out = await client.call("engine.simulate", { projectId, engine });
        const res = await fetchRef.current(engineRunUrl(httpBase, projectId, out.sim, out.run_id));
        if (!res.ok) throw new Error(`engine run ${out.sim}/${out.run_id}: HTTP ${res.status}`);
        const record = parseEngineRun(await res.text());
        if (mine()) ui.setState({ run: { key, state: "ready", record, runId: out.run_id } });
      } catch (e) {
        if (mine()) ui.setState({ run: { key, state: "error", record: null, error: message(e) } });
      }
    })();
  }, [client, projectId, engine, key, httpBase, ui]);

  const record = run?.key === key ? run.record : null;
  const plots = useMemo(() => (record ? engineeringPlots(record) : []), [record]);
  const summary = useMemo(() => (record ? runSummary(record) : []), [record]);
  const names = engines as Record<string, { name?: string } | undefined> | null;

  return (
    <div className="rw-eng" data-testid="propsim.engineering" data-engine={engine ?? ""} data-state={run?.key === key ? run.state : "idle"} data-provenance={record?.provenance ?? ""}>
      <header className="rw-eng__bar">
        {all.length > 0 && (
          <label className="rw-eng__engine">
            <span>Engine</span>
            <select data-testid="engineering.engine" value={engine ?? ""} onChange={(e) => ui.setState({ engine: e.target.value })}>
              {all.map((id) => (
                <option key={id} value={id}>
                  {names?.[id]?.name ?? id}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="rw-eng__run" data-testid="engineering.run-id">
          {record ? `Run ${record.run_id} · ${record.engine}` : ""}
        </span>
        <span className="rw-eng__provenance" data-testid="traces.provenance" data-provenance={record?.provenance ?? ""}>
          {record ? `${provenanceLabel(record.provenance)} · blowdown (engine_simulate)` : ""}
        </span>
      </header>
      {engine === null ? (
        <p className="rw-eng__empty" data-testid="engineering.empty">
          No liquid engine in this project. Add one under engines/&lt;id&gt;.rw.toml.
        </p>
      ) : run?.key === key && run.state === "error" ? (
        <p className="rw-eng__empty" data-testid="engineering.error">
          The blowdown could not run: {run.error}
        </p>
      ) : record === null ? (
        <p className="rw-eng__empty" data-testid="engineering.loading">
          Running the blowdown…
        </p>
      ) : (
        <div className="rw-eng__body">
          <div className="rw-eng__plots">
            {plots.map((p) => (
              <EngineeringPlotPanel key={p.id} plot={p} />
            ))}
          </div>
          <aside className="rw-eng__side">
            <section className="rw-eng__summary" data-testid="engineering.summary">
              <h2 className="rw-eng__title">Run summary</h2>
              <dl>
                {summary.map((r) => (
                  <div key={r.key} className="rw-eng__row" data-key={r.key}>
                    <dt>{r.label}</dt>
                    <dd>{r.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
            <section className="rw-eng__assumptions" data-testid="engineering.assumptions">
              <h2 className="rw-eng__title">Assumptions</h2>
              <ul>
                {(record.design.assumptions ?? []).map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}

function EngineeringPlotPanel({ plot }: { plot: EngineeringPlot }) {
  const legend = useRef<HTMLUListElement>(null);
  const last = plot.lines[0]?.t.at(-1) ?? 0;
  return (
    <section className="rw-eng-plot" data-testid="engineering.plot" data-plot={plot.id} data-series={plot.lines.length} data-points={plot.lines[0]?.t.length ?? 0} data-t-end={last.toFixed(3)}>
      <h3 className="rw-eng-plot__title">{plot.title}</h3>
      <div className="rw-eng-plot__chart">
        <TimePlot lines={plot.lines} events={[]} yLabel={plot.yLabel} topInset={10} avoid={legend} />
        <ul className="rw-eng-plot__legend rw-list" ref={legend} data-testid="engineering.legend">
          {plot.lines.map((l) => (
            <li key={l.id} data-testid="engineering.series" data-series={l.id}>
              <span className="rw-eng-plot__swatch" style={{ background: l.color }} aria-hidden />
              {l.label}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
