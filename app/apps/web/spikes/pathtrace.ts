/**
 * RL1b (M1.13b): `three-gpu-pathtracer/webgpu` 0.0.27 still of the recovery
 * bay (true glass: the far wall and the chute refract correctly), 64 spp by
 * default (`?spp=`), studio environment, optional OIDN (`?oidn=<weights url>`,
 * relative to this page; `run.ts --oidn-weights <file>` stages one).
 *
 * The scene uses the same bay as RL1a with transmission glass, plus a floor
 * so shadows have somewhere to land (the tracer has no shadow-catcher material).
 */
import * as THREE from "three/webgpu";
import { StillRenderer } from "../src/render/pathtrace.ts";
import { buildRecoveryBay, canvasFacts, initRenderer, isoCamera, loadStudioEnvironment, makeCanvas, params, runSpike, screenRect } from "./common.ts";

runSpike(async () => {
  const spp = Number(params.get("spp") ?? 64);
  const oidn = params.get("oidn");
  const t0 = performance.now();
  const canvas = makeCanvas();
  const { renderer, gpu } = await initRenderer(canvas, { antialias: false });
  const scene = new THREE.Scene();
  const env = await loadStudioEnvironment({ data: true });
  scene.environment = env;
  scene.environmentIntensity = 0.9;

  const bay = buildRecoveryBay("transmission", env);
  bay.group.rotation.set(0.0, 0.35, -0.42);
  scene.add(bay.group);
  const box = new THREE.Box3().setFromObject(bay.group);
  const size = box.getSize(new THREE.Vector3()).length();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(size * 12, size * 12), new THREE.MeshStandardMaterial({ color: "#2a2f33", roughness: 0.85 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = box.min.y - size * 0.18;
  scene.add(floor);
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(size * 0.6, size * 1.4, size * 0.8);
  scene.add(key);
  const camera = isoCamera(bay.group, window.innerWidth / window.innerHeight);
  scene.updateMatrixWorld(true);

  const still = new StillRenderer(renderer);
  const tSetup = performance.now();
  const result = await still.render(scene, camera, { samples: spp, oidnWeightsUrl: oidn ? new URL(oidn, window.location.href).href : null, timeoutMs: 170_000, frameBudget: params.has("budget") ? Number(params.get("budget")) : undefined });
  return {
    spike: "pathtrace",
    variant: `spp=${spp}${params.has("budget") ? `,budget=${params.get("budget")}` : ""}${oidn ? ",oidn" : ""}`,
    gpu,
    canvas: canvasFacts(renderer),
    regions: { bay: screenRect(bay.group, camera, window.innerWidth, window.innerHeight), chute: screenRect(bay.chute, camera, window.innerWidth, window.innerHeight) },
    checks: {
      webgpu: { value: gpu.isWebGPUBackend, pass: gpu.isWebGPUBackend && gpu.adapter.isFallbackAdapter !== true },
      samples: { value: result.samples.min, pass: result.samples.min >= spp, note: `min spp over all pixels (avg ${result.samples.avg.toFixed(1)})` },
      denoised: { value: result.denoised, pass: oidn ? result.denoised : true, note: oidn ? "OIDN guided small weights" : "OIDN not requested" },
    },
    timings: {
      setupMs: Math.round(tSetup - t0),
      traceMs: Math.round(result.traceMs),
      denoiseMs: result.denoiseMs === null ? -1 : Math.round(result.denoiseMs),
      samplesPerSecond: Math.round(result.samplesPerSecond * 10) / 10,
      frames: result.frames,
    },
    notes: [],
  };
});
