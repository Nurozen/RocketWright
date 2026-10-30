/**
 * The page 06 visual flow viewport (M5.2/M5.3, FID-06): one WebGPU scene
 * on the page 01 studio (rig environment, soft contact shadow on the floor,
 * light pool) with the cutaway (`cutaway.ts`: opaque brushed shell opened
 * by a wedge section with capped cut faces, frames, aft bulkhead, clear
 * domed tank, plumbed feed line, engine on the bulkhead), the MLS-MPM liquid
 * (`mpm.ts`) and its reconstructed surface (`surface.ts`: the tank below a
 * free-surface plane fitted over the particles' top layer, `freeSurface.ts`,
 * read back a few times a second and eased, so it sloshes, with a ripple
 * capped and gentle, from the slosh: one smooth surface), the feed line,
 * valve, engine inlet, chamber, and nozzle (`layout.ts`), and the white
 * illustrative streamlines (`streamlines.ts`). Each frame reads the study
 * state at the transport time (`timeline.ts`): the vehicle tilts, the
 * liquid settles along the body-frame specific force and drains to the
 * engineering run's fill fraction, and the streamlines run with the
 * relative flow.
 *
 * Frames: the vehicle group is the body frame (+X aft, +Z up, metres,
 * origin at the tank centre); world is three.js Y-up with gravity -Y. A
 * vertical vehicle has body X = world -Y, body Z = world +X; the tilt
 * rotates it about world Z, so a tilt θ gives the specific force
 * g (-cos θ, 0, sin θ) the study writes.
 *
 * WebGPU only (I11): `create` throws on a WebGL2 or fallback adapter.
 * Visual tier only (I13).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- TSL node graphs are untyped at this level */
import * as TSL from "three/tsl";
import * as THREE from "three/webgpu";
import { loadStudioRig, STUDIO_RIG } from "../viewport/lighting.ts";
import { POOL_GRADIENT } from "../viewport/stage.ts";
import { buildCutaway, cutawayMaterials, type CutawayParts } from "./cutaway.ts";
import { bakeContactFloor, CONTACT_LOOK, type FloorBake } from "./floor.ts";
import { FluidSim, PARTICLE_STRIDE } from "./mpm.ts";
import { cutawayLayout, type CutawayLayout } from "./layout.ts";
import { arcLengths, pointAt, streamlines, type Streamline } from "./streamlines.ts";
import { angleBetween, belowPlane, easeNormal, fitSurface, planeOffsetForFill, tankLattice, upOf, waveAmplitude, type SurfacePlane } from "./freeSurface.ts";
import { fluidSurface, type FluidSurface } from "./surface.ts";
import { centreOfMass, fillOf, fluidGrid, tankSdf, tankShape, type FluidGrid, type TankGeometry, type TankShape, type Vec3 } from "./tankSdf.ts";
import { sampleAt, type TimelineState, type VisualRun } from "./timeline.ts";

type N = any;

/** TSL builders, untyped: the node graphs here outgrow the published overloads. */
const {
  float,
  mix,
  positionLocal,
  select,
  smoothstep,
  texture,
  uniform,
  uv,
  vec3,
  vec4,
} = TSL as N;

export interface StageLayers {
  shell: boolean;
  section: boolean;
  flow: boolean;
  labels: boolean;
}

export const DEFAULT_LAYERS: StageLayers = { shell: true, section: true, flow: true, labels: true };

export type AnchorId = "liquid" | "feed" | "inlet" | "nozzle";

export interface StageOverlay {
  /** Canvas CSS px, or null when behind the camera. */
  anchors: Record<AnchorId, [number, number] | null>;
  /** Body axes as seen by the camera: unit 2D directions (x right, y down) and depth toward the viewer. */
  axes: { axis: "X" | "Y" | "Z"; x: number; y: number; depth: number }[];
  /** The studio light pool on screen (canvas CSS px), or null while the floor is off. */
  pool: PoolScreen | null;
}

/** The light pool's ellipse on screen (canvas px, y down), as page 01 draws it. */
export interface PoolScreen {
  x: number;
  y: number;
  rx: number;
  ry: number;
  angleDeg: number;
}

export interface GpuInfo {
  backend: "webgpu" | "webgl2";
  vendor: string;
  architecture: string;
  isFallbackAdapter: boolean | null;
}

export interface FluidReadback {
  active: number;
  /** Fill fraction of the particles inside the tank. */
  fill: number;
  /** Fraction of active particles inside the tank wall (within one cell). */
  inside: number;
  /** Liquid centre of mass, tank (body) frame, metres. */
  com: Vec3;
}

export interface StageStats {
  frames: number;
  /** Frames per second over the last full second. */
  fps: number;
  /** Mean fps since the stats were reset. */
  meanFps: number;
  particles: number;
  active: number;
  fill: number;
  state: TimelineState | null;
}

export interface StageOptions {
  /** Load the studio environment (default true). */
  environment?: boolean;
  /** Draw the raw particles instead of the surface (development aid; never in the product). */
  debugParticles?: boolean;
}

/** A thumbnail framed on one body segment, turned upright (nose up) and filling the height. */
export interface SnapshotFit {
  /** Body-frame end points (fore, aft) of the segment. */
  from: Vec3;
  to: Vec3;
  /** Fraction of the output height the segment spans. */
  fill: number;
}

