/**
 * The page 01 render engine: three r186 `WebGPURenderer` (WebGL2 fallback is
 * built in) with a `RenderPipeline` scene pass plus a teal `OutlineNode` on the
 * selection, studio lights, a shadow catcher, orbit controls, and the camera
 * presets. Scene state lives in `AssemblyModel`; picking and projection work
 * from the camera alone, so the page stays functional when no GPU adapter is
 * available (backend `none`; the e2e asserts behaviour, the GPU gate I11
 * asserts the adapter).
 */
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { outline } from "three/addons/tsl/display/OutlineNode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { builtinAOContext, float, mrt, normalView, packNormalToRGB, pass, sample, screenUV, texture, uniform, unpackRGBToNormal, vec4 } from "three/tsl";
import * as THREE from "three/webgpu";
import type { ViewId } from "@rw/contracts";
import type { MarkMap } from "./marks.ts";
import { SELECTION_TEAL } from "./materials.ts";
import { crispOutline, loadStudioRig, readCanvas, STUDIO, STUDIO_RIG } from "./lighting.ts";
import { analyzeOutput, type OutputProbe } from "./outputProbe.ts";
import { freshCapture, nextRenderFrame } from "./renderFrame.ts";
import { bakeStage, POOL_GRADIENT, STAGE_LOOK, type StageBake } from "./stage.ts";
import { type AssemblyModel, pickPart } from "./scene.ts";
import { alignOffset, fitPlacement, footprintClear, unionRect } from "./fit.ts";
import { cameraBasis, fitDistance, isoTiltFor, viewPose, type Vec3, type ViewPose } from "./views.ts";
import { explodeAt, ExplodeAnimator } from "./explodeAnim.ts";
import { CAP_LAYER } from "../render/section.ts";
import type { StillOutput, StillRequest } from "../render/still.ts";

/**
 * Layer of the meshes the GTAO prepass sees (M3.1): every opaque part and
 * detail mesh; clear (transmissive) parts stay out (RL1: AO from the glass
 * darkens the contents seen through it), as do the section writers and cap.
 */
export const AO_LAYER = 4;

/** GTAO radius in world metres (three's 0.25 default is for rooms; RL1 tuned 0.02 on a 54 mm bay). */
export const AO_RADIUS_M = 0.02;

export type RenderBackend = "pending" | "webgpu" | "webgl" | "none";

export interface EngineState {
  view: ViewId;
  explode: number;
  section: boolean;
  showInternals: boolean;
  shadows: boolean;
  hidden: readonly string[];
  selected: readonly string[];
  /** Compare marks (M2.7): id → removed/changed/added, the rest dimmed; absent or null = normal look. */
  marks?: MarkMap | null;
  /**
   * M3.2: ease a change of `explode` (Assembled/Exploded buttons, agent
   * requests) instead of jumping to it (slider drags). The camera eases
   * between the start and end framings with the same curve.
   */
  explodeAnimate?: boolean;
}

/** Explode animation state, for the probe and the region's data attributes. */
export interface ExplodeAnimState {
  /** Factor on screen now. */
  shown: number;
  /** Where it is heading. */
  target: number;
  running: boolean;
  /** Time pinned by a capture (`seekExplode`). */
  paused: boolean;
  /** Normalised time of the tween (1 when idle). */
  t: number;
}

/** Camera placement the explode tween interpolates. */
interface CamPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
  offset: { x: number; y: number } | null;
}

/** The light pool's ellipse on screen (canvas px, y down). */
export interface PoolScreen {
  x: number;
  y: number;
  /** Half axes (px). */
  rx: number;
  ry: number;
  /** Major axis angle (deg, clockwise on screen). */
  angleDeg: number;
}

export interface ScreenPart {
  id: string;
  /** Canvas px, y down. */
  x: number;
  y: number;
  /** Projected radius (px). */
  r: number;
  /** World x of the part's fore end (assembly order). */
  order: number;
}

const FOV = 28;
/** Key times (after t = 0) the explode tween frames the camera at (M3.2). */
const CAMERA_KEY_TIMES = [0.2, 0.4, 0.6, 0.8, 1];

type ScreenRect = { x: number; y: number; w: number; h: number };

/** Free space kept around the fitted model (px), and extra right room as a fraction of the width. */
export interface FitMargin {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Extra right margin (fraction of the width, at most 140 px): room for labels running out to the right. */
  labelRoom: number;
}

/** The assembly's margins: room for the leader labels; the aft end's labels run out to the right. */
export const FIT_MARGIN: FitMargin = { left: 40, top: 28, right: 32, bottom: 40, labelRoom: 0.13 };
/** Clearance between the model and an occluder (px). */
const FIT_CLEARANCE = 14;
/** Vertices sampled per mesh for the screen footprints. */
const FOOTPRINT_SAMPLES = 600;

