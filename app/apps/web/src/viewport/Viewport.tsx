/**
 * Three.js r186 WebGPU viewport over a GLB from rw-wasm (M1.9 spike, grows
 * into the page 01 viewport at M1.50). Renderer and nodes come only from
 * `three/webgpu`; the GLTF loader is an addon sharing three's core.
 */
import { useEffect, useRef } from "react";
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { BODY_TO_YUP_RX, countNonZero, countObjectPixels } from "./probe.ts";
import type { ViewportProbe } from "./probe.ts";

export interface ViewportProps {
  /** Binary glTF in the body frame (`extras.rw_frame = "body"`). */
  glb: Uint8Array;
  coreVersion?: string;
  /** Called once after the first frame and the render-target probe. */
  onReady?: (probe: ViewportProbe) => void;
  onError?: (error: unknown) => void;
}

const BACKGROUND = 0x0d1014;
const PROBE_SIZE = 256;

export function Viewport({ glb, coreVersion = "", onReady, onError }: ViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Callbacks live in refs so a new closure per render does not rebuild the renderer.
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.001, 100);

    const resize = () => {
      const w = Math.max(1, canvas.clientWidth);
      const h = Math.max(1, canvas.clientHeight);
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };

    (async () => {
      await renderer.init();
      if (disposed) return;
      scene.background = new THREE.Color(BACKGROUND);
      scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x20242b, 1.4));
      const key = new THREE.DirectionalLight(0xffffff, 2.6);
      key.position.set(2, 3, 4);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x9fc4ff, 1.0);
      rim.position.set(-3, 1, -2);
      scene.add(rim);

      const bytes = glb.slice().buffer;
      const gltf = await new GLTFLoader().parseAsync(bytes, "");
      if (disposed) return;
      // Body frame -> three.js Y-up, applied exactly once (plan, Conventions).
      gltf.scene.rotation.x = BODY_TO_YUP_RX;
      scene.add(gltf.scene);
      frame(camera, gltf.scene);
      resize();

      const probe = await probeRenderer(renderer, scene, camera, coreVersion);
      if (disposed) return;
      renderer.setAnimationLoop(() => renderer.render(scene, camera));
      // Let two frames reach the canvas before reporting ready.
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      if (!disposed) callbacks.current.onReady?.(probe);
    })().catch((e: unknown) => {
      if (!disposed) callbacks.current.onError?.(e);
    });

    window.addEventListener("resize", resize);
    return () => {
      disposed = true;
      window.removeEventListener("resize", resize);
      renderer.setAnimationLoop(null);
      renderer.dispose();
    };
  }, [glb, coreVersion]);

  return <canvas ref={canvasRef} data-testid="viewport-canvas" style={{ width: "100%", height: "100%", display: "block" }} />;
}

/** Places the camera on an iso-like diagonal that fits the object's bounds. */
function frame(camera: THREE.PerspectiveCamera, object: THREE.Object3D): void {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius || 1;
  const dist = (radius * 1.15) / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
  const dir = new THREE.Vector3(0.55, 0.45, 1).normalize();
  camera.position.copy(centre).addScaledVector(dir, dist);
  camera.near = dist / 100;
  camera.far = dist * 10;
  camera.lookAt(centre);
  camera.updateProjectionMatrix();
}

/** Backend and adapter facts plus a linear render-target readback (I11). */
async function probeRenderer(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  coreVersion: string,
): Promise<ViewportProbe> {
  const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean; device?: GPUDevice };
  let info: GPUAdapterInfo | undefined = backend.device?.adapterInfo;
  if (!info && typeof navigator !== "undefined" && navigator.gpu) {
    info = (await navigator.gpu.requestAdapter())?.info;
  }

  const rt = new THREE.RenderTarget(PROBE_SIZE, PROBE_SIZE);
  const aspect = camera.aspect;
  camera.aspect = 1;
  camera.updateProjectionMatrix();
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  const pixels = (await renderer.readRenderTargetPixelsAsync(rt, 0, 0, PROBE_SIZE, PROBE_SIZE)) as ArrayLike<number>;
  rt.dispose();

  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  return {
    isWebGPUBackend: backend.isWebGPUBackend === true,
    adapter: {
      vendor: info?.vendor ?? "",
      architecture: info?.architecture ?? "",
      description: info?.description ?? "",
      isFallbackAdapter: info && "isFallbackAdapter" in info ? Boolean(info.isFallbackAdapter) : null,
    },
    rt: { width: PROBE_SIZE, height: PROBE_SIZE, nonZero: countNonZero(pixels), objectPixels: countObjectPixels(pixels) },
    canvas: { width: size.x, height: size.y, devicePixelRatio: window.devicePixelRatio },
    coreVersion,
  };
}
