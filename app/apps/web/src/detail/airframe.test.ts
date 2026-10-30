/**
 * BC5 fidelity geometry (visual tier): rounded fin plates at the model's
 * thickness, the nose shoulder lip, coupler lips, and the motor retainer,
 * built from the contract fixture's evaluated components.
 */
import { readFileSync } from "node:fs";
import type { EvaluatedModel } from "@rw/contracts";
import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { lookFor } from "../viewport/materials.ts";
import { airframeTubeDetail, foreHost, motorMountOf, noseShoulderDetail } from "./airframe.ts";
import { edgeRadius, finSetDetail, insetConvex, polygonArea, roundedPlate } from "./fins.ts";
import { DetailMaterials } from "./looks.ts";
import type { DetailContext, EvalComponent } from "./types.ts";

const repo = new URL("../../../../../", import.meta.url);
const evaluated = (JSON.parse(readFileSync(new URL("fixtures/contracts/evaluated-model.json", repo), "utf8")) as { payload: EvaluatedModel }).payload;
const byId = new Map(evaluated.components.map((c) => [c.id, c as EvalComponent]));
const lookup = (id: string) => byId.get(id);

function ctx(id: string): DetailContext {
  const c = byId.get(id)!;
  return { component: c, look: lookFor(c.appearance ?? null, c.shape.type), lookup, showcase: [0, 0, 1], segments: 24, materials: new DetailMaterials() };
}

function bounds(o: THREE.Object3D): THREE.Box3 {
  o.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(o);
}

/** Signed volume of an indexed, closed triangle mesh. */
function volume(g: THREE.BufferGeometry): number {
  const p = g.getAttribute("position");
  const idx = g.index!;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let v = 0;
  for (let i = 0; i < idx.count; i += 3) {
    a.fromBufferAttribute(p, idx.getX(i));
    b.fromBufferAttribute(p, idx.getX(i + 1));
    c.fromBufferAttribute(p, idx.getX(i + 2));
    v += a.dot(b.clone().cross(c)) / 6;
  }
  return v;
}

describe("rounded fin plates", () => {
  it("insets a convex polygon by a distance", () => {
    const sq: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const inner = insetConvex(sq, 0.1);
    expect(inner[0]![0]).toBeCloseTo(0.1, 9);
    expect(inner[0]![1]).toBeCloseTo(0.1, 9);
    expect(polygonArea(inner)).toBeCloseTo(0.64, 9);
  });

  it("is a closed plate of the given thickness with a rounded rim", () => {
    const poly: [number, number][] = [[0, 0], [0.14, 0], [0.1, 0.1], [0.04, 0.1]];
    const t = 0.003;
    const g = roundedPlate(poly, { thickness: t, radius: t / 2 });
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    expect(bb.max.z - bb.min.z).toBeCloseTo(t, 6);
    // Rounded corners pull the silhouette in by under a millimetre.
    expect(bb.max.x).toBeGreaterThan(0.139);
    expect(bb.max.x).toBeLessThanOrEqual(0.14);
    expect(bb.max.y).toBeCloseTo(0.1, 4);
    // Volume: the planform area times the thickness, less the rounded rim (a few percent).
    const area = polygonArea(poly);
    const v = volume(g);
    expect(v).toBeGreaterThan(0.9 * area * t);
    expect(v).toBeLessThan(area * t);
    // Smooth unit normals.
    const n = g.getAttribute("normal");
    for (let i = 0; i < n.count; i += 7) expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 5);
  });

  it("rounds edges per cross-section", () => {
    expect(edgeRadius("rounded", 0.003)).toBe(0.0015);
    expect(edgeRadius("square", 0.004)).toBeCloseTo(0.001, 12);
  });

  it("builds one plate per fin at the fin set's thickness, standing on the body", () => {
    const fins = byId.get("fins")!;
    const r = finSetDetail(ctx("fins"))!;
    expect(r).not.toBeNull();
    const plates = r.group.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
    expect(plates.length).toBe(fins.instances.length || 1);
    // The first fin stands on +Y (roll 0): its thickness runs along Z.
    const b = bounds(plates[0]!);
    const t = (fins.shape as unknown as { thickness: number }).thickness;
    expect(b.max.z - b.min.z).toBeCloseTo(t, 4);
    const span = (fins.shape as unknown as { span: number }).span;
    const root = (fins.anchors ?? []).find((a) => a.name === "root_le")!.r;
    expect(b.max.y).toBeCloseTo(root + span, 4);
    expect(b.min.x).toBeGreaterThanOrEqual(fins.x_fore - 1e-6);
    expect(b.max.x).toBeLessThanOrEqual(fins.x_aft + 1e-6);
  });
});

describe("airframe joints", () => {
  it("adds a machined shoulder lip behind the nose cone, keeping the cone", () => {
    const nose = byId.get("nose")!;
    const r = noseShoulderDetail(ctx("nose"))!;
    expect(r.replacesBase).toBe(false);
    const b = bounds(r.group);
    const sh = (nose.shape as unknown as { shoulder: { length: number; od: number } }).shoulder;
    expect(b.max.x).toBeCloseTo(nose.x_aft + sh.length, 4);
    expect(b.max.y).toBeGreaterThan(sh.od / 2);
    expect(b.max.y).toBeLessThan((nose.shape as unknown as { od: number }).od / 2);
  });

  it("adds a coupler lip where a tube slips onto the part ahead, and the motor retainer at the tail", () => {
    expect(foreHost(byId.get("airframe")!, lookup)?.id).toBe("recovery_bay");
    const fc = byId.get("fin_can")!;
    expect(motorMountOf(fc, lookup)?.id).toBe("motor_mount");
    const r = airframeTubeDetail(ctx("fin_can"))!;
    const names = r.group.children.map((o) => o.name);
    for (const n of ["tube-shell", "tube-coupler-lip", "tube-retainer-plate", "tube-motor-retainer"]) expect(names).toContain(n);
    const lip = bounds(r.group.children.find((o) => o.name === "tube-coupler-lip")!);
    expect(lip.min.x).toBeLessThan(fc.x_fore);
    const ret = bounds(r.group.children.find((o) => o.name === "tube-motor-retainer")!);
    expect(ret.max.x).toBeGreaterThan(fc.x_aft);
    // The nose (no fore host) and a tube without a motor mount get neither.
    expect(foreHost(byId.get("nose")!, lookup)).toBeNull();
    const air = airframeTubeDetail(ctx("airframe"))!;
    expect(air.group.children.map((o) => o.name)).not.toContain("tube-motor-retainer");
  });
});
