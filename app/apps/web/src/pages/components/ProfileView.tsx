/**
 * Page 02 profile (D11): an orthographic, shaded three.js view of the same
 * rw-wasm GLB as the Assembly viewport (PBR materials per appearance preset),
 * with an SVG overlay for the CG/CP markers, dimension lines, the selected
 * part's outline (teal fill: the proposal) and the previous revision's
 * outline (dashed amber ghost). The camera's orthographic window is the
 * overlay's `Frame`, so markers and geometry line up exactly. The Rust
 * `rw-draw` SVG stays the CLI and golden path.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import * as THREE from "three/webgpu";
import type { CheckReport, EvaluatedModel } from "@rw/contracts";
import { formatLength } from "../assembly/inspector-model.ts";
import type { DeepReadonly, Units } from "../../state/index.ts";
import { applyDetail, defaultDetailRegistry } from "../../detail/registry.ts";
import { applyCuts, cutAttrs, type CutReport } from "../../viewport/cuts.ts";
import { glbModelHash, loadAssemblyGlb, type GlbDeps } from "../../viewport/glb-source.ts";
import { loadStudioEnvironment, STUDIO } from "../../viewport/lighting.ts";
import { AssemblyModel, pickPart, type PartMeta } from "../../viewport/scene.ts";
import { cameraBasis, viewPose } from "../../viewport/views.ts";
import {
  fitFrame,
  isFinSet,
  modelExtents,
  PROFILE_VIEW_CAPTION,
  profileOverlay,
  projectBody,
  scaleLabel,
  toScreen,
  type FinOutline,
  type Frame,
  type ProfileOverlay,
  type ProfileView as ViewId,
} from "./profile-geometry.ts";

type Model = DeepReadonly<EvaluatedModel>;
type Backend = "pending" | "webgpu" | "webgl" | "none";

/**
 * Profile scaling of the studio rig: a straight-on orthographic view sees the
 * key light head-on, so it is softened to keep satin white parts from
 * clipping to flat white (their shading is the cylinder's form).
 */
const PROFILE_LIGHT = { key: 0.55, hemisphere: 0.6, environment: 0.85, exposure: 0.92 } as const;

