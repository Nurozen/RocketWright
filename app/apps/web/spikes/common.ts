/**
 * Shared plumbing for the RL1 visual spikes (`spikes/<x>.html`): a real
 * WebGPU renderer (I11: no WebGL2 or fallback adapter), the studio
 * environment, the recovery-bay test scene (concept 01's selected part), and
 * the `window.__rwSpike` probe the desktop capture waits on
 * (`app/e2e/capture/run.ts --url spikes/<x>`).
 *
 * Spike code: kept to answer go/no-go questions for M3.1/M3.4, not product code.
 */
import * as THREE from "three/webgpu";

export type Rect = [number, number, number, number];

export interface GpuFacts {
  isWebGPUBackend: boolean;
  adapter: { vendor: string; architecture: string; description: string; isFallbackAdapter: boolean | null };
}

export interface Check {
  value: number | string | boolean | null;
  pass: boolean;
  note?: string;
}

export interface SpikeProbe {
  spike: string;
  variant: string;
  gpu: GpuFacts;
  canvas: { width: number; height: number; devicePixelRatio: number };
  /** Screen rectangles (canvas px, y down) the PNG checks in `run.ts` look at. */
  regions: Record<string, Rect>;
  checks: Record<string, Check>;
  timings: Record<string, number>;
  notes: string[];
  /** Console warnings and errors the page logged (three reports shader and pipeline problems there). */
  console?: string[];
}

type Status = { status: "pending" } | { status: "ready"; probe: SpikeProbe } | { status: "error"; error: string };

declare global {
  interface Window {
    __rwSpike?: Status;
  }
}

export const params = new URLSearchParams(window.location.search);

/** Runs a spike body and publishes its probe (or error) on `window.__rwSpike`. */
export function runSpike(body: () => Promise<SpikeProbe>): void {
  window.__rwSpike = { status: "pending" };
  const logged: string[] = [];
  for (const level of ["warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      if (logged.length < 40) logged.push(`[${level}] ${args.map(String).join(" ").slice(0, 400)}`);
      orig(...args);
    };
  }
  body().then(
    (probe) => {
      const errors = logged.filter((l) => l.startsWith("[error]")).length;
      probe.checks["consoleErrors"] = { value: errors, pass: errors === 0, note: "WebGPU validation and shader errors logged by the page" };
      window.__rwSpike = { status: "ready", probe: { ...probe, console: logged } };
    },
    (e: unknown) => {
      console.error(e);
      window.__rwSpike = { status: "error", error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) };
    },
  );
}

/** A full-window canvas at the window's CSS size, DPR 1 under the capture's emulation. */
export function makeCanvas(): HTMLCanvasElement {
  // The canvas is transparent over the viewport vignette (tokens bg/viewport-top, bg/viewport-bottom), as in the app:
  // tone mapping would crush a dark scene.background towards black.
  document.body.style.cssText = "margin:0;overflow:hidden;height:100vh;background:linear-gradient(#22282c,#171c20)";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;width:100vw;height:100vh";
  document.body.append(canvas);
  return canvas;
}

/** Creates and initialises the renderer; throws unless it is WebGPU on a hardware adapter (I11). */
export async function initRenderer(canvas: HTMLCanvasElement, opts: { antialias?: boolean } = {}): Promise<{ renderer: THREE.WebGPURenderer; gpu: GpuFacts }> {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: opts.antialias ?? true, alpha: true });
  await renderer.init();
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap is gone in r186 WebGPU
  const backend = renderer.backend as { isWebGPUBackend?: boolean; device?: GPUDevice };
  let info: GPUAdapterInfo | undefined = backend.device?.adapterInfo;
  if (!info && navigator.gpu) info = (await navigator.gpu.requestAdapter())?.info;
  const gpu: GpuFacts = {
    isWebGPUBackend: backend.isWebGPUBackend === true,
    adapter: {
      vendor: info?.vendor ?? "",
      architecture: info?.architecture ?? "",
      description: info?.description ?? "",
      isFallbackAdapter: info && "isFallbackAdapter" in info ? Boolean((info as { isFallbackAdapter?: boolean }).isFallbackAdapter) : null,
    },
  };
  if (!gpu.isWebGPUBackend) throw new Error("spike: WebGPU backend required (three fell back to WebGL2)");
  if (gpu.adapter.isFallbackAdapter) throw new Error("spike: fallback (software) adapter");
  return { renderer, gpu };
}

export function canvasFacts(renderer: THREE.WebGPURenderer): SpikeProbe["canvas"] {
  const c = renderer.domElement;
  return { width: c.width, height: c.height, devicePixelRatio: window.devicePixelRatio };
}

/**
 * The studio panorama (`public/env/studio-environment.png`, LDR equirect) as an environment texture.
 * `data: true` returns a linear float `DataTexture` instead: the path tracer builds its importance-sampling
 * CDF from `image.data`, which an image-backed texture does not have.
 */
