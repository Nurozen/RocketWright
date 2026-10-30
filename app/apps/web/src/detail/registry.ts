/**
 * The detail-pipeline API (RL5 defines it; M3.0 productionizes it).
 *
 * - **Registry**: component id -> detail builder. `bind(id, ...)` pins a
 *   builder to one component; rules match by kind, appearance, or role
 *   (`rule({...})`, highest priority wins). `defaultDetailRegistry()`
 *   registers the stock builders (clear bay, folded parachute, streamer,
 *   electronics bay, flight computer, bevelled tubes, airframe tubes with
 *   coupler lips and the motor retainer, the nose shoulder, rounded fin
 *   plates, machined rings, bulkhead, motor casing).
 * - **applyDetail**: builds every resolved component's detail and parents it
 *   under the part's GLB node, so explode, visibility, section clipping, and
 *   selection keep working through `AssemblyModel`. The rw-geom base mesh's
 *   material is hidden; the mesh stays the pick proxy (BVH). Detail meshes are tagged
 *   `rwProvenance: "visual"` (I13) and never touch the evaluated model.
 * - **Helpers** re-exported here: bevel/normal (`bevel.ts`), materials
 *   (`looks.ts`), exploded spacing (`explode.ts`), framing presets
 *   (`framing.ts`).
 */
import * as THREE from "three/webgpu";
import { lookFor } from "../viewport/materials.ts";
import { ensureTangents, needsTangents } from "../viewport/presets.ts";
import type { AssemblyModel } from "../viewport/scene.ts";
import { triangleCount } from "./bevel.ts";
import { electronicsBayDetail, flightComputerDetail } from "./electronics.ts";
import { motorCasingDetail } from "./fittings.ts";
import { FRAMING_PRESETS } from "./framing.ts";
import { bevelledTubeDetail, bulkheadDetail, clearBayDetail, ringDetail } from "./hardware.ts";
import { DetailMaterials } from "./looks.ts";
import { airframeTubeDetail, noseShoulderDetail } from "./airframe.ts";
import { finSetDetail } from "./fins.ts";
import { parachuteDetail, streamerDetail } from "./parachute.ts";
import type { DetailBuilder, DetailContext, DetailReportRow, DetailRule, EvalComponent, Vec3 } from "./types.ts";

export type { DetailBuilder, DetailContext, DetailReportRow, DetailResult, DetailRule, EvalComponent, Vec3 } from "./types.ts";
export { chamferedPrism, filletPolyline, gridSurface, merge, revolve, roundedBox, smoothNormals, triangleCount, tubeProfile } from "./bevel.ts";
export type { ProfilePoint, RevolveOptions, TubeProfileOptions } from "./bevel.ts";
export { DetailMaterials, FINISHES, glassMaterial, type FinishId } from "./looks.ts";
export { explodeLayout, riderCarrier, type ExplodeInput, type ExplodeLayout } from "./explode.ts";
export { FRAMING_PRESETS, fitCamera, presetPose, projectFraction, type CameraFit, type FitRect, type FramingId, type FramingPreset, type Pose } from "./framing.ts";

export interface ResolvedBuilder {
  name: string;
  build: DetailBuilder;
}

export class DetailRegistry {
  private readonly byId = new Map<string, ResolvedBuilder>();
  private readonly rules: (DetailRule & { seq: number })[] = [];

  /** Pins `build` to one component id (wins over every rule). */
  bind(id: string, name: string, build: DetailBuilder): this {
    this.byId.set(id, { name, build });
    return this;
  }

  /** Adds a matching rule. */
  rule(r: DetailRule): this {
    this.rules.push({ ...r, seq: this.rules.length });
    return this;
  }

  /** The builder for `c`: its id binding, else the highest-priority matching rule, else null (the base mesh stays). */
  resolve(c: EvalComponent, lookup: (id: string) => EvalComponent | undefined = () => undefined): ResolvedBuilder | null {
    const pinned = this.byId.get(c.id);
    if (pinned) return pinned;
    let best: (DetailRule & { seq: number }) | null = null;
    for (const r of this.rules) {
      if (!r.match(c, { lookup })) continue;
      if (best === null || (r.priority ?? 0) > (best.priority ?? 0)) best = r;
    }
    return best ? { name: best.name, build: best.build } : null;
  }
}

/** Whether a component renders see-through (its appearance resolves to a clear look). */
export function isClearComponent(c: EvalComponent): boolean {
  return lookFor(c.appearance ?? null, c.shape.type).clear;
}

const kind = (c: EvalComponent) => c.shape.type;
const AVIONICS_ROLES = new Set(["flight_computer", "avionics", "electronics", "altimeter"]);
const role = (c: EvalComponent): string | null => {
  const r = (c.shape as unknown as Record<string, unknown>)["role"];
  return typeof r === "string" ? r : null;
};
const hasAvionics = (c: EvalComponent, lookup: (id: string) => EvalComponent | undefined) =>
  c.children.some((id) => {
    const k = lookup(id);
    return k !== undefined && kind(k) === "mass_component" && AVIONICS_ROLES.has(role(k) ?? "");
  });

