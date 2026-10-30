/**
 * Simulate > Propulsion simulation, Visual flow tier (M5.1-M5.3, concept
 * 06): the project's visual flow studies (`sims/<id>.rw.toml`,
 * `kind = "visual_flow"`), each run through `sim.run` (a `provenance =
 * "visual"` run whose `visual.json` timeline drains the tank with the
 * engine's engineering blowdown), shown as the WebGPU cutaway with the
 * MLS-MPM liquid, white illustrative streamlines, leader labels, the
 * transport, and the "Relative flow" / "Relative fill" traces. The label
 * "Visual model · Not an engineering result" is bound to the record's
 * `provenance` (I13), never assumed.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { parseRef, VISUAL_RUN_PATH } from "@rw/contracts";
import { engineNodeThumbKey, sectionThumbKey } from "../../state/entities.ts";
import { DEFAULT_LAYERS, FluidStage, type SnapshotFit, type AnchorId, type FluidReadback, type GpuInfo, type StageLayers, type StageOptions, type StageOverlay, type StageStats } from "../../fluid/stage.ts";
import { FLUID_TEAL } from "../../fluid/surface.ts";
import { poolCss } from "../../viewport/stage.ts";
import { parseVisualRun, traces, type VisualRun } from "../../fluid/timeline.ts";
import type { RpcLike } from "../../state/rpc.ts";
import { useAppState, type AppStore } from "../../state/index.ts";
import type { FetchText } from "./engineering.tsx";
import { LayersPanel, orderStudies, StudyList, type StudyRow } from "./layers.tsx";
import { provenanceLabel } from "./model.ts";
import { Traces } from "./traces.tsx";
import { clockOf, createTransport, TransportBar, useTransportLoop, type TransportStore } from "./transport.tsx";

export type SubTab = "inputs" | "traces" | "assumptions";

export interface VisualUi {
  study: string | null;
  run: { key: string; state: "running" | "ready" | "error"; record: VisualRun | null; error?: string } | null;
  layers: StageLayers;
  sub: SubTab;
}

export type VisualStore = StoreApi<VisualUi>;

export function createVisualUi(): VisualStore {
  return createStore<VisualUi>()(() => ({ study: null, run: null, layers: { ...DEFAULT_LAYERS }, sub: "traces" }));
}

/** `<base>/api/projects/<p>/runs/<sim>/<runId>/visual.json` */
export function visualRunUrl(baseUrl: string, projectId: string, sim: string, runId: string): string {
  const path = VISUAL_RUN_PATH.replace(":projectId", encodeURIComponent(projectId)).replace(":sim", encodeURIComponent(sim)).replace(":runId", encodeURIComponent(runId));
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** The project's visual flow studies, in list order. */
export function studyRows(sims: Readonly<Record<string, { id?: string; name?: string; kind?: string } | null | undefined>> | null | undefined): StudyRow[] {
  return orderStudies(
    Object.entries(sims ?? {})
      .filter(([, s]) => s?.kind === "visual_flow")
      .map(([id, s]) => ({ id, name: s?.name ?? id })),
  );
}

/** The selected study each tier store last followed. */
const followed = new WeakMap<VisualStore, string | null>();

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface VisualFlowTabProps {
  store: AppStore;
  client: RpcLike | null;
  ui: VisualStore;
  httpBase: string;
  fetchText?: FetchText;
}

/** The live tier: studies from the project, each run through the sidecar. */
export function VisualFlowTab({ store, client, ui, httpBase, fetchText = (u) => fetch(u) }: VisualFlowTabProps) {
  const projectId = useAppState(store, (s) => s.project.projectId);
  const sims = useAppState(store, (s) => s.project.snapshot?.evaluated?.sims ?? null);
  const hash = useAppState(store, (s) => s.project.snapshot?.evaluated?.model_hash ?? "");
  const studies = useMemo(() => studyRows(sims as Record<string, { name?: string; kind?: string }> | null), [sims]);
  const chosen = useStore(ui, (s) => s.study);
  const study = chosen !== null && studies.some((s) => s.id === chosen) ? chosen : (studies[0]?.id ?? null);
  const run = useStore(ui, (s) => s.run);
  const key = `${study ?? ""}@${hash}`;
  const fetchRef = useRef(fetchText);
  fetchRef.current = fetchText;
  const refs = useAppState(store, (s) => s.selection.refs);
  const thumbs = useAppState(store, (s) => s.thumbs.urls);

  // A selected study (`rw:sim/<study>`, e.g. the agent's Section view card) opens here with the section on.
  const pick = refs.map((r) => parseRef(r)).find((p) => "ok" in p && p.ok.kind === "sim" && studies.some((x) => x.id === p.ok.id));
  const picked = pick !== undefined && "ok" in pick ? pick.ok.id : null;
  useEffect(() => {
    // Once per selection (a remount after a tier switch keeps the user's own study choice).
    if (followed.get(ui) === picked) return;
    followed.set(ui, picked);
    if (picked === null) return;
    const cur = ui.getState();
    ui.setState({ study: picked, layers: { ...cur.layers, shell: true, section: true } });
  }, [picked, ui]);

  useEffect(() => {
    const cur = ui.getState().run;
    if (client === null || projectId === null || study === null || (cur?.key === key && cur.state !== "error")) return;
    ui.setState({ run: { key, state: "running", record: cur?.record ?? null } });
    const mine = () => ui.getState().run?.key === key;
    void (async () => {
      try {
        const out = await client.call("sim.run", { projectId, sim: study });
        const res = await fetchRef.current(visualRunUrl(httpBase, projectId, out.sim, out.run_id));
        if (!res.ok) throw new Error(`visual run ${out.sim}/${out.run_id}: HTTP ${res.status}`);
        const record = parseVisualRun(await res.text());
        if (mine()) ui.setState({ run: { key, state: "ready", record } });
      } catch (e) {
        if (mine()) ui.setState({ run: { key, state: "error", record: null, error: message(e) } });
      }
    })();
  }, [client, projectId, study, key, httpBase, ui]);

  const mine = run?.key === key ? run : null;
  const rec = mine?.record ?? run?.record ?? null;
  // The study tank's picture for `@` chips of that tank (once per model and tank).
  const tankKey = rec ? engineNodeThumbKey(rec.engine, rec.tank.node) : null;
  return (
    <VisualFlowView
      studies={studies}
      selected={study}
      onSelect={(id) => ui.setState({ study: id })}
      record={mine?.record ?? run?.record ?? null}
      state={mine?.state ?? (study === null ? "empty" : "running")}
      error={mine?.error ?? null}
      ui={ui}
      onOpenEngineering={() => store.getState().ui.navigate("propulsion-sim", "engineering")}
      onImportCfd={() => store.getState().ui.navigate("propulsion-sim", "cfd")}
      // The study's section view picture for the agent's result card (once per model and study).
      {...(study !== null && hash !== "" && thumbs[sectionThumbKey(study)] === undefined
        ? { onThumb: (png: string) => void store.getState().thumbs.add(hash, sectionThumbKey(study), png).catch(() => undefined) }
        : {})}
      {...(tankKey !== null && hash !== "" && thumbs[tankKey] === undefined
        ? { onTankThumb: (png: string) => void store.getState().thumbs.add(hash, tankKey, png).catch(() => undefined) }
        : {})}
    />
  );
}

export interface VisualFlowViewProps {
  studies: readonly StudyRow[];
  selected: string | null;
  onSelect: (id: string) => void;
  record: VisualRun | null;
  state: "empty" | "running" | "ready" | "error";
  error: string | null;
  ui: VisualStore;
  onOpenEngineering?: () => void;
  onImportCfd?: () => void;
  /** An externally owned transport (tests, the RL1d spike); one per view otherwise. */
  transport?: TransportStore;
  /** Stage options (the RL1d spike's development aids). */
  stageOptions?: StageOptions;
  /** Receives one section view picture (PNG base64) of the study once the liquid has settled. */
  onThumb?: (png: string) => void;
  /** Receives one upright picture (PNG base64) of the study tank's section, for its `@` chip. */
  onTankThumb?: (png: string) => void;
}

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: "inputs", label: "Inputs" },
  { id: "traces", label: "Traces" },
  { id: "assumptions", label: "Assumptions" },
];