/** Body-frame direction toward the viewer of a profile view (detail faces it: windows, boards). */
export function showcaseFor(view: ViewId): [number, number, number] {
  const b = cameraBasis(viewPose(view)).back;
  // World (three, Y up) -> body (x, -z, y).
  const v: [number, number, number] = [b[0], -b[2], b[1]];
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Orthographic renderer for one canvas. Never throws on a missing GPU (backend `none`; the overlay still draws). */
class ProfileEngine {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  backend: Backend = "pending";
  model: AssemblyModel | null = null;
  private renderer: THREE.WebGPURenderer | null = null;
  private readonly canvas: HTMLCanvasElement;
  private size = { w: 1, h: 1 };
  private dirty = true;
  private disposed = false;
  private readonly raycaster = new THREE.Raycaster();
  private readonly key = new THREE.DirectionalLight(0xffffff, STUDIO.key * PROFILE_LIGHT.key);

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // The studio rig of the 3D viewport (lighting.ts), so a preset reads the same on both pages.
    this.scene.add(new THREE.HemisphereLight(0xe4ecf5, 0x1a1d21, STUDIO.hemisphere * PROFILE_LIGHT.hemisphere));
    this.scene.add(this.key, this.key.target);
    const rim = new THREE.DirectionalLight(0xa9c8ff, STUDIO.rim);
    rim.position.set(-3, -1.5, -2);
    this.scene.add(rim);
  }

  async init(): Promise<Backend> {
    try {
      const r = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: true, alpha: true });
      await r.init();
      if (this.disposed) {
        r.dispose();
        return this.backend;
      }
      r.setClearColor(0x000000, 0);
      r.toneMapping = THREE.NeutralToneMapping;
      r.toneMappingExposure = PROFILE_LIGHT.exposure;
      r.setPixelRatio(window.devicePixelRatio);
      r.setSize(this.size.w, this.size.h, false);
      this.scene.environmentIntensity = STUDIO.envIntensity * PROFILE_LIGHT.environment;
      try {
        // The studio panorama (as on page 01); the procedural room is the fallback.
        this.scene.environment = await loadStudioEnvironment();
      } catch {
        try {
          this.scene.environment = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.04).texture;
        } catch {
          // Lights alone still read as PBR.
        }
      }
      if (this.disposed) {
        r.dispose();
        return this.backend;
      }
      this.renderer = r;
      this.backend = (r.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? "webgpu" : "webgl";
      r.setAnimationLoop(() => this.tick());
    } catch {
      this.backend = "none";
    }
    this.dirty = true;
    return this.backend;
  }

  setModel(m: AssemblyModel | null): void {
    if (this.model === m) return;
    if (this.model) {
      this.scene.remove(this.model.root);
      this.model.dispose();
    }
    this.model = m;
    if (m) {
      m.apply({ explode: 0, hidden: [], showInternals: false, section: false });
      this.scene.add(m.root);
    }
    this.dirty = true;
  }

  setHidden(hidden: readonly string[]): void {
    this.model?.apply({ explode: 0, hidden, showInternals: false, section: false });
    this.dirty = true;
  }

  /** Points the orthographic camera at `frame` for `view` (frame h/v are the view's body axes). */
  setFrame(f: Frame, view: ViewId): void {
    const pose = viewPose(view);
    const b = cameraBasis(pose);
    const R = new THREE.Vector3(...b.right);
    const U = new THREE.Vector3(...b.up);
    const back = new THREE.Vector3(...b.back);
    const hc = (f.h0 + f.h1) / 2;
    const vc = (f.v0 + f.v1) / 2;
    const reach = Math.max(f.h1 - f.h0, f.v1 - f.v0);
    const dist = reach * 4;
    const centre = R.clone().multiplyScalar(hc).add(U.clone().multiplyScalar(vc));
    this.camera.position.copy(centre).addScaledVector(back, dist);
    this.camera.up.copy(U);
    this.camera.left = -(f.h1 - f.h0) / 2;
    this.camera.right = (f.h1 - f.h0) / 2;
    this.camera.top = (f.v1 - f.v0) / 2;
    this.camera.bottom = -(f.v1 - f.v0) / 2;
    this.camera.near = dist / 100;
    this.camera.far = dist * 3;
    this.camera.lookAt(centre);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    // Key light from upper front-left of the view, as in the studio art.
    this.key.position.copy(centre).addScaledVector(back, dist).addScaledVector(U, reach * 2).addScaledVector(R, -reach);
    this.key.target.position.copy(centre);
    this.key.target.updateMatrixWorld();
    this.dirty = true;
  }

  resize(w: number, h: number): void {
    this.size = { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
    this.renderer?.setSize(this.size.w, this.size.h, false);
    this.dirty = true;
  }

  pickAt(x: number, y: number): string | null {
    if (!this.model) return null;
    return pickPart(this.model, this.camera, { x: (x / this.size.w) * 2 - 1, y: -(y / this.size.h) * 2 + 1 }, this.raycaster);
  }

  dispose(): void {
    this.disposed = true;
    if (this.renderer) {
      this.renderer.setAnimationLoop(null);
      this.renderer.dispose();
    }
    this.model?.dispose();
  }

  private tick(): void {
    if (!this.dirty || !this.renderer) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
  }
}

export interface ProfileViewProps {
  /** The model drawn (draft preview while editing, else the committed model). */
  evaluated: Model | null;
  check: DeepReadonly<CheckReport> | null;
  /** The previous revision (amber ghost of the selected part), or null. */
  base: Model | null;
  selected: string | null;
  view: ViewId;
  units: Units;
  hidden: readonly string[];
  glbDeps: GlbDeps;
  /** A proposal is shown (labels the teal and amber outlines). */
  proposal: boolean;
  onPick?: (id: string | null) => void;
}

const CLICK_SLOP_PX = 5;

