/**
 * The assembly as a three.js scene graph built from the rw-geom GLB (node
 * name = component id, body frame). Owns per-part state: explode offset (the
 * recursive layout in explode.ts, from the assembled bounds and the tree
 * parents), visibility, x-ray, section clipping, and the BVH used for picking. No renderer here, so it runs (and
 * is tested) without a GPU.
 */
import type { CutReport } from "./cuts.ts";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import * as THREE from "three/webgpu";
import { DEFAULT_SPACING, explodeOffsets, planExplode, type ExplodeItem, type ExplodePlan, type ExplodeSpacing } from "./explode.ts";
import { BODY_TO_YUP_RX } from "./probe.ts";
import { GHOST_OPACITY, lookFor, type PbrLook } from "./materials.ts";
import { applyLook, ensureTangents, needsTangents, physicalMaterial } from "./presets.ts";
import { DIM_COLOR, DIM_OPACITY, MARK_COLORS, type MarkMap, type MarkStatus } from "./marks.ts";
import type { schema } from "@rw/contracts";
import { StencilCaps } from "../render/section.ts";

type Appearance = schema.Appearance;

/** Component kinds inside the airframe (mirrors rw-geom `frames::is_internal`). */
const AXIAL = new Set(["nose_cone", "body_tube", "transition"]);
const SURFACE = new Set(["trapezoidal_fin_set", "elliptical_fin_set", "freeform_fin_set", "tube_fin_set", "launch_lug", "rail_button"]);

export function isInternalKind(kind: string): boolean {
  return !AXIAL.has(kind) && !SURFACE.has(kind);
}

export interface PartMeta {
  name?: string;
  appearance?: Appearance | null;
  /** Tree parent (the host the part mounts in); drives the recursive explode. */
  parent?: string | null;
}

export interface Part {
  id: string;
  kind: string;
  internal: boolean;
  /** Top-level GLB node (body frame, child of the Y-up root). */
  node: THREE.Object3D;
  meshes: THREE.Mesh[];
  /** rw-geom `rw_explode`: its flat displacement at explode = 1 (body frame, metres). The viewport uses `AssemblyModel.plan`. */
  explode: THREE.Vector3;
  look: PbrLook;
  materials: THREE.MeshPhysicalNodeMaterial[];
  /**
   * Visual-only detail group (M3.0, `detail/registry.ts`), parented under
   * `node`. While it shows, the base materials are hidden (the base meshes
   * stay the pick proxy); x-ray ghosting and compare marks show the base
   * instead, so those looks stay one material per part.
   */
  detail?: THREE.Object3D | null;
  /** Whether the detail replaces the base meshes (default true). */
  detailReplacesBase?: boolean;
}

export interface PartStateInput {
  explode: number;
  hidden: readonly string[];
  showInternals: boolean;
  section: boolean;
}

/**
 * Kinds whose rw-geom mesh is a solid stand-in for soft or detailed contents
 * (packed chute, streamer, shock cord, a mass such as the flight computer):
 * the live section leaves them uncapped so their visual detail reads in the
 * cut instead of a hatched block (M3.3).
 */
export const CAP_PROXY_KINDS = new Set(["parachute", "streamer", "shock_cord", "mass_component"]);

/** The section plane keeps world z <= 0 (cuts away the half toward the Iso/Side camera). */
export const SECTION_PLANE = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);

export class AssemblyModel {
  /** Clipping group around the Y-up root (section toggle). */
  readonly root: THREE.ClippingGroup;
  /** Body-frame group rotated once to Y-up. */
  readonly body: THREE.Group;
  /**
   * Decorative groups under `body` that are not parts (page 05's aeroshell
   * panels): no pick, label, or outline, but the camera fit frames them and
   * leader labels avoid them (`ViewportEngine.partFootprints`).
   */
  readonly decor: THREE.Object3D[] = [];
  /**
   * Scene-level companions of `root` that must stay outside the clipping
   * group: the live section cap quad (M3.3). Add it to the scene beside `root`.
   */
  readonly overlay: THREE.Group;
  /** Live section caps (M3.3): stencil writers on every base mesh plus the cap quad in `overlay`. */
  readonly caps: StencilCaps;
  readonly parts = new Map<string, Part>();
  /** `asset.extras.model_hash` of the GLB, if any. */
  readonly modelHash: string | null;
  /** Recursive exploded-view layout (explode.ts), from the assembled bounds and the tree parents. */
  readonly plan: ExplodePlan;
  private explodeFactor = 0;
  private sectionOn = false;
  /** Compare marks (M2.7); null when not comparing. */
  private markState: MarkMap | null = null;
  private readonly disposers: (() => void)[] = [];
  /** What `applyDetail` built (M3.0), for the probe. */
  detailReport: readonly { id: string; builder: string; meshes: number; triangles: number }[] = [];
  /** What `applyCuts` subtracted before this model was built (R2.4), for the DOM and probes. */
  cutReport: CutReport | null = null;

