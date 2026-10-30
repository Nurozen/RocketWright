/**
 * M3.1 appearance presets (no GPU): the preset table, the look -> physical
 * material mapping (RL1 clear-layer rule, brushed anisotropy with tangents,
 * fabric sheen), mark restore, the detail toggles under x-ray and compare,
 * and the output-probe statistics the e2e gates on.
 */
import { readFileSync } from "node:fs";
import type { EvaluatedModel } from "@rw/contracts";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { applyDetail, defaultDetailRegistry } from "../detail/registry.ts";
import { DetailMaterials } from "../detail/looks.ts";
import { glbModelHash } from "./glb-source.ts";
import { outlineKernel } from "./lighting.ts";
import { analyzeOutput, distanceField, outputProbeFailures, type Frame } from "./outputProbe.ts";
import { lookFor, PRESET_LOOKS, SELECTION_TEAL } from "./materials.ts";
import { applyLook, ensureTangents, needsTangents, physicalMaterial, THIN_WALL_IOR } from "./presets.ts";
import { AssemblyModel } from "./scene.ts";

const repo = new URL("../../../../../", import.meta.url);
const glbBytes = readFileSync(new URL("app/apps/web/public/fixtures/contract-vehicle.glb", repo));
const evaluated = (JSON.parse(readFileSync(new URL("fixtures/contracts/evaluated-model.json", repo), "utf8")) as { payload: EvaluatedModel }).payload;

async function fixtureModel(): Promise<AssemblyModel> {
  const ab = glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength) as ArrayBuffer;
  const gltf = await new GLTFLoader().parseAsync(ab, "");
  const meta = Object.fromEntries(evaluated.components.map((c) => [c.id, { name: c.name, appearance: c.appearance ?? null }]));
  return new AssemblyModel(gltf.scene, meta, glbModelHash(glbBytes));
}

describe("appearance presets", () => {
  it("maps each preset to its physical parameters", () => {
    const white = physicalMaterial(PRESET_LOOKS.composite_white);
    expect(white.metalness).toBe(0);
    expect(white.clearcoat).toBeGreaterThan(0);
    expect(white.roughness).toBeGreaterThan(0.3); // satin, not gloss
    expect(white.transmission).toBe(0);
    const alu = physicalMaterial(PRESET_LOOKS.aluminium_brushed);
    expect(alu.metalness).toBe(1);
    expect(alu.anisotropy).toBeGreaterThan(0.3);
    expect(needsTangents(alu)).toBe(true);
    const nylon = physicalMaterial(PRESET_LOOKS.nylon_orange);
    expect(nylon.sheen).toBeGreaterThan(0);
    expect(nylon.specularIntensity).toBeLessThan(0.5); // stays saturated under tone mapping
    const pcb = physicalMaterial(PRESET_LOOKS.pcb_green);
    expect(`#${pcb.color.getHexString()}`).toBe(PRESET_LOOKS.pcb_green.color);
    const black = physicalMaterial(PRESET_LOOKS.black_gloss);
    expect(black.roughness).toBeLessThan(0.25);
    expect(black.clearcoat).toBeGreaterThan(0.5);
  });

  it("renders clear polycarbonate with transmission, never blending (RL1), outer layer without depth writes", () => {
    const look = PRESET_LOOKS.clear_polycarbonate;
    expect(look.clear).toBe(true);
    expect(look.opacity).toBe(1);
    const outer = physicalMaterial(look);
    expect(outer.transmission).toBe(1);
    expect(outer.transparent).toBe(false);
    expect(outer.opacity).toBe(1);
    expect(outer.depthWrite).toBe(false);
    expect(look.ior).toBeCloseTo(1.585);
    expect(outer.ior).toBe(THIN_WALL_IOR); // thin shell: no transmission blur or refraction offset
    const inner = physicalMaterial(look, { clearLayer: "inner" });
    expect(inner.transmission).toBe(1);
    expect(inner.depthWrite).toBe(true);
    // Detail glass follows the same rule: both walls transmit, the near wall skips depth.
    const dm = new DetailMaterials();
    const near = dm.glass(look);
    const far = dm.glass(look, true);
    expect(near.transmission).toBe(1);
    expect(far.transmission).toBe(1);
    expect(near.depthWrite).toBe(false);
    expect(near.transparent).toBe(false);
    expect(far.side).toBe(THREE.BackSide);
    dm.dispose();
  });

  it("keeps a component's transmission override as transmission", () => {
    const l = lookFor({ preset: "composite_white", transmission: 0.8 } as never, "body_tube");
    expect(l.transmission).toBeCloseTo(0.8);
    expect(l.clear).toBe(true);
    expect(l.opacity).toBe(1);
  });

  it("restores a look after a mark recolour", () => {
    const m = physicalMaterial(PRESET_LOOKS.aluminium_brushed);
    m.color.set("#ff0000");
    m.metalness = 0;
    m.anisotropy = 0;
    applyLook(m, PRESET_LOOKS.aluminium_brushed);
    expect(`#${m.color.getHexString()}`).toBe(PRESET_LOOKS.aluminium_brushed.color);
    expect(m.metalness).toBe(1);
    expect(m.anisotropy).toBe(PRESET_LOOKS.aluminium_brushed.anisotropy);
  });

  it("writes circumferential tangents about +X (brushed streaks run around revolved parts)", () => {
    const g = new THREE.CylinderGeometry(0.02, 0.02, 0.1, 16, 1, true).rotateZ(-Math.PI / 2);
    g.deleteAttribute("tangent");
    ensureTangents(g);
    const t = g.getAttribute("tangent");
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    for (let i = 0; i < p.count; i++) {
      const tv = new THREE.Vector3(t.getX(i), t.getY(i), t.getZ(i));
      expect(tv.length()).toBeCloseTo(1, 5);
      expect(Math.abs(tv.x)).toBeLessThan(1e-6); // around the axis, not along it
      const nv = new THREE.Vector3().fromBufferAttribute(n, i);
      expect(Math.abs(tv.dot(nv))).toBeLessThan(1e-5);
      const radial = new THREE.Vector3(0, p.getY(i), p.getZ(i)).normalize();
      expect(Math.abs(tv.dot(radial))).toBeLessThan(1e-5);
    }
  });
});

