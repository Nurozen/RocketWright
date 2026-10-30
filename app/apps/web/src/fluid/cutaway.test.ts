/**
 * FID-06 page 06 cutaway hardware: the layout puts the engine on the aft
 * bulkhead and the tank inside the shell; the wedge section's cut faces sit
 * on the two wedge planes and close the wall's cross-section; the opaque
 * parts use the page 01 metal presets; and the studio floor's contact
 * shadow is darker under parts near the floor than under parts high above.
 */
import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import study from "../../spikes/propsim/study-01.visual.json";
import { engineNodeThumbKey, engineNodeThumbOf, withThumb, type EntityView } from "../state/entities.ts";
import { atPhi, buildCutaway, capGeometry, cutawayMaterials, KEEP, profilePolygon, revolve, WEDGE, type ProfileChain } from "./cutaway.ts";
import { bakeContactFloor } from "./floor.ts";
import { partVisibility } from "./stage.ts";
import { cutawayLayout, distanceToPolyline } from "./layout.ts";
import type { Vec3 } from "./tankSdf.ts";
import type { VisualRun } from "./timeline.ts";

const RUN = study as unknown as VisualRun;
const l = cutawayLayout(RUN);

describe("cutaway layout", () => {
  it("bolts the engine to the shell's aft bulkhead and keeps the tank and frames inside the shell", () => {
    expect(l.shell.aftX).toBe(l.injector.x);
    expect(l.bulkhead.thickness).toBeGreaterThan(0);
    expect(l.bulkhead.hole).toBeGreaterThan(l.feedRadius);
    const ri = l.shell.od / 2 - l.shell.wall;
    expect(l.tankOd / 2).toBeLessThan(ri);
    expect(l.frames.length).toBeGreaterThan(2);
    for (const f of l.frames) {
      expect(f.x).toBeLessThan(l.shell.aftX - l.bulkhead.thickness);
      expect(f.x).toBeGreaterThan(l.shell.foreX);
      expect(ri - f.depth).toBeGreaterThan(l.tankOd / 2);
    }
    // The feed line runs inside the shell from the tank outlet to the bulkhead.
    for (const p of l.feed) expect(Math.hypot(p[1], p[2])).toBeLessThan(ri);
    expect(l.tankSeams).toHaveLength(2);
  });

  it("seats the engine inlet on the aft bulkhead inside the shell, connected to the feed line through the valve cluster", () => {
    const ri = l.shell.od / 2 - l.shell.wall;
    const inl = l.inlet;
    // On the shell: the flange's aft face on the bulkhead's fore face, the whole flange inside the shell's bore.
    expect(inl.at[0] + inl.thickness / 2).toBeCloseTo(l.shell.aftX - l.bulkhead.thickness, 9);
    expect(Math.hypot(inl.at[1], inl.at[2]) + inl.radius).toBeLessThan(ri);
    expect(inl.at[0]).toBeGreaterThan(l.outletX);
    expect(inl.radius).toBeGreaterThan(l.bulkhead.hole);
    // Connected: the feed line (and the drawn curve through its points) passes through the inlet's centre,
    // starts in the tank at the outlet, and runs on through the bulkhead into the injector.
    expect(distanceToPolyline(inl.at, l.feed)).toBeLessThan(1e-9);
    const curve = new THREE.CatmullRomCurve3(l.feed.map((p) => new THREE.Vector3(...p)));
    const drawn = curve.getSpacedPoints(600).map((v) => v.toArray() as Vec3);
    expect(distanceToPolyline(inl.at, drawn)).toBeLessThan(0.05 * l.feedRadius);
    expect(l.feed[0]![0]).toBeLessThan(l.outletX);
    expect(l.feed.at(-1)![0]).toBe(l.injector.x);
    // The valve cluster sits on the line, between the outlet and the inlet, and is much wider than the line.
    expect(distanceToPolyline(l.valve.at, drawn)).toBeLessThan(0.05 * l.feedRadius);
    expect(l.valve.at[0]).toBeGreaterThan(l.outletX);
    expect(l.valve.at[0]).toBeLessThan(inl.at[0]);
    expect(l.valve.radius).toBeGreaterThan(2 * l.feedRadius);
    expect(Math.hypot(...l.valve.dir)).toBeCloseTo(1, 9);
    // The "Engine inlet" label points at the inlet flange.
    expect(Math.hypot(l.anchors.inlet[0] - inl.at[0], l.anchors.inlet[1] - inl.at[1], l.anchors.inlet[2] - inl.at[2])).toBeLessThanOrEqual(inl.radius);
  });

  it("keeps every feed fitting (outlet boss, valve cluster, inlet flange) inside the shell and engine bay", () => {
    const parts = buildCutaway(l, cutawayMaterials());
    const ri = l.shell.od / 2 - l.shell.wall;
    parts.fittings.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    let n = 0;
    parts.fittings.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const pos = mesh.geometry.getAttribute("position");
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        expect(Math.hypot(v.y, v.z)).toBeLessThan(ri);
        // Forward of the bulkhead's aft face (the inlet's bolts run into the bulkhead).
        expect(v.x).toBeLessThanOrEqual(l.shell.aftX + 1e-9);
        expect(v.x).toBeGreaterThan(l.outletX - 0.25 * l.tankOd);
        n++;
      }
    });
    expect(n).toBeGreaterThan(0);
  });
});