/** The tier's layout: side column, viewport, transport, sub-tabs with the traces. */
export function VisualFlowView({ studies, selected, onSelect, record, state, error, ui, onOpenEngineering, onImportCfd, transport: external, stageOptions, onThumb, onTankThumb }: VisualFlowViewProps) {
  const own = useMemo(() => createTransport(record?.duration ?? 10), []); // eslint-disable-line react-hooks/exhaustive-deps
  const transport = external ?? own;
  useTransportLoop(transport);
  const layers = useStore(ui, (s) => s.layers);
  const sub = useStore(ui, (s) => s.sub);
  const runId = record?.run_id ?? null;
  useEffect(() => {
    if (record) {
      transport.getState().pause();
      transport.getState().setDuration(record.duration);
      transport.getState().seek(0);
    }
  }, [runId, record, transport]);
  const tr = useMemo(() => (record ? traces(record) : { flow: [], fill: [] }), [record]);
  const provenance = record?.provenance ?? "";
  const setLayers = (l: StageLayers) => ui.setState({ layers: l });
  return (
    <div className="rw-vis" data-testid="propsim.visual" data-state={state} data-study={selected ?? ""} data-run={runId ?? ""} data-provenance={provenance}>
      <aside className="rw-vis-side" data-rw-region="study-column" data-testid="study-column">
        <StudyList studies={studies} selected={selected} onSelect={onSelect} />
        <LayersPanel layers={layers} onChange={setLayers} />
      </aside>
      <div className="rw-vis-stage" data-rw-region="viewport">
        {record ? (
          <FluidViewport record={record} transport={transport} layers={layers} options={stageOptions ?? {}} {...(onThumb ? { onThumb } : {})} {...(onTankThumb ? { onTankThumb } : {})} />
        ) : (
          <div className="rw-vis-viewport rw-vis-viewport--empty" data-testid="visual.viewport" data-state={state}>
            <p className="rw-eng__empty" data-testid={state === "error" ? "visual.error" : "visual.loading"}>
              {state === "error" ? `The study could not run: ${error ?? ""}` : state === "empty" ? "No visual flow study in this project. Add one under sims/<id>.rw.toml with kind = \"visual_flow\"." : "Preparing the study…"}
            </p>
          </div>
        )}
      </div>
      <TransportBar store={transport} section={layers.section} onSection={(on) => setLayers({ ...layers, section: on })} />
      <div className="rw-vis-lower" data-rw-region="traces" data-testid="traces">
        <div className="rw-vis-lower__bar">
          <nav className="rw-vis-subtabs" role="tablist" aria-label="Study detail">
            {SUB_TABS.map((t) => (
              <button key={t.id} type="button" role="tab" className="rw-tab rw-tab--editor" data-testid="visual.subtab" data-sub={t.id} aria-selected={t.id === sub} onClick={() => ui.setState({ sub: t.id })}>
                {t.label}
              </button>
            ))}
          </nav>
          {provenance !== "" && (
            <span className="rw-vis-provenance" data-testid="traces.provenance" data-provenance={provenance}>
              {provenanceLabel(provenance)}
            </span>
          )}
        </div>
        <div className="rw-vis-lower__body">
          {sub === "traces" && <Traces store={transport} flow={tr.flow} fill={tr.fill} />}
          {sub === "inputs" && record && <StudyInputs record={record} />}
          {sub === "assumptions" && record && (
            <ul className="rw-vis-assumptions" data-testid="visual.assumptions">
              {record.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="rw-vis-lower__actions">
          <button type="button" className="rw-button" data-testid="visual.open-engineering" onClick={onOpenEngineering}>
            <OpenIcon />
            Open engineering run
          </button>
          <button type="button" className="rw-button" data-testid="visual.import-cfd" onClick={onImportCfd}>
            <ImportIcon />
            Import CFD result
          </button>
        </div>
      </div>
    </div>
  );
}

function OpenIcon() {
  return (
    <svg className="rw-icon" width={16} height={16} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path d="M11 3h6v6M17 3l-8 8M14 12v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ImportIcon() {
  return (
    <svg className="rw-icon" width={16} height={16} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path d="M10 3v10M6 9l4 4 4-4M4 16h12" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StudyInputs({ record }: { record: VisualRun }) {
  const f = (v: number, d: number) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const rows: [string, string][] = [
    ["Engine", `${record.engine_name} (${record.engine})`],
    ["Tank", `${record.tank.node} · ${record.tank.fluid.toUpperCase()} · ${f(record.tank.volume * 1000, 2)} L`],
    ["Fill at start", `${f(record.tank.fill0 * 100, 0)} %`],
    ["Attitude", record.attitude === "run" ? `Replay of ${record.replay_run ?? "a flight run"}` : "Scripted tilt (static stand)"],
    ["Duration", `${f(record.duration, 1)} s`],
    ["Burn time (engineering)", `${f(record.burn_time, 2)} s`],
    ["Run", record.run_id],
  ];
  return (
    <dl className="rw-vis-inputs" data-testid="visual.inputs">
      {rows.map(([k, v]) => (
        <div key={k} className="rw-eng__row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Leader labels (concept 06). */
export const LABELS: { id: AnchorId; text: string[]; lead: { dx: number; dy: number } }[] = [
  // The tank label clears the shell: a longer leader out to its right.
  { id: "liquid", text: ["Liquid propellant", "(forward tank)"], lead: { dx: 132, dy: -62 } },
  // The feed and inlet labels clear the shell's upper edge: leaders out past its silhouette.
  { id: "feed", text: ["Feed line"], lead: { dx: 96, dy: -58 } },
  { id: "inlet", text: ["Engine inlet"], lead: { dx: 104, dy: -22 } },
  { id: "nozzle", text: ["Engine nozzle"], lead: { dx: 30, dy: -24 } },
];

/** Probe for e2e and captures (read-only): the stage's GPU facts, stats, and a GPU readback. */
export interface FluidProbe {
  state: "loading" | "ready" | "error";
  error: string | null;
  gpu: GpuInfo | null;
  runId: string | null;
  provenance: string | null;
  layers: StageLayers;
  stats: () => StageStats | null;
  readback: () => Promise<FluidReadback | null>;
  resetStats: () => void;
  /** PNG (base64) of the next rendered frame at `w` x `h` (bar motion clips; the canvas only, no DOM labels). */
  snapshot: (w: number, h: number) => Promise<string>;
}

declare global {
  interface Window {
    __rwFluid?: FluidProbe;
  }
}

/** The studio light pool's gradient (page 01, `viewport/stage.ts`). */
const POOL_BACKGROUND = poolCss();

/** Gap between a leader's end and its label. */
const LEAD_GAP = 6;

/** The viewport background's top and bottom colours (tokens). */
function viewportBg(el: Element | null): readonly [string, string] {
  const css = getComputedStyle(el ?? document.body);
  return [css.getPropertyValue("--rw-bg-viewport-top").trim() || "#22282c", css.getPropertyValue("--rw-bg-viewport-bottom").trim() || "#171c20"];
}

/** Thumbnail size (2x the agent card's picture) and the zoom about the canvas centre (tank bottom, feed line, engine). */
const THUMB = { w: 192, h: 132, zoom: 1.6 } as const;
/** Tank chip picture (2x the chip's 18 x 22 thumbnail). */
const TANK_THUMB = { w: 36, h: 44 } as const;

/** The tank's aft section, fore end up (what the `@` chip's picture frames). */
function tankFit(record: VisualRun): SnapshotFit {
  const L = record.tank.length;
  return { from: [-0.36 * L, 0, 0], to: [L / 2 + 0.1 * record.tank.od, 0, 0], fill: 0.92 };
}
/** Frames rendered before the thumbnail (the liquid settles first). */
const THUMB_AFTER_FRAMES = 90;

function FluidViewport({
  record,
  transport,
  layers,
  options,
  onThumb,
  onTankThumb,
}: {
  record: VisualRun;
  transport: TransportStore;
  layers: StageLayers;
  options: StageOptions;
  onThumb?: (png: string) => void;
  onTankThumb?: (png: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const labelRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const gizmo = useRef<SVGGElement>(null);
  const pool = useRef<HTMLDivElement>(null);
  const stageRef = useRef<FluidStage | null>(null);
  const [status, setStatus] = useState<{ state: "loading" | "ready" | "error"; error: string | null; gpu: GpuInfo | null }>({ state: "loading", error: null, gpu: null });
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const recordRef = useRef(record);
  recordRef.current = record;

  useEffect(() => {
    let disposed = false;
    const c = canvas.current;
    if (!c) return;
    let stage: FluidStage | null = null;
    let ro: ResizeObserver | null = null;
    const record0 = recordRef.current;
    void FluidStage.create(c, record0, clockOf(transport), options).then(
      (s) => {
        if (disposed) {
          s.dispose();
          return;
        }
        stage = s;
        stageRef.current = s;
        // The study may have changed while the stage started.
        if (recordRef.current !== record0) s.setRun(recordRef.current);
        s.setLayers(layersRef.current);
        const fit = () => {
          const r = host.current?.getBoundingClientRect();
          if (r) s.resize(r.width, r.height);
        };
        fit();
        ro = new ResizeObserver(fit);
        if (host.current) ro.observe(host.current);
        s.setOverlayListener((o) => drawOverlay(o));
        s.start();
        setStatus({ state: "ready", error: null, gpu: s.gpu });
      },
      (e: unknown) => {
        if (!disposed) setStatus({ state: "error", error: message(e), gpu: null });
      },
    );
    return () => {
      disposed = true;
      ro?.disconnect();
      stage?.dispose();
      stageRef.current = null;
    };
    // One stage per mounted viewport; study changes go through setRun.
  }, [transport]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    stageRef.current?.setRun(record);
  }, [record]);

  useEffect(() => {
    stageRef.current?.setLayers(layers);
  }, [layers]);

  // One section view picture per mount (when asked): every layer on, after the liquid has settled.
  const thumbRef = useRef(onThumb);
  thumbRef.current = onThumb;
  const tankThumbRef = useRef(onTankThumb);
  tankThumbRef.current = onTankThumb;
  const allOn = status.state === "ready" && layers.shell && layers.section && layers.flow;
  const wantThumb = allOn && (onThumb !== undefined || onTankThumb !== undefined);
  useEffect(() => {
    if (!wantThumb) return;
    let live = true;
    const timer = window.setInterval(() => {
      const stage = stageRef.current;
      if (!stage || stage.stats().frames < THUMB_AFTER_FRAMES) return;
      window.clearInterval(timer);
      const bg = viewportBg(canvas.current);
      void (async () => {
        if (thumbRef.current) {
          const png = await stage.snapshot(THUMB.w, THUMB.h, bg, THUMB.zoom);
          if (live && png !== "") thumbRef.current?.(png);
        }
        if (live && tankThumbRef.current) {
          const png = await stage.snapshot(TANK_THUMB.w, TANK_THUMB.h, bg, 1, tankFit(recordRef.current));
          if (live && png !== "") tankThumbRef.current?.(png);
        }
      })();
    }, 250);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [wantThumb]);

  useEffect(() => {
    window.__rwFluid = {
      state: status.state,
      error: status.error,
      gpu: status.gpu,
      runId: record.run_id,
      provenance: record.provenance,
      layers,
      stats: () => stageRef.current?.stats() ?? null,
      readback: async () => (stageRef.current ? stageRef.current.readback() : null),
      resetStats: () => stageRef.current?.resetStats(),
      snapshot: async (w, h) => (stageRef.current ? stageRef.current.snapshot(w, h, viewportBg(canvas.current)) : ""),
    };
  }, [status, record, layers]);

  /** Positions the leader labels and the gizmo from the stage's projected anchors (DOM, every frame). */
  function drawOverlay(o: StageOverlay): void {
    const show = layersRef.current.labels;
    const pl = pool.current;
    if (pl) {
      const p = o.pool;
      pl.style.visibility = p ? "visible" : "hidden";
      if (p) {
        pl.style.left = `${(p.x - p.rx).toFixed(1)}px`;
        pl.style.top = `${(p.y - p.ry).toFixed(1)}px`;
        pl.style.width = `${(2 * p.rx).toFixed(1)}px`;
        pl.style.height = `${(2 * p.ry).toFixed(1)}px`;
        pl.style.transform = `rotate(${p.angleDeg.toFixed(2)}deg)`;
      }
    }
    const lines = svg.current?.querySelectorAll<SVGPolylineElement>("polyline[data-anchor]") ?? [];
    for (const l of lines) {
      const id = l.dataset["anchor"] as AnchorId;
      const p = o.anchors[id];
      const label = labelRefs.current[id];
      if (!p || !show) {
        l.setAttribute("visibility", "hidden");
        if (label) label.style.visibility = "hidden";
        continue;
      }
      const [x, y] = p;
      const lead = LABELS.find((x) => x.id === id)?.lead ?? { dx: 30, dy: -24 };
      l.setAttribute("visibility", "visible");
      l.setAttribute("points", `${x.toFixed(1)},${y.toFixed(1)} ${(x + lead.dx).toFixed(1)},${(y + lead.dy).toFixed(1)}`);
      if (label) {
        label.style.visibility = "visible";
        label.style.transform = `translate(${(x + lead.dx + LEAD_GAP).toFixed(1)}px, calc(${(y + lead.dy).toFixed(1)}px - 50%))`;
        label.dataset["x"] = x.toFixed(1);
        label.dataset["y"] = y.toFixed(1);
      }
    }
    const g = gizmo.current;
    if (g) {
      for (const a of o.axes) {
        const line = g.querySelector<SVGLineElement>(`line[data-axis="${a.axis}"]`);
        const text = g.querySelector<SVGTextElement>(`text[data-axis="${a.axis}"]`);
        const len = 22;
        const x2 = 32 + a.x * len;
        const y2 = 32 + a.y * len;
        line?.setAttribute("x2", x2.toFixed(1));
        line?.setAttribute("y2", y2.toFixed(1));
        text?.setAttribute("x", (32 + a.x * (len + 8)).toFixed(1));
        text?.setAttribute("y", (32 + a.y * (len + 8) + 4).toFixed(1));
      }
    }
  }

  return (
    <div
      className="rw-vis-viewport"
      ref={host}
      data-testid="visual.viewport"
      data-state={status.state}
      data-backend={status.gpu?.backend ?? ""}
      data-fallback-adapter={String(status.gpu?.isFallbackAdapter ?? "")}
      data-section={layers.section}
      data-flow={layers.flow}
    >
      <div ref={pool} className="rw-vis-pool" data-testid="visual.light-pool" aria-hidden style={{ visibility: "hidden", background: POOL_BACKGROUND }} />
      <canvas ref={canvas} className="rw-vis-viewport__canvas" data-testid="visual.canvas" />
      <svg ref={svg} className="rw-vis-overlay" aria-hidden>
        {LABELS.map((l) => (
          <polyline key={l.id} data-anchor={l.id} className="rw-vis-leader" points="0,0 0,0" visibility="hidden" />
        ))}
      </svg>
      {LABELS.map((l) => (
        <div
          key={l.id}
          ref={(el) => {
            labelRefs.current[l.id] = el;
          }}
          className="rw-vis-label"
          data-testid="visual.label"
          data-label={l.id}
          style={{ visibility: "hidden" }}
        >
          {l.text.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      ))}
      <div className="rw-vis-legend" data-testid="visual.legend">
        <span className="rw-vis-legend__title">Illustrative flow preview</span>
        <span className="rw-vis-legend__bar" style={{ background: `linear-gradient(90deg, ${FLUID_TEAL}, #8fd3d0)` }} />
        <span className="rw-vis-legend__ends">
          <span>Low</span>
          <span>High</span>
        </span>
      </div>
      <svg className="rw-vis-gizmo" width={64} height={64} viewBox="0 0 64 64" data-testid="visual.gizmo" aria-label="Body axes">
        <g ref={gizmo}>
          {(
            [
              ["X", "#e5484d"],
              ["Y", "#46a758"],
              ["Z", "#3e8ed0"],
            ] as const
          ).map(([a, c]) => (
            <g key={a}>
              <line data-axis={a} x1={32} y1={32} x2={32} y2={32} stroke={c} strokeWidth={1.6} strokeLinecap="round" />
              <text data-axis={a} x={32} y={32} fill={c} fontSize={10} textAnchor="middle">
                {a}
              </text>
            </g>
          ))}
        </g>
      </svg>
      {status.state === "error" && (
        <p className="rw-vis-viewport__error" data-testid="visual.gpu-error">
          {status.error}
        </p>
      )}
    </div>
  );
}
