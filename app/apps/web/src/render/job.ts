/**
 * The `rocketwright-render` job (RL3), run in the hidden window's page
 * (`?mode=render&job=1`): the Electron main calls `window.__rwRunJob(request,
 * opts)` with the IF8 `RenderRequest`; the page meshes `evaluated` with
 * rw-wasm (the viewport's mesh path, D5), renders it with three r186 on
 * WebGPU into a full-window canvas, and returns the reply the Rust side
 * verifies (`crates/rw-cli/src/render3d.rs` `RendererReply`).
 *
 * The PNG is the final tone-mapped sRGB canvas output, read in the same task
 * as the render; never the linear render-target readback (plan, three r186
 * pitfalls). The canvas keeps showing that frame, so a screen capture of the
 * window is the on-screen reference for the colour agreement test.
 */
import { applyCuts } from "../viewport/cuts.ts";
import type { EvaluatedModel, schema } from "@rw/contracts";

type RenderRequest = schema.RenderRequest;
import type { RwWasm } from "@rw/rw-wasm";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import * as THREE from "three/webgpu";
import { AssemblyModel, type PartMeta } from "../viewport/scene.ts";
import { DIM_COLOR_LIGHT, MARK_COLORS_LIGHT, markMap, mergeForCompare, type MarkMap } from "../viewport/marks.ts";
import { bodyCamera, CHECK_COLORS, checkColor, frameBox, isCapPixel, isJobView, presetFor, worstSeverity, type Framing } from "./recipes.ts";
import { capMaterial, cutObjectForStill, loadManifold, type StillCutReport } from "./section.ts";
import { SECTION_PLANE } from "../viewport/scene.ts";

export interface JobOptions {
  /** Accept WebGL2 or a fallback adapter (never in gates, I11). */
  allowSoftware?: boolean;
}

export interface AdapterReport {
  vendor: string;
  architecture: string;
  description: string;
  is_fallback_adapter: boolean | null;
}

/** `RendererReply` (snake_case, read by Rust). */
export type JobReply =
  | {
      status: "ready";
      backend: "webgpu" | "webgl2";
      adapter: AdapterReport;
      png_base64: string;
      width: number;
      height: number;
      camera: ReturnType<typeof bodyCamera>;
      timings_ms: Record<string, number>;
      /** `--view section` (M3.5): what the manifold cut did, and the cut-face pixels in the PNG. */
      section?: { report: StillCutReport; cap_pixels: number };
    }
  | { status: "error"; error: string; backend?: string; adapter?: AdapterReport };

const RADIAL_SEGMENTS = 96;

function adapterOf(renderer: THREE.WebGPURenderer): AdapterReport {
  const backend = renderer.backend as unknown as { device?: GPUDevice & { adapterInfo?: GPUAdapterInfo } };
  const info = backend.device?.adapterInfo;
  return {
    vendor: info?.vendor ?? "",
    architecture: info?.architecture ?? "",
    description: info?.description ?? "",
    is_fallback_adapter: info && "isFallbackAdapter" in info ? Boolean((info as { isFallbackAdapter?: boolean }).isFallbackAdapter) : null,
  };
}

function cameraFor(f: Framing, aspect: number): THREE.Camera {
  let cam: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  if (f.orthographic) {
    const h = (f.orthoHeight ?? 1) / 2;
    cam = new THREE.OrthographicCamera(-h * aspect, h * aspect, h, -h, f.near, f.far);
  } else {
    cam = new THREE.PerspectiveCamera(f.fovDeg ?? 28, aspect, f.near, f.far);
  }
  cam.position.set(...f.position);
  cam.up.set(...f.up);
  cam.lookAt(...f.target);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
}

/**
 * Swaps every part to its flat check material. With compare marks
 * (`rw render --compare`), marked parts take their mark colour (removed red,
 * changed amber, added green) and the rest a light grey.
 */
function applyCheckMaterials(model: AssemblyModel, request: RenderRequest, marks: MarkMap | null): void {
  const worst = worstSeverity(request.check ?? null);
  for (const part of model.parts.values()) {
    const m = marks?.[part.id];
    const color = marks === null ? checkColor(part.id, worst) : m !== undefined ? MARK_COLORS_LIGHT[m] : DIM_COLOR_LIGHT;
    const mat = new THREE.MeshStandardNodeMaterial({ color: new THREE.Color(color), roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    for (const m of part.meshes) m.material = mat;
    for (const old of part.materials) old.dispose();
    part.materials.length = 0;
  }
}

function addLights(scene: THREE.Scene, f: Framing, pbr: boolean): void {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f96, pbr ? 1.1 : 1.6));
  // A key light from above and slightly behind the camera, so every preset is lit from the viewer's side.
  const key = new THREE.DirectionalLight(0xffffff, pbr ? 2.4 : 1.5);
  const t = new THREE.Vector3(...f.target);
  const dir = new THREE.Vector3(...f.position).sub(t).normalize();
  key.position.copy(t).addScaledVector(dir, 3).add(new THREE.Vector3(...f.up).multiplyScalar(2));
  key.target.position.copy(t);
  scene.add(key, key.target);
}