describe("wedge section", () => {
  it("removes a wedge centred on the camera side (body -Y)", () => {
    const [y] = atPhi(1, WEDGE.centre);
    expect(y).toBeLessThan(-0.95);
    expect(KEEP.phi).toBeCloseTo(2 * Math.PI - 2 * WEDGE.half, 12);
  });

  it("closes the chained profile into one polygon", () => {
    const m = new THREE.MeshBasicNodeMaterial();
    const chains: ProfileChain[] = [
      { pts: [[0, 1], [2, 1]], mat: m },
      { pts: [[2, 1], [2, 0.9]], mat: m },
      { pts: [[2, 0.9], [0, 0.9]], mat: m },
      { pts: [[0, 0.9], [0, 1]], mat: m },
    ];
    expect(profilePolygon(chains)).toEqual([
      [0, 1],
      [2, 1],
      [2, 0.9],
      [0, 0.9],
    ]);
  });

  it("caps the wall on both wedge planes with the full cross-section", () => {
    const poly = [
      [0, 1],
      [2, 1],
      [2, 0.9],
      [0, 0.9],
    ] as const;
    const g = capGeometry(poly);
    const pos = g.getAttribute("position");
    expect(pos.count).toBe(12);
    const planes = [KEEP.phi0, KEEP.phi0 + KEEP.phi];
    let area = 0;
    for (let t = 0; t < pos.count; t += 3) {
      const tri = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(pos, t + k));
      // Every vertex lies on one of the wedge planes: (y, z) along that plane's direction.
      const r = Math.hypot(tri[0]!.y, tri[0]!.z);
      const phi = planes.find((p) => {
        const [y, z] = atPhi(r, p);
        return Math.abs(y - tri[0]!.y) < 1e-6 && Math.abs(z - tri[0]!.z) < 1e-6;
      });
      expect(phi).toBeDefined();
      area += new THREE.Triangle(tri[0], tri[1], tri[2]).getArea();
    }
    // Two caps of the 2 x 0.1 wall section.
    expect(area).toBeCloseTo(0.4, 5);
  });

  it("revolves the kept part with its cut faces only when sectioned", () => {
    const m = new THREE.MeshBasicNodeMaterial();
    const chains: ProfileChain[] = [
      { pts: [[0, 1], [2, 1], [2, 0.9], [0, 0.9], [0, 1]], mat: m },
    ];
    expect(revolve(chains, { cut: false, capMat: m }).children).toHaveLength(1);
    expect(revolve(chains, { cut: true, capMat: m }).children).toHaveLength(2);
  });
});

describe("cutaway parts", () => {
  const mats = cutawayMaterials();
  const parts = buildCutaway(l, mats);
  it("builds whole and sectioned variants of the shell, feed line, and engine", () => {
    for (const g of [parts.shellFull, parts.shellCut, parts.feedFull, parts.feedCut, parts.engineFull, parts.engineCut]) expect(g.children.length).toBeGreaterThan(0);
    expect(parts.shadowProxy).toHaveLength(2);
  });
  it("draws the shell and bell as opaque brushed metal and the tank as clear glass", () => {
    const shell = mats.shell as THREE.MeshPhysicalNodeMaterial;
    const bell = mats.engine as THREE.MeshPhysicalNodeMaterial;
    for (const m of [shell, bell]) {
      expect(m.metalness).toBe(1);
      expect(m.transparent).toBe(false);
      expect(m.opacity).toBe(1);
      expect(m.anisotropy).toBeGreaterThan(0);
    }
    expect(mats.glass.transparent).toBe(true);
    expect(mats.glass.depthWrite).toBe(false);
  });
});

