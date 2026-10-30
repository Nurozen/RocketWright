/**
 * Simulate > Propulsion simulation, Imported CFD tier (M5.4, spec R6.15,
 * Acc 9): a dataset imported with `cfd_import` (`cfd.import` RPC; listed by
 * `cfd.list`; its record `cfd.json` over HTTP at `CFD_RUN_PATH`) drawn as
 * points in the body frame, coloured by a chosen scalar. The legend's range
 * is that scalar's min and max in the shown step's file; a scrubber steps
 * through the `_t<s>` files. The provenance label is bound to the record
 * (I13): imported results are never engineering numbers.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { schema } from "@rw/contracts";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { RpcLike } from "../../state/rpc.ts";
import { useAppState, type AppStore } from "../../state/index.ts";
import type { FetchText } from "./engineering.tsx";
import {
  CFD_VIEWS,
  cfdRunUrl,
  colormap,
  column,
  formatValue,
  legendGradient,
  normalize,
  parseCfdRecord,
  projectStep,
  scalarColumns,
  scalarLabel,
  stepRange,
  timeLabel,
  viewAxes,
  type CfdRecord,
  type CfdView,
} from "./cfdModel.ts";
import { provenanceLabel } from "./model.ts";

export interface CfdUi {
  /** `cfd.list` result (null until loaded). */
  datasets: schema.CfdDataset[] | null;
  listError: string | null;
  /** Chosen dataset id. */
  dataset: string | null;
  /** The loaded record of `<sim>/<run_id>`. */
  record: { key: string; state: "loading" | "ready" | "error"; record: CfdRecord | null; error?: string } | null;
  scalar: string | null;
  step: number;
  view: CfdView;
  importPath: string;
  importing: boolean;
  importError: string | null;
}

export type CfdStore = StoreApi<CfdUi>;