describe("detail in the assembly model", () => {
  it("shows detail in the normal look and the base under x-ray and compare marks", async () => {
    const model = await fixtureModel();
    const applied = applyDetail(model, evaluated.components, defaultDetailRegistry(), { segments: 24 });
    model.onDispose(applied.dispose);
    const withDetail = [...model.parts.values()].filter((p) => p.detail != null);
    expect(withDetail.length).toBeGreaterThan(3);
    const opaque = withDetail.find((p) => !p.look.clear && !p.internal && p.detailReplacesBase !== false)!;
    expect(opaque).toBeDefined();
    const base = { explode: 0, hidden: [] as string[], section: false };
    model.apply({ ...base, showInternals: false });
    expect(opaque.detail!.visible).toBe(true);
    expect(opaque.materials.every((m) => !m.visible)).toBe(true);
    // X-ray ghosts the base (one material per part), so the detail steps aside.
    model.apply({ ...base, showInternals: true });
    expect(opaque.detail!.visible).toBe(false);
    expect(opaque.materials.every((m) => m.visible && m.opacity < 1)).toBe(true);
    model.apply({ ...base, showInternals: false });
    expect(opaque.detail!.visible).toBe(true);
    // Compare marks recolour the base; the detail hides.
    model.setMarks({ [opaque.id]: "changed" });
    model.apply({ ...base, showInternals: false });
    expect(opaque.detail!.visible).toBe(false);
    model.setMarks(null);
    model.apply({ ...base, showInternals: false });
    expect(opaque.detail!.visible).toBe(true);
    expect(`#${opaque.materials[0]!.color.getHexString()}`).toBe(opaque.look.color);
    // Visual-only detail never picks (the base mesh is the proxy).
    expect(model.pickables().some((m) => m.userData["rwProvenance"] === "visual")).toBe(false);
    model.dispose();
    expect(opaque.detail).toBeNull();
  });
});

// ---- output probes ------------------------------------------------------------

function frame(w: number, h: number, paint: (x: number, y: number) => [number, number, number, number] | null): Frame {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = paint(x, y);
      if (c) data.set(c, (y * w + x) * 4);
    }
  return { data, width: w, height: h };
}

const W = 120;
const H = 80;
const inBody = (x: number, y: number) => x >= 30 && x < 90 && y >= 30 && y < 40;
const tealHex = Number.parseInt(SELECTION_TEAL.slice(1), 16);
const TEAL: [number, number, number, number] = [(tealHex >> 16) & 255, (tealHex >> 8) & 255, tealHex & 255, 255];
const WHITE: [number, number, number, number] = [230, 230, 228, 255];
const ring = (x: number, y: number, width: number) => !inBody(x, y) && x >= 30 - width && x < 90 + width && y >= 30 - width && y < 40 + width;