/** Transport input the stage reads each frame. */
export interface ClockSource {
  /** Study time, s. */
  time(): number;
  /** Bumps on every seek (scrub, study change, reset); the liquid re-settles. */
  seekId(): number;
}

/**
 * The page 01 rig, lifted for this view: the cutaway is mostly metal seen
 * from the side (page 01's key strip runs along a horizontal body), so the
 * environment and key are scaled up to keep the brushed skin silver.
 */
export const STAGE_LIGHT = { env: 1.7, key: 1.6, fill: 0.9 } as const;

/**
 * Concept 06 framing: at the study's mean tilt, the tank's fore dome apex
 * and the nozzle exit land at these viewport points (NDC, x right scaled by
 * the aspect, y up), seen along `view` (world, from the target), the
 * camera rolled by `rollDeg` so the vehicle crosses at concept 06's shallower
 * angle (about 35 degrees below the horizontal).
 */
export const FRAME = { tiltDeg: 50, fore: [-0.88, 0.58] as [number, number], exit: [0.56, -0.6] as [number, number], view: [0.3, 0.3, 1] as [number, number, number], rollDeg: -12 } as const;

/** Which cutaway parts draw for the layers. */
export interface PartVisibility {
  shellFull: boolean;
  shellCut: boolean;
  tank: boolean;
  flow: boolean;
  feedFull: boolean;
  feedCut: boolean;
  fittings: boolean;
  engineFull: boolean;
  engineCut: boolean;
  feedCore: boolean;
}

/**
 * The parts each layer set draws. The section view cuts the shell, feed
 * line, and engine with the same wedge (R20-06: the chamber, throat, and
 * bell interior open to the camera, solid metal outside); without it every
 * part is whole. Inside an uncut shell nothing of the tank shows (and the
 * ray-marched box would poke through it).
 */
export function partVisibility(layers: StageLayers): PartVisibility {
  const { shell, section, flow } = layers;
  const open = !shell || section;
  return {
    shellFull: shell && !section,
    shellCut: shell && section,
    tank: open,
    flow: flow && open,
    feedFull: !section && !shell,
    feedCut: section,
    fittings: open,
    engineFull: !section,
    engineCut: section,
    feedCore: open,
  };
}

export class FluidStage {
  readonly renderer: THREE.WebGPURenderer;
  readonly gpu: GpuInfo;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(28, 1, 0.01, 50);
  readonly layout: CutawayLayout;
  readonly shape: TankShape;
  readonly grid: FluidGrid;
  readonly fluid: FluidSim;
  private readonly surface: FluidSurface;
  private feedCore: THREE.Mesh | null = null;
  private cutaway: CutawayParts | null = null;
  private readonly floorTexture = new THREE.DataTexture(new Uint8Array(CONTACT_LOOK.resolution * CONTACT_LOOK.resolution * 4), CONTACT_LOOK.resolution, CONTACT_LOOK.resolution, THREE.RGBAFormat, THREE.UnsignedByteType);
  private readonly floor: THREE.Mesh;
  private floorY: number | null = null;
  private floorBake: FloorBake | null = null;
  private floorTilt = Number.NaN;
  private floorAge = 0;
  private proxies: THREE.BufferGeometry[] = [];
  private readonly vehicle = new THREE.Group();
  private readonly parts: { shellFull: THREE.Object3D; shellCut: THREE.Object3D; tank: THREE.Object3D; flow: THREE.Object3D; arrows: THREE.InstancedMesh };
  private readonly lines: { s: Streamline; lengths: number[]; arrowFrom: number }[];
  private readonly flowU: { time: N; flow: N; opacity: N; engineXray: N };
  private run: VisualRun;
  private clock: ClockSource;
  private layers: StageLayers = { ...DEFAULT_LAYERS };
  private lastSeek = -1;
  private last = 0;
  private frameTimes: number[] = [];
  private statFrames = 0;
  private statStart = 0;
  private frames = 0;
  private state: TimelineState | null = null;
  private onOverlay: ((o: StageOverlay) => void) | null = null;
  private snapReq: { w: number; h: number; zoom: number; bg: readonly [string, string]; fit: SnapshotFit | null; resolve: (png: string) => void } | null = null;
  private running = false;
  private animTime = 0;
  /** The free surface (tank frame): eased toward the latest particle fit. */
  private readonly lattice: Float32Array;
  private plane: SurfacePlane = { normal: [0, 0, 1], offset: 0 };
  private fitTarget: Vec3 | null = null;
  /** The drawn ripple amplitude (m), eased toward the slosh's. */
  private waveAmp = 0;
  private fitPending = false;
  private lastFit = 0;
  private rippleTime = 0;