export async function loadStudioEnvironment(opts: { data?: boolean } = {}): Promise<THREE.Texture> {
  const url = new URL("../env/studio-environment.png", window.location.href).href;
  if (opts.data) {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("spike: no 2d context");
    ctx.drawImage(bitmap, 0, 0);
    const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const f = new Float32Array(px.length);
    const lin = (v: number) => {
      const x = v / 255;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    for (let i = 0; i < px.length; i += 4) {
      f[i] = lin(px[i]!);
      f[i + 1] = lin(px[i + 1]!);
      f[i + 2] = lin(px[i + 2]!);
      f[i + 3] = 1;
    }
    const tex = new THREE.DataTexture(f, bitmap.width, bitmap.height, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.flipY = true;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Resolves after `n` animation frames. */
export function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

/** Screen bounding rectangle (canvas px) of an object's world AABB. */
export function screenRect(obj: THREE.Object3D, camera: THREE.Camera, width: number, height: number): Rect {
  const box = new THREE.Box3().setFromObject(obj);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(camera);
    const x = ((p.x + 1) / 2) * width;
    const y = ((1 - p.y) / 2) * height;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1)];
}

// ---- recovery bay (concept 01, "Recovery bay": clear polycarbonate, aluminium rings, orange chute) ----

export type GlassMode = "transmission" | "blend" | "oit";

/** Recovery bay dimensions (m): 120 mm long, 54 mm OD (inspector card in exemplar 01). */
export const BAY = { length: 0.12, outerRadius: 0.027, wall: 0.0016, ringLength: 0.011, chuteRadius: 0.0205, chuteLength: 0.086 } as const;

/** Layer for see-through parts: rendered by the main camera, skipped by the GTAO normal/depth prepass. */
export const GLASS_LAYER = 1;

/** An annular tube along +X from x0 to x1 (closed profile, so it has inner and outer walls). */
export function tubeGeometry(rOuter: number, rInner: number, x0: number, x1: number, segments = 128): THREE.BufferGeometry {
  const profile = [new THREE.Vector2(rInner, x0), new THREE.Vector2(rOuter, x0), new THREE.Vector2(rOuter, x1), new THREE.Vector2(rInner, x1), new THREE.Vector2(rInner, x0)];
  const g = new THREE.LatheGeometry(profile, segments);
  g.rotateZ(-Math.PI / 2); // lathe axis +Y -> +X
  return g;
}

/** The stowed chute: a soft bundle with folds and pleats (displaced cylinder, rounded ends). */
function chuteGeometry(): THREE.BufferGeometry {
  const { chuteRadius: R, chuteLength: L } = BAY;
  const g = new THREE.CylinderGeometry(R, R, L, 96, 64, false);
  const p = g.attributes["position"] as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const t = v.y / L + 0.5; // 0..1 along the bundle
    const a = Math.atan2(v.z, v.x);
    const r = Math.hypot(v.x, v.z);
    const ends = Math.sqrt(Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, t)))));
    const folds = 1 + 0.07 * Math.sin(7 * a + 9 * t) + 0.05 * Math.sin(3 * a - 23 * t) + 0.035 * Math.sin(17 * a + 3 * t) + 0.04 * Math.sin(31 * t + a);
    const rr = r === 0 ? 0 : (R * folds * (0.35 + 0.65 * ends)) / R;
    v.x *= rr;
    v.z *= rr;
    // Cap rings collapse towards the axis; flatten the ends a little.
    if (r === 0) v.y = (t - 0.5) * L * 0.96;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.rotateZ(-Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

export interface RecoveryBay {
  group: THREE.Group;
  glass: THREE.Mesh;
  chute: THREE.Mesh;
}

/** Glass materials per strategy (all `clear_polycarbonate`: faint cool tint, glossy). */
export function glassMaterial(mode: GlassMode, env: THREE.Texture | null = null): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial({ color: "#eaf6f7", metalness: 0, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.04, ior: 1.585 });
  if (env) {
    // Stronger studio reflections on the clear wall than the scene-wide environment gives (reads as glass, exemplar 01).
    m.envMap = env;
    m.envMapIntensity = 2.2;
  }
  if (mode === "transmission") {
    m.transmission = 1;
    m.thickness = BAY.wall;
    m.attenuationColor = new THREE.Color("#cfe9ec");
    m.attenuationDistance = 0.6;
    m.specularIntensity = 1;
  } else {
    m.transparent = true;
    m.opacity = 0.2;
    m.depthWrite = false;
    m.blending = THREE.NormalBlending;
  }
  return m;
}

