/**
 * The shared studio stage for the small 3D views (FID-03-05): the page 03
 * motor casing, the page 04 run snapshot thumbnails and trajectory pad, and
 * any other product shot outside the main viewport. It carries page 01's
 * look (BC5) so every 3D view reads as one studio:
 *
 * - `StudioFloor`: the baked soft contact shadow (`stage.ts`) on a floor quad
 *   under the subject, and the light pool ellipse on screen for the backdrop
 *   layer (`poolOnScreen`, drawn by the host as `poolCss()`).
 * - `ProductStage`: a WebGPU renderer (transparent canvas over the CSS
 *   vignette), the studio rig environment (`loadStudioRig`) with the key,
 *   rim, and hemisphere lights, neutral tone mapping, and a camera fitted to
 *   the subject by a framing preset (`detail/framing.ts`).
 *
 * Materials come from the PBR presets (`presets.ts`, `detail/looks.ts`).
 * Visual tier only (I13): pictures, never engineering numbers.
 */
import { texture, uniform, vec4 } from "three/tsl";
import * as THREE from "three/webgpu";
import { fitCamera, levelTilt, presetPose, type FitRect } from "../detail/framing.ts";
import type { Vec3 } from "../detail/types.ts";
import type { PoolScreen } from "./engine.ts";
import { loadStudioRig, STUDIO_RIG } from "./lighting.ts";
import { bakeStage, POOL_GRADIENT, STAGE_LOOK, type StageBake, type StageLook } from "./stage.ts";

/** Triangle budget of a floor bake (the coverage grid is coarse; more adds nothing). */
const FLOOR_MAX_TRIANGLES = 40_000;

/**
 * World positions (9 floats per triangle) of the visible meshes under
 * `root`, decimated to about `maxTriangles`. Fully transparent or
 * colour-masked materials are skipped (they cast nothing in the studio).
 */