  private constructor(renderer: THREE.WebGPURenderer, gpu: GpuInfo, run: VisualRun, clock: ClockSource, env: THREE.Texture | null, opts: StageOptions) {
    this.renderer = renderer;
    this.gpu = gpu;
    this.run = run;
    this.clock = clock;
    const tank = run.tank as TankGeometry;
    this.shape = tankShape(tank);
    this.grid = fluidGrid(this.shape, run.tank.fill0);
    this.layout = cutawayLayout(run);
    this.fluid = new FluidSim(this.grid, this.shape);
    this.surface = fluidSurface(this.shape);
    this.lattice = tankLattice(this.shape);

    const scene = this.scene;
    // The page 01 studio (`viewport/lighting.ts`): the baked rig environment plus its direct lights.
    if (env) {
      scene.environment = env;
      scene.environmentIntensity = STUDIO_RIG.envIntensity * STAGE_LIGHT.env;
    }
    scene.add(new THREE.HemisphereLight(0xe4ecf5, 0x1a1d21, STUDIO_RIG.hemisphere));
    const key = new THREE.DirectionalLight(0xfff8f0, STUDIO_RIG.key * STAGE_LIGHT.key);
    key.position.set(...STUDIO_RIG.keyDir);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xa9c8ff, STUDIO_RIG.rim);
    rim.position.set(-3, 1.5, -2);
    scene.add(rim);
    // A low fill from the camera side, so the bell's and shell's undersides read as metal, not black.
    const fill = new THREE.DirectionalLight(0xdde7ef, STAGE_LIGHT.fill);
    fill.position.set(2.5, -1.2, 2.5);
    scene.add(fill);
    this.surface.light.value.copy(key.position).normalize();

