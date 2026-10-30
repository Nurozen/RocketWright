/**
 * RL5 detail pipeline (no GPU): bevel/normal helpers, fabric and hardware
 * bounds, registry resolution, applyDetail on the contract-fixture GLB
 * (provenance, base proxy, picking, undo, model untouched), exploded
 * spacing rules, and the page-01 framing preset with its leader labels.
 */
import { readFileSync } from "node:fs";
import type { EvaluatedModel } from "@rw/contracts";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { glbModelHash } from "../viewport/glb-source.ts";
import { explodeOffsets } from "../viewport/explode.ts";
import { labelsDisjoint, layoutLabels } from "../viewport/labels.ts";
import { AssemblyModel, pickPart } from "../viewport/scene.ts";
import { chamferedPrism, filletPolyline, gridSurface, revolve, tubeProfile } from "./bevel.ts";
import { bayHardware, threadedRod } from "./hardware.ts";
import { lookFor } from "../viewport/materials.ts";
import { DetailMaterials } from "./looks.ts";
import { bundleGeometry, bundleRadius, parachuteDetail, type BundleOptions } from "./parachute.ts";
import {
  applyDetail,
  defaultDetailRegistry,
  DetailRegistry,
  explodeLayout,
  fitCamera,
  FRAMING_PRESETS,
  isClearComponent,
  presetPose,
  projectFraction,
  type Vec3,
} from "./registry.ts";

const repo = new URL("../../../../../", import.meta.url);
const glbBytes = readFileSync(new URL("app/apps/web/public/fixtures/contract-vehicle.glb", repo));
const evaluated = (JSON.parse(readFileSync(new URL("fixtures/contracts/evaluated-model.json", repo), "utf8")) as { payload: EvaluatedModel }).payload;
const comps = evaluated.components;
const byId = new Map(comps.map((c) => [c.id, c]));

async function fixtureModel(): Promise<AssemblyModel> {
  const ab = glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength) as ArrayBuffer;
  const gltf = await new GLTFLoader().parseAsync(ab, "");
  const meta = Object.fromEntries(comps.map((c) => [c.id, { name: c.name, appearance: c.appearance ?? null }]));
  return new AssemblyModel(gltf.scene, meta, glbModelHash(glbBytes));
}

function radialDot(g: THREE.BufferGeometry, i: number): { r: number; dot: number } {
  const p = g.getAttribute("position");
  const n = g.getAttribute("normal");
  const r = Math.hypot(p.getY(i), p.getZ(i));
  return { r, dot: (n.getY(i) * p.getY(i) + n.getZ(i) * p.getZ(i)) / (r || 1) };
}

describe("bevel and normal helpers", () => {
  it("fillets a corner with an arc inside the original corner", () => {
    const pts = filletPolyline(
      [
        [0, 0],
        [0, 1],
        [1, 1],
      ],
      0.2,
      4,
    );
    expect(pts.length).toBe(1 + 5 + 1);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-12);
      expect(p.r).toBeLessThanOrEqual(1 + 1e-12);
    }
    // The sharp corner (0, 1) is gone; the arc's midpoint sits 0.2(1 - 1/sqrt2) inside it.
    const mid = pts[3]!;
    expect(Math.hypot(mid.x - 0, mid.r - 1)).toBeCloseTo(0.2 * (Math.SQRT2 - 1), 6);
  });

  it("revolves a bevelled tube with outward normals on both walls", () => {
    const prof = tubeProfile({ x0: 0, x1: 0.1, ro: 0.02, ri: 0.018, bevel: 0.0006 });
    expect(prof.closed).toBe(true);
    const g = revolve(prof.points, { segments: 32, closed: true });
    const pos = g.getAttribute("position");
    let outer = 0;
    let inner = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      if (x < 0.0005 || x > 0.0995) continue;
      // Tangent points where the walls meet the fillets.
      const { r, dot } = radialDot(g, i);
      if (r > 0.02 - 1e-7) {
        expect(dot).toBeGreaterThan(0.9);
        outer++;
      } else if (r < 0.018 + 1e-7) {
        expect(dot).toBeLessThan(-0.9);
        inner++;
      }
    }
    expect(outer).toBeGreaterThan(0);
    expect(inner).toBeGreaterThan(0);
    g.computeBoundingBox();
    expect(g.boundingBox!.max.x).toBeLessThanOrEqual(0.1 + 1e-7);
    expect(g.boundingBox!.min.x).toBeGreaterThanOrEqual(-1e-9);
  });

  it("shares the seam vertices of a wrapped grid (smooth across the seam)", () => {
    const g = gridSurface(4, 16, (i, j, out) => out.set(i, Math.cos((j / 16) * 2 * Math.PI), Math.sin((j / 16) * 2 * Math.PI)), true);
    expect(g.getAttribute("position").count).toBe(5 * 16);
    const { dot } = radialDot(g, 2 * 16);
    expect(dot).toBeGreaterThan(0.99);
  });

  it("machines grooves and a hex nut with flat facets", () => {
    const grooved = tubeProfile({ x0: 0, x1: 0.01, ro: 0.02, ri: 0.015, bevel: 0.0005, grooves: [0.5], grooveDepth: 0.0004, grooveWidth: 0.0003 });
    const minR = Math.min(...grooved.points.filter((p) => Math.abs(p.x - 0.005) < 1e-9).map((p) => p.r));
    expect(minR).toBeCloseTo(0.0196, 9);
    const nut = chamferedPrism(0, 0.003, 0.004, 6, 0.0005, 0.0015);
    nut.computeBoundingBox();
    // Flat faces +Y: the across-flats half-width is r cos(30 deg).
    expect(nut.boundingBox!.max.y).toBeCloseTo(0.004 * Math.cos(Math.PI / 6), 6);
  });
});