export function createCfdUi(): CfdStore {
  return createStore<CfdUi>()(() => ({
    datasets: null,
    listError: null,
    dataset: null,
    record: null,
    scalar: null,
    step: 0,
    view: "side",
    importPath: "",
    importing: false,
    importError: null,
  }));
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface CfdTabProps {
  store: AppStore;
  client: RpcLike | null;
  ui: CfdStore;
  httpBase: string;
  fetchText?: FetchText;
}

export function CfdTab({ store, client, ui, httpBase, fetchText = (u) => fetch(u) }: CfdTabProps) {
  const projectId = useAppState(store, (s) => s.project.projectId);
  const datasets = useStore(ui, (s) => s.datasets);
  const chosen = useStore(ui, (s) => s.dataset);
  const loaded = useStore(ui, (s) => s.record);
  const fetchRef = useRef(fetchText);
  fetchRef.current = fetchText;

  const list = useMemo(
    () => async (select?: string) => {
      if (client === null || projectId === null) return;
      try {
        const out = await client.call("cfd.list", { projectId });
        ui.setState({ datasets: out.datasets, listError: null, ...(select === undefined ? {} : { dataset: select, step: 0 }) });
      } catch (e) {
        ui.setState({ datasets: [], listError: message(e) });
      }
    },
    [client, projectId, ui],
  );

  useEffect(() => {
    if (ui.getState().datasets === null) void list();
  }, [list, ui]);

  const ds = datasets?.find((d) => d.id === chosen) ?? datasets?.[0] ?? null;
  const key = ds ? `${ds.sim}/${ds.run_id}` : "";

  useEffect(() => {
    if (ds === null || projectId === null) return;
    const cur = ui.getState().record;
    if (cur?.key === key && cur.state !== "error") return;
    ui.setState({ record: { key, state: "loading", record: null } });
    const mine = () => ui.getState().record?.key === key;
    void (async () => {
      try {
        const res = await fetchRef.current(cfdRunUrl(httpBase, projectId, ds.sim, ds.run_id));
        if (!res.ok) throw new Error(`cfd run ${key}: HTTP ${res.status}`);
        const record = parseCfdRecord(await res.text());
        if (!mine()) return;
        const scalars = scalarColumns(record);
        const s = ui.getState().scalar;
        ui.setState({
          record: { key, state: "ready", record },
          scalar: s !== null && scalars.includes(s) ? s : (scalars[0] ?? null),
          step: Math.min(ui.getState().step, Math.max(0, record.steps.length - 1)),
        });
      } catch (e) {
        if (mine()) ui.setState({ record: { key, state: "error", record: null, error: message(e) } });
      }
    })();
  }, [ds, key, projectId, httpBase, ui]);

  const record = loaded?.key === key ? loaded.record : null;
  const state = datasets === null ? "loading" : ds === null ? "empty" : (loaded?.key === key ? loaded.state : "loading");

  return (
    <div className="rw-cfd" data-testid="propsim.cfd" data-state={state} data-dataset={ds?.id ?? ""} data-provenance={record?.provenance ?? ""}>
      <header className="rw-eng__bar">
        {datasets !== null && datasets.length > 1 && (
          <label className="rw-eng__engine">
            <span>Dataset</span>
            <select data-testid="cfd.dataset" value={ds?.id ?? ""} onChange={(e) => ui.setState({ dataset: e.target.value, step: 0 })}>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.id}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="rw-eng__run" data-testid="cfd.run-id">
          {record ? `Run ${record.run_id} · ${record.id}` : ""}
        </span>
        <span className="rw-eng__provenance" data-testid="cfd.provenance" data-provenance={record?.provenance ?? ""}>
          {record ? `${provenanceLabel(record.provenance)} · imported points (cfd_import)` : ""}
        </span>
      </header>
      {state === "empty" ? (
        <div className="rw-cfd__empty" data-testid="propsim.cfd-empty">
          <p className="rw-eng__empty">
            No imported CFD result. Import a CSV point file (header x,y,z in metres, body frame; optional vx,vy,vz and scalar columns), or a directory of
            &lt;name&gt;_t&lt;seconds&gt;.csv steps. Imported fields show here with their own provenance and never feed engineering numbers.
          </p>
          <ImportForm ui={ui} client={client} projectId={projectId} onImported={(id) => void list(id)} />
        </div>
      ) : state === "error" ? (
        <p className="rw-eng__empty" data-testid="cfd.error">
          The dataset could not load: {loaded?.error ?? ""}
        </p>
      ) : record === null || ds === null ? (
        <p className="rw-eng__empty" data-testid="cfd.loading">
          Loading the imported dataset…
        </p>
      ) : (
        <CfdDatasetView record={record} dataset={ds} ui={ui} client={client} projectId={projectId} onImported={(id) => void list(id)} />
      )}
    </div>
  );
}

function ImportForm({ ui, client, projectId, onImported }: { ui: CfdStore; client: RpcLike | null; projectId: string | null; onImported: (id: string) => void }) {
  const path = useStore(ui, (s) => s.importPath);
  const busy = useStore(ui, (s) => s.importing);
  const error = useStore(ui, (s) => s.importError);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = path.trim();
    if (client === null || projectId === null || p === "" || busy) return;
    ui.setState({ importing: true, importError: null });
    void (async () => {
      try {
        const out = await client.call("cfd.import", { projectId, path: p });
        ui.setState({ importing: false, importPath: "" });
        onImported(out.dataset.id);
      } catch (x) {
        ui.setState({ importing: false, importError: message(x) });
      }
    })();
  };
  return (
    <form className="rw-cfd__import" data-testid="cfd.import-form" onSubmit={submit}>
      <label>
        <span>CSV file or directory</span>
        <input
          type="text"
          data-testid="cfd.import-path"
          placeholder="/path/to/tank_t0.5.csv or a directory of steps"
          value={path}
          spellCheck={false}
          onChange={(e) => ui.setState({ importPath: e.target.value })}
        />
      </label>
      <button type="submit" className="rw-button rw-button--primary" data-testid="cfd.import" disabled={busy || path.trim() === "" || client === null}>
        {busy ? "Importing…" : "Import"}
      </button>
      {error !== null && (
        <p className="rw-cfd__error" data-testid="cfd.import-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function CfdDatasetView({ record, dataset, ui, client, projectId, onImported }: { record: CfdRecord; dataset: schema.CfdDataset; ui: CfdStore; client: RpcLike | null; projectId: string | null; onImported: (id: string) => void }) {
  const scalars = useMemo(() => scalarColumns(record), [record]);
  const chosen = useStore(ui, (s) => s.scalar);
  const scalar = chosen !== null && scalars.includes(chosen) ? chosen : (scalars[0] ?? null);
  const rawStep = useStore(ui, (s) => s.step);
  const stepIx = Math.min(Math.max(0, rawStep), record.steps.length - 1);
  const step = record.steps[stepIx]!;
  const view = useStore(ui, (s) => s.view);
  const range = useMemo(() => (scalar === null ? null : stepRange(record, step, scalar)), [record, step, scalar]);

  return (
    <div className="rw-cfd__body">
      <div className="rw-cfd__main">
        <div className="rw-cfd__controls">
          <label className="rw-eng__engine">
            <span>Colour by</span>
            <select data-testid="cfd.scalar" value={scalar ?? ""} onChange={(e) => ui.setState({ scalar: e.target.value })}>
              {scalars.map((s) => (
                <option key={s} value={s}>
                  {scalarLabel(record, s)}
                </option>
              ))}
            </select>
          </label>
          <label className="rw-eng__engine">
            <span>View</span>
            <select data-testid="cfd.view" value={view} onChange={(e) => ui.setState({ view: e.target.value as CfdView })}>
              {CFD_VIEWS.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <PointCanvas record={record} stepIx={stepIx} scalar={scalar} range={range} view={view} />
        {scalar !== null && range !== null && (
          <div className="rw-cfd__legend" data-testid="cfd.legend" data-scalar={scalar} data-min={String(range.min)} data-max={String(range.max)} data-step={stepIx} data-file={step.file}>
            <span className="rw-cfd__legend-title">{scalarLabel(record, scalar)}</span>
            <span className="rw-cfd__legend-min" data-testid="cfd.legend-min">
              {formatValue(range.min)}
            </span>
            <span className="rw-cfd__legend-bar" style={{ background: legendGradient() }} aria-hidden />
            <span className="rw-cfd__legend-max" data-testid="cfd.legend-max">
              {formatValue(range.max)}
            </span>
          </div>
        )}
        <div className="rw-cfd__transport">
          <input
            type="range"
            aria-label="Time step"
            data-testid="cfd.step"
            min={0}
            max={record.steps.length - 1}
            step={1}
            value={stepIx}
            disabled={record.steps.length < 2}
            onChange={(e) => ui.setState({ step: Number(e.target.value) })}
          />
          <span className="rw-cfd__time" data-testid="cfd.time" data-time={String(step.time)}>
            {timeLabel(step.time)} · step {stepIx + 1} of {record.steps.length}
          </span>
        </div>
      </div>
      <aside className="rw-eng__side">
        <section className="rw-eng__summary" data-testid="cfd.summary">
          <h2 className="rw-eng__title">Dataset</h2>
          <dl>
            <div className="rw-eng__row" data-key="points">
              <dt>Points in this step</dt>
              <dd>{step.points.toLocaleString("en-US")}</dd>
            </div>
            <div className="rw-eng__row" data-key="steps">
              <dt>Steps</dt>
              <dd>{record.steps.length}</dd>
            </div>
            <div className="rw-eng__row" data-key="velocity">
              <dt>Velocity</dt>
              <dd>{dataset.has_velocity ? "vx, vy, vz (m/s)" : "none"}</dd>
            </div>
            <div className="rw-eng__row" data-key="frame">
              <dt>Frame</dt>
              <dd>Body (+X aft, +Z up), m</dd>
            </div>
            <div className="rw-eng__row" data-key="file">
              <dt>File</dt>
              <dd className="rw-cfd__file" title={step.file}>
                {step.file.split("/").at(-1)}
              </dd>
            </div>
          </dl>
        </section>
        <section className="rw-eng__assumptions" data-testid="cfd.notes">
          <h2 className="rw-eng__title">Provenance</h2>
          <ul>
            <li>Imported points, shown as given: not computed by RocketWright and never used for engineering numbers.</li>
            <li>The colour range is the chosen scalar's min and max in this step's file.</li>
          </ul>
        </section>
        <section className="rw-cfd__import-side">
          <h2 className="rw-eng__title">Import another</h2>
          <ImportForm ui={ui} client={client} projectId={projectId} onImported={onImported} />
        </section>
      </aside>
    </div>
  );
}

const PAD = 28;

function PointCanvas({ record, stepIx, scalar, range, view }: { record: CfdRecord; stepIx: number; scalar: string | null; range: { min: number; max: number } | null; view: CfdView }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [drawn, setDrawn] = useState(0);

  useEffect(() => {
    const el = wrap.current;
    if (el === null) return;
    const measure = () => setSize({ w: Math.floor(el.clientWidth), h: Math.floor(el.clientHeight) });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (c === null || size.w === 0 || size.h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const g = c.getContext("2d");
    if (g === null) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.w, size.h);
    const step = record.steps[stepIx]!;
    const p = projectStep(record, step, view, size.w, size.h, PAD);
    const vals = scalar === null ? null : column(record, step, scalar);
    const r = Math.max(2, Math.min(4.5, Math.sqrt((size.w * size.h) / Math.max(1, step.points)) / 6));
    for (const i of p.order) {
      const [cr, cg, cb] = vals !== null && range !== null ? colormap(normalize(vals[i]!, range.min, range.max)) : [201, 206, 209];
      g.fillStyle = `rgb(${cr},${cg},${cb})`;
      g.beginPath();
      g.arc(p.px[i]!, p.py[i]!, r, 0, Math.PI * 2);
      g.fill();
    }
    setDrawn(p.order.length);
  }, [record, stepIx, scalar, range, view, size]);

  const ax = viewAxes(view);
  return (
    <div className="rw-cfd__plot" ref={wrap}>
      <canvas ref={canvas} data-testid="cfd.canvas" data-points={drawn} data-view={view} style={{ width: size.w, height: size.h }} />
      <span className="rw-cfd__axis rw-cfd__axis--u">{ax.uLabel} →</span>
      <span className="rw-cfd__axis rw-cfd__axis--v">↑ {ax.vLabel}</span>
    </div>
  );
}