    // Studio floor: the baked soft contact shadow on a quad (`floor.ts`), as on page 01.
    this.floorTexture.magFilter = THREE.LinearFilter;
    this.floorTexture.minFilter = THREE.LinearFilter;
    this.floorTexture.generateMipmaps = false;
    this.floorTexture.needsUpdate = true;
    const floorMat = new THREE.NodeMaterial();
    floorMat.side = THREE.DoubleSide;
    floorMat.fragmentNode = vec4(0, 0, 0, texture(this.floorTexture).a);
    floorMat.transparent = false;
    floorMat.depthWrite = false;
    floorMat.blending = THREE.CustomBlending;
    floorMat.blendSrc = THREE.SrcAlphaFactor;
    floorMat.blendDst = THREE.OneMinusSrcAlphaFactor;
    floorMat.blendSrcAlpha = THREE.OneFactor;
    floorMat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), floorMat);
    this.floor.rotation.x = Math.PI / 2;
    this.floor.renderOrder = -1;
    this.floor.name = "rw-studio-floor";
    this.floor.visible = false;
    scene.add(this.floor);

    const l = this.layout;
    const v = this.vehicle;
    scene.add(v);

    // ---- the cutaway hardware (`cutaway.ts`): shell, frames, bulkhead, clear tank, plumbing, engine
    const mats = cutawayMaterials();
    const cw = buildCutaway(l, mats);
    this.cutaway = cw;
    const shellFull = cw.shellFull;
    const shellCut = cw.shellCut;
    v.add(shellFull, shellCut);

    // Tank: blended in order: back wall, liquid, streamlines, front wall.
    const tankGroup = new THREE.Group();
    cw.tank.back.renderOrder = 1;
    this.surface.mesh.renderOrder = 2;
    cw.tank.front.renderOrder = 4;
    tankGroup.add(cw.tank.back, this.surface.mesh, cw.tank.front, cw.tank.rings);
    if (opts.debugParticles) {
      tankGroup.add(this.fluid.debugPoints());
      this.surface.mesh.visible = false;
    }
    v.add(tankGroup);

    // Feed line (half pipe in the section, the liquid core inside), fittings, engine.
    const curve = new THREE.CatmullRomCurve3(l.feed.map((p) => new THREE.Vector3(...p)));
    const core = new THREE.Mesh(new THREE.TubeGeometry(curve, 96, l.feedRadius * 0.74, 16, false), new THREE.MeshBasicNodeMaterial({ color: "#4cc0c9", transparent: true, opacity: 0.72, depthWrite: false }));
    core.renderOrder = 2;
    this.feedCore = core;
    v.add(core, cw.feedFull, cw.feedCut, cw.fittings, cw.engineFull, cw.engineCut);
    this.proxies = cw.shadowProxy.map((g) => (g.index ? g.toNonIndexed() : g));
    const D = l.tankOd;

    // ---- streamlines
    const lineSet = streamlines(l, this.shape, 10);
    const flowTime: N = uniform(0);
    const flowAmount: N = uniform(1);
    const flowOpacity: N = uniform(1);
    // 1 while the engine is whole (no section): the lines show through its wall; 0 when it is sectioned.
    const engineXray: N = uniform(0);
    this.flowU = { time: flowTime, flow: flowAmount, opacity: flowOpacity, engineXray };
    // Lines show in the tank only below the free surface (the liquid), everywhere past the outlet.
    const pN: N = this.surface.planeNormal;
    const pD: N = this.surface.planeOffset;
    const inLiquid = float(1).sub(smoothstep(-0.003, 0.002, positionLocal.dot(pN).sub(pD)));
    const inTank = positionLocal.x.lessThan(l.outletX - 0.004);
    const mask = select(inTank, inLiquid, float(1));
    const pulse = uv().x.mul(9.0).sub(flowTime.mul(0.9)).fract();
    const head = smoothstep(0.55, 0.98, pulse);
    // The lines end on the nozzle exit plane (`streamlines.ts`), fading out over the bell's last stretch so
    // they finish inside the bell instead of as cut stubs at the lip.
    const exitFade = float(1).sub(smoothstep(l.exit.x - 0.16 * l.tankOd, l.exit.x, positionLocal.x).mul(0.9));
    const alpha = mask.mul(exitFade).mul(flowOpacity).mul(flowAmount.mul(0.5).add(0.5)).mul(float(0.82).add(head.mul(0.18)));
    // Bright white, tinted teal through the feed line and injector (as concept 06's glowing feed).
    const x = positionLocal.x;
    const feedTint = smoothstep(l.outletX - 0.06 * D, l.outletX + 0.08 * D, x).mul(float(1).sub(smoothstep(l.injector.x + 0.5 * l.injector.length, l.nozzle[0]!.x + 0.25 * D, x)));
    const tint = mix(vec3(0.95, 0.99, 1.0), vec3(0.62, 0.97, 1.0), feedTint.mul(0.85).add(0.1));
    const glow = tint.mul(float(1.05).add(head.mul(0.45)));
    const lineMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    lineMat.colorNode = vec4(glow, alpha);
    // From the outlet through the feed line, valve cluster, engine inlet, and injector, the lines draw over
    // the hardware (an x-ray view, as concept 06 draws them), so the flow path reads unbroken. In the chamber
    // and bell they are depth-tested: the section opens the engine, so they show inside it, never painted
    // over the bell's solid wall (unless the engine is whole, when they show through it).
    const injEnd = l.injector.x + l.injector.length;
    const inFeed = smoothstep(l.outletX - 0.01 * D, l.outletX + 0.03 * D, x).mul(float(1).sub(smoothstep(injEnd - 0.02 * D, injEnd + 0.02 * D, x)));
    const inPath = inFeed.max(smoothstep(l.outletX, l.outletX + 0.03 * D, x).mul(engineXray));
    const xrayMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false });
    xrayMat.colorNode = vec4(glow, alpha.mul(inPath).mul(0.9));
    const flow = new THREE.Group();
    // Thick enough to read at viewport scale (concept 06's streamlines are bold strokes, not hairlines).
    const lineRadius = 0.009 * D;
    this.lines = lineSet.map((s) => {
      const c = new THREE.CatmullRomCurve3(s.points.map((p) => new THREE.Vector3(...p)));
      const m = new THREE.Mesh(new THREE.TubeGeometry(c, Math.max(64, s.points.length * 2), lineRadius, 8, false), lineMat);
      m.renderOrder = 3;
      const xray = new THREE.Mesh(m.geometry, xrayMat);
      xray.renderOrder = 5;
      flow.add(m, xray);
      const lengths = arcLengths(s.points);
      return { s, lengths, arrowFrom: lengths[s.tankEnd]! / lengths[lengths.length - 1]! };
    });
    const arrowMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    arrowMat.colorNode = vec4(0.95, 0.99, 1.0, flowOpacity.mul(flowAmount.mul(0.6).add(0.4)).mul(0.92));
    const ARROWS = 5;
    const arrows = new THREE.InstancedMesh(new THREE.ConeGeometry(lineRadius * 2.4, lineRadius * 7, 12), arrowMat, this.lines.length * ARROWS);
    arrows.renderOrder = 5;
    arrows.frustumCulled = false;
    flow.add(arrows);
    v.add(flow);
    this.parts = { shellFull, shellCut, tank: tankGroup, flow, arrows };
    this.applyLayers();
  }

  /** Creates the stage on `canvas`; throws unless the renderer is WebGPU on a hardware adapter (I11). */
  static async create(canvas: HTMLCanvasElement, run: VisualRun, clock: ClockSource, opts: StageOptions = {}): Promise<FluidStage> {
    if (!("gpu" in navigator) || !navigator.gpu) throw new Error("WebGPU is not available in this browser");
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
    await renderer.init();
    const backend = renderer.backend as { isWebGPUBackend?: boolean; device?: GPUDevice };
    let info: GPUAdapterInfo | undefined = backend.device?.adapterInfo;
    if (!info) info = (await navigator.gpu.requestAdapter())?.info;
    const gpu: GpuInfo = {
      backend: backend.isWebGPUBackend === true ? "webgpu" : "webgl2",
      vendor: info?.vendor ?? "",
      architecture: info?.architecture ?? "",
      isFallbackAdapter: info && "isFallbackAdapter" in info ? Boolean((info as { isFallbackAdapter?: boolean }).isFallbackAdapter) : null,
    };
    if (gpu.backend !== "webgpu") {
      renderer.dispose();
      throw new Error("the visual flow needs WebGPU (three fell back to WebGL2)");
    }
    if (gpu.isFallbackAdapter) {
      renderer.dispose();
      throw new Error("the visual flow needs a hardware GPU adapter (got a fallback adapter)");
    }
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.setPixelRatio(window.devicePixelRatio);
    let env: THREE.Texture | null = null;
    if (opts.environment !== false) {
      try {
        env = await loadStudioRig();
      } catch {
        env = null;
      }
    }
    return new FluidStage(renderer, gpu, run, clock, env, opts);
  }

  /** Switches the study (same tank and engine proportions expected; the liquid re-settles). */
  setRun(run: VisualRun): void {
    this.run = run;
    this.lastSeek = -1;
    this.floorY = null;
  }

  setClock(clock: ClockSource): void {
    this.clock = clock;
    this.lastSeek = -1;
  }

  setLayers(l: StageLayers): void {
    this.layers = { ...l };
    this.applyLayers();
  }

  setOverlayListener(cb: ((o: StageOverlay) => void) | null): void {
    this.onOverlay = cb;
  }

  private applyLayers(): void {
    const v = partVisibility(this.layers);
    const cw = this.cutaway;
    this.parts.shellFull.visible = v.shellFull;
    this.parts.shellCut.visible = v.shellCut;
    this.parts.tank.visible = v.tank;
    this.parts.flow.visible = v.flow;
    if (cw) {
      cw.feedFull.visible = v.feedFull;
      cw.feedCut.visible = v.feedCut;
      cw.fittings.visible = v.fittings;
      cw.engineFull.visible = v.engineFull;
      cw.engineCut.visible = v.engineCut;
    }
    if (this.feedCore) this.feedCore.visible = v.feedCore;
    this.flowU.engineXray.value = v.engineCut ? 0 : 1;
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.frameCamera();
  }

  /**
   * The concept 06 camera: the vehicle crosses the viewport diagonally, the
   * whole tank (fore dome to aft dome) high on the left, the cutaway running
   * down to the bell low on the right, nothing cropped; slightly above and
   * aft of the section plane so the cut faces, the inside of the shell, and
   * the bell's mouth read.
   */
  private frameCamera(): void {
    const l = this.layout;
    const cam = this.camera;
    const aspect = cam.aspect || 1.5;
    // Fixed camera at the study's mean tilt: two body points land where concept 06 has them.
    const q = this.baseQuaternion(THREE.MathUtils.degToRad(FRAME.tiltDeg));
    const world = (x: number) => new THREE.Vector3(x, 0, 0).applyQuaternion(q);
    // The tank's fore dome apex and the nozzle exit.
    const A = world(-l.tankLength / 2);
    const B = world(l.exit.x);
    const target = { A: new THREE.Vector2(...FRAME.fore), B: new THREE.Vector2(...FRAME.exit) };
    const dir = new THREE.Vector3(...FRAME.view).normalize();
    // Camera up: world up rolled about the view direction.
    cam.up.set(0, 1, 0).applyAxisAngle(dir, THREE.MathUtils.degToRad(FRAME.rollDeg));
    const mid = A.clone().add(B).multiplyScalar(0.5);
    let dist = A.distanceTo(B) * 1.6;
    const ndc = (p: THREE.Vector3) => {
      const v = p.clone().project(cam);
      return new THREE.Vector2(v.x * aspect, v.y);
    };
    let aim = mid.clone();
    for (let i = 0; i < 6; i++) {
      cam.position.copy(aim).addScaledVector(dir, dist);
      cam.lookAt(aim);
      cam.near = dist * 0.05;
      cam.far = dist * 20;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      const a = ndc(A);
      const b = ndc(B);
      const want = new THREE.Vector2(target.A.x * aspect, target.A.y).distanceTo(new THREE.Vector2(target.B.x * aspect, target.B.y));
      dist *= a.distanceTo(b) / want;
      cam.position.copy(aim).addScaledVector(dir, dist);
      cam.updateMatrixWorld(true);
      // Move the aim so the pair's midpoint sits at the target midpoint (camera right/up at the aim distance).
      const m = ndc(A).add(ndc(B)).multiplyScalar(0.5);
      const tm = new THREE.Vector2(((target.A.x + target.B.x) / 2) * aspect, (target.A.y + target.B.y) / 2);
      const halfH = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * dist;
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      aim = aim.addScaledVector(right, (m.x - tm.x) * halfH).addScaledVector(up, (m.y - tm.y) * halfH);
    }
    cam.position.copy(aim).addScaledVector(dir, dist);
    cam.lookAt(aim);
    cam.updateProjectionMatrix();
  }

  /**
   * Tilts the vehicle about a pivot midway between the tank's fore dome and
   * the nozzle exit (the middle of the frame), so the rocking reads without
   * either end swinging out of the viewport.
   */
  private placeVehicle(tiltDeg: number): void {
    const pivot = new THREE.Vector3((-this.layout.tankLength / 2 + this.layout.exit.x) / 2, 0, 0);
    const q = this.baseQuaternion(THREE.MathUtils.degToRad(tiltDeg));
    const anchor = pivot.clone().applyQuaternion(this.baseQuaternion(THREE.MathUtils.degToRad(FRAME.tiltDeg)));
    this.vehicle.quaternion.copy(q);
    this.vehicle.position.copy(anchor.sub(pivot.applyQuaternion(q)));
    this.vehicle.updateMatrixWorld(true);
  }

  /** Body → world for a tilt θ from vertical: Rz(θ)·B (B: body X = world -Y, body Z = world +X). */
  baseQuaternion(tiltRad: number): THREE.Quaternion {
    const B = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0));
    const q = new THREE.Quaternion().setFromRotationMatrix(B);
    return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), tiltRad).multiply(q);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.statStart = this.last;
    this.renderer.setAnimationLoop(() => this.frame());
  }

  stop(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  /** Resets the fps statistics (e.g. after the warm-up). */
  resetStats(): void {
    this.statFrames = 0;
    this.statStart = performance.now();
    this.frameTimes = [];
  }

  stats(): StageStats {
    const now = performance.now();
    const recent = this.frameTimes.filter((t) => t > now - 1000);
    const span = (now - this.statStart) / 1000;
    return {
      frames: this.frames,
      fps: recent.length,
      meanFps: span > 0 ? this.statFrames / span : 0,
      particles: this.grid.maxParticles,
      active: this.fluid.active,
      fill: this.fluid.fill,
      state: this.state,
    };
  }

  /** Renders one frame (the animation loop calls this). */
  frame(): void {
    const now = performance.now();
    const dt = Math.min(1 / 20, Math.max(0, (now - this.last) / 1000)) || 1 / 60;
    this.last = now;
    this.frames++;
    this.statFrames++;
    this.frameTimes.push(now);
    if (this.frameTimes.length > 240) this.frameTimes.splice(0, this.frameTimes.length - 240);
    const st = sampleAt(this.run, this.clock.time());
    this.state = st;
    const seek = this.clock.seekId();
    const up = upOf(st.specificForce);
    if (seek !== this.lastSeek) {
      this.lastSeek = seek;
      this.fluid.seed(st.fillFraction, st.specificForce);
      // Settled: the surface is level under the apparent gravity.
      this.plane = { normal: up, offset: 0 };
      this.fitTarget = null;
      this.lastFit = now;
    } else {
      this.fluid.setFill(st.fillFraction);
      this.fluid.setSpecificForce(st.specificForce);
    }
    this.fluid.step(this.renderer, dt);
    if (this.floorY === null) this.floorY = this.floorLevel();
    this.placeVehicle(st.tiltDeg);
    this.updateFloor(st.tiltDeg);
    this.animTime += dt * (0.25 + 1.5 * st.relativeFlow);
    this.flowU.time.value = this.animTime;
    this.flowU.flow.value = st.relativeFlow;
    this.updatePlane(st, up, now, dt);
    this.rippleTime += dt;
    this.surface.time.value = this.rippleTime;
    this.surface.opacity.value = st.fillFraction > 0.002 ? 1 : 0;
    this.placeArrows(st);
    this.renderer.render(this.scene, this.camera);
    if (this.onOverlay) this.onOverlay(this.overlay());
    if (this.snapReq) this.takeSnapshot();
  }

  /**
   * A PNG (base64) of the next rendered frame: the final tone-mapped canvas,
   * centre-cropped at `zoom` to `w` x `h` over the viewport background
   * (`bg` top and bottom colours). Read in the task that rendered the frame
   * (a WebGPU canvas only reads back there). Product thumbnails (the agent
   * pane's section view card, the tank chip), never engineering data (I13).
   * With `fit`, the crop is that body segment turned upright instead.
   */
  snapshot(w: number, h: number, bg: readonly [string, string], zoom = 1, fit: SnapshotFit | null = null): Promise<string> {
    return new Promise((resolve) => {
      this.snapReq = { w, h, zoom, bg, fit, resolve };
    });
  }

  /** A body point in canvas device px. */
  private canvasPx(p: Vec3, w: number, h: number): THREE.Vector2 {
    const v = new THREE.Vector3(...p).applyMatrix4(this.vehicle.matrixWorld).project(this.camera);
    return new THREE.Vector2(((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h);
  }

  private takeSnapshot(): void {
    const req = this.snapReq!;
    this.snapReq = null;
    const src = this.renderer.domElement;
    const out = document.createElement("canvas");
    out.width = req.w;
    out.height = req.h;
    const g = out.getContext("2d");
    if (!g || src.width === 0 || src.height === 0) return req.resolve("");
    const grad = g.createLinearGradient(0, 0, 0, req.h);
    grad.addColorStop(0, req.bg[0]);
    grad.addColorStop(1, req.bg[1]);
    g.fillStyle = grad;
    g.fillRect(0, 0, req.w, req.h);
    if (req.fit) {
      // Upright on the segment: its fore end up, scaled to `fill` of the height, centred.
      const a = this.canvasPx(req.fit.from, src.width, src.height);
      const b = this.canvasPx(req.fit.to, src.width, src.height);
      const len = Math.max(1, a.distanceTo(b));
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const s = (req.fit.fill * req.h) / len;
      g.save();
      g.translate(req.w / 2, req.h / 2);
      g.rotate(Math.PI / 2 - ang);
      g.scale(s, s);
      g.translate(-(a.x + b.x) / 2, -(a.y + b.y) / 2);
      g.drawImage(src, 0, 0);
      g.restore();
      const url = out.toDataURL("image/png");
      return req.resolve(url.slice(url.indexOf(",") + 1));
    }
    // Cover the output with the canvas centre, then zoom in about it.
    const k = Math.max(req.w / src.width, req.h / src.height) * req.zoom;
    const dw = src.width * k;
    const dh = src.height * k;
    const ox = (req.w - dw) / 2;
    const oy = (req.h - dh) / 2;
    // The light pool backdrop layer (as the viewport draws it under the canvas).
    const pool = this.poolOnScreen(src.width, src.height);
    if (pool) {
      g.save();
      g.translate(ox + pool.x * k, oy + pool.y * k);
      g.rotate((pool.angleDeg * Math.PI) / 180);
      g.scale(1, pool.ry / pool.rx);
      const r = pool.rx * k;
      const rad = g.createRadialGradient(0, 0, 0, 0, 0, r);
      for (const [at, alpha] of POOL_GRADIENT) rad.addColorStop(at, `rgba(255, 255, 255, ${alpha})`);
      g.fillStyle = rad;
      g.fillRect(-r, -r, 2 * r, 2 * r);
      g.restore();
    }
    g.drawImage(src, ox, oy, dw, dh);
    const url = out.toDataURL("image/png");
    req.resolve(url.slice(url.indexOf(",") + 1));
  }

  /** Body radius the floor's blurs scale with (the shell). */
  private get bodyRadius(): number {
    return this.layout.shell.od / 2;
  }

  /** World y of the floor: just under the lowest point of the vehicle over the study's tilt range. */
  private floorLevel(): number {
    const tilts = this.run.samples.map((x) => x.tilt_deg);
    const range = tilts.length > 0 ? [Math.min(...tilts), Math.max(...tilts)] : [50];
    let lowest = Infinity;
    const p = new THREE.Vector3();
    for (const t of range) {
      this.placeVehicle(t);
      for (const g of this.proxies) {
        const pos = g.getAttribute("position");
        for (let i = 0; i < pos.count; i++) lowest = Math.min(lowest, p.fromBufferAttribute(pos, i).applyMatrix4(this.vehicle.matrixWorld).y);
      }
    }
    return lowest - 0.3 * this.bodyRadius;
  }

  /** Re-bakes the contact shadow when the tilt has moved (throttled: the bake is CPU work). */
  private updateFloor(tiltDeg: number): void {
    this.floorAge++;
    const moved = !(Math.abs(tiltDeg - this.floorTilt) < 0.6);
    if (!moved || (this.floorBake !== null && this.floorAge < 8)) return;
    this.floorAge = 0;
    this.floorTilt = tiltDeg;
    const y = this.floorY;
    if (y === null) return;
    const m = this.vehicle.matrixWorld;
    let n = 0;
    for (const g of this.proxies) n += g.getAttribute("position").count;
    const tris = new Float32Array(n * 3);
    const p = new THREE.Vector3();
    let k = 0;
    for (const g of this.proxies) {
      const pos = g.getAttribute("position");
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i).applyMatrix4(m);
        tris[k++] = p.x;
        tris[k++] = p.y;
        tris[k++] = p.z;
      }
    }
    // The pool sits under the engine and the tank's aft end (the part in view).
    const focus = new THREE.Vector3(this.layout.injector.x, 0, 0).applyMatrix4(m);
    const bake = bakeContactFloor(tris, y, this.bodyRadius, [focus.x - 1.5 * this.bodyRadius, focus.z - 2.5 * this.bodyRadius]);
    this.floorBake = bake;
    if (!bake) {
      this.floor.visible = false;
      return;
    }
    const { grid } = bake;
    (this.floorTexture.image as { data: Uint8Array }).data.set(bake.rgba);
    this.floorTexture.needsUpdate = true;
    this.floor.position.set(grid.x0 + (grid.nx * grid.cell) / 2, y, grid.z0 + (grid.nz * grid.cell) / 2);
    this.floor.scale.set(grid.nx * grid.cell, grid.nz * grid.cell, 1);
    this.floor.visible = true;
  }

  /** The light pool on screen (canvas CSS px), as page 01's `poolOnScreen`. */
  private poolOnScreen(w: number, h: number): PoolScreen | null {
    const b = this.floorBake;
    const y = this.floorY;
    if (!b || y === null || !this.floor.visible) return null;
    const project = (x: number, z: number) => {
      const v = new THREE.Vector3(x, y, z).project(this.camera);
      return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, z: v.z };
    };
    const c = project(b.pool.cx, b.pool.cz);
    if (c.z > 1) return null;
    let a = 0;
    let angle = 0;
    const pts: { x: number; y: number }[] = [];
    for (let k = 0; k < 48; k++) {
      const t = (2 * Math.PI * k) / 48;
      const p = project(b.pool.cx + b.pool.rx * Math.cos(t), b.pool.cz + b.pool.rz * Math.sin(t));
      if (p.z > 1) continue;
      pts.push(p);
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d > a) {
        a = d;
        angle = Math.atan2(p.y - c.y, p.x - c.x);
      }
    }
    let minor = 0;
    for (const p of pts) minor = Math.max(minor, Math.abs(-(p.x - c.x) * Math.sin(angle) + (p.y - c.y) * Math.cos(angle)));
    if (!(a > 0) || !(minor > 0)) return null;
    return { x: c.x, y: c.y, rx: a, ry: minor, angleDeg: (angle * 180) / Math.PI };
  }

  /**
   * The free surface: a few times a second the particles are read back and
   * a plane fitted over their top layer (the slosh); between fits the
   * surface eases toward it, and its offset always holds the study's fill.
   */
  private updatePlane(st: TimelineState, up: Vec3, now: number, dt: number): void {
    if (!this.fitPending && now - this.lastFit > 180 && this.fluid.active > 64) {
      this.fitPending = true;
      this.lastFit = now;
      const seek = this.lastSeek;
      const n = this.fluid.active;
      this.fluid
        .readParticles(this.renderer)
        .then((arr) => {
          if (seek !== this.lastSeek) return;
          const fit = fitSurface(this.grid, this.shape, arr, Math.min(n, arr.length / PARTICLE_STRIDE), PARTICLE_STRIDE, up);
          this.fitTarget = fit.normal;
        })
        .catch(() => undefined)
        .finally(() => {
          this.fitPending = false;
        });
    }
    // Without a fit yet, the surface follows the apparent gravity (with the same lag).
    const target = this.fitTarget ?? up;
    const normal = easeNormal(this.plane.normal, target, 1 - Math.exp(-dt / 0.3));
    this.plane = { normal, offset: planeOffsetForFill(this.lattice, normal, st.fillFraction) };
    this.surface.planeNormal.value.set(...normal);
    this.surface.planeOffset.value = this.plane.offset;
    // A gentle ripple from the fluid state: the slosh (the surface's tilt off the apparent gravity), capped.
    const amp = waveAmplitude(this.layout.tankOd, angleBetween(normal, up));
    this.waveAmp = this.waveAmp > 0 ? this.waveAmp + (amp - this.waveAmp) * (1 - Math.exp(-dt / 0.4)) : amp;
    this.surface.waveAmp.value = this.waveAmp;
  }

  /** The current free surface (tank frame). */
  freeSurface(): SurfacePlane {
    return { normal: [...this.plane.normal], offset: this.plane.offset };
  }

  private placeArrows(st: TimelineState): void {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const sc = new THREE.Vector3(1, 1, 1);
    const zero = new THREE.Vector3(0, 0, 0);
    let k = 0;
    const per = this.parts.arrows.count / Math.max(1, this.lines.length);
    for (const line of this.lines) {
      // Arrows ride the whole line; in the tank only those in the liquid show.
      for (let i = 0; i < per; i++) {
        const f = 0.04 + ((i / per + this.animTime * 0.04) % 1) * 0.92;
        const { p, t } = pointAt(line.s.points, line.lengths, f);
        q.setFromUnitVectors(up, new THREE.Vector3(...t));
        const inTank = f <= line.arrowFrom;
        // None in the bell's last stretch, where the lines fade out before the exit plane.
        const nearExit = p[0] > this.layout.exit.x - 0.16 * this.layout.tankOd;
        const show = st.relativeFlow > 0.01 && !nearExit && (inTank ? st.fillFraction > 0.01 && belowPlane(this.plane, [p[0] + this.plane.normal[0] * 0.006, p[1] + this.plane.normal[1] * 0.006, p[2] + this.plane.normal[2] * 0.006]) : true);
        m.compose(new THREE.Vector3(...p), q, show ? sc : zero.clone());
        this.parts.arrows.setMatrixAt(k++, m);
      }
    }
    this.parts.arrows.instanceMatrix.needsUpdate = true;
  }

  /** Label anchors and gizmo axes in canvas CSS px. */
  overlay(): StageOverlay {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    const project = (p: Vec3): [number, number] | null => {
      const v = new THREE.Vector3(...p).applyMatrix4(this.vehicle.matrixWorld).project(this.camera);
      if (v.z > 1) return null;
      return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h];
    };
    const a = this.layout.anchors;
    const view = this.camera.matrixWorldInverse;
    const axes = (["X", "Y", "Z"] as const).map((axis, i) => {
      const d = new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0).applyQuaternion(this.vehicle.quaternion).transformDirection(view);
      return { axis, x: d.x, y: -d.y, depth: d.z };
    });
    return { anchors: { liquid: project(a.liquid), feed: project(a.feed), inlet: project(a.inlet), nozzle: project(a.nozzle) }, axes, pool: this.poolOnScreen(w, h) };
  }

  /** GPU readback: fill fraction and centre of mass of the liquid now. */
  async readback(): Promise<FluidReadback> {
    const arr = await this.fluid.readParticles(this.renderer);
    const n = this.fluid.active;
    let inside = 0;
    const g = this.grid;
    for (let i = 0; i < n; i++) {
      const p: Vec3 = [arr[i * 20]! * g.h + g.origin[0], arr[i * 20 + 1]! * g.h + g.origin[1], arr[i * 20 + 2]! * g.h + g.origin[2]];
      if (tankSdf(this.shape, p) <= g.h) inside++;
    }
    return {
      active: n,
      fill: fillOf(g, inside),
      inside: n > 0 ? inside / n : 1,
      com: centreOfMass(g, arr, n, 20),
    };
  }

  dispose(): void {
    this.snapReq?.resolve("");
    this.snapReq = null;
    this.stop();
    this.fluid.dispose();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
    });
    for (const g of this.proxies) g.dispose();
    for (const g of this.cutaway?.shadowProxy ?? []) g.dispose();
    this.floorTexture.dispose();
    this.renderer.dispose();
  }
}