export function buildRecoveryBay(mode: GlassMode, env: THREE.Texture | null = null): RecoveryBay {
  const { length: L, outerRadius: R, wall, ringLength: rl } = BAY;
  const group = new THREE.Group();
  group.name = "recovery_bay";
  const x0 = -L / 2;
  const x1 = L / 2;

  const glass = new THREE.Mesh(tubeGeometry(R - 0.0002, R - 0.0002 - wall, x0 + rl * 0.6, x1 - rl * 0.6), glassMaterial(mode, env));
  glass.name = "bay_glass";
  glass.castShadow = false;
  glass.receiveShadow = false;
  glass.layers.set(GLASS_LAYER);
  group.add(glass);

  const alu = new THREE.MeshPhysicalNodeMaterial({ color: "#c3c7cb", metalness: 1, roughness: 0.3, anisotropy: 0.6 });
  const darkAlu = new THREE.MeshPhysicalNodeMaterial({ color: "#8d9296", metalness: 1, roughness: 0.38 });
  const addRing = (xa: number, xb: number, rOuter: number, rInner: number, mat: THREE.Material) => {
    const ring = new THREE.Mesh(tubeGeometry(rOuter, rInner, xa, xb), mat);
    ring.castShadow = true;
    ring.receiveShadow = true;
    group.add(ring);
    return ring;
  };
  for (const s of [-1, 1]) {
    const outer = s < 0 ? x0 : x1 - rl;
    addRing(outer, outer + rl, R, R - 0.0035, alu);
    // A machined groove band and a thin lip where the glass seats.
    const lip = s < 0 ? x0 + rl : x1 - rl - 0.0018;
    addRing(lip, lip + 0.0018, R - 0.0009, R - 0.0032, darkAlu);
    // Bulkhead disc closing the end.
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(R - 0.0035, R - 0.0035, 0.0025, 96), darkAlu);
    disc.rotation.z = Math.PI / 2;
    disc.position.x = s < 0 ? x0 + 0.004 : x1 - 0.004;
    disc.castShadow = true;
    disc.receiveShadow = true;
    group.add(disc);
    // Coupler shoulder stub (fits the neighbouring airframe).
    addRing(s < 0 ? x0 - 0.006 : x1, s < 0 ? x0 : x1 + 0.006, R - 0.0042, R - 0.0062, darkAlu);
  }
  // Eye bolt on the forward bulkhead.
  const eye = new THREE.Mesh(new THREE.TorusGeometry(0.0045, 0.0011, 16, 48), alu);
  eye.position.set(x0 + 0.0095, 0, 0);
  eye.rotation.y = Math.PI / 2;
  group.add(eye);

  const nylon = new THREE.MeshPhysicalNodeMaterial({ color: "#e8732a", metalness: 0, roughness: 0.72, sheen: 0.6, sheenRoughness: 0.5, sheenColor: new THREE.Color("#ffb27a") });
  const chute = new THREE.Mesh(chuteGeometry(), nylon);
  chute.name = "parachute";
  chute.position.x = 0.002;
  chute.castShadow = true;
  chute.receiveShadow = true;
  group.add(chute);
  return { group, glass, chute };
}

/** Key, fill, and rim lights plus a shadow catcher under `target`. */
export function studioLights(scene: THREE.Scene, target: THREE.Object3D): { key: THREE.DirectionalLight; ground: THREE.Mesh } {
  const box = new THREE.Box3().setFromObject(target);
  const size = box.getSize(new THREE.Vector3()).length();
  const centre = box.getCenter(new THREE.Vector3());
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.copy(centre).add(new THREE.Vector3(0.6, 1.4, 0.8).multiplyScalar(size));
  key.target.position.copy(centre);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0003;
  key.shadow.radius = 6;
  const cam = key.shadow.camera;
  cam.left = cam.bottom = -size;
  cam.right = cam.top = size;
  cam.near = 0.01;
  cam.far = size * 6;
  const rim = new THREE.DirectionalLight(0xa9c8ff, 0.8);
  rim.position.copy(centre).add(new THREE.Vector3(-1, 0.6, -1.2).multiplyScalar(size));
  scene.add(key, key.target, rim, new THREE.HemisphereLight(0xe4ecf5, 0x1a1d21, 0.35));
  const catcher = new THREE.ShadowNodeMaterial();
  catcher.opacity = 0.35;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(size * 8, size * 8), catcher);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(centre.x, box.min.y - size * 0.18, centre.z);
  ground.receiveShadow = true;
  scene.add(ground);
  return { key, ground };
}

/** Iso-like framing in the spirit of exemplar 01 (axis running upper-left to lower-right). */
export function isoCamera(target: THREE.Object3D, aspect: number, fill = 0.62): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(28, aspect, 0.001, 50);
  const box = new THREE.Box3().setFromObject(target);
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(28 / 2)) / (fill * 1.6);
  camera.position.copy(centre).add(new THREE.Vector3(0.42, 0.62, 1).normalize().multiplyScalar(dist));
  camera.lookAt(centre);
  camera.layers.enable(GLASS_LAYER);
  return camera;
}
