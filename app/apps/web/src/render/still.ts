/**
 * "Render still" (M3.4, R6.12): a path-traced still of the live assembly
 * view with `three-gpu-pathtracer/webgpu` (RL1b verdict) and optional OIDN
 * (`oidn-web`, when weights are served). A product feature only: never bar
 * evidence (D26), and visual tier (I13: `provenance: "visual"`, labelled in
 * the UI). Loaded on demand (this module pulls in the tracer).
 *
 * The still renders in its own offscreen WebGPU renderer, so the live
 * viewport keeps running. Its scene is a copy of the model as shown: the
 * same parts, detail, explode, and hidden set (shared geometry and
 * materials), with
 * - clear parts retuned for the tracer (it reads `color` as the transmission
 *   tint, so the raster tint makes glass smoky, RL1),
 * - section stills cut for real with `manifold-3d` (the tracer ignores
 *   clipping planes; `cutObjectForStill`), caps in a plain hatch-less grey,
 * - a floor instead of the shadow catcher (the tracer supports only
 *   Standard/Physical materials) and the studio panorama as a float
 *   environment.
 */
import * as THREE from "three/webgpu";
import type { AssemblyModel } from "../viewport/scene.ts";
import { SECTION_PLANE } from "../viewport/scene.ts";
import { STUDIO } from "../viewport/lighting.ts";
import { noiseMetric } from "./metrics.ts";
export { STILL_NOISE_MAX } from "./metrics.ts";
import { loadStudioEnvironmentData, StillRenderer } from "./pathtrace.ts";
import { CAP_COLORS, cutObjectForStill, loadManifold, type StillCutReport } from "./section.ts";

export interface StillRequest {
  width: number;
  height: number;
  /** Samples per pixel to reach (every pixel). */
  samples: number;
  /** Cut the model at the section plane (manifold-3d geometry). */
  section: boolean;
  /** OIDN weights (`rt_hdr_alb_nrm_small.tza`); null or absent: no denoise. */
  oidnWeightsUrl?: string | null;
  timeoutMs?: number;
  onProgress?: (minSamples: number, target: number) => void;
}

export interface StillOutput {
  provenance: "visual";
  png_base64: string;
  width: number;
  height: number;
  samples: { min: number; max: number; avg: number };
  traceMs: number;
  denoised: boolean;
  /** `noiseMetric` of the final image (8-bit luma units; lower is smoother). */
  noise: number;
  /** Section stills: what the cut did per mesh. */
  section: StillCutReport | null;
}


/** Tracer-tuned clear look (RL1: the raster tint reads as smoke in the tracer). */
function tracerGlass(src: THREE.MeshPhysicalMaterial): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: "#ffffff",
    roughness: 0.02,
    metalness: 0,
    transmission: 1,
    ior: 1.5,
    thickness: 0.0016,
    clearcoat: 0.5,
    side: src.side,
  });
  m.name = `${src.name || "clear"}-tracer`;
  return m;
}

function visibleChain(o: THREE.Object3D): boolean {
  for (let x: THREE.Object3D | null = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

/**
 * A copy of the model as shown, for the tracer: meshes whose material or
 * node is hidden, and the section writers, are left out; clear materials
 * are swapped. Returns the copy (world space under a fresh group) and the
 * materials it created.
 */
export function stillCopy(root: THREE.Object3D): { group: THREE.Group; created: THREE.Material[] } {
  root.updateWorldMatrix(true, true);
  const group = new THREE.Group();
  group.name = "rw-still-copy";
  const swapped = new Map<THREE.Material, THREE.Material>();
  const swap = (m: THREE.Material): THREE.Material => {
    if (m.userData["rwClear"] !== true || !((m as THREE.MeshPhysicalMaterial).transmission > 0)) return m;
    let s = swapped.get(m);
    if (!s) {
      s = tracerGlass(m as THREE.MeshPhysicalMaterial);
      swapped.set(m, s);
    }
    return s;
  };
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o.userData["rwSectionWriter"] === true || o.userData["rwSectionCap"] === true) return;
    const mats = Array.isArray(o.material) ? (o.material as THREE.Material[]) : [o.material as THREE.Material];
    if (!mats.some((m) => m.visible) || !visibleChain(o)) return;
    const copy = new THREE.Mesh(o.geometry, Array.isArray(o.material) ? mats.map(swap) : swap(mats[0]!));
    o.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
    copy.castShadow = true;
    copy.receiveShadow = true;
    copy.userData["rwPart"] = o.userData["rwPart"];
    group.add(copy);
  });
  return { group, created: [...swapped.values()] };
}