  constructor(glbScene: THREE.Object3D, meta: Record<string, PartMeta> = {}, modelHash: string | null = null, spacing: ExplodeSpacing = DEFAULT_SPACING) {
    this.modelHash = modelHash;
    this.root = new THREE.ClippingGroup();
    this.root.name = "rw-assembly";
    this.root.clippingPlanes = [SECTION_PLANE];
    this.root.enabled = false;
    this.body = new THREE.Group();
    this.body.name = "rw-body";
    this.body.rotation.x = BODY_TO_YUP_RX;
    this.root.add(this.body);

    for (const node of [...glbScene.children]) {
      // A cutter (`cut = true`) is never a drawn part: `applyCuts` subtracts it from its parent.
      if (node.userData["rw_cut"] === true) continue;
      const ex = node.userData["rw_explode"] as unknown;
      const kind = typeof node.userData["rw_type"] === "string" ? (node.userData["rw_type"] as string) : "body_tube";
      const id = node.name;
      const explode = Array.isArray(ex) && ex.length === 3 ? new THREE.Vector3(Number(ex[0]), Number(ex[1]), Number(ex[2])) : new THREE.Vector3();
      const look = lookFor(meta[id]?.appearance, kind);
      const part: Part = { id, kind, internal: isInternalKind(kind), node, meshes: [], explode, look, materials: [] };
      // The GLB writer bakes `explode · rw_explode` into the translation; start from zero.
      node.position.set(0, 0, 0);
      node.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const mat = physicalMaterial(look);
        o.material = mat;
        if (needsTangents(mat)) ensureTangents(o.geometry as THREE.BufferGeometry);
        o.castShadow = true;
        o.receiveShadow = true;
        o.userData["rwPart"] = id;
        const geom = o.geometry as THREE.BufferGeometry & { computeBoundsTree?: typeof computeBoundsTree; boundsTree?: unknown };
        // Fin instances share one geometry; build its BVH once.
        if (geom.boundsTree === undefined) {
          geom.computeBoundsTree = computeBoundsTree;
          geom.computeBoundsTree();
        }
        o.raycast = acceleratedRaycast;
        part.meshes.push(o);
        part.materials.push(mat);
      });
      this.body.add(node);
      this.parts.set(id, part);
    }
    this.overlay = new THREE.Group();
    this.overlay.name = "rw-assembly-overlay";
    // Proxy volumes (stowed chute, streamer, avionics mass) get no cap: their detail shows through the cut.
    this.caps = new StencilCaps(
      [...this.parts.values()].filter((p) => !CAP_PROXY_KINDS.has(p.kind)).flatMap((p) => p.meshes),
      SECTION_PLANE,
    );
    this.overlay.add(this.caps.cap);
    this.root.updateMatrixWorld(true);
    // Assembled bounds; world (x, y, z) = body (x, z, -y).
    const items: ExplodeItem[] = [];
    const box = new THREE.Box3();
    const c = new THREE.Vector3();
    for (const p of this.parts.values()) {
      box.setFromObject(p.node, true);
      if (box.isEmpty()) box.set(new THREE.Vector3(), new THREE.Vector3());
      box.getCenter(c);
      items.push({
        id: p.id,
        kind: p.kind,
        parent: meta[p.id]?.parent ?? null,
        lo: box.min.x,
        hi: box.max.x,
        centreYZ: [-c.z, c.y],
        diameter: Math.max(box.max.y - box.min.y, box.max.z - box.min.z),
        clear: p.look.clear,
      });
    }
    this.plan = planExplode(items, spacing);
  }

  get explode(): number {
    return this.explodeFactor;
  }

  get section(): boolean {
    return this.sectionOn;
  }

  /** The compare marks in force (null: the normal look). */
  get marks(): MarkMap | null {
    return this.markState;
  }

  /** The mark of one part, or null (unmarked or not comparing). */
  markOf(id: string): MarkStatus | null {
    return this.markState?.[id] ?? null;
  }

  /**
   * Compare marks (M2.7): marked parts take their mark colour (removed red,
   * changed amber, added green), every other part a dim translucent grey.
   * Null restores each part's look. Opacity is applied by `apply`.
   */
  setMarks(marks: MarkMap | null): boolean {
    const same = (a: MarkMap | null, b: MarkMap | null) => {
      if (a === b) return true;
      if (a === null || b === null) return false;
      const ka = Object.keys(a);
      return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
    };
    if (same(marks, this.markState)) return false;
    this.markState = marks === null ? null : { ...marks };
    for (const p of this.parts.values()) {
      const m = this.markOf(p.id);
      const color = marks === null ? p.look.color : m !== null ? MARK_COLORS[m] : DIM_COLOR;
      for (const mat of p.materials) {
        if (marks === null) applyLook(mat, p.look);
        else {
          mat.color.set(color);
          mat.metalness = 0;
          mat.roughness = 0.6;
          mat.clearcoat = 0;
          mat.anisotropy = 0;
          mat.sheen = 0;
          // Marked and dimmed parts blend (apply sets the opacity); a transmissive mark would hide its colour.
          mat.transmission = 0;
          mat.depthWrite = true;
          mat.needsUpdate = true;
        }
        mat.emissive.set(m !== null ? color : "#000000");
        mat.emissiveIntensity = m !== null ? 0.25 : 0;
      }
    }
    return true;
  }

  /** Applies explode, visibility, x-ray, and section. Returns true when anything changed. */
  apply(s: PartStateInput): boolean {
    let changed = false;
    const f = Number.isFinite(s.explode) ? Math.min(1, Math.max(0, s.explode)) : 0;
    if (f !== this.explodeFactor) changed = true;
    this.explodeFactor = f;
    const hidden = new Set(s.hidden);
    const offsets = explodeOffsets(this.plan, f);
    for (const p of this.parts.values()) {
      const o = offsets.get(p.id);
      // Explicit zero when assembled (no -0 from negative directions).
      const pos = f === 0 || !o ? new THREE.Vector3() : new THREE.Vector3(o[0], o[1], o[2]);
      if (!pos.equals(p.node.position)) {
        p.node.position.copy(pos);
        changed = true;
      }
      const visible = !hidden.has(p.id);
      if (p.node.visible !== visible) {
        p.node.visible = visible;
        changed = true;
      }
      const ghost = s.showInternals && !p.internal && !p.look.clear;
      const marks = this.markState;
      const opacity = marks !== null ? (marks[p.id] !== undefined ? 1 : DIM_OPACITY) : ghost ? GHOST_OPACITY : p.look.opacity;
      // Detail shows only in the normal look; ghosting and marks recolour the base (one material per part).
      const detailOn = p.detail != null && !ghost && marks === null;
      if (p.detail != null && p.detail.visible !== detailOn) {
        p.detail.visible = detailOn;
        changed = true;
      }
      for (const m of p.materials) {
        const baseVisible = !detailOn || p.detailReplacesBase === false;
        if (m.visible !== baseVisible) {
          m.visible = baseVisible;
          changed = true;
        }
        if (m.opacity !== opacity) {
          m.opacity = opacity;
          m.transparent = opacity < 1;
          // Clear (transmissive) layers keep their RL1 depth rule at full opacity.
          m.depthWrite = opacity < 1 ? false : m.userData["rwClear"] === true && m.transmission > 0 ? m.userData["rwDepthWrite"] === true : true;
          m.needsUpdate = true;
          changed = true;
        }
      }
    }
    if (this.sectionOn !== s.section) {
      this.sectionOn = s.section;
      this.root.enabled = s.section;
      this.caps.setEnabled(s.section);
      changed = true;
    }
    this.root.updateMatrixWorld(true);
    if (this.sectionOn) this.caps.fit(this.bounds());
    return changed;
  }

  isVisible(id: string): boolean {
    return this.parts.get(id)?.node.visible ?? false;
  }

  /** World-space bounds of the visible parts (current explode). */
  bounds(target = new THREE.Box3()): THREE.Box3 {
    target.makeEmpty();
    const b = new THREE.Box3();
    for (const p of this.parts.values()) {
      if (!p.node.visible) continue;
      b.setFromObject(p.node, true);
      target.union(b);
    }
    return target;
  }

  /** World-space bounds of one part. */
  partBounds(id: string, target = new THREE.Box3()): THREE.Box3 | null {
    const p = this.parts.get(id);
    if (!p) return null;
    return target.setFromObject(p.node, true);
  }

  /** Visible base meshes (pick candidates; BVH). Visual-only detail never picks: its base mesh is the proxy. */
  pickables(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const p of this.parts.values()) if (p.node.visible) for (const m of p.meshes) if (m.userData["rwProvenance"] !== "visual") out.push(m);
    return out;
  }

  /** Runs `fn` when the model is disposed (detail teardown). */
  onDispose(fn: () => void): void {
    this.disposers.push(fn);
  }

  /** The component id owning `object`, walking up to the part node. */
  partOf(object: THREE.Object3D | null): string | null {
    for (let o = object; o; o = o.parent) {
      const id = o.userData["rwPart"];
      if (typeof id === "string") return id;
      if (this.parts.get(o.name)?.node === o) return o.name;
    }
    return null;
  }

  dispose(): void {
    for (const fn of this.disposers.splice(0)) fn();
    this.caps.dispose();
    const seen = new Set<THREE.BufferGeometry>();
    for (const p of this.parts.values()) {
      for (const m of p.meshes) {
        const g = m.geometry as THREE.BufferGeometry & { disposeBoundsTree?: typeof disposeBoundsTree };
        if (seen.has(g)) continue;
        seen.add(g);
        g.disposeBoundsTree = disposeBoundsTree;
        g.disposeBoundsTree();
        g.dispose();
      }
      for (const m of p.materials) m.dispose();
    }
  }
}

/**
 * Picks the nearest visible part under a normalised device coordinate,
 * skipping hits on the clipped-away side while the section is on.
 */
export function pickPart(model: AssemblyModel, camera: THREE.Camera, ndc: { x: number; y: number }, raycaster = new THREE.Raycaster()): string | null {
  raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
  const hits = raycaster.intersectObjects(model.pickables(), false);
  for (const h of hits) {
    if (model.section && SECTION_PLANE.distanceToPoint(h.point) < 0) continue;
    const id = model.partOf(h.object);
    if (id !== null) return id;
  }
  return null;
}