export class ViewportEngine {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.001, 100);
  backend: RenderBackend = "pending";
  /** Why the renderer is unavailable, when `backend === "none"`. */
  error: string | null = null;
  model: AssemblyModel | null = null;
  /** A page's own camera presets (page 05 frames its module upright); null: the assembly presets. */
  poseFor: ((view: ViewId, width: number, height: number) => ViewPose) | null = null;
  /** Where the contact-shadow floor sits (world y) for a page's own model; null: under the body (`contactFloor`). */
  floorFor: ((all: THREE.Box3, model: AssemblyModel) => number) | null = null;
  /** Body radius (m) the floor shadow's blur scales with, for a page's own model; null: the assembly's body radius. */
  shadowRadiusFor: ((model: AssemblyModel) => number) | null = null;
  /** A page's own fit margins (page 05 fills more of its viewport); null: `FIT_MARGIN`. */
  fitMargin: FitMargin | null = null;

  private readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGPURenderer | null = null;
  private pipeline: THREE.RenderPipeline | null = null;
  private outlinePass: ReturnType<typeof outline> | null = null;
  /** `crispOutline`'s switch: 1 while the selection is non-empty. */
  private outlineOn: { value: number } | null = null;
  /** GTAO strength (1 on; the AO probe renders with 0 for the comparison). */
  private aoStrength: { value: number } | null = null;
  /** Cameras for the GTAO prepass (AO layer only) and the outline (layer 0: no section cap); synced to `camera` per render. */
  private readonly aoCamera = new THREE.PerspectiveCamera();
  private readonly outlineCamera = new THREE.PerspectiveCamera();
  private controls: OrbitControls | null = null;
  private readonly key = new THREE.DirectionalLight(0xfff8f0, STUDIO_RIG.key);
  private readonly ground: THREE.Mesh;
  /** The baked floor (`stage.ts`): the contact shadow (the light pool is a backdrop layer, `poolOnScreen`). */
  private readonly stageTexture = new THREE.DataTexture(new Uint8Array(STAGE_LOOK.resolution * STAGE_LOOK.resolution * 4), STAGE_LOOK.resolution, STAGE_LOOK.resolution, THREE.RGBAFormat, THREE.UnsignedByteType);
  /** Floor shadow strength (1 = the studio's; `setShadowOpacity`). */
  private readonly floorOpacity = uniform(1);
  /** World y of the floor (set when the camera frames). */
  private stageFloor: number | null = null;
  /** Parts moved, hid, or reframed since the last bake. */
  private stageDirty = true;
  /** The last bake (tests and the probe). */
  private stageBake: StageBake | null = null;
  private readonly raycaster = new THREE.Raycaster();
  /** Orbit target (the framed centre); controls adopt it whenever they are created. */
  private readonly target = new THREE.Vector3();
  private readonly listeners = new Set<() => void>();
  private state: EngineState | null = null;
  private framed: { view: ViewId; explode: number; model: AssemblyModel } | null = null;
  /** M3.2 exploded-view tween (explodeAnim.ts) and the camera framings it eases between. */
  private readonly anim = new ExplodeAnimator();
  /** Camera framings at key times of the tween (piecewise-linear in t between them). */
  private camTween: { t: number; pose: CamPose }[] | null = null;
  private animT = 1;
  private dirty = true;
  /** The output probe owns the canvas between its renders (the loop stays idle). */
  private probing = false;
  private disposed = false;
  private size = { w: 1, h: 1 };
  /** Width (px) of overlays on the right edge (the inspector); the model centres in the rest. */
  private insetRight = 0;
  /** Screen rectangles the camera fit keeps the model clear of (inspector, gizmo). */
  private occluders: ScreenRect[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // The view sees the section cap (M3.3); the outline and AO cameras do not.
    this.camera.layers.enable(CAP_LAYER);
    this.raycaster.layers.enableAll();
    // No scene background: the canvas is transparent over the CSS viewport vignette (bg/viewport tokens).
    this.scene.add(new THREE.HemisphereLight(0xe4ecf5, 0x1a1d21, STUDIO_RIG.hemisphere));
    // The floor shadow is baked (`stage.ts`): the key light lights, it casts no shadow map.
    this.key.castShadow = false;
    this.scene.add(this.key, this.key.target);
    const rim = new THREE.DirectionalLight(0xa9c8ff, STUDIO_RIG.rim);
    rim.position.set(-3, 1.5, -2);
    rim.castShadow = false;
    this.scene.add(rim);
    // Studio floor (BC5): a baked soft contact shadow on a quad under the model.
    this.stageTexture.magFilter = THREE.LinearFilter;
    this.stageTexture.minFilter = THREE.LinearFilter;
    this.stageTexture.generateMipmaps = false;
    this.stageTexture.needsUpdate = true;
    // Unlit black with the baked alpha (a basic material would pick up the studio environment).
    const floor = new THREE.NodeMaterial();
    floor.side = THREE.DoubleSide;
    floor.fragmentNode = vec4(0, 0, 0, texture(this.stageTexture).a.mul(this.floorOpacity));
    // Drawn first and without depth writes, so parts that dip below the floor (fin tips) draw over it.
    // Normal blending, spelled out: in the opaque list three only blends `transparent` materials.
    floor.transparent = false;
    floor.depthWrite = false;
    floor.blending = THREE.CustomBlending;
    floor.blendSrc = THREE.SrcAlphaFactor;
    floor.blendDst = THREE.OneMinusSrcAlphaFactor;
    floor.blendSrcAlpha = THREE.OneFactor;
    floor.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    floor.fog = false;
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), floor);
    // +90 deg about x: plane +y runs along world +z, so texture row 0 is the floor's min z (`stage.ts`).
    this.ground.rotation.x = Math.PI / 2;
    this.ground.renderOrder = -1;
    this.ground.name = "rw-studio-floor";
    this.ground.visible = false;
    this.scene.add(this.ground);
  }

  /** Creates the renderer. Never throws: failure leaves backend `none`. */
  async init(): Promise<RenderBackend> {
    try {
      // Stencil: the live section caps (M3.3) count clipped solids in it.
      const renderer = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: true, alpha: true, stencil: true });
      await renderer.init();
      if (this.disposed) {
        renderer.dispose();
        return this.backend;
      }
      renderer.setClearColor(0x000000, 0);
      renderer.toneMapping = THREE.NeutralToneMapping;
      // No shadow maps: the floor shadow is baked (`stage.ts`), creases come from GTAO.
      renderer.shadowMap.enabled = false;
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(this.size.w, this.size.h, false);
      this.renderer = renderer;
      this.backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? "webgpu" : "webgl";
      this.scene.environmentIntensity = STUDIO.envIntensity;
      try {
        // The studio rig (BC5): the panorama plus HDR softboxes; the procedural room is the fallback.
        this.scene.environment = await loadStudioRig();
        this.scene.environmentIntensity = STUDIO_RIG.envIntensity;
        if (this.model) boostGlass(this.model.root, this.scene.environment, STUDIO_RIG.glassReflection);
      } catch {
        try {
          this.scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
        } catch {
          // Lights alone still read as PBR; the environment is a nicety.
        }
      }
      // Unmounted while the environment loaded: dispose() already freed the renderer.
      if (this.disposed) return this.backend;
      try {
        const pipeline = new THREE.RenderPipeline(renderer);
        // Depth + stencil target: the section cap draws where the writers left a non-zero count.
        const depthStencil = new THREE.DepthTexture(1, 1);
        depthStencil.format = THREE.DepthStencilFormat;
        depthStencil.type = THREE.UnsignedInt248Type;
        const scenePass = pass(this.scene, this.camera, { stencilBuffer: true, depthTexture: depthStencil });
        // GTAO (M3.1, RL1 recipe): a single-sampled normal/depth prepass of the opaque parts (AO layer),
        // applied to indirect light only through the AO context.
        const prePass = pass(this.scene, this.aoCamera, { samples: 0 });
        prePass.transparent = false;
        prePass.setMRT(mrt({ output: packNormalToRGB(normalView) }));
        prePass.getTexture("output").type = THREE.UnsignedByteType;
        const prePassNormal = sample((uv) => unpackRGBToNormal(prePass.getTextureNode().sample(uv)));
        const aoPass = ao(prePass.getTextureNode("depth"), prePassNormal, this.aoCamera);
        aoPass.resolutionScale = 0.5;
        aoPass.radius.value = AO_RADIUS_M;
        const strength = uniform(1);
        const aoTerm = aoPass.getTextureNode().sample(screenUV).r;
        scenePass.contextNode = builtinAOContext(float(1).sub(strength).add(aoTerm.mul(strength)));
        this.aoStrength = strength;
        // OutlineNode supplies the selection mask; `crispOutline` draws a hard 2 px teal line from it (no blur, no bloom).
        const o = outline(this.scene, this.outlineCamera, { selectedObjects: [], edgeThickness: uniform(1), edgeGlow: uniform(0) });
        // Keeps the pass alpha so the transparent canvas shows the CSS vignette.
        const crisp = crispOutline(o, vec4(scenePass.rgb, scenePass.a), SELECTION_TEAL);
        pipeline.outputNode = crisp.output;
        this.pipeline = pipeline;
        this.outlinePass = o;
        this.outlineOn = crisp.enabled;
      } catch {
        this.pipeline = null;
        this.aoStrength = null;
      }
      const controls = new OrbitControls(this.camera, this.canvas);
      controls.enableDamping = false;
      controls.target.copy(this.target);
      controls.update();
      controls.addEventListener("change", () => this.invalidate());
      this.controls = controls;
      this.applySelection();
      renderer.setAnimationLoop(() => this.tick());
    } catch (e) {
      this.backend = "none";
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.invalidate();
    return this.backend;
  }

  /** Called after a frame with a camera or scene change. */
  onFrame(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setModel(model: AssemblyModel | null): void {
    if (this.model === model) return;
    if (this.model) {
      // The engine owns the models it is given: free the replaced one's GPU and BVH data.
      this.scene.remove(this.model.root, this.model.overlay);
      this.model.dispose();
    }
    this.model = model;
    this.framed = null;
    if (model) {
      this.scene.add(model.root, model.overlay);
      markAoLayer(model.root);
      boostGlass(model.root, this.scene.environment, STUDIO_RIG.glassReflection);
    }
    if (this.state) this.setState(this.state);
    this.invalidate();
  }

  setState(s: EngineState): void {
    this.state = { ...s, hidden: [...s.hidden], selected: [...s.selected] };
    const m = this.model;
    const target = Number.isFinite(s.explode) ? Math.min(1, Math.max(0, s.explode)) : 0;
    if (m) {
      m.setMarks(s.marks ?? null);
      const f = this.framed;
      const reframe = f === null || f.model !== m || f.view !== s.view;
      if (!reframe && s.explodeAnimate === true && this.renderer !== null && target !== this.anim.target) {
        this.startExplodeTween(target);
      } else if (reframe || target !== this.anim.target || (s.explodeAnimate !== true && this.anim.running)) {
        // Slider drags, view changes, and the first frame jump (a view change mid-tween lands it).
        this.anim.jump(target);
        this.camTween = null;
        this.animT = 1;
      }
      if (m.apply(this.partState(this.anim.value))) this.stageDirty = true;
      if (reframe) this.frame(s.view, false);
      else if (!this.anim.running && this.framed?.explode !== m.explode) this.frame(s.view, true);
    } else {
      this.anim.jump(target);
    }
    if (this.ground.visible !== s.shadows) this.stageDirty = true;
    this.ground.visible = s.shadows;
    this.applySelection();
    this.invalidate();
  }

  resize(w: number, h: number, insetRight = this.insetRight): void {
    this.size = { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
    this.insetRight = Math.min(Math.max(0, insetRight), this.size.w * 0.5);
    this.camera.aspect = this.size.w / this.size.h;
    if (this.anim.running) {
      // A resize mid-tween lands it: the framings it eased between are stale.
      this.anim.jump(this.anim.target);
      this.camTween = null;
      this.animT = 1;
      this.model?.apply(this.partState(this.anim.value));
    }
    this.centreInFreeArea();
    this.renderer?.setSize(this.size.w, this.size.h, false);
    if (this.state && this.model) this.frame(this.state.view, this.framed !== null);
    this.invalidate();
  }

  /** Contact-shadow strength on the floor, relative to the studio's `STUDIO.shadow.opacity`. */
  setShadowOpacity(opacity: number): void {
    this.floorOpacity.value = Math.min(1, Math.max(0, opacity / STUDIO.shadow.opacity));
    this.invalidate();
  }

  /** The last floor bake (grid, shadow alpha, pool), or null before the first frame. */
  stage(): StageBake | null {
    return this.stageBake;
  }

  /**
   * The light pool (the floor ellipse of the last bake) on screen: centre,
   * half axes, and the major axis angle (canvas px, y down; degrees), or
   * null while the floor is off or not baked.
   */
  poolOnScreen(): PoolScreen | null {
    const b = this.stageBake;
    if (!b || !this.ground.visible || this.stageFloor === null) return null;
    const y = this.stageFloor;
    const c = this.project(new THREE.Vector3(b.pool.cx, y, b.pool.cz));
    if (c.z > 1) return null;
    let a = 0;
    let angle = 0;
    const pts: { x: number; y: number }[] = [];
    for (let k = 0; k < 48; k++) {
      const t = (2 * Math.PI * k) / 48;
      const p = this.project(new THREE.Vector3(b.pool.cx + b.pool.rx * Math.cos(t), y, b.pool.cz + b.pool.rz * Math.sin(t)));
      if (p.z > 1) continue;
      pts.push(p);
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d > a) {
        a = d;
        angle = Math.atan2(p.y - c.y, p.x - c.x);
      }
    }
    let bMinor = 0;
    for (const p of pts) bMinor = Math.max(bMinor, Math.abs(-(p.x - c.x) * Math.sin(angle) + (p.y - c.y) * Math.cos(angle)));
    if (!(a > 0) || !(bMinor > 0)) return null;
    return { x: c.x, y: c.y, rx: a, ry: bMinor, angleDeg: (angle * 180) / Math.PI };
  }

  /** Parts the outline pass currently draws (empty without a render pipeline). */
  outlinedParts(): string[] {
    const ids = new Set<string>();
    for (const o of this.outlinePass?.selectedObjects ?? []) {
      const id = this.model?.partOf(o);
      if (id) ids.add(id);
    }
    return [...ids];
  }

  /** The exploded-view tween (M3.2). */
  explodeAnimState(): ExplodeAnimState {
    return { shown: this.model?.explode ?? this.anim.value, target: this.anim.target, running: this.anim.running, paused: this.anim.paused, t: this.animT };
  }

  /**
   * Deterministic capture (M3.2): pins the explode tween at normalised time
   * `t` (0..1), or resumes it on the clock (`null`). Pinning while idle holds
   * the next tween at `t` from its start.
   */
  seekExplode(t: number | null): void {
    this.anim.seek(t);
    this.invalidate();
  }

  /** Whether the studio floor (contact shadow, and with it the light pool) shows. */
  shadowsOn(): boolean {
    return this.ground.visible;
  }

  /** Canvas size in CSS px. */
  viewSize(): { w: number; h: number } {
    return { ...this.size };
  }

  /** Canvas-relative px -> component id. */
  pickAt(x: number, y: number): string | null {
    if (!this.model) return null;
    const ndc = { x: (x / this.size.w) * 2 - 1, y: -(y / this.size.h) * 2 + 1 };
    return pickPart(this.model, this.camera, ndc, this.raycaster);
  }

  /** World point -> canvas px (y down); `z > 1` means behind the camera. */
  project(p: THREE.Vector3): { x: number; y: number; z: number } {
    const v = p.clone().project(this.camera);
    return { x: ((v.x + 1) / 2) * this.size.w, y: ((1 - v.y) / 2) * this.size.h, z: v.z };
  }

  /** Projected centres of the visible parts. */
  screenParts(): ScreenPart[] {
    const m = this.model;
    if (!m) return [];
    const out: ScreenPart[] = [];
    const box = new THREE.Box3();
    const c = new THREE.Vector3();
    const s = new THREE.Sphere();
    for (const p of m.parts.values()) {
      if (!p.node.visible) continue;
      m.partBounds(p.id, box);
      if (box.isEmpty()) continue;
      box.getCenter(c);
      box.getBoundingSphere(s);
      const a = this.project(c);
      if (a.z > 1) continue;
      const dist = this.camera.position.distanceTo(c) || 1;
      // Radius across the axis (world x is the body axis), so the leader starts at the part's surface.
      const across = Math.min(s.radius, Math.max(box.max.y - box.min.y, box.max.z - box.min.z) / 2, 0.03);
      const r = (across / (dist * Math.tan((this.camera.fov * Math.PI) / 360))) * (this.size.h / 2);
      out.push({ id: p.id, x: a.x, y: a.y, r, order: box.min.x });
    }
    return out;
  }

  /**
   * Screen rectangles covering the visible parts: per part, slices along the
   * world X axis, each the screen box of the part's (sampled) mesh vertices
   * in that slice, so fins and tapers are not inflated to their bounding box.
   * Falls back to the slice's cross-section box for a part without vertices.
   */
  partFootprints(maxSlices = 48): (ScreenRect & { id: string })[] {
    const m = this.model;
    if (!m) return [];
    const out: (ScreenRect & { id: string })[] = [];
    const box = new THREE.Box3();
    const p = new THREE.Vector3();
    const { w: W, h: H } = this.size;
    // Parts, plus a page's decorative groups (page 05's aeroshell panels): the fit frames them and labels avoid them.
    const sources: { id: string; node: THREE.Object3D; meshes: readonly THREE.Mesh[] }[] = [...m.parts.values()].map((p) => ({ id: p.id, node: p.node, meshes: p.meshes }));
    for (const d of m.decor) {
      const meshes: THREE.Mesh[] = [];
      d.traverse((o) => o instanceof THREE.Mesh && meshes.push(o));
      sources.push({ id: `decor:${d.name}`, node: d, meshes });
    }
    for (const part of sources) {
      if (!part.node.visible) continue;
      box.setFromObject(part.node, true);
      if (box.isEmpty()) continue;
      const a = this.project(new THREE.Vector3(box.min.x, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2));
      const b = this.project(new THREE.Vector3(box.max.x, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2));
      const n = Math.max(2, Math.min(maxSlices, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 10) + 1));
      const bins = Array.from({ length: n }, () => [Infinity, Infinity, -Infinity, -Infinity]);
      const span = box.max.x - box.min.x;
      let sampled = 0;
      part.node.updateWorldMatrix(true, true);
      for (const mesh of part.meshes) {
        const pos = mesh.geometry.getAttribute("position");
        if (!pos || pos.count === 0) continue;
        const stride = Math.max(1, Math.ceil(pos.count / FOOTPRINT_SAMPLES));
        for (let i = 0; i < pos.count; i += stride) {
          p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
          const k = span > 1e-9 ? Math.min(n - 1, Math.max(0, Math.floor(((p.x - box.min.x) / span) * n))) : 0;
          p.project(this.camera);
          if (p.z > 1) continue;
          const sx = ((p.x + 1) / 2) * W;
          const sy = ((1 - p.y) / 2) * H;
          const bin = bins[k]!;
          bin[0] = Math.min(bin[0]!, sx);
          bin[1] = Math.min(bin[1]!, sy);
          bin[2] = Math.max(bin[2]!, sx);
          bin[3] = Math.max(bin[3]!, sy);
          sampled++;
        }
      }
      if (sampled > 0) {
        for (const [x0, y0, x1, y1] of bins)
          if (Number.isFinite(x0!)) out.push({ id: part.id, x: x0!, y: y0!, w: Math.max(2, x1! - x0!), h: Math.max(2, y1! - y0!) });
        continue;
      }
      for (let i = 0; i < n; i++) {
        const x = THREE.MathUtils.lerp(box.min.x, box.max.x, i / (n - 1));
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const y of [box.min.y, (box.min.y + box.max.y) / 2, box.max.y])
          for (const z of [box.min.z, (box.min.z + box.max.z) / 2, box.max.z]) {
            const s = this.project(p.set(x, y, z));
            if (s.z > 1) continue;
            x0 = Math.min(x0, s.x);
            y0 = Math.min(y0, s.y);
            x1 = Math.max(x1, s.x);
            y1 = Math.max(y1, s.y);
          }
        if (Number.isFinite(x0)) out.push({ id: part.id, x: x0, y: y0, w: Math.max(2, x1 - x0), h: Math.max(2, y1 - y0) });
      }
    }
    return out;
  }

  /**
   * The shared axis in the explode gaps (concept 01's dotted centre line):
   * screen segments between consecutive visible parts of the explode
   * sequence, from one part's aft end to the next one's fore end.
   */
  axisGaps(): [number, number, number, number][] {
    const m = this.model;
    if (!m || m.explode === 0) return [];
    const out: [number, number, number, number][] = [];
    const box = new THREE.Box3();
    let prevAft: number | null = null;
    for (const id of m.plan.order) {
      if (!m.isVisible(id)) continue;
      m.partBounds(id, box);
      if (box.isEmpty()) continue;
      if (prevAft !== null && box.min.x > prevAft + 1e-6) {
        const a = this.project(new THREE.Vector3(prevAft, 0, 0));
        const b = this.project(new THREE.Vector3(box.min.x, 0, 0));
        if (a.z <= 1 && b.z <= 1) out.push([a.x, a.y, b.x, b.y]);
      }
      prevAft = prevAft === null ? box.max.x : Math.max(prevAft, box.max.x);
    }
    return out;
  }

  /**
   * Each visible sequenced part's screen extent along the projected body axis
   * (px from the canvas origin along `axisOnScreen`), with its followers (fins
   * on the fin can, the stowed chute in the bay) counted in, in explode order.
   * Two neighbours overlap on screen exactly when their intervals do (a probe
   * for the explode spacing; every drawn vertex is projected).
   */
  axisIntervals(): { id: string; lo: number; hi: number }[] {
    const m = this.model;
    if (!m) return [];
    const [ux, uy] = this.axisOnScreen();
    const { w: W, h: H } = this.size;
    const p = new THREE.Vector3();
    const span = new Map<string, [number, number]>();
    for (const part of m.parts.values()) {
      if (!m.isVisible(part.id)) continue;
      const anchor = m.plan.order.includes(part.id) ? part.id : m.plan.follows.get(part.id);
      if (anchor === undefined) continue;
      part.node.updateWorldMatrix(true, true);
      const s = span.get(anchor) ?? [Infinity, -Infinity];
      for (const mesh of part.meshes) {
        let drawn = !Array.isArray(mesh.material) && (mesh.material as THREE.Material).visible;
        mesh.traverseAncestors((a) => (drawn &&= a.visible));
        if (!drawn || !mesh.visible) continue;
        const pos = mesh.geometry.getAttribute("position");
        if (!pos) continue;
        for (let i = 0; i < pos.count; i++) {
          p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).project(this.camera);
          if (p.z > 1) continue;
          const d = ((p.x + 1) / 2) * W * ux + ((1 - p.y) / 2) * H * uy;
          s[0] = Math.min(s[0], d);
          s[1] = Math.max(s[1], d);
        }
      }
      if (Number.isFinite(s[0])) span.set(anchor, s);
    }
    return m.plan.order.filter((id) => span.has(id)).map((id) => ({ id, lo: span.get(id)![0], hi: span.get(id)![1] }));
  }

  /** Screen direction (px, y down, unit) of the assembly axis (world +X). */
  axisOnScreen(): [number, number] {
    const b = this.basis();
    const x = b.right[0];
    const y = -b.up[0];
    const l = Math.hypot(x, y);
    return l < 1e-3 ? [0, 0] : [x / l, y / l];
  }

  /** Camera basis in world space (for the gizmo). */
  basis(): { right: Vec3; up: Vec3; back: Vec3 } {
    const e = this.camera.matrixWorld.elements;
    const v = (i: number): Vec3 => {
      const x = e[i]!, y = e[i + 1]!, z = e[i + 2]!;
      const l = Math.hypot(x, y, z) || 1;
      return [x / l, y / l, z / l];
    };
    return { right: v(0), up: v(4), back: v(8) };
  }

  /**
   * Re-applies a preset and auto-fits the camera to the visible (exploded)
   * parts: the assembly fills the viewport inside `FIT_MARGIN` (Iso lays it
   * on the diagonal), clear of the occluders (inspector strip, gizmo). The
   * fit is iterative on the real perspective projection; the final placement
   * is a pure image translation (`setViewOffset`). `keepDir` keeps the
   * current orbit direction.
   */
  frame(view: ViewId, keepDir: boolean): void {
    const m = this.model;
    if (!m) return;
    const box = m.bounds();
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    let dir: THREE.Vector3;
    let up: THREE.Vector3;
    if (keepDir && this.framed) {
      dir = this.camera.position.clone().sub(this.target).normalize();
      up = this.camera.up.clone();
    } else {
      // The diagonal of the area left of the inspector, counting half the inset (the aft end may pass under it).
      const pose = this.poseFor?.(view, this.size.w, this.size.h) ?? viewPose(view, isoTiltFor(this.size.w - this.insetRight / 2, this.size.h));
      dir = new THREE.Vector3(...cameraBasis(pose).back);
      up = new THREE.Vector3(...pose.up);
      // A preset may bring its own lens (Iso: a longer one, so the stack's far end is not dwarfed).
      this.camera.fov = pose.fovDeg ?? FOV;
    }
    const target = sphere.center.clone();
    let dist = fitDistance(sphere.radius, this.camera.fov, this.size.w / this.size.h, 1.08);
    this.camera.up.copy(up);
    this.camera.clearViewOffset();
    const place = () => {
      this.camera.position.copy(target).addScaledVector(dir, dist);
      this.camera.near = dist / 100;
      this.camera.far = dist * 10;
      this.camera.lookAt(target);
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld(true);
    };
    place();
    const { w: W, h: H } = this.size;
    const mg = this.fitMargin ?? FIT_MARGIN;
    const right = mg.right + Math.min(140, mg.labelRoom * W);
    const rect = { x: mg.left, y: mg.top, w: Math.max(40, W - mg.left - right), h: Math.max(40, H - mg.top - mg.bottom) };
    const camRight = new THREE.Vector3();
    const camUp = new THREE.Vector3();
    // Scale and centre on the projected footprint (a few rounds converge under perspective).
    for (let i = 0; i < 5; i++) {
      const b = unionRect(this.partFootprints(16));
      if (!b) break;
      const worldPerPx = (2 * dist * Math.tan((this.camera.fov * Math.PI) / 360)) / H;
      camRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
      camUp.setFromMatrixColumn(this.camera.matrixWorld, 1);
      target.addScaledVector(camRight, (b.x + b.w / 2 - W / 2) * worldPerPx).addScaledVector(camUp, -(b.y + b.h / 2 - H / 2) * worldPerPx);
      dist /= Math.min(rect.w / b.w, rect.h / b.h);
      place();
    }
    // Largest scale and an alignment in the rect clear of the occluders (fit.ts), then verify on the real projection.
    let offset = { x: 0, y: 0 };
    const baseDist = dist;
    const fp0 = this.partFootprints(24);
    const plan = fitPlacement(fp0, rect, this.occluders, FIT_CLEARANCE);
    let scale = plan.scale;
    for (let attempt = 0; attempt < 8; attempt++) {
      dist = baseDist / scale;
      place();
      const fp = this.partFootprints(24);
      const b = unionRect(fp);
      if (!b) break;
      const [tx, ty] = alignOffset(b, rect, plan.ax, plan.ay);
      offset = { x: -tx, y: -ty };
      if (!plan.clear || footprintClear(fp, tx, ty, this.occluders, FIT_CLEARANCE)) break;
      // Perspective drift: re-place at this scale, else step down a little.
      const again = fitPlacement(fp, rect, this.occluders, FIT_CLEARANCE, { minScale: 1 });
      if (again.clear) {
        const [tx2, ty2] = alignOffset(b, rect, again.ax, again.ay);
        offset = { x: -tx2, y: -ty2 };
        break;
      }
      scale *= 0.98;
    }
    if (Math.abs(offset.x) > 0.01 || Math.abs(offset.y) > 0.01) {
      this.camera.setViewOffset(W, H, offset.x, offset.y, W, H);
      this.camera.updateProjectionMatrix();
    }
    this.target.copy(target);
    if (this.controls) {
      this.controls.target.copy(target);
      this.controls.update();
    }
    this.placeStage(m.bounds(new THREE.Box3()), sphere);
    this.framed = { view, explode: m.explode, model: m };
  }

  /** Screen rectangles (canvas px) the fit keeps the model clear of. */
  setOccluders(rects: readonly { x: number; y: number; w: number; h: number }[]): void {
    this.occluders = rects.map((r) => ({ ...r }));
  }

  /**
   * Places the camera at `position` looking at `target` (body frame, metres;
   * the loader's body -> Y-up rotation is applied here). The preset stays
   * the current view, so the next toolbar view change reframes.
   */
  setCamera(position: Vec3 | undefined, target: Vec3 | undefined): void {
    const toWorld = ([x, y, z]: Vec3) => new THREE.Vector3(x, z, -y);
    if (target) this.target.copy(toWorld(target));
    if (position) this.camera.position.copy(toWorld(position));
    const dist = this.camera.position.distanceTo(this.target) || 1;
    this.centreInFreeArea();
    this.camera.near = dist / 100;
    this.camera.far = dist * 10;
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    if (this.controls) {
      this.controls.target.copy(this.target);
      this.controls.update();
    }
    if (this.model && this.state) this.framed = { view: this.state.view, explode: this.model.explode, model: this.model };
    this.invalidate();
  }

  /** Adapter label for `viewport_render` (`vendor architecture`, or the backend name). */
  adapterLabel(): string {
    const info = (this.renderer?.backend as { adapter?: { info?: { vendor?: string; architecture?: string; description?: string } } } | undefined)?.adapter?.info;
    const label = [info?.vendor, info?.architecture].filter((x) => x).join(" ") || info?.description || "";
    return label || (this.backend === "webgpu" ? "webgpu" : "webgl2");
  }

  /**
   * Renders a frame now and reads the canvas back as a PNG (the tone-mapped
   * sRGB output the user sees; never the linear RT), composited over the
   * viewport vignette the canvas is transparent against. The read happens in
   * the same task as the render, while the swap-chain texture is current.
   * `width`/`height` scale the image (aspect kept by letterboxing).
   */
  capturePng(width?: number, height?: number): { png_base64: string; width: number; height: number } {
    if (!this.renderer) throw new Error(this.error ?? "no renderer");
    this.renderFrame();
    const src = this.canvas;
    const w = Math.round(width ?? src.width);
    const h = Math.round(height ?? src.height);
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const g = out.getContext("2d");
    if (!g) throw new Error("no 2d context for the capture");
    const css = getComputedStyle(src);
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, css.getPropertyValue("--rw-bg-viewport-top").trim() || "#22282c");
    bg.addColorStop(1, css.getPropertyValue("--rw-bg-viewport-bottom").trim() || "#171c20");
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    const k = Math.min(w / src.width, h / src.height);
    // The light pool backdrop layer (as `AssemblyViewport` draws it under the canvas).
    const pool = this.poolOnScreen();
    if (pool) {
      const sx = (src.width / this.size.w) * k;
      g.save();
      g.translate((w - src.width * k) / 2 + pool.x * sx, (h - src.height * k) / 2 + pool.y * sx);
      g.rotate((pool.angleDeg * Math.PI) / 180);
      g.scale(pool.rx * sx, pool.ry * sx);
      const rg = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      for (const [at, a] of POOL_GRADIENT) rg.addColorStop(at, `rgba(255,255,255,${a})`);
      g.fillStyle = rg;
      g.beginPath();
      g.arc(0, 0, 1, 0, 2 * Math.PI);
      g.fill();
      g.restore();
    }
    const dw = src.width * k;
    const dh = src.height * k;
    g.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
    const url = out.toDataURL("image/png");
    return { png_base64: url.slice(url.indexOf(",") + 1), width: w, height: h };
  }

  /**
   * `capturePng` in a render-loop frame that started after the call, so the
   * image is drawn with the camera as it is now (`renderFrame.ts`
   * `freshCapture`): `viewport_render` right after `viewport_set_camera`
   * never returns the previous camera's picture.
   */
  captureFresh(width?: number, height?: number): Promise<{ png_base64: string; width: number; height: number }> {
    const r = this.renderer;
    if (!r) return Promise.reject(new Error(this.error ?? "no renderer"));
    return freshCapture(() => r.info.frame, () => this.capturePng(width, height));
  }

  /**
   * Resolves once the render loop has started a new frame (`renderFrame.ts`):
   * three draws each pass once per frame, so a probe render after it redraws
   * every pass with what the probe toggled.
   */
  private freshFrame(): Promise<void> {
    const r = this.renderer;
    return r ? nextRenderFrame(() => r.info.frame) : Promise.resolve();
  }

  /**
   * Output probes (M3.1 verify) on the final tone-mapped canvas: renders the
   * current frame three ways (as shown, catcher hidden, catcher hidden and no
   * outline), reads each back, and restores the state. Each render starts a
   * new render-loop frame (three reuses a frame's passes; B7e) and shares a
   * task with its read (a WebGPU canvas only reads back its first render per
   * task). Null without a render pipeline.
   */
  async probeOutput(): Promise<OutputProbe | null> {
    if (!this.renderer || !this.pipeline || !this.outlinePass) return null;
    const pipeline = this.pipeline;
    const o = this.outlinePass;
    const render = async () => {
      await this.freshFrame();
      if (this.stageDirty && this.ground.visible) this.bakeStage();
      this.syncCameras();
      pipeline.render();
      return readCanvas(this.canvas);
    };
    const groundWas = this.ground.visible;
    const selection = [...o.selectedObjects];
    this.probing = true;
    try {
      // Warm-up: the first render after a layout change uploads the floor bake and the transmission
      // buffers; read the frame after it, so the three readbacks differ only by what they toggle.
      await render();
      const full = await render();
      this.ground.visible = false;
      const noGround = await render();
      this.setOutlined([]);
      const bare = await render();
      const css = getComputedStyle(this.canvas);
      // sRGB 0-255 (`getHex` converts back from three's linear working space).
      const bg = new THREE.Color(css.getPropertyValue("--rw-bg-viewport-top").trim() || "#22282c").getHex();
      return analyzeOutput(full, noGround, bare, SELECTION_TEAL, [(bg >> 16) & 255, (bg >> 8) & 255, bg & 255]);
    } finally {
      this.probing = false;
      this.ground.visible = groundWas;
      this.setOutlined(selection);
      this.invalidate();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.controls?.dispose();
    if (this.renderer) {
      this.renderer.setAnimationLoop(null);
      this.renderer.dispose();
    }
    this.pipeline?.dispose();
    this.model?.dispose();
  }

  /**
   * GTAO probe (M3.1 verify): renders the frame with and without the AO term
   * and counts pixels it darkens by more than 2 levels (final tone-mapped
   * output). Null without the pipeline.
   */
  async probeAO(): Promise<{ darkened: number; meanDelta: number; maxDelta: number } | null> {
    if (!this.renderer || !this.pipeline || !this.aoStrength) return null;
    const pipeline = this.pipeline;
    const strength = this.aoStrength;
    const luma = (d: Uint8ClampedArray, i: number) => 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
    this.probing = true;
    try {
      // Each render in a new render-loop frame, so the AO pass redraws with the strength set (B7e).
      await this.freshFrame();
      this.syncCameras();
      strength.value = 1;
      pipeline.render();
      const on = readCanvas(this.canvas);
      await this.freshFrame();
      strength.value = 0;
      pipeline.render();
      const off = readCanvas(this.canvas);
      let darkened = 0;
      let sum = 0;
      let maxDelta = 0;
      for (let i = 0; i < on.data.length; i += 4) {
        const delta = luma(off.data, i) - luma(on.data, i);
        if (delta > 2) {
          darkened++;
          sum += delta;
          maxDelta = Math.max(maxDelta, delta);
        }
      }
      return { darkened, meanDelta: darkened > 0 ? sum / darkened : 0, maxDelta };
    } finally {
      strength.value = 1;
      this.probing = false;
      this.invalidate();
    }
  }

  /**
   * "Render still" (M3.4): path-traces the current view (parts, detail,
   * explode, hidden set, section) in a separate offscreen renderer; the live
   * view keeps running. Visual tier, never bar evidence (D26).
   */
  async renderStill(req: Omit<StillRequest, "section"> & { section?: boolean }): Promise<StillOutput> {
    const m = this.model;
    if (!m) throw new Error("no model loaded");
    if (this.backend !== "webgpu") throw new Error("Render still needs WebGPU");
    const { renderStill } = await import("../render/still.ts");
    this.camera.updateMatrixWorld(true);
    return renderStill(m, this.camera, { ...req, section: req.section ?? m.section });
  }

  /** Live section caps (M3.3): writer and cap state, for the probe. */
  sectionCaps(): ReturnType<AssemblyModel["caps"]["stats"]> | null {
    return this.model?.caps.stats() ?? null;
  }

  /**
   * Cut-face pixels (M3.3 verify): renders with and without the cap quad and
   * counts the pixels it changes (final output). Null without a renderer.
   */
  async probeCapPixels(): Promise<number | null> {
    const m = this.model;
    if (!this.renderer || !m) return null;
    const was = m.caps.cap.visible;
    this.probing = true;
    try {
      // Each render in a new render-loop frame, so the scene pass redraws with the cap toggled (B7e).
      await this.freshFrame();
      m.caps.cap.visible = was;
      this.renderFrame();
      const on = readCanvas(this.canvas);
      await this.freshFrame();
      m.caps.cap.visible = false;
      this.renderFrame();
      const off = readCanvas(this.canvas);
      let n = 0;
      for (let i = 0; i < on.data.length; i += 4) {
        const d = Math.abs(on.data[i]! - off.data[i]!) + Math.abs(on.data[i + 1]! - off.data[i + 1]!) + Math.abs(on.data[i + 2]! - off.data[i + 2]!);
        if (d > 12) n++;
      }
      return n;
    } finally {
      m.caps.cap.visible = was;
      this.probing = false;
      this.invalidate();
    }
  }

  // ---- internals --------------------------------------------------------------

  /** Renders one frame through the pipeline (or plainly), with the helper cameras synced. */
  private renderFrame(): void {
    if (!this.renderer) return;
    if (this.stageDirty && this.ground.visible) this.bakeStage();
    this.syncCameras();
    if (this.pipeline) this.pipeline.render();
    else this.renderer.render(this.scene, this.camera);
  }

  private syncCameras(): void {
    for (const [cam, mask] of [
      [this.aoCamera, 1 << AO_LAYER],
      [this.outlineCamera, 1],
    ] as const) {
      cam.copy(this.camera, false);
      cam.layers.mask = mask;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
    }
  }

  private partState(explode: number) {
    const s = this.state;
    return { explode, hidden: s?.hidden ?? [], showInternals: s?.showInternals ?? false, section: s?.section ?? false };
  }

  private camPose(): CamPose {
    const v = this.camera.view;
    return {
      position: this.camera.position.clone(),
      target: this.target.clone(),
      up: this.camera.up.clone(),
      offset: v?.enabled ? { x: v.offsetX, y: v.offsetY } : null,
    };
  }

  private setCamPose(p: CamPose): void {
    this.camera.position.copy(p.position);
    this.camera.up.copy(p.up);
    this.target.copy(p.target);
    const dist = this.camera.position.distanceTo(this.target) || 1;
    this.camera.near = dist / 100;
    this.camera.far = dist * 10;
    this.camera.lookAt(this.target);
    if (p.offset) this.camera.setViewOffset(this.size.w, this.size.h, p.offset.x, p.offset.y, this.size.w, this.size.h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    if (this.controls) {
      this.controls.target.copy(this.target);
      this.controls.update();
    }
  }

  /**
   * Starts the explode tween (M3.2): frames the M3.0 layout at a few key
   * times of the eased tween (keeping the view direction), then eases parts
   * and camera from where they are now, so every in-between frame stays
   * framed (the explode-to-offset map is not linear, so two end framings
   * alone would clip the ends mid-tween).
   */
  private startExplodeTween(to: number): void {
    const m = this.model;
    const s = this.state;
    if (!m || !s) return;
    const fromValue = this.anim.value;
    const from = this.camPose();
    const keys: { t: number; pose: CamPose }[] = [{ t: 0, pose: from }];
    for (const t of CAMERA_KEY_TIMES) {
      m.apply(this.partState(explodeAt(fromValue, to, t)));
      this.frame(s.view, true);
      keys.push({ t, pose: this.camPose() });
    }
    this.anim.start(to);
    m.apply(this.partState(this.anim.value));
    this.setCamPose(from);
    this.camTween = keys;
    this.animT = 0;
  }

  /** Advances the explode tween one frame (no-op when idle or when the pinned time has not moved). */
  private stepExplode(): void {
    if (!this.anim.running) return;
    const m = this.model;
    const fr = this.anim.step();
    if (!m) return;
    if (fr.t === this.animT && fr.running && m.explode === fr.value) return;
    this.animT = fr.t;
    if (m.apply(this.partState(fr.value))) this.stageDirty = true;
    const keys = this.camTween;
    if (keys) {
      const t = fr.running ? fr.t : 1;
      let i = 0;
      while (i < keys.length - 2 && t > keys[i + 1]!.t) i++;
      const a = keys[i]!;
      const b = keys[i + 1]!;
      const k = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t || 1)));
      const lerp = (u: THREE.Vector3, v: THREE.Vector3) => u.clone().lerp(v, k);
      const ao = a.pose.offset;
      const bo = b.pose.offset;
      const off = ao || bo ? { x: THREE.MathUtils.lerp(ao?.x ?? 0, bo?.x ?? 0, k), y: THREE.MathUtils.lerp(ao?.y ?? 0, bo?.y ?? 0, k) } : null;
      this.setCamPose({ position: lerp(a.pose.position, b.pose.position), target: lerp(a.pose.target, b.pose.target), up: lerp(a.pose.up, b.pose.up).normalize(), offset: off });
      if (!fr.running) this.camTween = null;
    }
    if (!fr.running && this.framed) this.framed = { ...this.framed, explode: m.explode };
    this.dirty = true;
  }

  private placeStage(box: THREE.Box3, sphere: THREE.Sphere): void {
    const r = sphere.radius;
    // The floor sits a little under the body (`contactFloor`), not under the fin tips,
    // so the shadow pools under the model instead of a fin-span lower (a detached diagonal copy).
    this.stageFloor = this.floorFor && this.model ? this.floorFor(box, this.model) : this.model ? contactFloor(this.model, box) : box.min.y;
    this.stageDirty = true;
    this.key.position.copy(sphere.center).add(new THREE.Vector3(...STUDIO_RIG.keyDir).multiplyScalar(3 * r));
    this.key.target.position.copy(sphere.center);
    this.key.target.updateMatrixWorld();
  }

  /**
   * Bakes the floor (`stage.ts`) from the visible, drawn triangles at their
   * current (exploded) positions, and fits the floor quad to its grid.
   */
  private bakeStage(): void {
    this.stageDirty = false;
    const m = this.model;
    if (!m || this.stageFloor === null) return;
    m.root.updateMatrixWorld(true);
    const tris = drawnTriangles(m.root, STAGE_MAX_TRIANGLES);
    const bake = bakeStage(tris, this.stageFloor, Math.max(1e-3, this.shadowRadiusFor ? this.shadowRadiusFor(m) : m.plan.diameter / 2));
    this.stageBake = bake;
    if (!bake) return;
    const { grid } = bake;
    const tex = this.stageTexture;
    (tex.image as { data: Uint8Array }).data.set(bake.rgba);
    tex.needsUpdate = true;
    this.ground.position.set(grid.x0 + (grid.nx * grid.cell) / 2, this.stageFloor, grid.z0 + (grid.nz * grid.cell) / 2);
    this.ground.scale.set(grid.nx * grid.cell, grid.nz * grid.cell, 1);
    this.ground.updateMatrixWorld(true);
  }

  /** Optical centre shifted left by half the right inset (the model centres in the free area). */
  private centreInFreeArea(): void {
    if (this.insetRight > 0) this.camera.setViewOffset(this.size.w, this.size.h, this.insetRight / 2, 0, this.size.w, this.size.h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  private applySelection(): void {
    if (!this.outlinePass || !this.model || !this.state) return;
    const sel = new Set(this.state.selected);
    const objs: THREE.Object3D[] = [];
    for (const p of this.model.parts.values()) if (sel.has(p.id) && p.node.visible) objs.push(...p.meshes);
    this.setOutlined(objs);
  }

  private setOutlined(objs: THREE.Object3D[]): void {
    if (!this.outlinePass) return;
    this.outlinePass.selectedObjects = objs;
    if (this.outlineOn) this.outlineOn.value = objs.length > 0 ? 1 : 0;
  }

  private invalidate(): void {
    this.dirty = true;
    // Without a render loop, listeners still need to hear about the change.
    if (this.renderer === null && !this.disposed) queueMicrotask(() => this.notify());
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  private tick(): void {
    if (this.probing) return;
    this.stepExplode();
    if (!this.dirty || !this.renderer) return;
    this.dirty = false;
    try {
      this.renderFrame();
    } catch (e) {
      if (this.pipeline) {
        // Keep the plain scene render if the post pipeline cannot compile here.
        this.pipeline = null;
        this.outlinePass = null;
        this.dirty = true;
      } else {
        this.error = e instanceof Error ? e.message : String(e);
      }
    }
    this.notify();
  }
}

/**
 * World height of the contact-shadow catcher: just under the body. The
 * median of the visible parts' lowest points is the body tube's underside
 * (fins and other outliers are a minority), less `STUDIO_RIG.floorGap` of it.
 */
export function contactFloor(model: AssemblyModel, all: THREE.Box3): number {
  const bottoms: number[] = [];
  const b = new THREE.Box3();
  for (const p of model.parts.values()) {
    if (!p.node.visible) continue;
    model.partBounds(p.id, b);
    if (!b.isEmpty()) bottoms.push(b.min.y);
  }
  if (bottoms.length === 0) return all.min.y;
  bottoms.sort((x, y) => x - y);
  const median = bottoms[Math.floor(bottoms.length / 2)]!;
  return median - Math.abs(median) * STUDIO_RIG.floorGap;
}

/**
 * Scales the environment reflection of clear glass under `root` (once per
 * material): the studio rig's room is darker than the panorama, and the bay
 * glass should still read as bright, reflective polycarbonate (concept 01).
 */
export function boostGlass(root: THREE.Object3D, env: THREE.Texture | null, gain: number): void {
  if (!env) return;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material]) as THREE.MeshPhysicalNodeMaterial[]) {
      if (m.userData["rwGlass"] !== true || m.envMap === env) continue;
      // The material's own env map: its `envMapIntensity` applies (the scene environment ignores it).
      const base = (m.userData["rwGlassEnv"] as number | undefined) ?? m.envMapIntensity;
      m.userData["rwGlassEnv"] = base;
      m.envMap = env;
      m.envMapIntensity = base * gain;
      m.needsUpdate = true;
    }
  });
}