describe("fabric and hardware", () => {
  const o: BundleOptions = { x0: 0.2, x1: 0.255, radius: 0.015, lobes: 5, twist: 1.1, depth: 0.2, folds: [0.38, 0.7], endPower: 2.6, phase: 0.4 };

  it("folds the chute inside its packed envelope", () => {
    for (let u = 0; u <= 1; u += 0.05) {
      for (let phi = 0; phi < 2 * Math.PI; phi += 0.1) {
        const r = bundleRadius(o, u, phi);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(o.radius * 1.03);
      }
    }
    // Lobes: the radius varies around the bundle at mid-length.
    const ring = Array.from({ length: 64 }, (_, k) => bundleRadius(o, 0.5, (k / 64) * 2 * Math.PI));
    expect(Math.max(...ring) - Math.min(...ring)).toBeGreaterThan(0.1 * o.radius);
    const g = bundleGeometry(o);
    g.computeBoundingBox();
    const b = g.boundingBox!;
    expect(b.min.x).toBeGreaterThanOrEqual(o.x0 - 1e-9);
    expect(b.max.x).toBeLessThanOrEqual(o.x1 + 1e-9);
    expect(Number.isFinite(b.max.y)).toBe(true);
    expect(g.getAttribute("color").count).toBe(g.getAttribute("position").count);
  });

  it("keeps bay rods clear of the packed chute and inside the bore", () => {
    const bay = byId.get("recovery_bay")!;
    const chute = byId.get("parachute")!;
    const hw = bayHardware(bay);
    expect(hw.rodCircle + hw.rodR).toBeLessThan(hw.ri);
    // The folded bundle shrinks (visual only) to clear the rod cage.
    const fabric = parachuteDetail({ component: chute, look: lookFor(chute.appearance ?? null, "parachute"), lookup: (id) => byId.get(id), showcase: [0, -1, 0], segments: 24, materials: new DetailMaterials() })!;
    const bundle = fabric.group.children.find((o) => o.name === "chute-bundle") as THREE.Mesh;
    const pos = bundle.geometry.getAttribute("position");
    let maxR = 0;
    for (let i = 0; i < pos.count; i++) maxR = Math.max(maxR, Math.hypot(pos.getY(i), pos.getZ(i)));
    expect(maxR).toBeLessThan(hw.rodCircle - hw.rodR);
    const rod = threadedRod(hw.foreFace, hw.aftFace, hw.rodR, 0.001, hw.rodCircle, 0);
    rod.computeBoundingBox();
    expect(rod.boundingBox!.max.y).toBeLessThanOrEqual(hw.rodCircle + hw.rodR + 1e-9);
    expect(rod.boundingBox!.min.x).toBeGreaterThanOrEqual(hw.foreFace - 1e-7);
  });
});

