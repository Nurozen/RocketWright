/**
 * Propulsion > Liquid propulsion design (concept 05, M4.7). Slots the shell
 * places: the workspace (title, Assembly | System | Properties, the
 * procedural 3D module, the connectivity diagram, the inspector), the rail's
 * `Propulsion system` categories with eye toggles, and the agent pane's
 * `Missing inputs · N` row plus the thread's design history.
 *
 * Data: the engine's evaluated feed graph from the project snapshot
 * (`EvaluatedModel.engines`), the check report's liquid diagnostics
 * (RW-W200-W249: the missing-inputs badge), and the sidecar's
 * `engine_design` over RPC (`engine.design`: sizing, injector, tanks,
 * assumptions) for the bell and the Properties tables. One selection:
 * `rw:eng/<engine>/feed/node/<id>` or `.../feed/edge/<i>` (C §5.1).
 */
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { RwRef } from "@rw/contracts";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { Icon } from "../../shell/Icon.tsx";
import type { RpcLike } from "../../state/rpc.ts";
import { useAppState, type AppStore } from "../../state/index.ts";
import { AssemblyViewport } from "../../viewport/AssemblyViewport.tsx";
import type { EngineState, FitMargin } from "../../viewport/engine.ts";
import type { GlbDeps } from "../../viewport/glb-source.ts";
import * as THREE from "three/webgpu";
import type { AssemblyModel } from "../../viewport/scene.ts";
import { cameraBasis, type ViewPose } from "../../viewport/views.ts";
import { ThreadHistory, useOpenThreadHistory } from "../components/AgentExtras.tsx";
import { ConnectivityDiagram } from "./Diagram.tsx";
import {
  CATEGORIES,
  bcLabel,
  categoryOfTarget,
  categoryTarget,
  connectionOf,
  diagramLayout,
  edgePart,
  edgeRef,
  engineIds,
  feedTarget,
  flowPaths,
  fluidLabel,
  fmt,
  hiddenKey,
  hiddenParts,
  inputRows,
  missingInputs,
  nodeIcon,
  nodeLabel,
  nodeRef,
  partOfTarget,
  pickEngine,
  propertyGroups,
  refOfPart,
  sourceRefs,
  type AnalysisState,
  type CategoryId,
  type Connection,
  type Diagnostic,
  type EngineDesignOut,
  type EvalEngine,
  type FeedTarget,
  type InputRow,
} from "./model.ts";
import { buildLiquidScene, type LiquidScene } from "./scene3d.ts";
import "./liquid.css";

export const LIQUID_TABS = [
  { id: "assembly", label: "Assembly" },
  { id: "system", label: "System" },
  { id: "properties", label: "Properties" },
] as const;
export type LiquidTab = (typeof LIQUID_TABS)[number]["id"];
export const isLiquidTab = (t: string | null | undefined): t is LiquidTab => LIQUID_TABS.some((x) => x.id === t);

export const INSPECTOR_TABS = [
  { id: "connection", label: "Selected connection" },
  { id: "inputs", label: "Inputs" },
  { id: "assumptions", label: "Assumptions" },
] as const;
export type InspectorTab = (typeof INSPECTOR_TABS)[number]["id"];

export interface LiquidUi {
  /** The engine last shown (kept when the selection clears). */
  engine: string | null;
  inspectorTab: InspectorTab;
  sourcesOpen: boolean;
  /** `engine_design` per engine and model hash. */
  design: { key: string; state: "loading" | "ready" | "error"; out: EngineDesignOut | null; error?: string } | null;
  /** The blowdown analysis per engine (`engine.simulate`). */
  analysis: Record<string, AnalysisState>;
}

export type LiquidStore = StoreApi<LiquidUi>;

export function createLiquidUi(): LiquidStore {
  return createStore<LiquidUi>()(() => ({ engine: null, inspectorTab: "connection", sourcesOpen: false, design: null, analysis: {} }));
}

export interface LiquidSlots {
  content: ReactNode;
  nav: ReactNode;
  agentExtra: ReactNode;
}