/** The stock builders. Rules are generic (kind, appearance, role); nothing is keyed to the fixture's ids. */
export function defaultDetailRegistry(): DetailRegistry {
  return new DetailRegistry()
    .rule({ name: "clear-bay", priority: 20, match: (c) => kind(c) === "body_tube" && isClearComponent(c), build: clearBayDetail })
    .rule({ name: "bevelled-tube", priority: 10, match: (c) => kind(c) === "coupler", build: bevelledTubeDetail })
    .rule({ name: "airframe-tube", priority: 10, match: (c) => kind(c) === "body_tube", build: airframeTubeDetail })
    .rule({ name: "nose-shoulder", priority: 10, match: (c) => kind(c) === "nose_cone", build: noseShoulderDetail })
    .rule({ name: "bevelled-fins", priority: 10, match: (c) => kind(c) === "trapezoidal_fin_set", build: finSetDetail })
    .rule({
      name: "electronics-bay",
      priority: 20,
      match: (c, { lookup }) => kind(c) === "coupler" && (hasAvionics(c, lookup) || c.appearance?.preset === "pcb_green"),
      build: electronicsBayDetail,
    })
    .rule({ name: "folded-parachute", priority: 10, match: (c) => kind(c) === "parachute", build: parachuteDetail })
    .rule({ name: "rolled-streamer", priority: 10, match: (c) => kind(c) === "streamer", build: streamerDetail })
    .rule({ name: "flight-computer", priority: 10, match: (c) => kind(c) === "mass_component" && (AVIONICS_ROLES.has(role(c) ?? "") || c.appearance?.preset === "pcb_green"), build: flightComputerDetail })
    .rule({ name: "machined-ring", priority: 10, match: (c) => kind(c) === "centering_ring", build: ringDetail })
    .rule({ name: "bulkhead", priority: 10, match: (c) => kind(c) === "bulkhead", build: bulkheadDetail })
    .rule({
      name: "motor-casing",
      priority: 15,
      match: (c) => kind(c) === "inner_tube" && (c.shape as unknown as Record<string, unknown>)["motor_mount"] === true,
      build: motorCasingDetail,
    })
    .rule({ name: "bevelled-inner-tube", priority: 10, match: (c) => kind(c) === "inner_tube", build: bevelledTubeDetail });
}

export interface ApplyDetailOptions {
  /** Body-frame direction toward the default viewer (window and board facing). Default: the page-01 camera. */
  showcase?: Vec3;
  segments?: number;
  materials?: DetailMaterials;
}

export interface AppliedDetail {
  report: DetailReportRow[];
  materials: DetailMaterials;
  /** Removes the detail groups, restores the base meshes, and frees detail GPU data. */
  dispose(): void;
}

/** Page-01 camera direction in the body frame (world (x, y, z) -> body (x, -z, y)). */
export const SHOWCASE_01: Vec3 = (() => {
  const w = FRAMING_PRESETS["01"].dir;
  const v: Vec3 = [w[0], -w[2], w[1]];
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
})();

/** Builds and attaches detail for every part of `model` that has a builder. */
export function applyDetail(model: AssemblyModel, components: readonly EvalComponent[], registry: DetailRegistry, opts: ApplyDetailOptions = {}): AppliedDetail {
  const byId = new Map(components.map((c) => [c.id, c]));
  const lookup = (id: string) => byId.get(id);
  const materials = opts.materials ?? new DetailMaterials();
  const report: DetailReportRow[] = [];
  const undo: (() => void)[] = [];
  const geoms = new Set<THREE.BufferGeometry>();
  for (const part of model.parts.values()) {
    const c = byId.get(part.id);
    if (!c) continue;
    // A part with cuts subtracted (`applyCuts`, R2.4: vents, slots) keeps its cut base mesh: the
    // detail builders rebuild the uncut shape from the model and would hide the holes.
    if (part.meshes.some((m) => m.userData["rwCut"] === true)) continue;
    const resolved = registry.resolve(c, lookup);
    if (!resolved) continue;
    const ctx: DetailContext = { component: c, look: part.look, lookup, showcase: opts.showcase ?? SHOWCASE_01, segments: opts.segments ?? 96, materials };
    const result = resolved.build(ctx);
    if (!result) continue;
    const group = result.group;
    group.name = `rw-detail:${part.id}`;
    group.userData["rwProvenance"] = "visual";
    group.userData["rwDetail"] = resolved.name;
    let meshes = 0;
    let tris = 0;
    group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.userData["rwPart"] = part.id;
      o.userData["rwProvenance"] = "visual";
      const glass = (o.material as THREE.Material).userData["rwGlass"] === true;
      o.castShadow = !glass;
      if (needsTangents(o.material as THREE.Material)) ensureTangents(o.geometry);
      o.receiveShadow = true;
      meshes++;
      tris += triangleCount(o.geometry);
      geoms.add(o.geometry);
    });
    part.node.add(group);
    const base = [...part.meshes];
    const replaces = result.replacesBase !== false;
    part.detail = group;
    part.detailReplacesBase = replaces;
    // Hide the base through its material: for single-mesh parts the GLB node *is* the base mesh,
    // and hiding the node would hide the detail under it. Renderers skip invisible materials;
    // raycasting does not, so the base stays the BVH pick proxy.
    const baseMats = base.map((m) => m.material as THREE.Material);
    if (replaces) for (const m of baseMats) m.visible = false;
    const outline = result.outline ?? group.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
    // Outline (and picking) see the detail silhouette; hidden base meshes stay pickable through the BVH.
    part.meshes.push(...outline);
    undo.push(() => {
      part.node.remove(group);
      part.meshes.splice(base.length);
      part.detail = null;
      if (replaces) for (const m of baseMats) m.visible = true;
    });
    report.push({ id: part.id, builder: resolved.name, meshes, triangles: tris });
  }
  model.root.updateMatrixWorld(true);
  return {
    report,
    materials,
    dispose() {
      for (const u of undo) u();
      for (const g of geoms) g.dispose();
      materials.dispose();
    },
  };
}