describe("detail registry", () => {
  it("resolves id bindings over rules, then the highest priority rule", () => {
    const nose = byId.get("nose")!;
    const r = new DetailRegistry()
      .rule({ name: "low", priority: 1, match: () => true, build: () => null })
      .rule({ name: "high", priority: 5, match: (c) => c.shape.type === "nose_cone", build: () => null });
    expect(r.resolve(nose)?.name).toBe("high");
    expect(r.resolve(byId.get("airframe")!)?.name).toBe("low");
    r.bind("nose", "pinned", () => null);
    expect(r.resolve(nose)?.name).toBe("pinned");
    expect(new DetailRegistry().resolve(nose)).toBeNull();
  });

  it("maps the fixture's components to the stock builders", () => {
    const reg = defaultDetailRegistry();
    const lookup = (id: string) => byId.get(id);
    const name = (id: string) => reg.resolve(byId.get(id)!, lookup)?.name ?? null;
    expect(name("recovery_bay")).toBe("clear-bay");
    expect(name("parachute")).toBe("folded-parachute");
    expect(name("airframe")).toBe("airframe-tube");
    expect(name("avionics")).toBe("flight-computer");
    expect(name("motor_mount")).toBe("motor-casing");
    expect(name("ring_upper")).toBe("machined-ring");
    expect(name("bulkhead")).toBe("bulkhead");
    expect(name("nose")).toBe("nose-shoulder");
    expect(name("fins")).toBe(byId.get("fins")!.shape.type === "trapezoidal_fin_set" ? "bevelled-fins" : null);
    expect(isClearComponent(byId.get("recovery_bay")!)).toBe(true);
  });

  it("attaches visual-only detail under the part nodes and keeps picking, selection, and the model intact", async () => {
    const model = await fixtureModel();
    const before = JSON.stringify(evaluated);
    const looks = new Map([...model.parts.values()].map((p) => [p.id, JSON.stringify(p.look)]));
    const applied = applyDetail(model, comps, defaultDetailRegistry(), { segments: 24 });
    const ids = applied.report.map((r) => r.id).sort();
    expect(ids).toEqual(["airframe", "avionics", "bulkhead", "fin_can", "fins", "motor_mount", "nose", "parachute", "recovery_bay", "ring_lower", "ring_upper"]);
    const bay = model.parts.get("recovery_bay")!;
    const group = bay.node.children.find((o) => o.name === "rw-detail:recovery_bay")!;
    expect(group.userData["rwProvenance"]).toBe("visual");
    const names = new Set<string>();
    group.traverse((o) => {
      names.add(o.name);
      if (o instanceof THREE.Mesh) expect(o.userData["rwPart"]).toBe("recovery_bay");
    });
    for (const n of ["bay-glass-near", "bay-glass-far", "bay-cap-fore", "bay-cap-aft", "bay-threaded-rods", "bay-nuts", "bay-eyebolt-fore", "bay-twist-lugs"]) expect(names).toContain(n);
    // The base mesh is hidden but still the first (BVH) pick proxy; outline meshes follow it.
    expect((bay.meshes[0]!.material as THREE.Material).visible).toBe(false);
    expect(bay.node.visible).toBe(true);
    expect(bay.meshes.some((m) => m.name === "bay-glass-near")).toBe(true);
    // A ray down onto the bay's middle still picks the bay.
    const box = model.partBounds("recovery_bay")!;
    const c = box.getCenter(new THREE.Vector3());
    const cam = new THREE.PerspectiveCamera(30, 1, 0.001, 100);
    cam.position.set(c.x, c.y + 1, c.z);
    cam.lookAt(c);
    cam.updateMatrixWorld(true);
    expect(pickPart(model, cam, { x: 0, y: 0 })).toBe("recovery_bay");
    // Visual only: the evaluated model and the part looks are untouched.
    expect(JSON.stringify(evaluated)).toBe(before);
    for (const p of model.parts.values()) expect(JSON.stringify(p.look)).toBe(looks.get(p.id));
    // Explode still moves detail with its part.
    const dx = explodeOffsets(model.plan, 1).get("recovery_bay")![0];
    expect(Math.abs(dx)).toBeGreaterThan(0.01);
    model.apply({ explode: 1, hidden: [], showInternals: false, section: false });
    const moved = model.partBounds("recovery_bay")!;
    expect(moved.min.x).toBeCloseTo(box.min.x + dx, 6);
    applied.dispose();
    expect(bay.node.children.some((o) => o.name.startsWith("rw-detail:"))).toBe(false);
    expect(bay.meshes.every((m) => (m.material as THREE.Material).visible)).toBe(true);
    model.dispose();
  });
});

