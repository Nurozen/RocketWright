/**
 * RL1c (M1.13c): `manifold-3d` section cut with caps, volume-checked.
 *
 * - Check tube: the F:82 native spike tube (300 mm, r 27/26, 64 segments);
 *   manifold volumes must read 49871.1 (whole) and 24935.6 (cut at x = 0).
 * - Rendered part: that tube plus a motor mount (inner tube and two centering
 *   rings), cut at x = 0, caps hatched. The converted triangle mesh's own
 *   volume must equal the manifold's (closed, consistently wound).
 * - `?pt=1` path traces the same cut (the tracer ignores clipping planes, so
 *   real cut geometry is the only way to get path-traced sections).
 */
import { float, fract, mix, positionLocal, step, vec3 } from "three/tsl";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import * as THREE from "three/webgpu";
import { StillRenderer } from "../src/render/pathtrace.ts";
import { loadManifold, meshVolume, polygonTubeVolume, sectionCut, tubeShell, type SectionMesh, type TubeSpec } from "../src/render/section.ts";
import { canvasFacts, frames, initRenderer, isoCamera, loadStudioEnvironment, makeCanvas, params, runSpike, screenRect, studioLights } from "./common.ts";

const F82: TubeSpec = { length: 300, outerRadius: 27, innerRadius: 26, segments: 64 };
const F82_EXPECTED = { whole: "49871.1", cut: "24935.6" };

function toGeometry(mesh: SectionMesh): THREE.BufferGeometry {
  // Split shared vertices per role so caps get flat normals and their own material.
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  // Smooth across the facets of a wall, sharp at the cut and at the tube ends (crease 30°).
  const flat = toCreasedNormals(g, Math.PI / 6);
  flat.clearGroups();
  for (const grp of mesh.groups) flat.addGroup(grp.start, grp.count, grp.role === "cap" ? 1 : 0);
  return flat;
}

