/**
 * M1.50 viewport units (no GPU): view presets, framing, leader-label layout,
 * gizmo, GLB source fallback, and the assembly scene (recursive explode,
 * visibility, section, BVH picking) on the contract-fixture GLB.
 */
import { readFileSync } from "node:fs";
import type { EvaluatedModel } from "@rw/contracts";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { gizmoAxes } from "./gizmo.ts";
import { glbModelHash, loadAssemblyGlb, MESH_OPTIONS } from "./glb-source.ts";
import { labelsDisjoint, layoutLabels, leadersClean, rectsOverlap, segmentHitsRect, segmentsCross, type LabelAnchor } from "./labels.ts";
import { lookFor, PRESET_LOOKS } from "./materials.ts";
import { AssemblyModel, isInternalKind, pickPart, SECTION_PLANE } from "./scene.ts";
import { cameraBasis, fitDistance, framePosition, ISO_AXIS_TILT_DEG, isoTiltFor, screenDir, VIEW_IDS, viewPose } from "./views.ts";

const repo = new URL("../../../../../", import.meta.url);
const glbBytes = readFileSync(new URL("app/apps/web/public/fixtures/contract-vehicle.glb", repo));
const evaluated = (JSON.parse(readFileSync(new URL("fixtures/contracts/evaluated-model.json", repo), "utf8")) as { payload: EvaluatedModel }).payload;

async function fixtureModel(): Promise<AssemblyModel> {
  const ab = glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength) as ArrayBuffer;
  const gltf = await new GLTFLoader().parseAsync(ab, "");
  const meta = Object.fromEntries(evaluated.components.map((c) => [c.id, { name: c.name, appearance: c.appearance ?? null, parent: c.parent ?? null }]));
  return new AssemblyModel(gltf.scene, meta, glbModelHash(glbBytes));
}

function cameraFor(model: AssemblyModel, view: (typeof VIEW_IDS)[number], aspect = 1.4): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(30, aspect, 0.001, 100);
  const sphere = model.bounds().getBoundingSphere(new THREE.Sphere());
  const pose = viewPose(view);
  const pos = framePosition(pose, [sphere.center.x, sphere.center.y, sphere.center.z], sphere.radius, 30, aspect);
  cam.position.set(...pos);
  cam.up.set(...pose.up);
  cam.lookAt(sphere.center);
  cam.updateMatrixWorld(true);
  return cam;
}

/** NDC of a world point. */
function ndcOf(cam: THREE.Camera, p: THREE.Vector3): { x: number; y: number } {
  const v = p.clone().project(cam);
  return { x: v.x, y: v.y };
}

describe("view presets", () => {
  it("gives orthonormal poses for every chip", () => {
    for (const v of VIEW_IDS) {
      const b = cameraBasis(viewPose(v));
      for (const a of [b.right, b.up, b.back]) expect(Math.hypot(...a)).toBeCloseTo(1, 9);
      expect(b.right[0] * b.up[0] + b.right[1] * b.up[1] + b.right[2] * b.up[2]).toBeCloseTo(0, 9);
    }
  });

  it("Iso runs the body axis down to the right; Side and Top keep the nose left", () => {
    const [x, y] = screenDir(viewPose("iso"), [1, 0, 0]);
    expect((Math.atan2(y, x) * 180) / Math.PI).toBeCloseTo(-ISO_AXIS_TILT_DEG, 6);
    expect(screenDir(viewPose("side"), [1, 0, 0])[0]).toBeCloseTo(1, 9);
    expect(screenDir(viewPose("top"), [1, 0, 0])[0]).toBeCloseTo(1, 9);
    // Front looks aft (camera ahead of the nose), Rear looks fore.
    expect(viewPose("front").dir[0]).toBeLessThan(0);
    expect(viewPose("rear").dir[0]).toBeGreaterThan(0);
  });

  it("tilts Iso to the viewport diagonal, clamped", () => {
    expect(isoTiltFor(893, 735)).toBeCloseTo((Math.atan2(735, 893) * 180) / Math.PI, 9);
    expect(isoTiltFor(2000, 300)).toBe(26);
    expect(isoTiltFor(300, 2000)).toBe(46);
    expect(isoTiltFor(0, 0)).toBe(ISO_AXIS_TILT_DEG);
    const [x, y] = screenDir(viewPose("iso", 40), [1, 0, 0]);
    expect((Math.atan2(y, x) * 180) / Math.PI).toBeCloseTo(-40, 6);
  });

  it("frames a sphere inside the narrower field of view", () => {
    const d1 = fitDistance(1, 30, 2);
    const d2 = fitDistance(1, 30, 0.5);
    expect(d2).toBeGreaterThan(d1);
    expect(1 / d1).toBeLessThan(Math.sin((15 * Math.PI) / 180));
  });
});