describe("exploded spacing", () => {
  const isClear = (id: string) => isClearComponent(byId.get(id)!);
  const gap = 0.03;

  it("orders items, keeps riders with their carriers, and leaves equal gaps", () => {
    const l = explodeLayout({ components: comps, isClear, gap });
    expect(l.carrier.get("parachute")).toBe("recovery_bay");
    expect(l.carrier.get("fins")).toBe("fin_can");
    expect(l.carrier.get("lug")).toBe("airframe");
    expect(l.carrier.has("avionics")).toBe(false);
    // Inner items leave their opaque carrier through the nearer end.
    expect(l.order.slice(0, 5)).toEqual(["nose", "recovery_bay", "bulkhead", "avionics", "airframe"]);
    expect(l.order.slice(-4)).toEqual(["ring_upper", "fin_can", "motor_mount", "ring_lower"]);
    for (let i = 1; i < l.order.length; i++) {
      const a = l.span.get(l.order[i - 1]!)!;
      const b = l.span.get(l.order[i]!)!;
      expect(b[0] - a[1]).toBeCloseTo(gap, 9);
    }
    expect(l.offset.get("parachute")).toBe(l.offset.get("recovery_bay"));
    // The exploded layout stays centred on the assembled one.
    const lo = Math.min(...comps.map((c) => c.x_fore));
    const hi = Math.max(...comps.map((c) => c.x_aft));
    const s0 = l.span.get(l.order[0]!)!;
    const s1 = l.span.get(l.order.at(-1)!)!;
    expect((s0[0] + s1[1]) / 2).toBeCloseTo((lo + hi) / 2, 9);
    expect(explodeLayout({ components: comps, isClear, gap })).toEqual(l);
  });

  it("uses measured extents when given", () => {
    const l = explodeLayout({ components: comps, isClear, gap, extent: (id) => (id === "nose" ? [0, 0.25] : null) });
    const nose = l.span.get("nose")!;
    const bay = l.span.get("recovery_bay")!;
    expect(bay[0] - nose[1]).toBeCloseTo(gap, 9);
  });
});

describe("framing presets", () => {
  it("tilts the body axis to the preset angle on screen", () => {
    for (const p of Object.values(FRAMING_PRESETS)) {
      const pose = presetPose(p);
      const ang = (Math.atan2(pose.up[0], pose.right[0]) * 180) / Math.PI;
      expect(ang).toBeCloseTo(p.axisTiltDeg, 6);
      const d = pose.right[0] * pose.up[0] + pose.right[1] * pose.up[1] + pose.right[2] * pose.up[2];
      expect(d).toBeCloseTo(0, 9);
    }
  });

  it("fits the exploded fixture into the page-01 rectangle with disjoint leader labels", async () => {
    const preset = FRAMING_PRESETS["01"];
    const model = await fixtureModel();
    const l = explodeLayout({ components: comps, isClear: (id) => isClearComponent(byId.get(id)!), gap: 0.03 });
    for (const p of model.parts.values()) p.explode.set(l.offset.get(p.id) ?? 0, 0, 0);
    model.apply({ explode: 1, hidden: [], showInternals: false, section: false });
    const pts: Vec3[] = [];
    const box = new THREE.Box3();
    for (const id of l.order) {
      model.partBounds(id, box);
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) pts.push([x, y, z]);
    }
    const aspect = 892 / 733;
    const pose = presetPose(preset);
    const fit = fitCamera(pts, pose, preset.fovDeg, aspect, preset.fit);
    const f = preset.fit;
    expect(fit.bounds.x0).toBeGreaterThanOrEqual(f.x0 - 1e-3);
    expect(fit.bounds.x1).toBeLessThanOrEqual(f.x1 + 1e-3);
    expect(fit.bounds.y0).toBeGreaterThanOrEqual(f.y0 - 1e-3);
    expect(fit.bounds.y1).toBeLessThanOrEqual(f.y1 + 1e-3);
    // The tighter axis touches its edges.
    const fill = Math.max((fit.bounds.x1 - fit.bounds.x0) / (f.x1 - f.x0), (fit.bounds.y1 - fit.bounds.y0) / (f.y1 - f.y0));
    expect(fill).toBeGreaterThan(0.98);
    const anchors = l.order.map((id, k) => {
      model.partBounds(id, box);
      const c = box.getCenter(new THREE.Vector3());
      const s = projectFraction([c.x, c.y, c.z], fit.position, pose, preset.fovDeg, aspect);
      return { id, text: byId.get(id)!.name, x: s.x * 892, y: s.y * 733, r: 8, order: k };
    });
    const labels = layoutLabels(anchors, { width: 892, height: 733, normal: [0.68, 0.73] });
    expect(labels.length).toBe(l.order.length);
    expect(labelsDisjoint(labels, 2)).toBe(true);
    model.dispose();
  });
});