export function ProfileView({ evaluated, check, base, selected, view, units, hidden, glbDeps, proposal, onPick }: ProfileViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ProfileEngine | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [backend, setBackend] = useState<Backend>("pending");
  const [glbHash, setGlbHash] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cutReport, setCutReport] = useState<CutReport | null>(null);
  const live = useRef({ evaluated, onPick });
  live.current = { evaluated, onPick };

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const engine = new ProfileEngine(canvas);
    engineRef.current = engine;
    let alive = true;
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      engine.resize(r.width, r.height);
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(wrap);
    const r0 = wrap.getBoundingClientRect();
    engine.resize(r0.width, r0.height);
    setSize({ w: r0.width, h: r0.height });
    void engine.init().then((b) => alive && setBackend(b));
    return () => {
      alive = false;
      ro.disconnect();
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // One GLB per model hash (the draft preview re-meshes as fields change).
  const modelHash = evaluated?.model_hash ?? null;
  useEffect(() => {
    let alive = true;
    const ev = live.current.evaluated;
    if (ev === null) return;
    void (async () => {
      try {
        const glb = await loadAssemblyGlb(ev as EvaluatedModel, glbDeps);
        const ab = glb.bytes.buffer.slice(glb.bytes.byteOffset, glb.bytes.byteOffset + glb.bytes.byteLength) as ArrayBuffer;
        const gltf = await new GLTFLoader().parseAsync(ab, "");
        const cuts = await applyCuts(gltf.scene);
        if (!alive) return;
        const meta: Record<string, PartMeta> = {};
        for (const c of ev.components) meta[c.id] = { name: c.name, appearance: (c.appearance ?? null) as Exclude<PartMeta["appearance"], undefined>, parent: c.parent ?? null };
        const m = new AssemblyModel(gltf.scene, meta, glbModelHash(glb.bytes));
        m.cutReport = cuts;
        setCutReport(cuts);
        // The same visual-only detail as the 3D viewport (M3.0, I13): bevelled tube ends (joint
        // lines), the clear bay with its folded chute, machined motor casing; facing this view.
        const applied = applyDetail(m, ev.components as EvaluatedModel["components"], defaultDetailRegistry(), { showcase: showcaseFor(view) });
        m.detailReport = applied.report;
        m.onDispose(applied.dispose);
        engineRef.current?.setModel(m);
        setGlbHash(m.modelHash ?? ev.model_hash);
        setLoadError(null);
      } catch (e) {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
    // The detail faces the view it is built for (a new view re-meshes once).
  }, [modelHash, glbDeps, view]);

  // The frame covers the model and the ghost so neither clips.
  const frame = useMemo(() => {
    if (evaluated === null || size.w < 2 || size.h < 2) return null;
    return fitFrame(modelExtents([evaluated, base]), size.w, size.h, view);
  }, [evaluated, base, size.w, size.h, view]);

  useEffect(() => {
    if (frame !== null) engineRef.current?.setFrame(frame, view);
  }, [frame, view, glbHash]);

  useEffect(() => {
    engineRef.current?.setHidden(hidden);
  }, [hidden, glbHash]);

  const overlay = useMemo(
    () => (evaluated !== null && frame !== null ? profileOverlay(evaluated, check, frame, view, selected, base) : null),
    [evaluated, check, frame, view, selected, base],
  );

  const down = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (ev: ReactPointerEvent<HTMLCanvasElement>) => {
    down.current = { x: ev.clientX, y: ev.clientY };
  };
  const onPointerUp = (ev: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = down.current;
    down.current = null;
    if (!d || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > CLICK_SLOP_PX) return;
    const r = canvasRef.current?.getBoundingClientRect();
    const e = engineRef.current;
    if (!r || !e) return;
    live.current.onPick?.(e.pickAt(ev.clientX - r.left, ev.clientY - r.top));
  };

  const sel = selected !== null ? (evaluated?.components.find((c) => c.id === selected) ?? null) : null;
  const prev = selected !== null ? (base?.components.find((c) => c.id === selected) ?? null) : null;
  return (
    <div
      ref={wrapRef}
      className="rw-viewport rw-profile"
      data-rw-region="viewport"
      data-testid="viewport"
      data-view={view}
      data-render={backend}
      data-ready={glbHash !== null && backend !== "pending" ? "true" : "false"}
      data-model-hash={evaluated?.model_hash ?? ""}
      data-selected={selected ?? ""}
      data-ghost={overlay !== null && overlay.ghost.length > 0 ? "true" : "false"}
      {...cutAttrs(cutReport)}
      {...(loadError ? { "data-error": loadError } : {})}
    >
      <div className="rw-profile__grid" data-testid="vp.grid" aria-hidden />
      <canvas
        ref={canvasRef}
        className="rw-profile__canvas"
        data-testid="viewport-canvas"
        role="img"
        aria-label={PROFILE_VIEW_CAPTION[view]}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      />
      {overlay !== null && (
        <Overlay
          o={overlay}
          view={view}
          units={units}
          selectedIsFins={isFinSet(sel)}
          selectedOutline={sel !== null && !isFinSet(sel) ? boxOutline(sel, overlay.frame, view) : null}
          ghostOutline={prev !== null && !isFinSet(prev) && proposal ? boxOutline(prev, overlay.frame, view) : null}
          finSpan={spanOf(sel)}
          ghostSpan={spanOf(prev)}
          proposal={proposal}
        />
      )}
      <span className="rw-profile__caption" data-testid="vp.view-label">
        {PROFILE_VIEW_CAPTION[view]}
      </span>
      {frame !== null && (
        <span className="rw-profile__scale" data-testid="vp.scale">
          {scaleLabel(frame)}
        </span>
      )}
      <OrientationCube view={view} />
    </div>
  );
}

/** Stations and dimensions: whole millimetres in mm (concept 02 `470 mm`), else the unit's precision. */
export function stationLabel(m: number, units: Units): string {
  return units === "mm" ? `${Math.round(m * 1000)} mm` : formatLength(m, units);
}

const spanOf = (c: { shape: unknown } | null): number | null => {
  const s = (c?.shape as { span?: number } | undefined)?.span;
  return typeof s === "number" ? s : null;
};

/** Side-view box of a body part (x range × diameter), for non-fin selections and ghosts. */
function boxOutline(c: { x_fore: number; x_aft: number; shape: unknown; radial: number }, f: Frame, view: ViewId): [number, number][] | null {
  if (view === "front" || view === "rear") return null;
  const s = c.shape as { od?: number; fore_od?: number; aft_od?: number };
  const r = Math.max(s.od ?? 0, s.fore_od ?? 0, s.aft_od ?? 0) / 2;
  if (!(r > 0) || !(c.x_aft > c.x_fore)) return null;
  const pts: [number, number][] = [];
  for (const [x, v] of [
    [c.x_fore, r],
    [c.x_aft, r],
    [c.x_aft, -r],
    [c.x_fore, -r],
  ] as const) {
    const [h, vv] = projectBody([x, view === "top" ? v : 0, view === "side" ? v + c.radial : 0], view);
    pts.push(toScreen(f, h, vv));
  }
  return pts;
}

const pointsAttr = (pts: readonly [number, number][]) => pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

function Overlay({
  o,
  view,
  units,
  selectedIsFins,
  selectedOutline,
  ghostOutline,
  finSpan,
  ghostSpan,
  proposal,
}: {
  o: ProfileOverlay;
  view: ViewId;
  units: Units;
  selectedIsFins: boolean;
  selectedOutline: [number, number][] | null;
  ghostOutline: [number, number][] | null;
  finSpan: number | null;
  ghostSpan: number | null;
  proposal: boolean;
}) {
  const { frame } = o;
  const side = view === "side" || view === "top";
  const cg = o.markers.find((m) => m.kind === "cg");
  const cp = o.markers.find((m) => m.kind === "cp");
  // Marker labels sit above the body; a CP label too close to the CG one moves right.
  const labelY = Math.max(18, o.bodyTop - 70);
  // Marker labels keep clear of the fins (drawn above the body) and of each other.
  const finPts = [...o.fins, ...o.ghost].filter((f) => f.facing).flatMap((f) => f.points);
  const finX0 = finPts.length > 0 ? Math.min(...finPts.map((p) => p[0])) : Infinity;
  const finX1 = finPts.length > 0 ? Math.max(...finPts.map((p) => p[0])) : -Infinity;
  const clear = (x: number) => (x > finX0 - 44 && x < finX1 + 44 ? finX0 - 48 : x);
  const cpX = cp !== undefined ? clear(cp.x) : 0;
  const cgX = cg !== undefined ? Math.min(clear(cg.x), cp !== undefined ? cpX - 84 : Infinity) : 0;
  const labelX = (m: { kind: string; x: number }) => (m.kind === "cp" ? cpX : cgX);
  const showGhost = proposal && o.ghost.length > 0;
  // Fin labels stack to the right of the fins, the higher tip's label on top (concept 02).
  const finLabels = (
    [
      ...(selectedIsFins && proposal && o.finTip !== null ? [{ kind: "new" as const, tip: o.finTip, span: finSpan }] : []),
      ...(showGhost && o.ghostTip !== null ? [{ kind: "prev" as const, tip: o.ghostTip, span: ghostSpan }] : []),
    ] as { kind: "new" | "prev"; tip: [number, number]; span: number | null }[]
  )
    .sort((a, b) => a.tip[1] - b.tip[1])
    .map((l, i, all) => {
      const x = Math.max(...all.map((a) => a.tip[0])) + 34;
      const top = Math.max(26, Math.min(...all.map((a) => a.tip[1])) - 34);
      return { ...l, x, y: top + i * 42 };
    });
  return (
    <>
      <svg className="rw-profile__overlay" width={frame.width} height={frame.height} aria-hidden>
        <defs>
          <marker id="rw-dim-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" className="rw-profile__arrow" />
          </marker>
        </defs>
        {/* Seams between airframe sections (dark groove, light lip aft of it). */}
        {o.joints.length > 0 && (
          <g data-testid="vp.joints" data-count={o.joints.length}>
            {o.joints.map((j) => (
              <g key={`joint-${j.station.toFixed(4)}`} data-station={j.station.toFixed(4)}>
                <line className="rw-profile__joint" x1={j.x} y1={j.y0 + 0.5} x2={j.x} y2={j.y1 - 0.5} />
                <line className="rw-profile__joint-lip" x1={j.x + 1.6} y1={j.y0 + 1} x2={j.x + 1.6} y2={j.y1 - 1} />
              </g>
            ))}
          </g>
        )}
        {/* Proposal: every fin of the set filled alike (the drawn count is the fin count). */}
        <g data-testid="vp.proposal" data-fins={selectedIsFins ? o.fins.length : 0} data-proposal={proposal ? "true" : "false"}>
          {o.fins.map((fin: FinOutline) => (
            <polygon key={`fin-${fin.index}`} className="rw-profile__fin" data-testid="vp.fin" data-index={fin.index} data-facing={fin.facing ? "true" : "false"} points={pointsAttr(fin.points)} />
          ))}
          {selectedOutline !== null && <polygon className="rw-profile__sel" data-testid="vp.selection" points={pointsAttr(selectedOutline)} />}
        </g>
        {showGhost && (
          <g data-testid="vp.ghost" data-fins={o.ghost.length}>
            {o.ghost
              .filter((g) => g.facing)
              .map((g) => (
                <polygon key={`ghost-${g.index}`} className="rw-profile__ghost" points={pointsAttr(g.points)} />
              ))}
          </g>
        )}
        {proposal && ghostOutline !== null && (
          <g data-testid="vp.ghost" data-fins={0}>
            <polygon className="rw-profile__ghost" points={pointsAttr(ghostOutline)} />
          </g>
        )}
        {side && (
          <g className="rw-profile__dims">
            {o.markers.map((m) => (
              <line key={`ext-${m.kind}`} className="rw-profile__ext" x1={m.x} y1={m.y + 10} x2={m.x} y2={(o.dims[0]?.y ?? m.y) + 6} />
            ))}
            {o.dims.map((d) => (
              <g key={d.key} data-testid="vp.dimension" data-dim={d.key} data-value={d.value.toFixed(4)}>
                {d.key === "overall" && (
                  <>
                    <line className="rw-profile__ext" x1={d.x1} y1={o.axisY} x2={d.x1} y2={d.y + 6} />
                    <line className="rw-profile__ext" x1={d.x2} y1={o.axisY} x2={d.x2} y2={d.y + 6} />
                  </>
                )}
                <line className="rw-profile__dim" x1={d.x1 + 1} y1={d.y} x2={d.x2 - 1} y2={d.y} markerStart="url(#rw-dim-arrow)" markerEnd="url(#rw-dim-arrow)" />
                <text className="rw-profile__dim-text" x={(d.x1 + d.x2) / 2} y={d.y + 16} textAnchor="middle">
                  {stationLabel(d.value, units)}
                </text>
              </g>
            ))}
            {o.markers.map((m) => {
              const lx = labelX(m);
              return (
                <g key={m.kind} data-testid={m.kind === "cg" ? "vp.cg" : "vp.cp"} data-station={m.station.toFixed(4)} data-x={m.x.toFixed(1)}>
                  <polyline className="rw-profile__leader" points={`${m.x},${m.y - 9} ${m.x},${labelY + 26} ${lx},${labelY + 26}`} />
                  {m.kind === "cg" ? (
                    <>
                      <circle cx={m.x} cy={m.y} r={8} className="rw-profile__cg-ring" />
                      <circle cx={m.x} cy={m.y} r={3.2} className="rw-profile__cg-dot" />
                    </>
                  ) : (
                    <>
                      <circle cx={m.x} cy={m.y} r={8} className="rw-profile__cp-ring" />
                      <line x1={m.x - 8} y1={m.y} x2={m.x + 8} y2={m.y} className="rw-profile__cp-cross" />
                      <line x1={m.x} y1={m.y - 8} x2={m.x} y2={m.y + 8} className="rw-profile__cp-cross" />
                    </>
                  )}
                  <text x={lx} y={labelY} textAnchor="middle" className="rw-profile__marker-name">
                    {m.kind.toUpperCase()}
                  </text>
                  <text x={lx} y={labelY + 17} textAnchor="middle" className="rw-profile__marker-value">
                    {stationLabel(m.station, units)}
                  </text>
                </g>
              );
            })}
          </g>
        )}
        {finLabels.map((l) => (
          <g key={l.kind} data-testid={l.kind === "new" ? "vp.proposal-label" : "vp.ghost-label"}>
            <polyline className={`rw-profile__leader rw-profile__leader--${l.kind === "new" ? "teal" : "amber"}`} points={`${l.tip[0]},${l.tip[1]} ${l.x - 10},${l.y - 5} ${l.x - 4},${l.y - 5}`} />
            <circle cx={l.tip[0]} cy={l.tip[1]} r={2} className={l.kind === "new" ? "rw-profile__tipdot" : "rw-profile__tipdot rw-profile__tipdot--amber"} />
            <text x={l.x} y={l.y - 8} className={`rw-profile__label rw-profile__label--${l.kind === "new" ? "teal" : "amber"}`}>
              {l.kind === "new" ? "New fin" : "Previous fin"}
            </text>
            <text x={l.x} y={l.y + 8} className={`rw-profile__label rw-profile__label--${l.kind === "new" ? "teal" : "amber"}`}>
              (span {l.span !== null ? stationLabel(l.span, units) : "—"})
            </text>
          </g>
        ))}
      </svg>
      {side && o.stability !== null && (
        <span className="rw-profile__stability" data-testid="vp.stability" data-cal={o.stability.toFixed(2)} title="Static stability margin at liftoff, from CG and CP">
          Stability {o.stability.toFixed(2)} cal
        </span>
      )}
    </>
  );
}

/** Orientation thumbnail: a small cube with the view's axes (C §4.2). */
function OrientationCube({ view }: { view: ViewId }) {
  const axes: Record<ViewId, { right: string; up: string; depth: string }> = {
    side: { right: "X", up: "Z", depth: "Y" },
    top: { right: "X", up: "Y", depth: "Z" },
    front: { right: "Y", up: "Z", depth: "X" },
    rear: { right: "Y", up: "Z", depth: "X" },
  };
  const a = axes[view];
  const color: Record<string, string> = { X: "#e5735c", Y: "#7dbb6b", Z: "#5b8fd9" };
  return (
    <svg className="rw-profile__cube" data-testid="vp.axis-gizmo" data-view={view} width={70} height={70} viewBox="0 0 70 70" role="img" aria-label={`Axes: ${a.right} right, ${a.up} up`}>
      <g className="rw-profile__cube-body">
        <polygon points="20,30 40,30 40,50 20,50" />
        <polygon points="20,30 28,22 48,22 40,30" />
        <polygon points="40,30 48,22 48,42 40,50" />
      </g>
      <g data-axis={a.right}>
        <line x1={40} y1={30} x2={60} y2={30} stroke={color[a.right]} strokeWidth={1.4} />
        <text x={63} y={33} fill={color[a.right]}>
          {a.right}
        </text>
      </g>
      <g data-axis={a.up}>
        <line x1={40} y1={30} x2={40} y2={10} stroke={color[a.up]} strokeWidth={1.4} />
        <text x={37} y={8} fill={color[a.up]}>
          {a.up}
        </text>
      </g>
      <g data-axis={a.depth}>
        <line x1={40} y1={30} x2={50} y2={58} stroke={color[a.depth]} strokeWidth={1.4} />
        <text x={52} y={67} fill={color[a.depth]}>
          {a.depth}
        </text>
      </g>
    </svg>
  );
}
