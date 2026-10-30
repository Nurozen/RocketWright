/**
 * Page 01 viewport (M1.50): the assembly GLB in the render engine with leader
 * labels, the axis gizmo, click picking, and the presentation state from the
 * store. Store-agnostic: the page passes `state` and gets `onPick`.
 *
 * The region element carries the applied state as data attributes and
 * publishes a read-only probe on `window.__rwViewport` (pick, part screen
 * points, part offsets) so the e2e can drive real clicks on parts. The probe
 * reads state; it never seeds it (seeding is the I12 broker hooks).
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as THREE from "three/webgpu";
import type { EvaluatedModel } from "@rw/contracts";
import { applyDetail, defaultDetailRegistry, type DetailReportRow } from "../detail/registry.ts";
import { ViewportEngine, type EngineState, type ExplodeAnimState, type FitMargin, type PoolScreen, type RenderBackend } from "./engine.ts";
import { poolCss } from "./stage.ts";
import type { OutputProbe } from "./outputProbe.ts";
import { AXIS_COLORS, gizmoAxes, type GizmoAxis } from "./gizmo.ts";
import { applyCuts, cutAttrs } from "./cuts.ts";
import { glbModelHash, loadAssemblyGlb, type GlbDeps, type GlbSource } from "./glb-source.ts";
import { layoutLabels, type PlacedLabel, type Rect } from "./labels.ts";
import { clearActiveViewport, setActiveViewport, type ViewportController } from "./registry.ts";
import { AssemblyModel, SECTION_PLANE, type PartMeta } from "./scene.ts";
import { ASSEMBLY_SPACING } from "./explode.ts";
import { StillPanel } from "./StillPanel.tsx";
import type { StencilCapStats } from "../render/section.ts";
import type { ViewPose } from "./views.ts";

export interface AssemblyViewportProps {
  state: EngineState;
  evaluated: EvaluatedModel | null;
  glbDeps: GlbDeps;
  /** A click on a part (or a label); `null` for empty space. */
  onPick?: (id: string | null) => void;
  /** Width of overlays on the right edge (the inspector strip). */
  insetRight?: number;
  /**
   * Bottom edge (px from the viewport top) of the right-edge overlay, read
   * when the camera frames; the model may pass under it. Default: full height.
   */
  measureInsetHeight?: () => number | undefined;
  /** The `@` affordance on the selected part: send it to the chat composer. */
  onMention?: (id: string, label: string) => void;
  /**
   * Extra reload key for the GLB (the Compare view meshes a merged Old+New
   * model whose New hash alone does not change when Old does).
   */
  modelKey?: string;
  /** Label only these parts (Compare: the marked ones); default all. */
  labelOnly?: ReadonlySet<string> | null;
  /** Accessible name of the canvas. */
  ariaLabel?: string;
  /**
   * Builds the scene instead of meshing `evaluated` (page 05's procedural
   * module); rebuilt when `modelKey` changes.
   */
  buildModel?: () => AssemblyModel | Promise<AssemblyModel>;
  /** Label text per part (default: the component names). */
  labelNames?: ReadonlyMap<string, string>;
  /** The page's camera presets (default: the assembly presets). */
  pose?: (view: string, width: number, height: number) => ViewPose;
  /** The model on screen (after each rebuild). */
  onModel?: (model: AssemblyModel | null) => void;
  /** Contact-shadow floor (world y) from the visible bounds; default under the body. */
  floor?: (all: THREE.Box3, model: AssemblyModel) => number;
  /** Contact-shadow strength (default the studio's). */
  shadowOpacity?: number;
  /** Body radius (m) the contact shadow's softness scales with (default the assembly's body radius). */
  shadowRadius?: (model: AssemblyModel) => number;
  /** The page's fit margins (default the assembly's, with label room on the right). */
  fitMargin?: FitMargin;
  /** Draw the studio light pool under the model (default: the meshed assembly only). */
  lightPool?: boolean;
}

