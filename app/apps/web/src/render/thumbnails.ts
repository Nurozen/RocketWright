/**
 * Part thumbnails (M3.6, U14): small studio renders of each part, with its
 * visual detail, for the component tree, the inspector header card, mention
 * chips, and the motor list. Cached by `(model_hash, id)` in
 * `.rw/cache/thumbs/` (server `ThumbCache`); the window renders only what
 * the cache lacks (`bake`).
 *
 * Each subject is rendered alone, assembled (no explode), in a small
 * offscreen WebGPU renderer with a transparent background (the UI's panel
 * shows through). A clear carrier brings its riders (the recovery bay shows
 * its stowed chute, as concept 01's inspector card). Two variants:
 * - `tree`: portrait (2:3, the row icon box), body axis near vertical with the nose up (concept 01's
 *   row icons), `FRAMING_PRESETS.thumb`;
 * - `card`: wide, the `01-focus` angle, for the inspector header,
 *   `FRAMING_PRESETS.card`;
 * - `snap`: the whole assembled rocket on a shallow diagonal with its soft
 *   contact shadow (the shared studio floor, `productStage.ts`), for the
 *   Results run snapshot cards (`SNAPSHOT_KEY`, `FRAMING_PRESETS["04"]`).
 * Visual tier (I13): pictures only.
 */
import type { EvaluatedModel } from "@rw/contracts";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as THREE from "three/webgpu";
import { applyDetail, defaultDetailRegistry } from "../detail/registry.ts";
import { fitCamera, FRAMING_PRESETS, presetPose, type FramingPreset } from "../detail/framing.ts";
import type { Vec3 } from "../detail/types.ts";
import { applyCuts } from "../viewport/cuts.ts";
import { glbModelHash, loadAssemblyGlb, type GlbDeps } from "../viewport/glb-source.ts";
import { loadStudioEnvironment, STUDIO } from "../viewport/lighting.ts";
import { BODY_TO_YUP_RX } from "../viewport/probe.ts";
import { StudioFloor } from "../viewport/productStage.ts";
import { AssemblyModel, type PartMeta } from "../viewport/scene.ts";

export type ThumbVariant = "tree" | "card" | "snap";

/** Pixel size per variant (the UI scales them down; 2x the largest display size). */
export const THUMB_SIZES: Record<ThumbVariant, readonly [number, number]> = { tree: [64, 96], card: [400, 200], snap: [204, 124] };

const PRESET: Record<ThumbVariant, FramingPreset> = { tree: FRAMING_PRESETS.thumb, card: FRAMING_PRESETS.card, snap: FRAMING_PRESETS["04"] };

/** Cache key of the whole-rocket snapshot (Results run cards); not a component id (ids are snake_case). */
export const SNAPSHOT_KEY = "snap-assembly";

/** Cache key of a part thumbnail: the component id (tree) or `<id>--card`; the snapshot has one key. */
export function thumbKey(id: string, variant: ThumbVariant = "tree"): string {
  return variant === "snap" ? SNAPSHOT_KEY : variant === "tree" ? id : `${id}--card`;
}

/** Every key a model needs. */
export function thumbKeys(ids: readonly string[]): string[] {
  return ids.flatMap((id) => [thumbKey(id, "tree"), thumbKey(id, "card")]);
}

/** Every key the baker keeps current: the part thumbnails plus the snapshot. */
export function bakeKeys(ids: readonly string[]): string[] {
  return [...thumbKeys(ids), SNAPSHOT_KEY];
}

/** `<id>` / `<id>--card` / `SNAPSHOT_KEY` back to its parts (the snapshot's id is empty: every part). */
export function parseThumbKey(key: string): { id: string; variant: ThumbVariant } {
  if (key === SNAPSHOT_KEY) return { id: "", variant: "snap" };
  return key.endsWith("--card") ? { id: key.slice(0, -"--card".length), variant: "card" } : { id: key, variant: "tree" };
}

/** The parts drawn in `id`'s thumbnail: itself, plus the contents riding in it when it is clear. */
export function thumbSubject(model: AssemblyModel, id: string): string[] {
  const part = model.parts.get(id);
  if (!part) return [];
  if (!part.look.clear) return [id];
  const riders = [...model.plan.follows].filter(([, host]) => host === id).map(([rider]) => rider);
  return [id, ...riders.filter((r) => r !== id)];
}

export class ThumbnailRenderer {
  private readonly scene = new THREE.Scene();
  private readonly stage = new THREE.Group();
  /** The snapshot's contact shadow. */
  private readonly floor = new StudioFloor();