function partOf(m: THREE.Mesh): string | null {
  const id = m.userData["rwPart"];
  return typeof id === "string" ? id : null;
}

/** Decodes a PNG data URL into RGBA pixels (for the noise metric). */
async function rasterOf(dataUrl: string): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = c.getContext("2d");
  if (!g) throw new Error("render still: no 2d context");
  g.drawImage(bitmap, 0, 0);
  return { width: bitmap.width, height: bitmap.height, data: g.getImageData(0, 0, bitmap.width, bitmap.height).data };
}

/**
 * Path-traces `model` as seen from `camera` (the live view camera, view
 * offset included) into a `width` x `height` PNG.
 */
export async function renderStill(model: AssemblyModel, camera: THREE.PerspectiveCamera, req: StillRequest): Promise<StillOutput> {
  const width = Math.max(16, Math.round(req.width));
  const height = Math.max(16, Math.round(req.height));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, alpha: false });
  const disposables: { dispose(): void }[] = [];
  let still: StillRenderer | null = null;
  try {
    await renderer.init();
    if (!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) throw new Error("Render still needs WebGPU (this window fell back to WebGL2)");
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);

    const scene = new THREE.Scene();
    scene.environment = await loadStudioEnvironmentData(new URL(STUDIO.envUrl, document.baseURI).href);
    scene.environmentIntensity = STUDIO.envIntensity;
    scene.background = new THREE.Color("#1d2226");

    let report: StillCutReport | null = null;
    let content: THREE.Group;
    if (req.section) {
      const mf = await loadManifold();
      const cap = new THREE.MeshStandardMaterial({ color: CAP_COLORS.studio[0], roughness: 0.6, metalness: 0.05 });
      disposables.push(cap);
      const cut = cutObjectForStill(mf, model.root, SECTION_PLANE, cap, partOf);
      report = cut.report;
      content = cut.group;
      // Swap clear materials on the cut copy as well.
      const swappedCut = stillCopy(cut.group);
      for (const c of cut.group.children) disposables.push((c as THREE.Mesh).geometry);
      content = swappedCut.group;
      disposables.push(...swappedCut.created);
    } else {
      const copy = stillCopy(model.root);
      content = copy.group;
      disposables.push(...copy.created);
    }
    scene.add(content);
    const box = new THREE.Box3().setFromObject(content);
    if (box.isEmpty()) throw new Error("nothing visible to render");
    const size = box.getSize(new THREE.Vector3()).length();
    const centre = box.getCenter(new THREE.Vector3());
    const floorMat = new THREE.MeshStandardMaterial({ color: "#2a2f33", roughness: 0.85 });
    const floorGeom = new THREE.PlaneGeometry(size * 60, size * 60);
    disposables.push(floorMat, floorGeom);
    const floor = new THREE.Mesh(floorGeom, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(centre.x, box.min.y - size * 0.04, centre.z);
    scene.add(floor);
    // A softer key than the raster's: the tracer's directional light is a hard sun; the panorama fills.
    const key = new THREE.DirectionalLight(0xffffff, STUDIO.key * 0.55);
    key.position.copy(centre).add(new THREE.Vector3(0.15, 3, 0.25).multiplyScalar(size));
    key.target.position.copy(centre);
    scene.add(key, key.target);
    scene.updateMatrixWorld(true);

    const cam = camera.clone();
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    still = new StillRenderer(renderer);
    const r = await still.render(scene, cam, {
      samples: req.samples,
      oidnWeightsUrl: req.oidnWeightsUrl ?? null,
      timeoutMs: req.timeoutMs ?? 180_000,
      onProgress: (n) => req.onProgress?.(n, req.samples),
    });
    const url = still.capture();
    const raster = await rasterOf(url);
    return {
      provenance: "visual",
      png_base64: url.slice(url.indexOf(",") + 1),
      width,
      height,
      samples: r.samples,
      traceMs: r.traceMs,
      denoised: r.denoised,
      noise: noiseMetric(raster).noise,
      section: report,
    };
  } finally {
    still?.dispose();
    for (const d of disposables) d.dispose();
    renderer.dispose();
  }
}
