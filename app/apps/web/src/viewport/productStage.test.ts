/**
 * FID-03-05 shared studio stage: the level camera helper, the triangles a
 * floor bake reads, and the floor placed under a subject (the GPU render
 * itself is covered by the page captures).
 */
import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { levelTilt, presetPose } from "../detail/framing.ts";
import { boxCorners, defaultShadowRadius, StudioFloor, visibleTriangles } from "./productStage.ts";

describe("level camera", () => {
  it("levelTilt makes presetPose apply no roll (the camera's right stays horizontal)", () => {
    for (const dir of [
      [0.12, 0.62, 1],
      [0.62, 0.32, 1],
      [-0.35, 0.5, 1],
      [1, 0.28, 0.08],
      [0, 1, 0.02],
    ] as const) {
      const pose = presetPose({ dir, axisTiltDeg: levelTilt(dir) });
      expect(Math.abs(pose.right[1]), `right.y for ${dir.join(",")}`).toBeLessThan(1e-9);
      expect(pose.up[1]).toBeGreaterThan(0);
    }
  });
});

describe("studio floor", () => {
  const subject = () => {
    const g = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 0.2, 0.2), new THREE.MeshBasicMaterial());
    box.position.set(0, 0.5, 0);
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    hidden.visible = false;
    g.add(box, hidden);
    return g;
  };

  it("reads world triangles of visible meshes only", () => {
    const tris = visibleTriangles(subject());
    expect(tris.length).toBe(12 * 9);
    let minY = Infinity;
    for (let i = 1; i < tris.length; i += 3) minY = Math.min(minY, tris[i]!);
    expect(minY).toBeCloseTo(0.4, 6);
  });

  it("bakes a soft shadow under the subject and fits the quad to the bake", () => {
    const floor = new StudioFloor();
    const g = subject();
    const bake = floor.place(g, 0.38, 0.1);
    expect(bake).not.toBeNull();
    expect(floor.mesh.visible).toBe(true);
    expect(floor.mesh.position.y).toBeCloseTo(0.38, 9);
    // Darkest under the body, fading out toward the rim.
    const s = bake!.shadow;
    const n = bake!.grid.nx;
    const centre = s[Math.floor(n / 2) * n + Math.floor(n / 2)]!;
    expect(centre).toBeGreaterThan(0.3);
    expect(s[0]).toBeLessThan(0.01);
    // Nothing visible casts: the floor hides.
    const empty = new THREE.Group();
    expect(floor.place(empty, 0, 0.1)).toBeNull();
    expect(floor.mesh.visible).toBe(false);
    floor.dispose();
  });

  it("frames by box corners and scales the default shadow to the subject's thin side", () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, 0, -0.1), new THREE.Vector3(1, 0.2, 0.1));
    expect(boxCorners(box)).toHaveLength(8);
    expect(defaultShadowRadius(box)).toBeCloseTo(0.05, 9);
  });
});