export function liquidSlots(store: AppStore, client: RpcLike | null, glbDeps: GlbDeps, ui: LiquidStore = createLiquidUi()): LiquidSlots {
  return {
    content: <LiquidWorkspace store={store} client={client} glbDeps={glbDeps} ui={ui} />,
    nav: <PropulsionTree store={store} ui={ui} />,
    agentExtra: <LiquidAgentExtra store={store} ui={ui} />,
  };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface EngineView {
  id: string;
  engine: EvalEngine;
  target: FeedTarget | null;
  connection: Connection | null;
  missing: Diagnostic[];
}

/** The engine on screen, the selected feed entity, its connection, and the engine's missing inputs. */
function useEngineView(store: AppStore, ui: LiquidStore): EngineView | null {
  const engines = useAppState(store, (s) => s.project.snapshot?.evaluated?.engines ?? null);
  const diagnostics = useAppState(store, (s) => s.project.snapshot?.check?.diagnostics ?? null);
  const refs = useAppState(store, (s) => s.selection.refs);
  const preferred = useStore(ui, (s) => s.engine);
  const designOut = useStore(ui, (s) => s.design?.out ?? null);
  const ids = useMemo(() => engineIds(engines as Record<string, unknown> | null), [engines]);
  const id = pickEngine(ids, refs, preferred);
  useEffect(() => {
    if (id !== null && id !== preferred) ui.setState({ engine: id });
  }, [id, preferred, ui]);
  return useMemo(() => {
    if (id === null || !engines) return null;
    const engine = (engines as Record<string, EvalEngine | undefined>)[id];
    if (!engine) return null;
    const target = refs.map(feedTarget).find((t): t is FeedTarget => t !== null && t.engine === id) ?? null;
    const connection = connectionOf(engine, target);
    // The check report owns the badge; before the first check, the design's own diagnostics stand in.
    const diags = diagnostics ?? (designOut?.engine === id ? designOut.diagnostics : null);
    return { id, engine, target, connection, missing: missingInputs(diags as Diagnostic[] | null, id) };
  }, [id, engines, refs, diagnostics, designOut]);
}

/** `engine.design` for the engine on screen, refetched when the model changes. */
function useEngineDesign(store: AppStore, client: RpcLike | null, ui: LiquidStore, engineId: string | null): void {
  const projectId = useAppState(store, (s) => s.project.projectId);
  const hash = useAppState(store, (s) => s.project.snapshot?.evaluated?.model_hash ?? "");
  const key = `${engineId ?? ""}@${hash}`;
  useEffect(() => {
    const cur = ui.getState().design;
    if (client === null || projectId === null || engineId === null || (cur?.key === key && cur.state !== "error")) return;
    ui.setState({ design: { key, state: "loading", out: cur?.key.startsWith(`${engineId}@`) ? cur.out : null } });
    // Only the newest request lands (the key moves on with the engine and the model).
    client
      .call("engine.design", { projectId, engine: engineId })
      .then((out) => ui.getState().design?.key === key && ui.setState({ design: { key, state: "ready", out } }))
      .catch((e: unknown) => ui.getState().design?.key === key && ui.setState({ design: { key, state: "error", out: null, error: message(e) } }));
  }, [client, projectId, engineId, key, ui]);
}

/**
 * The studio floor sits just under the module's lowest point (the nozzle
 * exit): the bell gets a contact shadow and the tanks a broad soft shade
 * round it, as page 01's stage (FID-03-05).
 */
export function liquidFloor(all: THREE.Box3): number {
  return all.min.y - 0.015 * (all.max.y - all.min.y);
}

/** The contact shadow's softness scales with the largest tank's radius (not the module's height). */
export function liquidShadowRadius(model: AssemblyModel): number {
  const b = new THREE.Box3();
  const s = new THREE.Vector3();
  let r = 0;
  for (const p of model.parts.values()) {
    if (p.kind !== "tank") continue;
    model.partBounds(p.id, b);
    if (!b.isEmpty()) r = Math.max(r, Math.min(b.getSize(s).y, b.getSize(s).z) / 2);
  }
  return r > 0 ? r : 0.05;
}

/** Page 05 fills its viewport (the three leader labels sit beside the parts, not in a right-hand column). */
export const LIQUID_FIT_MARGIN: FitMargin = { left: 24, top: 10, right: 24, bottom: 56, labelRoom: 0 };

/** The module's own Iso: from the front, a little right and above, aft down (concept 05). */
export function liquidPose(view: string): ViewPose {
  switch (view) {
    case "top":
      return { dir: [0, 1, 0], up: [0, 0, -1] };
    case "side":
      return { dir: [1, 0, 0], up: [0, 1, 0] };
    case "front":
      return { dir: [0, 0, 1], up: [0, 1, 0] };
    case "rear":
      return { dir: [0, 0, -1], up: [0, 1, 0] };
    default: {
      const d = Math.hypot(0.32, 0.62, 1);
      const dir: [number, number, number] = [0.32 / d, 0.62 / d, 1 / d];
      const b = cameraBasis({ dir, up: [0, 1, 0] });
      return { dir, up: [b.up[0], b.up[1], b.up[2]] };
    }
  }
}

function LiquidWorkspace({ store, client, glbDeps, ui }: { store: AppStore; client: RpcLike | null; glbDeps: GlbDeps; ui: LiquidStore }) {
  const view = useEngineView(store, ui);
  useEngineDesign(store, client, ui, view?.id ?? null);
  const tabRaw = useAppState(store, (s) => s.ui.tab);
  const tab: LiquidTab = isLiquidTab(tabRaw) ? tabRaw : "system";
  const snap = useAppState(store, (s) => s.project.snapshot);
  const design = useStore(ui, (s) => s.design);
  const out = design !== null && design.key.startsWith(`${view?.id ?? ""}@`) ? design.out : null;
  const setTab = (t: LiquidTab) => store.getState().ui.navigate("liquid", t);
  const ids = engineIds(snap?.evaluated?.engines as Record<string, unknown> | null | undefined);

  return (
    <div className="rw-liq" data-testid="liquid-page" data-engine={view?.id ?? ""} data-tab={tab}>
      <header className="rw-liq__head">
        <h1 className="rw-page-title" data-testid="page.title">
          Liquid propulsion
        </h1>
        {ids.length > 1 && view !== null && (
          <label className="rw-liq__engine">
            <span>Engine</span>
            <select
              data-testid="liquid.engine"
              value={view.id}
              onChange={(e) => {
                ui.setState({ engine: e.target.value });
                store.getState().selection.select([], "inspector");
              }}
            >
              {ids.map((id) => (
                <option key={id} value={id}>
                  {(snap?.evaluated?.engines as Record<string, EvalEngine | undefined> | undefined)?.[id]?.name ?? id}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>
      <nav className="rw-liq__tabs" role="tablist" aria-label="Liquid propulsion views">
        {LIQUID_TABS.map((t) => (
          <button key={t.id} type="button" role="tab" className="rw-tab rw-tab--editor" data-testid="propulsion.tab" data-group="page" data-tab={t.id} aria-selected={t.id === tab} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      {view === null ? (
        <p className="rw-liq__empty" data-testid="liquid.empty">
          {snap === null ? "Opening the project…" : "No liquid engine in this project. Add one under engines/<id>.rw.toml."}
        </p>
      ) : tab === "properties" ? (
        <PropertiesView view={view} out={out} state={design?.state ?? "loading"} error={design?.error} />
      ) : (
        <div className={`rw-liq__body rw-liq__body--${tab}`}>
          <ModuleViewport store={store} view={view} out={out} glbDeps={glbDeps} />
          {tab === "system" ? (
            <div className="rw-liq__lower">
              <ConnectivityDiagram
                layout={diagramLayout(view.engine)}
                target={view.target}
                connection={view.connection}
                onSelectNode={(id) => store.getState().selection.select([nodeRef(view.id, id)], "diagram")}
                onSelectEdge={(i) => store.getState().selection.select([edgeRef(view.id, i)], "diagram")}
              />
              <LiquidInspector store={store} client={client} ui={ui} view={view} out={out} />
            </div>
          ) : (
            <ParametersPanel view={view} />
          )}
        </div>
      )}
    </div>
  );
}

/** The 3D module: rebuilt per engine, model, and sizing; the selected connection glows teal. */
function ModuleViewport({ store, view, out, glbDeps }: { store: AppStore; view: EngineView; out: EngineDesignOut | null; glbDeps: GlbDeps }) {
  const ui = useAppState(store, (s) => s.ui);
  const hash = useAppState(store, (s) => s.project.snapshot?.evaluated?.model_hash ?? "");
  const sizing = out?.design?.sizing ?? null;
  const sceneRef = useRef<LiquidScene | null>(null);
  const engineRef = useRef(view.engine);
  engineRef.current = view.engine;
  const sizingRef = useRef(sizing);
  sizingRef.current = sizing;
  const key = `${view.id}@${hash}:${sizing ? sizing.throat_diameter.toFixed(6) : "none"}`;
  const build = useCallback((): AssemblyModel => {
    const scene = buildLiquidScene(engineRef.current, sizingRef.current as Parameters<typeof buildLiquidScene>[1]);
    sceneRef.current = scene;
    return scene.model;
  }, []);
  const conn = view.connection;
  const glow = useMemo(() => (conn?.edges ?? []).map(edgePart), [conn]);
  const selected = useMemo(() => {
    const t = view.target;
    if (t === null) return [];
    if (t.kind === "edge") return glow;
    const p = partOfTarget(t);
    return p === null ? [] : [p];
  }, [view.target, glow]);
  const hidden = useMemo(() => hiddenParts(view.engine, ui.hidden), [view.engine, ui.hidden]);
  const state: EngineState = useMemo(
    () => ({ view: ui.view, explode: 0, section: false, showInternals: false, shadows: ui.shadows, hidden, selected }),
    [ui.view, ui.shadows, hidden, selected],
  );
  useEffect(() => sceneRef.current?.setGlow(glow), [glow]);
  useEffect(() => sceneRef.current?.setHidden(hidden), [hidden]);
  // Leader labels: Storage (the first tank), Feed (a line of the selected connection), Engine.
  const labels = useMemo(() => {
    const paths = flowPaths(view.engine);
    const m = new Map<string, string>();
    const tank = paths[0]?.tank ?? Object.keys(view.engine.nodes).find((k) => view.engine.nodes[k]?.kind === "tank");
    if (tank) m.set(tank, "Storage");
    const feed = conn?.edges.find((i) => paths.some((p) => p.edges.includes(i))) ?? paths[0]?.edges.at(-1);
    if (feed !== undefined) m.set(edgePart(feed), "Feed");
    const eng = Object.keys(view.engine.nodes).find((k) => view.engine.nodes[k]?.kind === "engine");
    if (eng) m.set(eng, "Engine");
    return m;
  }, [view.engine, conn]);
  const only = useMemo(() => new Set(labels.keys()), [labels]);
  return (
    <div className="rw-liq__viewport">
      <AssemblyViewport
        state={state}
        evaluated={null}
        glbDeps={glbDeps}
        modelKey={key}
        buildModel={build}
        labelNames={labels}
        labelOnly={only}
        pose={liquidPose}
        floor={liquidFloor}
        shadowOpacity={0.55}
        fitMargin={LIQUID_FIT_MARGIN}
        shadowRadius={liquidShadowRadius}
        lightPool
        onModel={() => {
          sceneRef.current?.setGlow(glow);
          sceneRef.current?.setHidden(hidden);
        }}
        ariaLabel="Liquid propulsion module"
        onPick={(part) => store.getState().selection.select(part === null ? [] : [refOfPart(view.id, part)], "viewport")}
      />
    </div>
  );
}

// ---- inspector -------------------------------------------------------------------------

const TONE_ICON = { warn: "alert", ok: "check-circle", info: "info" } as const;
/** One shared value: a fresh object per read would make the store selector unstable. */
const NOT_RUN: AnalysisState = { kind: "not_run" };

function InputStatus({ row, action = null }: { row: InputRow; action?: ReactNode }) {
  return (
    <div className="rw-liq-input" data-testid="insp.input" data-key={row.key} data-tone={row.tone} title={row.diagnostic ? `${row.diagnostic.code}: ${row.diagnostic.message}${row.diagnostic.hint ? ` (${row.diagnostic.hint})` : ""}` : undefined}>
      <span className="rw-liq-input__label">{row.label}</span>
      <span className="rw-liq-input__value">
        {row.value}
        {action}
      </span>
      <span className="rw-liq-input__icon" data-tone={row.tone}>
        <Icon name={TONE_ICON[row.tone]} size={18} label={row.tone === "warn" ? "Missing" : row.tone === "ok" ? "Set" : "Information"} />
      </span>
    </div>
  );
}

function Endpoint({ view, ids }: { view: EngineView; ids: readonly string[] }) {
  if (ids.length === 0) return <span className="rw-liq-conn__value">—</span>;
  return (
    <span className="rw-liq-conn__value">
      {ids.map((id) => (
        <span key={id} className="rw-liq-conn__end">
          <Icon name={nodeIcon(view.engine.nodes[id]?.kind)} size={20} />
          {nodeLabel(id)}
        </span>
      ))}
    </span>
  );
}

function LiquidInspector({ store, client, ui, view, out }: { store: AppStore; client: RpcLike | null; ui: LiquidStore; view: EngineView; out: EngineDesignOut | null }) {
  const tab = useStore(ui, (s) => s.inspectorTab);
  const sourcesOpen = useStore(ui, (s) => s.sourcesOpen);
  const analysis = useStore(ui, (s) => s.analysis[view.id] ?? NOT_RUN);
  const projectId = useAppState(store, (s) => s.project.projectId);
  const rows = inputRows(view.engine, view.id, view.missing, view.connection, analysis);
  const blocked = view.missing.length > 0;
  const runAnalysis = () => {
    if (client === null || projectId === null || blocked) return;
    ui.setState((s) => ({ analysis: { ...s.analysis, [view.id]: { kind: "running" } } }));
    client
      .call("engine.simulate", { projectId, engine: view.id })
      .then((r) => {
        const b = out?.design?.blowdown;
        const summary = b ? `${fmt(b.burn_time, 3)} s burn` : `run ${r.run_id}`;
        ui.setState((s) => ({ analysis: { ...s.analysis, [view.id]: { kind: "complete", summary } } }));
      })
      .catch((e: unknown) => ui.setState((s) => ({ analysis: { ...s.analysis, [view.id]: { kind: "failed", message: message(e) } } })));
  };
  return (
    <section className="rw-liq-insp" data-rw-region="propulsion-inspector" data-testid="propulsion-inspector" data-tab={tab}>
      <nav className="rw-liq-insp__tabs" role="tablist" aria-label="Inspector">
        {INSPECTOR_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className="rw-liq-insp__tab"
            data-testid="propulsion.tab"
            data-group="inspector"
            data-tab={t.id}
            aria-selected={t.id === tab}
            onClick={() => ui.setState({ inspectorTab: t.id })}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="rw-liq-insp__body">
        {tab === "connection" && (
          <>
            <dl className="rw-liq-conn" data-testid="insp.connection" data-from={view.connection?.from.join(",") ?? ""} data-to={view.connection?.to.join(",") ?? ""}>
              <div className="rw-liq-conn__row">
                <dt>From</dt>
                <dd>
                  <Endpoint view={view} ids={view.connection?.from ?? []} />
                </dd>
              </div>
              <div className="rw-liq-conn__row">
                <dt>To</dt>
                <dd>
                  <Endpoint view={view} ids={view.connection?.to ?? []} />
                </dd>
              </div>
            </dl>
            {view.connection === null && <p className="rw-liq-insp__hint">Select a line, tank, or valve in the diagram or the 3D view.</p>}
            <div className="rw-liq-inputs">
              {rows.map((r) =>
                r.key === "analysis" ? (
                  <div key={r.key} className="rw-liq-analysis" data-testid="propulsion.analysis" data-blocked={blocked ? "true" : "false"} data-state={analysis.kind}>
                    <InputStatus
                      row={r}
                      action={
                        !blocked && analysis.kind !== "complete" ? (
                          <button type="button" className="rw-liq-analysis__run" data-testid="propulsion.run-analysis" disabled={client === null || analysis.kind === "running"} onClick={runAnalysis}>
                            Run
                          </button>
                        ) : null
                      }
                    />
                  </div>
                ) : (
                  <InputStatus key={r.key} row={r} />
                ),
              )}
            </div>
            {blocked && (
              <p className="rw-liq-insp__blocked" data-testid="propulsion.analysis-blocked">
                Analysis is blocked until the {view.missing.length === 1 ? "missing input is" : `${view.missing.length} missing inputs are`} set.
              </p>
            )}
          </>
        )}
        {tab === "inputs" && <InputsList view={view} />}
        {tab === "assumptions" && <AssumptionsList out={out} />}
      </div>
      <button type="button" className="rw-liq-sources" data-testid="insp.source-references" aria-expanded={sourcesOpen} onClick={() => ui.setState({ sourcesOpen: !sourcesOpen })}>
        <Icon name="document" size={20} />
        <span>Source references</span>
        <Icon name={sourcesOpen ? "chevron-up" : "chevron-right"} size={18} />
      </button>
      {sourcesOpen && <SourceList thermo={out?.design?.thermo ?? null} />}
    </section>
  );
}

function SourceList({ thermo }: { thermo: string | null }) {
  return (
    <ul className="rw-liq-sources__list" data-testid="insp.source-list">
      {sourceRefs(thermo).map((s) => (
        <li key={s.id} data-source={s.id}>
          <a href={s.url} target="_blank" rel="noreferrer" data-testid="insp.source-link">
            {s.title}
          </a>
          <span>{s.detail}</span>
        </li>
      ))}
    </ul>
  );
}

const q = (v: number | null | undefined, scale: number, unit: string, sig = 4) => (v == null ? "Not set" : `${fmt(v * scale, sig)} ${unit}`.trim());

/** The engine's own inputs (source model), the selected connection's lines, with unset ones flagged. */
function InputsList({ view }: { view: EngineView }) {
  const e = view.engine;
  const missing = new Set(view.missing.map((d) => d.path));
  const p = `/engines/${view.id}`;
  const rows: { key: string; label: string; value: string; warn: boolean }[] = [
    { key: "propellants", label: "Propellants", value: `${fluidLabel(e.oxidizer)} / ${fluidLabel(e.fuel)}`, warn: false },
    { key: "mixture_ratio", label: "Mixture ratio O/F", value: fmt(e.mixture_ratio, 3), warn: false },
    { key: "chamber_pressure", label: "Chamber pressure", value: q(e.chamber_pressure, 1e-5, "bar", 3), warn: false },
    { key: "thrust", label: "Thrust", value: q(e.thrust, 1, "N"), warn: false },
    { key: "expansion_ratio", label: "Expansion ratio", value: e.expansion_ratio == null ? "Not set" : fmt(e.expansion_ratio, 3), warn: missing.has(`${p}/expansion_ratio`) },
    { key: "l_star", label: "L*", value: q(e.l_star, 1, "m", 3), warn: missing.has(`${p}/l_star`) },
    { key: "fluid_model", label: "Fluid model", value: e.fluid_model ? e.fluid_model.replace(/_/g, " ") : "Not selected", warn: missing.has(`${p}/fluid_model`) },
  ];
  const edges = view.connection?.edges ?? e.edges.map((_, i) => i);
  return (
    <div className="rw-liq-list" data-testid="insp.inputs">
      <dl>
        {rows.map((r) => (
          <div key={r.key} className="rw-liq-list__row" data-key={r.key} data-warn={r.warn ? "true" : undefined}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
      <h3 className="rw-liq-list__title">Lines</h3>
      <dl>
        {edges.map((i) => {
          const ed = e.edges[i]!;
          return (
            <div key={i} className="rw-liq-list__row" data-key={`edge.${i}`} data-warn={missing.has(`${p}/feed/edge/${i}/bc`) ? "true" : undefined}>
              <dt>
                {nodeLabel(ed.from)} → {nodeLabel(ed.to)}
              </dt>
              <dd>
                {bcLabel(ed.bc)} · {q(ed.diameter, 1000, "mm", 3)} · {q(ed.length, 1, "m", 3)}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function AssumptionsList({ out }: { out: EngineDesignOut | null }) {
  const items = out?.design?.assumptions ?? [];
  return (
    <ul className="rw-liq-assumptions" data-testid="insp.assumptions">
      {items.length === 0 ? <li>Computed with the design (engine_design).</li> : items.map((a) => <li key={a}>{a}</li>)}
    </ul>
  );
}

/** Assembly tab: the module large, with the engine and tank parameters beside it. */
function ParametersPanel({ view }: { view: EngineView }) {
  const e = view.engine;
  const tanks = Object.entries(e.nodes).filter(([, n]) => n?.kind === "tank");
  return (
    <aside className="rw-liq-params" data-testid="liquid.parameters">
      <h2 className="rw-liq-panel__title">Engine</h2>
      <dl>
        <div className="rw-liq-list__row">
          <dt>Propellants</dt>
          <dd>
            {fluidLabel(e.oxidizer)} / {fluidLabel(e.fuel)}
          </dd>
        </div>
        <div className="rw-liq-list__row">
          <dt>Thrust</dt>
          <dd>{q(e.thrust, 1, "N")}</dd>
        </div>
        <div className="rw-liq-list__row">
          <dt>Chamber pressure</dt>
          <dd>{q(e.chamber_pressure, 1e-5, "bar", 3)}</dd>
        </div>
        <div className="rw-liq-list__row">
          <dt>Mixture ratio O/F</dt>
          <dd>{fmt(e.mixture_ratio, 3)}</dd>
        </div>
      </dl>
      {tanks.map(([id, n]) => (
        <div key={id} data-testid="liquid.tank" data-node={id}>
          <h2 className="rw-liq-panel__title">
            {nodeLabel(id)} · {fluidLabel(n?.fluid)}
          </h2>
          <dl>
            <div className="rw-liq-list__row">
              <dt>Volume</dt>
              <dd>{q(n?.tank?.volume ?? n?.volume, 1000, "L", 3)}</dd>
            </div>
            <div className="rw-liq-list__row">
              <dt>Length × diameter</dt>
              <dd>
                {q(n?.tank?.length, 1000, "", 4)} × {q(n?.tank?.od, 1000, "mm", 4)}
              </dd>
            </div>
            <div className="rw-liq-list__row">
              <dt>Pressure</dt>
              <dd>
                {q(n?.pressure, 1e-5, "bar", 3)} · {fluidLabel(n?.pressurant)}
              </dd>
            </div>
          </dl>
        </div>
      ))}
    </aside>
  );
}

function PropertiesView({ view, out, state, error }: { view: EngineView; out: EngineDesignOut | null; state: "loading" | "ready" | "error"; error?: string | undefined }) {
  const groups = propertyGroups(out);
  return (
    <div className="rw-liq-props" data-testid="liquid.properties" data-state={state}>
      {state === "error" && <p className="rw-liq__empty">engine_design failed: {error}</p>}
      {state === "loading" && groups.length === 0 && <p className="rw-liq__empty">Computing the design…</p>}
      {out !== null && groups.length === 0 && <p className="rw-liq__empty">The chamber cannot be sized yet: {out.missing_inputs.join(", ") || "inputs missing"}.</p>}
      <div className="rw-liq-props__grid">
        {groups.map((g) => (
          <section key={g.id} className="rw-liq-props__group" data-testid="props.group" data-group={g.id}>
            <h2 className="rw-liq-panel__title">{g.title}</h2>
            <dl>
              {g.rows.map((r) => (
                <div key={r.key} className="rw-liq-list__row" data-testid="props.row" data-key={r.key}>
                  <dt>{r.label}</dt>
                  <dd>
                    {r.value}
                    {r.unit && <span className="rw-liq-unit"> {r.unit}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <footer className="rw-liq-props__foot" data-testid="props.provenance">
        Engineering · {out?.design?.thermo ?? "—"} · {view.missing.length > 0 ? `Missing inputs · ${view.missing.length} (feed, tanks, and blowdown wait on them)` : "inputs complete"}
      </footer>
      <section className="rw-liq-props__sources">
        <h2 className="rw-liq-panel__title">Source references</h2>
        <SourceList thermo={out?.design?.thermo ?? null} />
      </section>
    </div>
  );
}

// ---- rail ------------------------------------------------------------------------------

/** The `Propulsion system` rail section: categories with eye toggles; a row selects its first entity. */
export function PropulsionTree({ store, ui }: { store: AppStore; ui: LiquidStore }) {
  const view = useEngineView(store, ui);
  const hidden = useAppState(store, (s) => s.ui.hidden);
  const selected = view ? categoryOfTarget(view.engine, view.target) : null;
  const select = (c: CategoryId) => {
    if (!view) return;
    const ref: RwRef | null = categoryTarget(view.engine, view.id, c);
    if (ref !== null) store.getState().selection.select([ref], "tree");
  };
  return (
    <ul className="rw-list" role="listbox" aria-label="Propulsion system" data-testid="propulsion.tree">
      {CATEGORIES.map((c) => {
        const off = hidden.includes(hiddenKey(c.id));
        return (
          <li key={c.id} className="rw-nav-row" role="option" data-testid="rail.nav-row" data-category={c.id} data-hidden={off ? "true" : undefined} aria-selected={selected === c.id} onClick={() => select(c.id)}>
            <button
              type="button"
              className="rw-eye"
              data-testid="tree.eye"
              aria-label={`${off ? "Show" : "Hide"} ${c.label}`}
              aria-pressed={!off}
              onClick={(e) => {
                e.stopPropagation();
                store.getState().ui.toggleHidden(hiddenKey(c.id));
              }}
            >
              <Icon name={off ? "eye-off" : "eye"} size={18} />
            </button>
            <span className="rw-thumb" data-testid="rail.thumb">
              <Icon name={c.icon} size={20} className="rw-nav-row__part" />
            </span>
            <span className="rw-nav-row__label">{c.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

// ---- agent pane --------------------------------------------------------------------------

/** `⚠ Missing inputs · N` with Review inputs, and this thread's steps. */
export function LiquidAgentExtra({ store, ui }: { store: AppStore; ui: LiquidStore }) {
  const view = useEngineView(store, ui);
  // This thread's steps; the strip's current step is current here too (the list agrees with the history strip below).
  const items = useOpenThreadHistory(store);
  const missing = view?.missing ?? [];
  const review = () => {
    if (!view) return;
    // The first missing input's entity: its feed edge, else the engine's first flow path.
    const edge = missing.map((d) => /\/feed\/edge\/(\d+)\//.exec(d.path ?? "")?.[1]).find((x) => x !== undefined);
    const ref = edge !== undefined ? edgeRef(view.id, Number(edge)) : categoryTarget(view.engine, view.id, "feed");
    store.getState().ui.navigate("liquid", "system");
    ui.setState({ inspectorTab: "connection" });
    if (ref !== null) store.getState().selection.select([ref], "agent");
  };
  return (
    <>
      {missing.length > 0 && (
        <div className="rw-liq-missing" data-testid="agent.missing-inputs" data-count={missing.length} title={missing.map((d) => `${d.code}: ${d.message}`).join("\n")}>
          <Icon name="alert" size={22} className="rw-liq-missing__icon" />
          <span className="rw-liq-missing__text">Missing inputs · {missing.length}</span>
          <button type="button" className="rw-button rw-button--primary rw-liq-missing__review" data-testid="agent.review-inputs" onClick={review}>
            Review inputs
          </button>
        </div>
      )}
      <ThreadHistory
        items={items}
        onOpen={(seq) => {
          const keep = store.getState().selection.refs.filter((r) => r.startsWith("rw:eng/"));
          store.getState().selection.select([...keep, `rw:step/${seq}` as RwRef], "agent");
        }}
      />
    </>
  );
}