/**
 * Puts every opaque mesh under `root` on the GTAO layer as well (M3.1): clear
 * transmissive parts, the section writers, and the cap stay off it.
 */
export function markAoLayer(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o.userData["rwSectionWriter"] === true) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const clear = mats.some((m: THREE.Material) => m.userData["rwClear"] === true && ((m as THREE.MeshPhysicalMaterial).transmission ?? 0) > 0);
    if (!clear) o.layers.enable(AO_LAYER);
  });
}

/** Upper bound on triangles fed to the floor bake (evenly subsampled beyond it). */
const STAGE_MAX_TRIANGLES = 120_000;

/**
 * World-space triangles (9 floats each) of every mesh under `root` that is
 * drawn: visible up the chain, with a visible material. Clear glass and the
 * section writers are skipped (the bay's contents and caps cast instead).
 */
export function drawnTriangles(root: THREE.Object3D, maxTriangles = STAGE_MAX_TRIANGLES): Float32Array {
  const meshes: { mesh: THREE.Mesh; count: number }[] = [];
  let total = 0;
  const visit = (o: THREE.Object3D) => {
    if (!o.visible) return;
    if (o instanceof THREE.Mesh && o.userData["rwSectionWriter"] !== true) {
      const mats = (Array.isArray(o.material) ? o.material : [o.material]) as THREE.Material[];
      const drawn = mats.some((mt) => mt.visible && mt.colorWrite !== false && mt.userData["rwGlass"] !== true && !(mt.userData["rwClear"] === true && (mt as THREE.MeshPhysicalMaterial).transmission > 0));
      const g = o.geometry as THREE.BufferGeometry;
      const pos = g.getAttribute("position");
      if (drawn && pos) {
        const count = g.index ? Math.floor(g.index.count / 3) : Math.floor(pos.count / 3);
        meshes.push({ mesh: o, count });
        total += count;
      }
    }
    for (const c of o.children) visit(c);
  };
  visit(root);
  const step = Math.max(1, Math.ceil(total / Math.max(1, maxTriangles)));
  const out = new Float32Array(Math.ceil(total / step) * 9 + 9 * meshes.length);
  let n = 0;
  const v = new THREE.Vector3();
  for (const { mesh, count } of meshes) {
    const g = mesh.geometry as THREE.BufferGeometry;
    const pos = g.getAttribute("position");
    const idx = g.index;
    for (let t = 0; t < count; t += step) {
      for (let k = 0; k < 3; k++) {
        const i = idx ? idx.getX(3 * t + k) : 3 * t + k;
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        out[n++] = v.x;
        out[n++] = v.y;
        out[n++] = v.z;
      }
    }
  }
  return out.subarray(0, n);
}