describe("engine section (R20-06)", () => {
  const mats = cutawayMaterials();
  const parts = buildCutaway(l, mats);
  it("cuts the engine with the shell's wedge in the section view, whole otherwise", () => {
    const on = partVisibility({ shell: true, section: true, flow: true, labels: true });
    expect(on.engineCut).toBe(true);
    expect(on.engineFull).toBe(false);
    expect(on.shellCut).toBe(true);
    expect(on.feedCut).toBe(true);
    const off = partVisibility({ shell: true, section: false, flow: true, labels: true });
    expect(off.engineFull).toBe(true);
    expect(off.engineCut).toBe(false);
    expect(off.flow).toBe(false);
    expect(partVisibility({ shell: false, section: false, flow: true, labels: true }).engineFull).toBe(true);
  });
  it("opens the chamber, throat, and bell: no engine surface in the removed wedge, cut faces on its planes", () => {
    parts.engineCut.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    let caps = 0;
    parts.engineCut.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.material === mats.engineCut) caps++;
      const pos = mesh.geometry.getAttribute("position");
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        const r = Math.hypot(v.y, v.z);
        if (r < 1e-6) continue;
        // Lathe angle of the point (body y = -r sin phi, z = r cos phi), relative to the wedge centre.
        const phi = Math.atan2(-v.y, v.z);
        const d = Math.abs(((phi - WEDGE.centre + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
        expect(d).toBeGreaterThanOrEqual(WEDGE.half - 0.02);
      }
    });
    expect(caps).toBeGreaterThan(0);
    // The bell's exit lip and the chamber are still there on the kept side.
    const box = new THREE.Box3().setFromObject(parts.engineCut);
    expect(box.max.x).toBeCloseTo(l.exit.x, 3);
    expect(box.min.x).toBeLessThanOrEqual(l.injector.x + 1e-9);
  });
});

describe("studio floor", () => {
  /** A horizontal strip of two triangles at height y over x in [x0, x1], z in [-0.05, 0.05]. */
  const strip = (x0: number, x1: number, y: number) =>
    [x0, y, -0.05, x1, y, -0.05, x1, y, 0.05, x0, y, -0.05, x1, y, 0.05, x0, y, 0.05];
  it("darkens the floor more under a part near it than under one high above", () => {
    const tris = new Float32Array([...strip(-1, -0.6, 0.05), ...strip(0.6, 1, 2.5)]);
    const bake = bakeContactFloor(tris, 0, 0.1, [0, 0])!;
    expect(bake).not.toBeNull();
    const at = (x: number) => {
      // The shadow is thrown back along the light; take the darkest cell in the column under x.
      const g = bake.grid;
      const i = Math.floor((x - g.x0) / g.cell);
      let best = 0;
      for (let j = 0; j < g.nz; j++) best = Math.max(best, bake.shadow[j * g.nx + i]!);
      return best;
    };
    expect(at(-0.8)).toBeGreaterThan(0.3);
    expect(at(-0.8)).toBeGreaterThan(3 * at(0.8 + 2.5 * 0.12));
    expect(bake.pool.rx).toBeGreaterThan(0);
  });
});

describe("tank chip thumbnail", () => {
  it("resolves an engine feed node ref to the tank picture the visual tier caches", () => {
    const key = engineNodeThumbKey("demo", "tank_a");
    expect(key).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    const urls = { [key]: "data:image/png;base64,AAAA" };
    expect(engineNodeThumbOf("rw:eng/demo/feed/node/tank_a", urls)).toBe(urls[key]);
    expect(engineNodeThumbOf("rw:eng/demo/feed/node/valve_1", urls)).toBeUndefined();
    const e: EntityView = { ref: "rw:eng/demo/feed/node/tank_a", kind: "engine", label: "Tank section", icon: "tank" };
    expect(withThumb(e, urls).thumb).toBe(urls[key]);
    expect(withThumb({ ...e, ref: "rw:eng/demo" }, urls).thumb).toBeUndefined();
  });
});