describe("leader labels", () => {
  const anchors = (n: number, spread: number): LabelAnchor[] =>
    Array.from({ length: n }, (_, i) => ({ id: `p${i}`, text: `Part number ${i}`, x: 200 + i * spread, y: 150 + i * spread * 0.6, r: 10, order: i }));

  it("places one label per in-view anchor without overlaps, inside the viewport", () => {
    const placed = layoutLabels(anchors(12, 18), { width: 800, height: 600 });
    expect(placed).toHaveLength(12);
    expect(labelsDisjoint(placed, 0)).toBe(true);
    for (const l of placed) {
      expect(l.box.x).toBeGreaterThanOrEqual(0);
      expect(l.box.y).toBeGreaterThanOrEqual(0);
      expect(l.box.x + l.box.w).toBeLessThanOrEqual(800);
      expect(l.box.y + l.box.h).toBeLessThanOrEqual(600);
      expect(l.collided).toBe(false);
      // The run from the elbow to the label is horizontal.
      expect(l.end[1]).toBe(l.elbow[1]);
    }
  });

  it("handles collisions by spreading stacked anchors and avoiding keep-outs", () => {
    const stacked = anchors(6, 0).map((a) => ({ ...a, x: 300, y: 300 }));
    const avoid = [{ x: 0, y: 0, w: 800, h: 120 }];
    const placed = layoutLabels(stacked, { width: 800, height: 600, avoid });
    expect(placed).toHaveLength(6);
    expect(labelsDisjoint(placed, 0)).toBe(true);
    for (const l of placed) expect(rectsOverlap(l.box, avoid[0]!)).toBe(false);
  });

  it("alternates sides along a diagonal, with clean leaders that never cross or overprint", () => {
    // A tight diagonal run like the exploded rings and bulkheads.
    const diag: LabelAnchor[] = Array.from({ length: 14 }, (_, i) => ({ id: `p${i}`, text: i % 3 ? `Centering ring ${i}` : `Bay ${i}`, x: 120 + i * 34, y: 90 + i * 30, r: 9, order: i }));
    const placed = layoutLabels(diag, { width: 900, height: 720, normal: [0.66, -0.75] });
    expect(placed).toHaveLength(14);
    expect(labelsDisjoint(placed, 0)).toBe(true);
    expect(leadersClean(placed)).toBe(true);
    for (const l of placed) expect(l.collided).toBe(false);
    const sides = placed.map((l) => l.side);
    expect(sides.filter((s) => s === 1).length).toBeGreaterThan(3);
    expect(sides.filter((s) => s === -1).length).toBeGreaterThan(3);
  });

  it("keeps labels off the model's footprint and reserves the accessory slot", () => {
    const parts = [{ id: "a", x: 300, y: 300, w: 200, h: 40 }];
    const placed = layoutLabels([{ id: "a", text: "Airframe tube", x: 400, y: 320, r: 20, order: 0, accessory: 26 }], { width: 800, height: 600, obstacles: parts });
    expect(placed[0]!.accessory).toBe(26);
    expect(placed[0]!.box.w).toBeGreaterThan(26 + 13 * 6);
    expect(rectsOverlap(placed[0]!.box, parts[0]!)).toBe(false);
  });

  it("segment helpers", () => {
    expect(segmentsCross([[0, 0], [10, 10]], [[0, 10], [10, 0]])).toBe(true);
    expect(segmentsCross([[0, 0], [10, 0]], [[0, 5], [10, 5]])).toBe(false);
    expect(segmentHitsRect([[0, 0], [100, 100]], { x: 40, y: 40, w: 5, h: 5 })).toBe(true);
    expect(segmentHitsRect([[0, 0], [100, 0]], { x: 40, y: 40, w: 5, h: 5 })).toBe(false);
  });

  it("drops anchors outside the viewport and is deterministic", () => {
    const a = [...anchors(3, 30), { id: "off", text: "Off", x: -50, y: 10, r: 1, order: 9 }];
    const one = layoutLabels(a, { width: 640, height: 480 });
    expect(one.map((l) => l.id)).toEqual(["p0", "p1", "p2"]);
    expect(layoutLabels(a, { width: 640, height: 480 })).toEqual(one);
  });
});