/** Runs one render job against `canvas`. Never throws: failures come back as `status: "error"`. */
export async function runRenderJob(canvas: HTMLCanvasElement, request: RenderRequest, rw: RwWasm, opts: JobOptions = {}): Promise<JobReply> {
  const t0 = performance.now();
  const timings: Record<string, number> = {};
  const mark = (k: string) => (timings[k] = Math.round(performance.now() - t0));
  let renderer: THREE.WebGPURenderer | null = null;
  let adapter: AdapterReport | undefined;
  let backendName: "webgpu" | "webgl2" | undefined;
  try {
    if (!isJobView(request.view)) throw new Error(`view ${request.view} is not a rocketwright-render view`);
    const view = request.view;
    const width = Math.round(request.width);
    const height = Math.round(request.height);
    if (!(width > 0 && height > 0)) throw new Error(`bad size ${width}x${height}`);
    canvas.width = width;
    canvas.height = height;

    renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false });
    await renderer.init();
    mark("init");
    backendName = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? "webgpu" : "webgl2";
    adapter = adapterOf(renderer);
    if (!opts.allowSoftware) {
      if (backendName !== "webgpu") throw new Error("three fell back to WebGL2: no WebGPU adapter in this window");
      if (adapter.is_fallback_adapter === true || /swiftshader/i.test(`${adapter.vendor} ${adapter.description}`)) throw new Error(`fallback adapter: ${adapter.vendor} ${adapter.description}`);
    }
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.setClearColor(new THREE.Color(CHECK_COLORS.background), 1);

    // `--compare`: New plus the removed parts of Old, coloured by mark.
    const marks = request.compare_marks?.length ? markMap(request.compare_marks) : null;
    const evaluated = marks !== null && request.compare_evaluated ? mergeForCompare(request.compare_evaluated as EvaluatedModel, request.evaluated as EvaluatedModel, marks) : (request.evaluated as EvaluatedModel);
    const glb = rw.meshModelGlb(evaluated, { radial_segments: RADIAL_SEGMENTS, explode: 0, internals: request.internals, cutters: true });
    const gltf = await new GLTFLoader().parseAsync(glb.slice().buffer, "");
    // Cut components come out of their parents, as in the viewport (R2.4).
    const cuts = await applyCuts(gltf.scene);
    const meta: Record<string, PartMeta> = {};
    for (const c of evaluated.components) meta[c.id] = { name: c.name, appearance: c.appearance ?? null };
    const model = new AssemblyModel(gltf.scene, meta, evaluated.model_hash);
    model.cutReport = cuts;
    model.apply({ explode: request.explode, hidden: [], showInternals: false, section: false });
    const pbr = request.scheme === "pbr";
    if (!pbr) applyCheckMaterials(model, request, marks);
    else if (marks !== null) {
      model.setMarks(marks);
      model.apply({ explode: request.explode, hidden: [], showInternals: false, section: false });
    }
    mark("mesh");

    const scene = new THREE.Scene();
    const b = model.bounds();
    if (b.isEmpty()) throw new Error("the model has no geometry to render");
    let section: { report: StillCutReport; cap: THREE.Material; group: THREE.Group } | null = null;
    if (view === "section") {
      // Real cut geometry (manifold-3d, M3.3 stills) with hatched caps; framed like the uncut Iso view.
      const mf = await loadManifold();
      const cap = capMaterial(pbr ? "studio" : "check");
      const cut = cutObjectForStill(mf, model.root, SECTION_PLANE, cap, (m) => (typeof m.userData["rwPart"] === "string" ? (m.userData["rwPart"] as string) : null));
      section = { report: cut.report, cap, group: cut.group };
      scene.add(cut.group);
      mark("section");
    } else {
      scene.add(model.root);
    }
    const aspect = width / height;
    const framing = frameBox(presetFor(view), { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] }, aspect, !pbr);
    addLights(scene, framing, pbr);
    if (pbr) {
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environmentIntensity = 0.55;
    }
    const camera = cameraFor(framing, aspect);
    // Compile first so the timed frame is the frame read back.
    await renderer.compileAsync(scene, camera);
    renderer.render(scene, camera);
    // Same task as the render: the swap-chain texture is still current.
    const url = canvas.toDataURL("image/png");
    mark("render");
    let capPixels = 0;
    if (section) {
      const g = document.createElement("canvas");
      g.width = width;
      g.height = height;
      const ctx = g.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        const img = new Image();
        img.src = url;
        await img.decode();
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, width, height).data;
        for (let i = 0; i < d.length; i += 4) if (isCapPixel(d[i]!, d[i + 1]!, d[i + 2]!)) capPixels++;
      }
      for (const c of section.group.children) (c as THREE.Mesh).geometry.dispose();
      section.cap.dispose();
    }
    model.dispose();
    return {
      status: "ready",
      backend: backendName,
      adapter,
      png_base64: url.slice(url.indexOf(",") + 1),
      width,
      height,
      camera: bodyCamera(framing),
      timings_ms: timings,
      ...(section ? { section: { report: section.report, cap_pixels: capPixels } } : {}),
    };
  } catch (e) {
    return {
      status: "error",
      error: e instanceof Error ? e.message : String(e),
      ...(backendName !== undefined ? { backend: backendName } : {}),
      ...(adapter !== undefined ? { adapter } : {}),
    };
  }
}