export function visibleTriangles(root: THREE.Object3D, maxTriangles = FLOOR_MAX_TRIANGLES): Float32Array {
  const meshes: { mesh: THREE.Mesh; count: number }[] = [];
  let total = 0;
  const visit = (o: THREE.Object3D) => {
    if (!o.visible) return;
    if (o instanceof THREE.Mesh && o.userData["rwFloor"] !== true) {
      const mats = (Array.isArray(o.material) ? o.material : [o.material]) as THREE.Material[];
      const drawn = mats.some((m) => m.visible && m.colorWrite !== false && m.opacity > 0.05);
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
  root.updateMatrixWorld(true);
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

/**
 * The studio floor: unlit black with the baked shadow alpha (`stage.ts`),
 * drawn first and without depth writes so parts that touch it draw over it.
 */
export class StudioFloor {
  readonly mesh: THREE.Mesh;
  private readonly tex: THREE.DataTexture;
  private readonly strength = uniform(1);
  private last: StageBake | null = null;
  private y: number | null = null;

  constructor(private readonly look: StageLook = STAGE_LOOK) {
    const n = look.resolution;
    this.tex = new THREE.DataTexture(new Uint8Array(n * n * 4), n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = false;
    this.tex.needsUpdate = true;
    const m = new THREE.NodeMaterial();
    m.side = THREE.DoubleSide;
    m.fragmentNode = vec4(0, 0, 0, texture(this.tex).a.mul(this.strength));
    m.transparent = false;
    m.depthWrite = false;
    m.blending = THREE.CustomBlending;
    m.blendSrc = THREE.SrcAlphaFactor;
    m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = THREE.OneFactor;
    m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    m.fog = false;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
    // +90 deg about x: plane +y runs along world +z, so texture row 0 is the floor's min z (`stage.ts`).
    this.mesh.rotation.x = Math.PI / 2;
    this.mesh.renderOrder = -1;
    this.mesh.name = "rw-studio-floor";
    this.mesh.userData["rwFloor"] = true;
    this.mesh.visible = false;
  }

  /** Shadow strength (0..1 of the studio look). */
  setOpacity(a: number): void {
    this.strength.value = Math.min(1, Math.max(0, a));
  }

  /**
   * Bakes the shadow of `root`'s visible triangles onto the plane y =
   * `floorY`, blurred at the scale of `radius` (m; the subject's body
   * radius), and fits the quad to the bake's grid. Null (floor hidden) when
   * nothing casts.
   */
  place(root: THREE.Object3D, floorY: number, radius: number): StageBake | null {
    const tris = visibleTriangles(root);
    const bake = bakeStage(tris, floorY, Math.max(1e-4, radius), this.look);
    this.last = bake;
    this.y = floorY;
    this.mesh.visible = bake !== null;
    if (!bake) return null;
    const { grid } = bake;
    (this.tex.image as { data: Uint8Array }).data.set(bake.rgba);
    this.tex.needsUpdate = true;
    this.mesh.position.set(grid.x0 + (grid.nx * grid.cell) / 2, floorY, grid.z0 + (grid.nz * grid.cell) / 2);
    this.mesh.scale.set(grid.nx * grid.cell, grid.nz * grid.cell, 1);
    this.mesh.updateMatrixWorld(true);
    return bake;
  }

  /** The last bake (tests and probes). */
  bake(): StageBake | null {
    return this.last;
  }

  /** The light pool (the bake's floor ellipse) on screen for `camera` at `w` x `h` px, or null. */
  poolOnScreen(camera: THREE.Camera, w: number, h: number): PoolScreen | null {
    const b = this.last;
    if (!b || this.y === null || !this.mesh.visible) return null;
    return projectPool(b, this.y, camera, w, h);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.tex.dispose();
  }
}

/** Projects the bake's pool ellipse (floor plane y) to screen px (y down). */
export function projectPool(b: StageBake, y: number, camera: THREE.Camera, w: number, h: number): PoolScreen | null {
  camera.updateMatrixWorld(true);
  const project = (p: THREE.Vector3) => {
    p.project(camera);
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h, z: p.z };
  };
  const c = project(new THREE.Vector3(b.pool.cx, y, b.pool.cz));
  if (c.z > 1) return null;
  let a = 0;
  let angle = 0;
  const pts: { x: number; y: number }[] = [];
  for (let k = 0; k < 48; k++) {
    const t = (2 * Math.PI * k) / 48;
    const p = project(new THREE.Vector3(b.pool.cx + b.pool.rx * Math.cos(t), y, b.pool.cz + b.pool.rz * Math.sin(t)));
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

/** Paints the light pool (`POOL_GRADIENT`) into a 2D context, as the CSS backdrop layer does. */
export function paintPool(g: CanvasRenderingContext2D, pool: PoolScreen, scale = 1): void {
  g.save();
  g.translate(pool.x * scale, pool.y * scale);
  g.rotate((pool.angleDeg * Math.PI) / 180);
  g.scale(pool.rx * scale, pool.ry * scale);
  const rg = g.createRadialGradient(0, 0, 0, 0, 0, 1);
  for (const [at, a] of POOL_GRADIENT) rg.addColorStop(at, `rgba(255,255,255,${a})`);
  g.fillStyle = rg;
  g.beginPath();
  g.arc(0, 0, 1, 0, 2 * Math.PI);
  g.fill();
  g.restore();
}

/** How a product shot frames its subject (`detail/framing.ts` presets). */
export interface ProductShot {
  /** World direction from the subject toward the camera. */
  dir: Vec3;
  /** Screen angle of world +X (deg, y up); null: a level camera (no roll). */
  axisTiltDeg: number | null;
  fovDeg: number;
  /** The subject fills this rectangle (viewport fractions, y down). */
  fit: FitRect;
  /** Contact shadow under the subject (default on). */
  floor?: boolean;
  /** Body radius the shadow blur scales with (m); default: a quarter of the subject's smallest box side. */
  radius?: number;
  /** Gap between the subject's lowest point and the floor, as a fraction of `radius` (default 0.05). */
  floorGap?: number;
  /** Shadow strength 0..1 (default 1). */
  shadow?: number;
}

/** Corners of a box (the fit's subject points). */
export function boxCorners(box: THREE.Box3): Vec3[] {
  const pts: Vec3[] = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) pts.push([x, y, z]);
  return pts;
}

/** Contact-shadow radius for a subject box when the shot gives none. */
export function defaultShadowRadius(box: THREE.Box3): number {
  const s = box.getSize(new THREE.Vector3());
  return Math.max(1e-4, Math.min(s.x, s.y, s.z) / 4);
}

export type StageBackend = "webgpu" | "none";

/**
 * A small studio renderer on its own canvas. `create` resolves null without
 * WebGPU (the host keeps its 2D fallback). Render on demand: `show` places a
 * subject, `render` draws it.
 */
export class ProductStage {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(22, 1, 1e-4, 100);
  readonly floor: StudioFloor;
  private readonly key = new THREE.DirectionalLight(0xfff8f0, STUDIO_RIG.key);
  private readonly holder = new THREE.Group();
  private size = { w: 1, h: 1 };
  private disposed = false;

  private constructor(
    private readonly renderer: THREE.WebGPURenderer,
    readonly canvas: HTMLCanvasElement,
    look: StageLook,
  ) {
    this.floor = new StudioFloor(look);
    this.scene.add(new THREE.HemisphereLight(0xe4ecf5, 0x1a1d21, STUDIO_RIG.hemisphere));
    this.scene.add(this.key, this.key.target);
    const rim = new THREE.DirectionalLight(0xa9c8ff, STUDIO_RIG.rim);
    rim.position.set(-3, 1.5, -2);
    this.scene.add(rim);
    this.scene.add(this.floor.mesh, this.holder);
  }

  /** A stage on `canvas` (an offscreen one when omitted); null without WebGPU. */
  static async create(canvas: HTMLCanvasElement = document.createElement("canvas"), look: StageLook = STAGE_LOOK): Promise<ProductStage | null> {
    if (typeof navigator === "undefined" || !("gpu" in navigator) || !navigator.gpu) return null;
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
    try {
      await renderer.init();
    } catch {
      renderer.dispose();
      return null;
    }
    if (!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) {
      renderer.dispose();
      return null;
    }
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = false;
    const stage = new ProductStage(renderer, canvas, look);
    try {
      stage.scene.environment = await loadStudioRig();
      stage.scene.environmentIntensity = STUDIO_RIG.envIntensity;
    } catch {
      // The lights alone still read.
    }
    return stage;
  }

  /** Canvas size in CSS px and the device pixel ratio. */
  setSize(w: number, h: number, pixelRatio = 1): void {
    this.size = { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(this.size.w, this.size.h, false);
  }

  /**
   * Shows `subject` (replacing the last one; the caller owns its geometry
   * and materials), fits the camera by `shot`, and bakes the floor under it.
   */
  show(subject: THREE.Object3D, shot: ProductShot): void {
    this.holder.clear();
    this.holder.add(subject);
    this.holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(subject, true);
    if (box.isEmpty()) {
      this.floor.mesh.visible = false;
      return;
    }
    const radius = shot.radius ?? defaultShadowRadius(box);
    const floorY = box.min.y - (shot.floorGap ?? 0.05) * radius;
    if (shot.floor !== false) {
      this.floor.setOpacity(shot.shadow ?? 1);
      this.floor.place(subject, floorY, radius);
    } else this.floor.mesh.visible = false;
    const pose = presetPose({ dir: shot.dir, axisTiltDeg: shot.axisTiltDeg ?? levelTilt(shot.dir) });
    const aspect = this.size.w / this.size.h;
    const fit = fitCamera(boxCorners(box), pose, shot.fovDeg, aspect, shot.fit);
    this.camera.fov = shot.fovDeg;
    this.camera.aspect = aspect;
    this.camera.position.set(...fit.position);
    this.camera.up.set(...fit.up);
    this.camera.lookAt(...fit.target);
    const dist = this.camera.position.distanceTo(new THREE.Vector3(...fit.target));
    this.camera.near = dist / 100;
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    const centre = box.getCenter(new THREE.Vector3());
    const r = box.getBoundingSphere(new THREE.Sphere()).radius;
    this.key.position.copy(centre).add(new THREE.Vector3(...STUDIO_RIG.keyDir).multiplyScalar(3 * r));
    this.key.target.position.copy(centre);
    this.key.target.updateMatrixWorld();
  }

  /** The light pool on this canvas (CSS px), or null without a floor. */
  pool(): PoolScreen | null {
    return this.floor.poolOnScreen(this.camera, this.size.w, this.size.h);
  }

  /** Compiles the subject's materials (first frame without a hitch). */
  async compile(): Promise<void> {
    await this.renderer.compileAsync(this.scene, this.camera);
  }

  render(): void {
    if (!this.disposed) this.renderer.render(this.scene, this.camera);
  }

  /** Renders and reads the canvas back as a PNG (base64), in one task. */
  renderPng(): string {
    this.render();
    const url = this.canvas.toDataURL("image/png");
    return url.slice(url.indexOf(",") + 1);
  }

  /** Detaches the subject (the caller disposes it). */
  clear(): void {
    this.holder.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.holder.clear();
    this.floor.dispose();
    this.renderer.dispose();
  }
}