export interface ViewportProbeApi {
  /** Component id under a client point. */
  pickAt(clientX: number, clientY: number): string | null;
  /** A client point whose pick returns `id`, or null when the part is not pickable. */
  pointFor(id: string): { x: number; y: number } | null;
  /** World offset of a part's node (explode), or null. */
  partOffset(id: string): [number, number, number] | null;
  /** Unit vector from the orbit target to the camera. */
  cameraDir(): [number, number, number];
  visibleParts(): string[];
  /** Material opacity of a part (x-ray ghosting under Show internals). */
  opacity(id: string): number | null;
  /** Material colour of a part (`#rrggbb`), or null. */
  color(id: string): string | null;
  /** Compare marks in force (id → removed/changed/added); empty when not comparing. */
  marks(): Record<string, string>;
  /** Parts drawn with the teal selection outline. */
  outlined(): string[];
  shadowsOn(): boolean;
  /** Whether the section clipping group is active. */
  sectionOn(): boolean;
  backend(): RenderBackend;
  /** Visual-only detail builders applied per part (M3.0). */
  detail(): DetailReportRow[];
  /** Shadow and outline statistics on the final output (M3.1); null without a GPU pipeline. */
  probeOutput(): Promise<OutputProbe | null>;
  /** The broker's `viewport_render` capture (PNG base64 of the tone-mapped canvas over the vignette). */
  capture(width?: number, height?: number): { png_base64: string; width: number; height: number };
  /** The exploded-view tween (M3.2): shown factor, target, running, pinned, normalised time. */
  explodeAnim(): ExplodeAnimState;
  /**
   * Capture clock (M3.2): pins the explode tween at normalised time `t`
   * (deterministic clip frames), or releases it (`null`). It moves no app
   * state: the tween's end is the store's explode either way.
   */
  seekExplode(t: number | null): void;
  /** Screen centres of the visible parts (canvas px), for motion checks on captured clips. */
  screenCentres(): Record<string, [number, number]>;
  /** Unit screen direction (px, y down) of the body axis. */
  axisOnScreen(): [number, number];
  /** Each visible sequenced part's (with its followers') screen extent along the axis, in explode order (px). */
  axisIntervals(): { id: string; lo: number; hi: number }[];
  /** The dotted shared-axis segments drawn in the explode gaps (canvas px). */
  axisGaps(): [number, number, number, number][];
  /** GTAO on the final output (M3.1): pixels the AO term darkens; null without the pipeline. */
  probeAO(): Promise<{ darkened: number; meanDelta: number; maxDelta: number } | null>;
  /** Live section caps (M3.3): stencil writers and the cap quad. */
  sectionCaps(): StencilCapStats | null;
  /** Pixels the section cap draws on the final output (M3.3). */
  capPixels(): Promise<number | null>;
  /**
   * Still section cut (M3.3, manifold-3d) of each visible part's base
   * (engineering) meshes at the current explode: method and closed volumes
   * before/after the cut (m^3). Visual tier: a cut check, never mass (I13).
   */
  sectionStill(): Promise<Record<string, { method: string[]; bodyVolume: number; volume: number; capArea: number }>>;
}

declare global {
  interface Window {
    __rwViewport?: ViewportProbeApi;
  }
}

/** Explode factor from which internal parts are far enough out to label. */
const INTERNAL_LABEL_EXPLODE = 0.15;
const GIZMO_SIZE = 64;
/** Gap between the gizmo and the inspector strip. */
const GIZMO_GAP = 32;
const CLICK_SLOP_PX = 5;

/** The light pool's gradient (`stage.ts`). */
const POOL_BACKGROUND = poolCss();

/** Width reserved at the selected label's far end for the `@` button. */
const MENTION_SLOT = 26;

interface Overlay {
  labels: PlacedLabel[];
  gizmo: GizmoAxis[];
  /** Dotted shared-axis segments in the explode gaps (x1, y1, x2, y2). */
  axis: [number, number, number, number][];
  anim: ExplodeAnimState | null;
  /** The studio light pool under the model (backdrop layer), or null. */
  pool: PoolScreen | null;
}

interface Insets {
  right: number;
  height: number | undefined;
}

