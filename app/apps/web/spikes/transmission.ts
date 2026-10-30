/**
 * RL1a (M1.13a): the clear recovery bay with the orange chute inside, under
 * the studio environment, with GTAO, a 2 px teal Outline on the selection, and
 * a shadow catcher. `?glass=` picks the see-through strategy:
 *
 * - `transmission` (default): `MeshPhysicalNodeMaterial.transmission` (screen
 *   space refraction of the opaque pass). The glass's own far wall is not in
 *   that pass (transmissive objects do not see each other, RF:53).
 * - `blend`: plain alpha blending, sorted, no depth write.
 * - `oit`: the same blended glass through `OITPassNode` (weighted blended OIT).
 *
 * `?inner=transmission|blend` adds a clear inner liner around the chute (a
 * second see-through layer inside the first: the glass-in-glass case of
 * RF:53, as a tank inside a clear shell on page 06).
 *
 * `run.ts` checks the capture: orange (chute) pixels inside the bay, teal
 * outline pixels and their stroke width.
 */
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { oitPass } from "three/addons/tsl/display/OITPassNode.js";
import { outline } from "three/addons/tsl/display/OutlineNode.js";
import { builtinAOContext, mrt, normalView, packNormalToRGB, sample, unpackRGBToNormal, pass, screenUV, uniform, vec3, vec4 } from "three/tsl";
import * as THREE from "three/webgpu";
import {
  BAY,
  buildRecoveryBay,
  canvasFacts,
  frames,
  GLASS_LAYER,
  glassMaterial,
  type GlassMode,
  initRenderer,
  isoCamera,
  loadStudioEnvironment,
  makeCanvas,
  params,
  tubeGeometry,
  runSpike,
  screenRect,
  studioLights,
} from "./common.ts";

/** `SELECTION_TEAL` (src/viewport/materials.ts). */
const TEAL = "#61b5ad";