  private constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.stage.rotation.x = BODY_TO_YUP_RX;
    this.scene.add(this.stage, this.floor.mesh);
    this.scene.add(new THREE.HemisphereLight(0xe4ecf5, 0x1a1d21, STUDIO.hemisphere));
    const key = new THREE.DirectionalLight(0xffffff, STUDIO.key);
    key.position.set(-1, 2.5, 2);
    const rim = new THREE.DirectionalLight(0xa9c8ff, STUDIO.rim);
    rim.position.set(2, 1, -2);
    this.scene.add(key, rim);
  }

  /** A renderer on its own offscreen canvas; null without WebGPU (the UI keeps its line icons). */
  static async create(): Promise<ThumbnailRenderer | null> {
    if (typeof navigator === "undefined" || !("gpu" in navigator) || !navigator.gpu) return null;
    const canvas = document.createElement("canvas");
    canvas.width = THUMB_SIZES.card[0];
    canvas.height = THUMB_SIZES.card[1];
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
    renderer.setPixelRatio(1);
    const t = new ThumbnailRenderer(renderer, canvas);
    try {
      t.scene.environment = await loadStudioEnvironment();
      t.scene.environmentIntensity = STUDIO.envIntensity;
    } catch {
      // Lights alone still read.
    }
    return t;
  }

  /** Renders `id` (and its riders) of `model` as a PNG (base64). */
  async render(model: AssemblyModel, id: string, variant: ThumbVariant): Promise<string | null> {
    // The snapshot: every part shown assembled (internals stay hidden, as the closed rocket).
    const ids = variant === "snap" ? [...model.parts.values()].filter((p) => p.node.visible).map((p) => p.id) : thumbSubject(model, id);
    if (ids.length === 0) return null;
    this.stage.clear();
    for (const pid of ids) {
      const part = model.parts.get(pid)!;
      const clone = part.node.clone(true);
      clone.position.set(0, 0, 0);
      clone.visible = true;
      this.stage.add(clone);
    }
    this.stage.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.stage, true);
    if (box.isEmpty()) return null;
    if (variant === "snap") {
      // Soft contact shadow just under the body (fins dip past it), scaled to the body radius.
      const radius = Math.max(1e-3, model.plan.diameter / 2);
      this.floor.place(this.stage, box.min.y - 0.02 * radius, radius);
    } else this.floor.mesh.visible = false;
    // The fit points: the box corners, or for the diagonal snapshot the meshes' own vertices (a long
    // body on a diagonal fills far less than its box, so corners would leave it small).
    const pts: Vec3[] = variant === "snap" ? sampledVertices(this.stage, 4000) : [];
    if (pts.length === 0) for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) pts.push([x, y, z]);
    const [w, h] = THUMB_SIZES[variant];
    const preset = PRESET[variant];
    const pose = presetPose(preset);
    const fit = fitCamera(pts, pose, preset.fovDeg, w / h, preset.fit);
    const cam = new THREE.PerspectiveCamera(preset.fovDeg, w / h, 1e-4, 100);
    cam.position.set(...fit.position);
    cam.up.set(...fit.up);
    cam.lookAt(...fit.target);
    const dist = cam.position.distanceTo(new THREE.Vector3(...fit.target));
    cam.near = dist / 100;
    cam.far = dist * 10;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    this.renderer.setSize(w, h, false);
    await this.renderer.compileAsync(this.scene, cam);
    // Render and read in one task (a WebGPU canvas reads back only while its frame is current).
    this.renderer.render(this.scene, cam);
    const url = this.canvas.toDataURL("image/png");
    this.stage.clear();
    this.floor.mesh.visible = false;
    return url.slice(url.indexOf(",") + 1);
  }

  dispose(): void {
    this.stage.clear();
    this.floor.dispose();
    this.renderer.dispose();
  }
}

/** World positions of the visible meshes' vertices under `root`, about `max` of them (fit points). */
export function sampledVertices(root: THREE.Object3D, max: number): Vec3[] {
  const meshes: THREE.Mesh[] = [];
  let total = 0;
  root.updateMatrixWorld(true);
  root.traverseVisible((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const n = (o.geometry as THREE.BufferGeometry).getAttribute("position")?.count ?? 0;
    if (n === 0) return;
    meshes.push(o);
    total += n;
  });
  const step = Math.max(1, Math.ceil(total / Math.max(1, max)));
  const out: Vec3[] = [];
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const pos = (m.geometry as THREE.BufferGeometry).getAttribute("position");
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      out.push([v.x, v.y, v.z]);
    }
  }
  return out;
}

/**
 * Renders the thumbnails `keys` of `evaluated` (its own GLB, detail
 * applied; the live viewport is untouched) and hands each to `onThumb` as
 * it lands. Returns the keys rendered; empty without WebGPU.
 */
export async function bakeThumbnails(
  evaluated: EvaluatedModel,
  glbDeps: GlbDeps,
  keys: readonly string[],
  onThumb: (key: string, png: string) => void,
  isCancelled: () => boolean = () => false,
): Promise<string[]> {
  if (keys.length === 0) return [];
  const r = await ThumbnailRenderer.create();
  if (!r) return [];
  let model: AssemblyModel | null = null;
  const done: string[] = [];
  try {
    const glb = await loadAssemblyGlb(evaluated, glbDeps);
    if (glb.source !== "rw-wasm") return [];
    const ab = glb.bytes.buffer.slice(glb.bytes.byteOffset, glb.bytes.byteOffset + glb.bytes.byteLength) as ArrayBuffer;
    const gltf = await new GLTFLoader().parseAsync(ab, "");
    const cuts = await applyCuts(gltf.scene);
    const meta: Record<string, PartMeta> = {};
    for (const c of evaluated.components) meta[c.id] = { name: c.name, appearance: c.appearance ?? null, parent: c.parent ?? null };
    model = new AssemblyModel(gltf.scene, meta, glbModelHash(glb.bytes));
    model.cutReport = cuts;
    const applied = applyDetail(model, evaluated.components, defaultDetailRegistry());
    model.onDispose(applied.dispose);
    model.apply({ explode: 0, hidden: [], showInternals: false, section: false });
    for (const key of keys) {
      if (isCancelled()) break;
      const { id, variant } = parseThumbKey(key);
      const png = await r.render(model, id, variant);
      if (png === null) continue;
      done.push(key);
      onThumb(key, png);
    }
    return done;
  } finally {
    model?.dispose();
    r.dispose();
  }
}