/** Screen keep-outs (viewport px): the inspector strip and the gizmo beside it. */
function occludersFor(w: number, h: number, inset: Insets): Rect[] {
  // The gizmo and the Render still button under it (M3.4).
  const out: Rect[] = [{ x: w - inset.right - GIZMO_GAP - GIZMO_SIZE - 8, y: 0, w: GIZMO_GAP + GIZMO_SIZE + 8, h: GIZMO_SIZE + 56 }];
  if (inset.right > 0) out.push({ x: w - inset.right - 8, y: 0, w: inset.right + 8, h: Math.min(h, inset.height ?? h) });
  return out;
}

export function AssemblyViewport({
  state,
  evaluated,
  glbDeps,
  onPick,
  onMention,
  insetRight = 0,
  measureInsetHeight,
  modelKey = "",
  labelOnly = null,
  ariaLabel = "Assembly view",
  buildModel,
  labelNames,
  pose,
  onModel,
  floor,
  shadowOpacity,
  fitMargin,
  lightPool,
  shadowRadius,
}: AssemblyViewportProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ViewportEngine | null>(null);
  const [backend, setBackend] = useState<RenderBackend>("pending");
  const [model, setModel] = useState<AssemblyModel | null>(null);
  const [source, setSource] = useState<GlbSource | null>(null);
  /** `modelKey` of the GLB on screen (Compare: Old>New hashes). */
  const [loadedKey, setLoadedKey] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay>({ labels: [], gizmo: [], axis: [], anim: null, pool: null });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [stillOpen, setStillOpen] = useState(false);
  const pool = lightPool ?? buildModel === undefined;
  const live = useRef({ state, evaluated, onPick, onMention, insetRight, measureInsetHeight, labelOnly, buildModel, onModel, pool });
  live.current = { state, evaluated, onPick, onMention, insetRight, measureInsetHeight, labelOnly, buildModel, onModel, pool };
  const insets = (): Insets => ({ right: live.current.insetRight, height: live.current.measureInsetHeight?.() });

  const componentNames = useMemo(() => new Map((evaluated?.components ?? []).map((c) => [c.id, c.name])), [evaluated]);
  const names = labelNames ?? componentNames;
  const namesRef = useRef(names);
  namesRef.current = names;

  // Engine lifetime: one per mounted canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const engine = new ViewportEngine(canvas);
    engineRef.current = engine;
    if (pose) engine.poseFor = pose;
    if (floor) engine.floorFor = floor;
    if (shadowOpacity !== undefined) engine.setShadowOpacity(shadowOpacity);
    if (fitMargin) engine.fitMargin = fitMargin;
    if (shadowRadius) engine.shadowRadiusFor = shadowRadius;
    let alive = true;
    const relayout = () => {
      if (!alive) return;
      setOverlay(computeOverlay(engine, live.current.state, namesRef.current, insets(), live.current.labelOnly, live.current.pool, live.current.buildModel === undefined));
    };
    const fit = (w: number, h: number) => {
      engine.setOccluders(occludersFor(w, h, insets()));
      engine.resize(w, h, live.current.insetRight);
      setSize({ w, h });
    };
    const off = engine.onFrame(relayout);
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      fit(r.width, r.height);
    });
    ro.observe(wrap);
    const r0 = wrap.getBoundingClientRect();
    fit(r0.width, r0.height);
    void engine.init().then((b) => alive && setBackend(b));
    window.__rwViewport = probeApi(engine, canvas);
    // The broker host (agent viewport_render / set_camera) drives this engine.
    const ctrl: ViewportController = {
      ready: () => engine.model !== null && engine.backend !== "pending",
      backend: () => engine.backend,
      adapter: () => engine.adapterLabel(),
      capture: (w, h) => engine.captureFresh(w, h),
      setCamera: (position, target) => engine.setCamera(position, target),
      seekExplode: (t) => engine.seekExplode(t),
    };
    setActiveViewport(ctrl);
    return () => {
      alive = false;
      clearActiveViewport(ctrl);
      off();
      ro.disconnect();
      engine.dispose();
      engineRef.current = null;
      if (window.__rwViewport) delete window.__rwViewport;
    };
  }, []);

  // GLB: rw-wasm when available, else the contract fixture; reloads per model hash.
  const modelHash = evaluated?.model_hash ?? null;
  useEffect(() => {
    let alive = true;
    const key = modelKey;
    void (async () => {
      try {
        const build = live.current.buildModel;
        if (build) {
          const m = await build();
          if (!alive) {
            m.dispose();
            return;
          }
          setModel(m);
          setSource(null);
          setLoadedKey(key);
          setLoadError(null);
          return;
        }
        const glb = await loadAssemblyGlb(live.current.evaluated, glbDeps);
        const ab = glb.bytes.buffer.slice(glb.bytes.byteOffset, glb.bytes.byteOffset + glb.bytes.byteLength) as ArrayBuffer;
        const gltf = await new GLTFLoader().parseAsync(ab, "");
        // Cut components (vents, slots) come out of their parents before the model is built (R2.4).
        const cuts = await applyCuts(gltf.scene);
        if (!alive) return;
        const meta: Record<string, PartMeta> = {};
        for (const c of live.current.evaluated?.components ?? []) meta[c.id] = { name: c.name, appearance: c.appearance ?? null, parent: c.parent ?? null };
        const m = new AssemblyModel(gltf.scene, meta, glbModelHash(glb.bytes), ASSEMBLY_SPACING);
        m.cutReport = cuts;
        // M3.0 visual-only detail (I13: never feeds mass or aero); torn down with the model.
        const components = live.current.evaluated?.components ?? [];
        if (components.length > 0) {
          const applied = applyDetail(m, components, defaultDetailRegistry());
          m.detailReport = applied.report;
          m.onDispose(applied.dispose);
        }
        setModel(m);
        setSource(glb.source);
        setLoadedKey(key);
        setLoadError(null);
      } catch (e) {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [modelHash, glbDeps, modelKey]);

  useEffect(() => {
    engineRef.current?.setModel(model);
    live.current.onModel?.(model);
  }, [model]);

  // The fit keeps clear of the inspector as it is when the camera frames (explode, view, resize); it does not chase its height.
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    const { w, h } = e.viewSize();
    e.setOccluders(occludersFor(w, h, insets()));
    e.setState(state);
  }, [state, model]);

  useEffect(() => {
    const e = engineRef.current;
    const wrap = wrapRef.current;
    if (!e || !wrap) return;
    const r = wrap.getBoundingClientRect();
    e.setOccluders(occludersFor(r.width, r.height, insets()));
    e.resize(r.width, r.height, insetRight);
  }, [insetRight]);

  const down = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (ev: ReactPointerEvent<HTMLCanvasElement>) => {
    down.current = { x: ev.clientX, y: ev.clientY };
  };
  const onPointerUp = (ev: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = down.current;
    down.current = null;
    if (!d || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > CLICK_SLOP_PX) return;
    const engine = engineRef.current;
    const canvas = canvasRef.current;
    if (!engine || !canvas) return;
    const r = canvas.getBoundingClientRect();
    live.current.onPick?.(engine.pickAt(ev.clientX - r.left, ev.clientY - r.top));
  };

  const selected = new Set(state.selected);
  const marks = state.marks ?? null;
  return (
    <div
      ref={wrapRef}
      className="rw-viewport rw-asm-viewport"
      data-rw-region="viewport"
      data-testid="viewport"
      data-view={state.view}
      data-explode={state.explode.toFixed(2)}
      data-explode-shown={(overlay.anim?.shown ?? state.explode).toFixed(3)}
      data-explode-anim={overlay.anim?.running ? (overlay.anim.paused ? "paused" : "running") : "idle"}
      data-section={String(state.section)}
      data-internals={String(state.showInternals)}
      data-shadows={String(state.shadows)}
      data-selected={state.selected.join(",")}
      data-hidden={[...state.hidden].sort().join(",")}
      data-glb-source={source ?? ""}
      {...cutAttrs(model?.cutReport ?? null)}
      data-model-hash={model?.modelHash ?? ""}
      data-model-key={loadedKey}
      data-render={backend}
      data-ready={model !== null && backend !== "pending" ? "true" : "false"}
      {...(marks ? { "data-marks": Object.entries(marks).map(([k, v]) => `${k}:${v}`).sort().join(",") } : {})}
      {...(loadError ? { "data-error": loadError } : {})}
    >
      {overlay.pool !== null && (
        <div
          className="rw-asm-pool"
          data-testid="vp.light-pool"
          aria-hidden
          style={{
            left: overlay.pool.x - overlay.pool.rx,
            top: overlay.pool.y - overlay.pool.ry,
            width: 2 * overlay.pool.rx,
            height: 2 * overlay.pool.ry,
            transform: `rotate(${overlay.pool.angleDeg.toFixed(2)}deg)`,
            background: POOL_BACKGROUND,
          }}
        />
      )}
      <canvas
        ref={canvasRef}
        className="rw-asm-viewport__canvas"
        data-testid="viewport-canvas"
        role="img"
        aria-label={ariaLabel}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      />
      <svg className="rw-asm-leaders" width={size.w} height={size.h} aria-hidden>
        {overlay.axis.map(([x1, y1, x2, y2], i) => (
          <line key={`axis-${i}`} className="rw-asm-axis" data-testid="vp.axis-gap" x1={x1} y1={y1} x2={x2} y2={y2} />
        ))}
        {overlay.labels.map((l) => (
          <polyline
            key={l.id}
            className="rw-asm-leader"
            data-selected={selected.has(l.id) ? "true" : undefined}
            points={`${l.start[0]},${l.start[1]} ${l.elbow[0]},${l.elbow[1]} ${l.end[0]},${l.end[1]}`}
          />
        ))}
        {overlay.labels.map((l) => (
          <circle key={`${l.id}-dot`} className="rw-asm-leader__dot" cx={l.start[0]} cy={l.start[1]} r={1.6} />
        ))}
      </svg>
      {overlay.labels.map((l) => {
        // The leader enters the box at its near end; the `@` slot is at the far end.
        const near = l.end[0] <= l.box.x + 1;
        const textX = near ? l.box.x : l.box.x + l.accessory;
        return (
          <button
            key={l.id}
            type="button"
            className="rw-asm-label"
            data-testid="vp.leader-label"
            data-part={l.id}
            data-side={l.side > 0 ? "a" : "b"}
            data-selected={selected.has(l.id) ? "true" : "false"}
            data-collided={l.collided ? "true" : undefined}
            data-mark={marks?.[l.id]}
            style={{ left: textX, top: l.box.y, width: l.box.w - l.accessory, height: l.box.h, textAlign: near ? "left" : "right" }}
            onClick={() => live.current.onPick?.(l.id)}
          >
            {l.text}
          </button>
        );
      })}
      {overlay.labels
        .filter((l) => l.accessory > 0 && selected.has(l.id))
        .map((l) => {
          const near = l.end[0] <= l.box.x + 1;
          const x = near ? l.box.x + l.box.w - l.accessory + 4 : l.box.x;
          return (
            <button
              key={`${l.id}-mention`}
              type="button"
              className="rw-asm-mention"
              data-testid="vp.mention"
              data-part={l.id}
              title={`Ask about ${l.text} in chat`}
              aria-label={`Mention ${l.text} in chat`}
              style={{ left: x, top: l.box.y - 1, width: l.accessory - 4, height: l.box.h + 2 }}
              onClick={() => live.current.onMention?.(l.id, l.text)}
            >
              @
            </button>
          );
        })}
      <AxisGizmo axes={overlay.gizmo} right={insetRight + GIZMO_GAP} view={state.view} />
      {backend === "webgpu" && model !== null && (
        <button
          type="button"
          className="rw-asm-still"
          data-testid="vp.render-still"
          title="Render still (path traced)"
          aria-label="Render still"
          aria-expanded={stillOpen}
          style={{ right: insetRight + GIZMO_GAP + (GIZMO_SIZE - 28) / 2, top: GIZMO_SIZE + 22 }}
          onClick={() => setStillOpen((o) => !o)}
        >
          <svg width={16} height={16} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 6.5h3l1.5-2h5l1.5 2h3v9.5H3z" />
            <circle cx="10" cy="11" r="3" />
          </svg>
        </button>
      )}
      {stillOpen && engineRef.current !== null && (
        <StillPanel
          width={Math.round(size.w)}
          height={Math.round(size.h)}
          section={state.section}
          fileName={`rocketwright-still${model?.modelHash ? `-${model.modelHash.slice(0, 8)}` : ""}.png`}
          render={(req) => engineRef.current!.renderStill(req)}
          onClose={() => setStillOpen(false)}
        />
      )}
    </div>
  );
}

function AxisGizmo({ axes, right, view }: { axes: GizmoAxis[]; right: number; view: string }) {
  const c = GIZMO_SIZE / 2;
  return (
    <svg
      className="rw-asm-gizmo"
      data-testid="vp.axis-gizmo"
      data-view={view}
      width={GIZMO_SIZE}
      height={GIZMO_SIZE}
      style={{ right }}
      role="img"
      aria-label="Axes: X red, Y green, Z blue"
    >
      <rect x={c - 9} y={c - 9} width={18} height={18} rx={3} className="rw-asm-gizmo__cube" />
      {axes.map((a) => (
        <g key={a.axis} data-axis={a.axis} data-x={a.x.toFixed(1)} data-y={a.y.toFixed(1)}>
          <line x1={c} y1={c} x2={a.x} y2={a.y} stroke={a.color} strokeWidth={1.6} />
          <text x={a.x + (a.x >= c ? 5 : -5)} y={a.y + (a.y >= c ? 9 : -3)} fill={AXIS_COLORS[a.axis]} textAnchor={a.x >= c ? "start" : "end"}>
            {a.axis}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** `pool`: draw the studio light pool; `assembly`: the meshed assembly (labels spread evenly), else a page's own scene. */
function computeOverlay(engine: ViewportEngine, state: EngineState, names: ReadonlyMap<string, string>, inset: Insets, only: ReadonlySet<string> | null, pool: boolean, assembly: boolean): Overlay {
  const parts = engine.model ? engine.screenParts() : [];
  // Internal parts are labelled once they are visible: pulled out, x-rayed, or cut open.
  const showInternal = state.explode >= INTERNAL_LABEL_EXPLODE || state.showInternals || state.section;
  const selected = new Set(state.selected);
  const anchors = parts
    .filter((p) => (only === null ? showInternal || !engine.model?.parts.get(p.id)?.internal : only.has(p.id)))
    .map((p) => ({ id: p.id, text: names.get(p.id) ?? p.id, x: p.x, y: p.y, r: p.r, order: p.order, accessory: selected.has(p.id) ? MENTION_SLOT : 0 }));
  const axis = engine.axisOnScreen();
  // Labels alternate sides of the axis, starting up-right (concept 01).
  let normal: [number, number] = axis[0] === 0 && axis[1] === 0 ? [0.6, -0.8] : [axis[1], -axis[0]];
  if (normal[0] < 0 || (normal[0] === 0 && normal[1] > 0)) normal = [-normal[0], -normal[1]];
  const { w, h } = engine.viewSize();
  // The meshed assembly spreads its labels evenly along the diagonal on one side (concept 01).
  const labels = layoutLabels(anchors, { width: w, height: h, normal, avoid: occludersFor(w, h, inset), obstacles: engine.partFootprints(16), spread: assembly ? "even" : "alternate" });
  return { labels, gizmo: gizmoAxes(engine.basis(), GIZMO_SIZE), axis: engine.axisGaps(), anim: engine.explodeAnimState(), pool: pool ? engine.poolOnScreen() : null };
}

function probeApi(engine: ViewportEngine, canvas: HTMLCanvasElement): ViewportProbeApi {
  const local = (x: number, y: number) => {
    const r = canvas.getBoundingClientRect();
    return { x: x - r.left, y: y - r.top, r };
  };
  return {
    pickAt(clientX, clientY) {
      const p = local(clientX, clientY);
      return engine.pickAt(p.x, p.y);
    },
    pointFor(id) {
      const m = engine.model;
      if (!m || !m.isVisible(id)) return null;
      const box = m.partBounds(id);
      if (!box || box.isEmpty()) return null;
      const r = canvas.getBoundingClientRect();
      const pts: THREE.Vector3[] = [box.getCenter(new THREE.Vector3())];
      const n = 6;
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) for (const k of [0.5, 0.25, 0.75]) {
        pts.push(new THREE.Vector3(
          THREE.MathUtils.lerp(box.min.x, box.max.x, (i + 0.5) / (n + 1)),
          THREE.MathUtils.lerp(box.min.y, box.max.y, (j + 0.5) / (n + 1)),
          THREE.MathUtils.lerp(box.min.z, box.max.z, k),
        ));
      }
      for (const p of pts) {
        const s = engine.project(p);
        if (s.z > 1 || s.x < 2 || s.y < 2 || s.x > r.width - 2 || s.y > r.height - 2) continue;
        if (engine.pickAt(s.x, s.y) === id) return { x: r.left + s.x, y: r.top + s.y };
      }
      return null;
    },
    partOffset(id) {
      const p = engine.model?.parts.get(id);
      return p ? [p.node.position.x, p.node.position.y, p.node.position.z] : null;
    },
    cameraDir() {
      const b = engine.basis();
      return [b.back[0], b.back[1], b.back[2]];
    },
    visibleParts() {
      const m = engine.model;
      return m ? [...m.parts.keys()].filter((id) => m.isVisible(id)) : [];
    },
    opacity(id) {
      return engine.model?.parts.get(id)?.materials[0]?.opacity ?? null;
    },
    color(id) {
      const m = engine.model?.parts.get(id)?.materials[0];
      return m ? `#${m.color.getHexString()}` : null;
    },
    marks() {
      return { ...engine.model?.marks };
    },
    outlined: () => engine.outlinedParts(),
    shadowsOn: () => engine.shadowsOn(),
    sectionOn: () => engine.model?.root.enabled ?? false,
    backend: () => engine.backend,
    detail: () => [...(engine.model?.detailReport ?? [])],
    probeOutput: () => engine.probeOutput(),
    capture: (w, h) => engine.capturePng(w, h),
    explodeAnim: () => engine.explodeAnimState(),
    seekExplode: (t) => engine.seekExplode(t),
    axisOnScreen: () => engine.axisOnScreen(),
    axisIntervals: () => engine.axisIntervals(),
    axisGaps: () => engine.axisGaps(),
    probeAO: () => engine.probeAO(),
    sectionCaps: () => engine.sectionCaps(),
    capPixels: () => engine.probeCapPixels(),
    async sectionStill() {
      const m = engine.model;
      if (!m) return {};
      const { loadManifold, cutMeshForStill } = await import("../render/section.ts");
      const mf = await loadManifold();
      m.root.updateMatrixWorld(true);
      const out: Record<string, { method: string[]; bodyVolume: number; volume: number; capArea: number }> = {};
      for (const p of m.parts.values()) {
        if (!m.isVisible(p.id)) continue;
        const row = { method: [] as string[], bodyVolume: 0, volume: 0, capArea: 0 };
        for (const mesh of p.meshes) {
          if (mesh.userData["rwProvenance"] === "visual") continue;
          const r = cutMeshForStill(mf, mesh.geometry as THREE.BufferGeometry, mesh.matrixWorld, SECTION_PLANE);
          row.method.push(r.method);
          row.bodyVolume += r.bodyVolume ?? 0;
          row.volume += r.volume ?? 0;
          row.capArea += r.capArea;
          r.geometry?.dispose();
        }
        out[p.id] = row;
      }
      return out;
    },
    screenCentres() {
      const out: Record<string, [number, number]> = {};
      for (const p of engine.screenParts()) out[p.id] = [p.x, p.y];
      return out;
    },
  };
}