describe("axis gizmo", () => {
  it("draws body X right, Z up in Side view", () => {
    const axes = gizmoAxes(cameraBasis(viewPose("side")), 64);
    const by = Object.fromEntries(axes.map((a) => [a.axis, a]));
    expect(by.X!.x).toBeGreaterThan(32);
    expect(by.X!.y).toBeCloseTo(32, 6);
    expect(by.Z!.y).toBeLessThan(32);
    expect(by.X!.color).toBe("#e5484d");
  });
});

describe("materials", () => {
  it("maps fixture presets and overrides", () => {
    expect(lookFor({ preset: "clear_polycarbonate" }, "body_tube").clear).toBe(true);
    expect(lookFor(null, "parachute")).toEqual(PRESET_LOOKS.nylon_orange);
    expect(lookFor({ preset: "composite_white", color: "#112233" }, "body_tube").color).toBe("#112233");
  });
});

describe("GLB source", () => {
  const fixture = new Uint8Array([1, 2, 3]);
  it("uses rw-wasm mesh_glb when the wrapper exposes it", async () => {
    let opts: unknown = null;
    const out = await loadAssemblyGlb(evaluated, {
      loadWasm: async () => ({ meshModelGlb: (_m: EvaluatedModel, o: unknown) => ((opts = o), new Uint8Array([9])) }),
      fetchFixture: async () => fixture,
    });
    expect(out.source).toBe("rw-wasm");
    expect(opts).toEqual(MESH_OPTIONS);
  });

  it("falls back to the contract fixture on the spike wrapper or a load failure", async () => {
    expect((await loadAssemblyGlb(evaluated, { loadWasm: async () => ({ coreVersion: () => "x" }), fetchFixture: async () => fixture })).source).toBe("contract-fixture");
    expect((await loadAssemblyGlb(evaluated, { loadWasm: async () => Promise.reject(new Error("no pkg")), fetchFixture: async () => fixture })).source).toBe("contract-fixture");
    expect((await loadAssemblyGlb(null, { loadWasm: async () => ({}), fetchFixture: async () => fixture })).bytes).toBe(fixture);
  });

  it("reads the model hash of the committed fixture", () => {
    expect(glbModelHash(glbBytes)).toBe(evaluated.model_hash);
  });
});