runSpike(async () => {
  const pt = params.get("pt") === "1";
  const t0 = performance.now();
  const mf = await loadManifold();
  const tLoad = performance.now();

  // Volume check on the F:82 tube.
  const tube = tubeShell(mf, F82);
  const tubeCut = sectionCut(mf, tube, { axis: "x", offset: 0, keep: "below" });
  const tubeMeshVolume = meshVolume(tubeCut.mesh.positions, tubeCut.mesh.indices);

  // The rendered part: tube + motor mount, cut at x = 0.
  const inner = tubeShell(mf, { length: 300, outerRadius: 19.5, innerRadius: 18.5, segments: 64 });
  const ring = tubeShell(mf, { length: 6, outerRadius: 26, innerRadius: 19.5, segments: 64 });
  const ringA = ring.translate([0, 0, 30]);
  const ringB = ring.translate([0, 0, 250]);
  const part = mf.Manifold.union([tube, inner, ringA, ringB]);
  const tCut0 = performance.now();
  const partCut = sectionCut(mf, part, { axis: "x", offset: 0, keep: "below" });
  const cutMs = performance.now() - tCut0;
  const partMeshVolume = meshVolume(partCut.mesh.positions, partCut.mesh.indices);
  for (const m of [tube, inner, ring, ringA, ringB, part]) m.delete();

  const canvas = makeCanvas();
  const { renderer, gpu } = await initRenderer(canvas, { antialias: !pt });
  const scene = new THREE.Scene();
  scene.environment = await loadStudioEnvironment({ data: pt });
  scene.environmentIntensity = 0.9;

  const body = new THREE.MeshPhysicalNodeMaterial({ color: "#e8e8e4", roughness: 0.42, clearcoat: 0.35 });
  const cap = new THREE.MeshStandardNodeMaterial({ color: "#7f8a8e", roughness: 0.6 });
  if (!pt) {
    // 45° hatch in part millimetres on the cut face (x = 0 plane): 2.5 mm pitch.
    const stripe = step(float(0.62), fract(positionLocal.y.add(positionLocal.z).div(2.5)));
    cap.colorNode = mix(vec3(0.64, 0.68, 0.7), vec3(0.3, 0.33, 0.35), stripe);
  }
  const mesh = new THREE.Mesh(toGeometry(partCut.mesh), [body, cap]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.scale.setScalar(0.001);
  const holder = new THREE.Group();
  holder.add(mesh);
  // Part axes to world: tube axis (+Z) along a screen diagonal, cut-face normal (+X) towards the iso camera.
  const axis = new THREE.Vector3(1, -0.32, -0.55).normalize();
  const toCamera = new THREE.Vector3(0.42, 0.62, 1).normalize();
  const xAxis = toCamera.clone().sub(axis.clone().multiplyScalar(toCamera.dot(axis))).normalize();
  // Tilt the cut face 25° off the view direction so the bore and the ring sections read in depth.
  xAxis.applyAxisAngle(axis, 0.45);
  const yAxis = axis.clone().cross(xAxis);
  holder.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, axis));
  mesh.position.set(0, 0, -0.15); // centre the 300 mm tube on the holder origin
  scene.add(holder);
  holder.updateMatrixWorld(true);
  const { ground } = studioLights(scene, holder);
  // The tracer supports only Standard/Physical materials: a dark floor instead of the shadow catcher.
  if (pt) ground.material = new THREE.MeshStandardMaterial({ color: "#2a2f33", roughness: 0.85 });
  const camera = isoCamera(holder, window.innerWidth / window.innerHeight, 0.7);

  let stillInfo: Record<string, number> = {};
  if (pt) {
    const still = new StillRenderer(renderer);
    const r = await still.render(scene, camera, { samples: Number(params.get("spp") ?? 32), timeoutMs: 170_000 });
    stillInfo = { ptMinSamples: r.samples.min, ptTraceMs: Math.round(r.traceMs) };
  } else {
    renderer.setAnimationLoop(() => renderer.render(scene, camera));
    await frames(20);
  }

  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
  return {
    spike: "section",
    variant: pt ? "pathtraced" : "raster",
    gpu,
    canvas: canvasFacts(renderer),
    regions: { part: screenRect(holder, camera, window.innerWidth, window.innerHeight) },
    checks: {
      webgpu: { value: gpu.isWebGPUBackend, pass: gpu.isWebGPUBackend && gpu.adapter.isFallbackAdapter !== true },
      tubeVolume: { value: tubeCut.bodyVolume.toFixed(1), pass: tubeCut.bodyVolume.toFixed(1) === F82_EXPECTED.whole, note: `F:82 expects ${F82_EXPECTED.whole}; analytic ${polygonTubeVolume(F82).toFixed(1)}` },
      tubeCutVolume: { value: tubeCut.volume.toFixed(1), pass: tubeCut.volume.toFixed(1) === F82_EXPECTED.cut, note: `F:82 expects ${F82_EXPECTED.cut}` },
      tubeMeshVolume: { value: tubeMeshVolume.toFixed(1), pass: near(tubeMeshVolume, tubeCut.volume, 0.05), note: "triangle mesh volume of the cut tube = manifold volume (closed)" },
      tubeCapArea: { value: tubeCut.capArea.toFixed(1), pass: near(tubeCut.capArea, 600, 0.01), note: "two 1 x 300 mm cut walls" },
      partHalf: { value: (partCut.volume / partCut.bodyVolume).toFixed(4), pass: near(partCut.volume / partCut.bodyVolume, 0.5, 1e-6), note: "symmetric part cut on its axis keeps half" },
      partMeshVolume: { value: partMeshVolume.toFixed(1), pass: near(partMeshVolume, partCut.volume, 0.05), note: `manifold ${partCut.volume.toFixed(1)} mm^3` },
      capTriangles: { value: (partCut.mesh.groups.find((g) => g.role === "cap")?.count ?? 0) / 3, pass: partCut.mesh.groups.some((g) => g.role === "cap") },
    },
    timings: { manifoldLoadMs: Math.round(tLoad - t0), partCutMs: Math.round(cutMs * 10) / 10, triangles: partCut.mesh.indices.length / 3, ...stillInfo },
    notes: [],
  };
});