runSpike(async () => {
  const mode = (params.get("glass") ?? "transmission") as GlassMode;
  if (!["transmission", "blend", "oit"].includes(mode)) throw new Error(`unknown glass mode ${mode}`);
  const ao_on = params.get("ao") !== "0";
  const thickness = Number(params.get("edge") ?? 1);
  const t0 = performance.now();
  const canvas = makeCanvas();
  const { renderer, gpu } = await initRenderer(canvas);
  const scene = new THREE.Scene();
  const env = await loadStudioEnvironment();
  scene.environment = env;
  scene.environmentIntensity = 0.9;

  const bay = buildRecoveryBay(mode, env);
  const inner = params.get("inner") as GlassMode | null;
  if (inner !== null) {
    if (!["transmission", "blend", "oit"].includes(inner)) throw new Error(`unknown inner mode ${inner}`);
    const m = glassMaterial(inner, env);
    m.color = new THREE.Color("#9fd3d8");
    const half = BAY.chuteLength / 2 + 0.006;
    const liner = new THREE.Mesh(tubeGeometry(0.0249, 0.0244, -half, half), m);
    liner.name = "bay_liner";
    liner.layers.set(GLASS_LAYER);
    bay.group.add(liner);
  }
  // `?dw=0`: the outer glass writes no depth, so blended parts behind it still draw (drawn over it, unrefracted).
  if (params.get("dw") === "0") (bay.glass.material as THREE.Material).depthWrite = false;
  bay.group.rotation.set(0.0, 0.35, -0.42);
  scene.add(bay.group);
  studioLights(scene, bay.group);
  const w = window.innerWidth;
  const h = window.innerHeight;
  const camera = isoCamera(bay.group, w / h);

  // GTAO from a normal/depth prepass without the glass (camera on layer 0 only),
  // applied to indirect light through the AO context (three r186 pattern).
  const aoCamera = camera.clone();
  aoCamera.layers.set(0);
  // The prepass must be single-sampled: with an MSAA renderer its depth is
  // texture_depth_multisampled_2d and GTAO's textureGather fails to compile (three r186).
  const prePass = pass(scene, aoCamera, { samples: 0 });
  prePass.transparent = false;
  prePass.setMRT(mrt({ output: packNormalToRGB(normalView) }));
  prePass.getTexture("output").type = THREE.UnsignedByteType;
  const prePassNormal = sample((uv) => unpackRGBToNormal(prePass.getTextureNode().sample(uv)));
  const aoPass = ao(prePass.getTextureNode("depth"), prePassNormal, aoCamera);
  aoPass.resolutionScale = Number(params.get("aos") ?? 0.5);
  // three's default radius (0.25 world units) suits metre-scale rooms; the bay is 54 mm across.
  aoPass.radius.value = Number(params.get("aor") ?? 0.02);

  const scenePass = mode === "oit" ? oitPass(scene, camera) : pass(scene, camera);
  if (ao_on) scenePass.contextNode = builtinAOContext(aoPass.getTextureNode().sample(screenUV).r);

  const o = outline(scene, camera, { selectedObjects: [bay.group], edgeThickness: uniform(thickness), edgeGlow: uniform(0), downSampleRatio: Number(params.get("ds") ?? 2) });
  const teal = uniform(new THREE.Color(TEAL));
  const edge = o.visibleEdge.mul(teal).mul(uniform(2.4)).add(o.hiddenEdge.mul(teal).mul(uniform(0.6)));
  const pipeline = new THREE.RenderPipeline(renderer);
  // Keep the pass alpha so the transparent canvas shows the CSS vignette.
  pipeline.outputNode = vec4(scenePass.rgb.add(edge), scenePass.a.max(o.visibleEdge.add(o.hiddenEdge).mul(2).min(1)));

  // `?debug=ao`: show the GTAO term itself (white = unoccluded).
  if (params.get("debug") === "ao") pipeline.outputNode = vec4(vec3(aoPass.getTextureNode().r), 1);
  if (params.get("debug") === "depth") pipeline.outputNode = vec4(vec3(prePass.getTextureNode("depth").r.pow(64)), 1);
  if (params.get("debug") === "normal") pipeline.outputNode = vec4(prePass.getTextureNode().rgb, 1);
  const tReady = performance.now();
  let frameCount = 0;
  let frameMs = 0;
  renderer.setAnimationLoop(() => {
    const s = performance.now();
    pipeline.render();
    frameMs = performance.now() - s;
    frameCount++;
  });
  await frames(30);
  // Average CPU-side frame time over 30 frames (GPU work is asynchronous; a lower bound on cost).
  const f0 = performance.now();
  const c0 = frameCount;
  await frames(30);
  const fps = ((frameCount - c0) * 1000) / (performance.now() - f0);

  const notes = [
    "Raster transmission samples a screen-space mip of the opaque pass: the glass's far wall and any second transmissive object are invisible through the near wall (RF:53).",
  ];
  return {
    spike: "transmission",
    variant: `glass=${mode}${inner ? `,inner=${inner}` : ""}${params.get("dw") === "0" ? ",dw=0" : ""}${ao_on ? "" : ",ao=0"},edge=${thickness}`,
    gpu,
    canvas: canvasFacts(renderer),
    regions: {
      bay: screenRect(bay.group, camera, w, h),
      chute: screenRect(bay.chute, camera, w, h),
    },
    checks: {
      webgpu: { value: gpu.isWebGPUBackend, pass: gpu.isWebGPUBackend && gpu.adapter.isFallbackAdapter !== true },
      fps: { value: Math.round(fps), pass: fps >= 30, note: "rAF rate with GTAO + outline + transmission at 1536x1024 (hidden window)" },
    },
    timings: { setupMs: Math.round(tReady - t0), lastFrameCpuMs: Math.round(frameMs * 10) / 10 },
    notes,
  };
});