describe("assembly scene (contract-fixture GLB)", () => {
  it("has one part per evaluated component with its kind and look", async () => {
    const m = await fixtureModel();
    expect([...m.parts.keys()].sort()).toEqual(evaluated.components.map((c) => c.id).sort());
    expect(m.parts.get("recovery_bay")!.look.clear).toBe(true);
    expect(m.parts.get("parachute")!.internal).toBe(true);
    expect(m.parts.get("fins")!.meshes).toHaveLength(4);
    expect(isInternalKind("trapezoidal_fin_set")).toBe(false);
  });

  it("explodes recursively along the body axis (body +X -> world +X) and reports changes", async () => {
    const m = await fixtureModel();
    const base = { hidden: [], showInternals: false, section: false };
    const c0 = m.partBounds("nose")!.getCenter(new THREE.Vector3());
    const len0 = m.bounds().getSize(new THREE.Vector3()).x;
    expect(m.apply({ ...base, explode: 0 })).toBe(false);
    expect(m.apply({ ...base, explode: 0.6 })).toBe(true);
    const c1 = m.partBounds("nose")!.getCenter(new THREE.Vector3());
    expect(c1.x - c0.x).toBeLessThan(-0.05);
    expect(c1.y - c0.y).toBeCloseTo(0, 6);
    expect(m.bounds().getSize(new THREE.Vector3()).x).toBeGreaterThan(len0 * 1.2);
    // Sequenced parts sit end to end with clear gaps.
    const order = m.plan.order;
    expect(order[0]).toBe("nose");
    const box = (id: string) => m.partBounds(id)!;
    for (let i = 1; i < order.length; i++) expect(box(order[i]!).min.x, `${order[i - 1]} | ${order[i]}`).toBeGreaterThan(box(order[i - 1]!).max.x + 0.005);
  });

  it("hides parts, ghosts outer parts for internals, and toggles the section group", async () => {
    const m = await fixtureModel();
    m.apply({ explode: 0, hidden: ["lug"], showInternals: true, section: true });
    expect(m.isVisible("lug")).toBe(false);
    expect(m.pickables().some((x) => x.userData["rwPart"] === "lug")).toBe(false);
    expect(m.parts.get("airframe")!.materials[0]!.opacity).toBeLessThan(0.5);
    expect(m.parts.get("parachute")!.materials[0]!.opacity).toBe(1);
    expect(m.root.enabled).toBe(true);
    expect(m.root.clippingPlanes).toContain(SECTION_PLANE);
  });

  it("picks parts through the BVH from every preset view", async () => {
    const m = await fixtureModel();
    m.apply({ explode: 0.6, hidden: [], showInternals: false, section: false });
    for (const view of ["iso", "side", "top"] as const) {
      const cam = cameraFor(m, view);
      for (const id of ["nose", "recovery_bay", "airframe", "motor_mount"]) {
        const c = m.partBounds(id)!.getCenter(new THREE.Vector3());
        expect(pickPart(m, cam, ndcOf(cam, c)), `${view}:${id}`).toBe(id);
      }
      expect(pickPart(m, cam, { x: 0.98, y: 0.98 })).toBeNull();
    }
  });

  it("skips hidden parts and the clipped-away half when picking", async () => {
    const m = await fixtureModel();
    m.apply({ explode: 0, hidden: [], showInternals: false, section: false });
    const cam = cameraFor(m, "side");
    // Off the mesh seam (a ray exactly along a triangle edge is ambiguous).
    const c = m.partBounds("recovery_bay")!.getCenter(new THREE.Vector3()).add(new THREE.Vector3(0.025, 0.004, 0)); // aft of the nose shoulder
    // Assembled, the bay wall is in front of the parachute.
    expect(pickPart(m, cam, ndcOf(cam, c))).toBe("recovery_bay");
    // Section: the near wall is cut away, the stowed parachute is hit.
    m.apply({ explode: 0, hidden: [], showInternals: false, section: true });
    expect(pickPart(m, cam, ndcOf(cam, c))).toBe("parachute");
    m.apply({ explode: 0, hidden: ["parachute"], showInternals: false, section: true });
    expect(pickPart(m, cam, ndcOf(cam, c))).toBe("recovery_bay");
  });
});