function scene(opts: { outline: number; halo?: boolean; shadowDy: number; hardShadow?: boolean }): [Frame, Frame, Frame] {
  const bare = frame(W, H, (x, y) => (inBody(x, y) ? WHITE : null));
  const noGround = frame(W, H, (x, y) => {
    if (inBody(x, y)) return WHITE;
    if (opts.outline > 0 && ring(x, y, opts.outline)) return TEAL;
    if (opts.halo && ring(x, y, opts.outline + 6)) return [TEAL[0], TEAL[1], TEAL[2], 50];
    return null;
  });
  const full = frame(W, H, (x, y) => {
    const c = noGround.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4);
    if (c[3]! > 0) return [c[0]!, c[1]!, c[2]!, c[3]!];
    // A soft shadow band under the body, `shadowDy` px down, tapering at its ends (or a hard-edged copy).
    const d = Math.abs(y - (35 + opts.shadowDy));
    if (opts.hardShadow) return x >= 26 && x < 94 && d < 8 ? [0, 0, 0, 90] : null;
    const ends = Math.min(1, (x - 18) / 10, (102 - x) / 10);
    if (ends > 0 && d < 8) return [0, 0, 0, Math.round(90 * (1 - d / 8) * ends)];
    return null;
  });
  return [full, noGround, bare];
}

describe("output probes", () => {
  it("measures distances with a chamfer field", () => {
    const m = new Uint8Array(25);
    m[12] = 1;
    const d = distanceField(m, 5, 5);
    expect(d[12]).toBe(0);
    expect(d[13]).toBe(1);
    expect(d[14]).toBe(2);
    expect(d[0]).toBeCloseTo(8 / 3, 5);
  });

  it("has a 2 px outline kernel", () => {
    const k = outlineKernel(2);
    expect(Math.max(...k.map((o) => Math.hypot(o.dx, o.dy)))).toBeLessThanOrEqual(2.25);
    expect(k.some((o) => o.dx === 2 && o.dy === 0)).toBe(true);
    expect(k.some((o) => o.dx === 0 && o.dy === 0)).toBe(false);
  });

  it("passes a crisp teal outline and a contact shadow under the model", () => {
    const p = analyzeOutput(...scene({ outline: 2, shadowDy: 6 }), SELECTION_TEAL);
    expect(p.outline.medianWidth).toBe(2);
    expect(p.outline.crisp).toBeGreaterThan(0.9);
    expect(p.outline.faint).toBe(0);
    expect(p.outline.tealDistance).toBeLessThan(3);
    expect(p.shadow.near).toBeGreaterThan(0.95);
    expect(p.shadow.lumaDrop).toBeGreaterThan(0);
    expect(outputProbeFailures(p)).toEqual([]);
  });

  it("fails a blurred halo and a detached shadow", () => {
    const p = analyzeOutput(...scene({ outline: 2, halo: true, shadowDy: 36 }), SELECTION_TEAL, [30, 35, 39], 20);
    expect(p.outline.faint).toBeGreaterThan(0.25);
    expect(p.shadow.near).toBeLessThan(0.6);
    const f = outputProbeFailures(p);
    expect(f.some((s) => s.startsWith("shadow:"))).toBe(true);
    expect(f.some((s) => s.includes("halo"))).toBe(true);
  });

  it("fails a hard-edged shadow (a per-part fringe) and reports its spread", () => {
    const soft = analyzeOutput(...scene({ outline: 2, shadowDy: 6 }), SELECTION_TEAL);
    expect(soft.shadow.maxStep).toBeLessThan(0.08);
    expect(soft.shadow.spread).toBeGreaterThan(4);
    expect(soft.pool.peak).toBe(0);
    const hard = analyzeOutput(...scene({ outline: 2, shadowDy: 6, hardShadow: true }), SELECTION_TEAL);
    expect(hard.shadow.maxStep).toBeGreaterThan(0.2);
    expect(outputProbeFailures(hard).some((s) => s.includes("hard fringe"))).toBe(true);
    // Page 01 gates: coverage and the broad spread are not met by this small synthetic frame.
    const f = outputProbeFailures(soft, true, { minSpreadPx: 30, minCoverage: 0.5 });
    expect(f.some((s) => s.startsWith("framing:"))).toBe(true);
    expect(f.some((s) => s.includes("spreads"))).toBe(true);
  });

  it("fails a thick outline", () => {
    const p = analyzeOutput(...scene({ outline: 7, shadowDy: 6 }), SELECTION_TEAL);
    expect(p.outline.medianWidth).toBeGreaterThan(3);
    expect(outputProbeFailures(p).some((s) => s.includes("median width"))).toBe(true);
  });
});
