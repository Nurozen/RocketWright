/**
 * Path-traced stills with `three-gpu-pathtracer/webgpu` 0.0.27 (RL1b,
 * M1.13b; productised by M3.4 "Render still"). A product feature only: never
 * bar evidence (D26), and visual tier (I13).
 *
 * The tracer captures the scene once (`setScene`), accumulates samples into
 * the renderer's canvas every frame, stops at `samples` per pixel, and then,
 * when a denoiser is attached, runs OIDN (`oidn-web`) over the result and
 * presents that instead. The tracer ignores clipping planes, so sections need
 * real cut geometry (`section.ts`).
 */
import * as THREE from "three/webgpu";
import type { Camera, Scene, WebGPURenderer } from "three/webgpu";
import { OIDNDenoiser, TRANSMISSIVE_BACKGROUND_ENVIRONMENT, WebGPUPathTracer } from "three-gpu-pathtracer/webgpu";

export interface StillOptions {
  /** Samples per pixel to reach (every pixel, `min`). */
  samples: number;
  /** OIDN weights for the guided (albedo + normal) model, e.g. `rt_hdr_alb_nrm_small.tza`. Null: no denoise. */
  oidnWeightsUrl?: string | null;
  timeoutMs?: number;
  maxBounces?: number;
  /** Path slots per frame (three-gpu-pathtracer default 250 000); higher converges faster at a lower frame rate. */
  frameBudget?: number | undefined;
  /** Called about every 8 frames with the current minimum sample count. */
  onProgress?: (minSamples: number) => void;
}

export interface StillResult {
  samples: { min: number; max: number; avg: number };
  samplesPerSecond: number;
  /** Wall time from `setScene` to the last sample (before denoising). */
  traceMs: number;
  /** Wall time of the OIDN pass; null without a denoiser. */
  denoiseMs: number | null;
  denoised: boolean;
  frames: number;
}

/** A still renderer bound to one renderer; `dispose` frees the tracer, its BVHs, and the denoiser. */
export class StillRenderer {
  readonly tracer: WebGPUPathTracer;
  private denoiser: OIDNDenoiser | null = null;
  private presenting = false;

  constructor(readonly renderer: WebGPURenderer) {
    this.tracer = new WebGPUPathTracer(renderer);
  }

  async render(scene: Scene, camera: Camera, opts: StillOptions): Promise<StillResult> {
    const pt = this.tracer;
    pt.renderDelay = 0;
    pt.fadeDuration = 0;
    pt.minSamples = 1;
    pt.dynamicLowRes = false;
    pt.maxBounces = opts.maxBounces ?? 8;
    if (opts.frameBudget !== undefined) pt.frameBudget = opts.frameBudget;
    pt.transmissiveBackground = TRANSMISSIVE_BACKGROUND_ENVIRONMENT;
    pt.maxSamples = opts.samples;
    if (opts.oidnWeightsUrl) {
      const { initUNetFromURL } = await import("oidn-web");
      this.denoiser = new OIDNDenoiser({ initUNetFromURL, auxWeightsUrl: opts.oidnWeightsUrl });
      pt.setDenoiser(this.denoiser);
    }
    const t0 = performance.now();
    pt.setScene(scene, camera);
    const deadline = t0 + (opts.timeoutMs ?? 120_000);
    let frames = 0;
    let counts = { min: 0, max: 0, avg: 0, samplesPerSecond: 0 };
    for (;;) {
      await nextFrame();
      pt.renderSample();
      frames++;
      if (frames % 8 === 0) {
        counts = await pt.getSampleCountsAsync();
        opts.onProgress?.(counts.min);
        if (counts.min >= opts.samples) break;
      }
      if (performance.now() > deadline) throw new Error(`pathtrace: ${counts.min}/${opts.samples} spp after ${opts.timeoutMs ?? 120_000} ms`);
    }
    const traceMs = performance.now() - t0;
    let denoiseMs: number | null = null;
    const d = this.denoiser;
    if (d) {
      const t1 = performance.now();
      // The tracer starts the pass once accumulation stops; keep presenting until it is done.
      while (!d.complete) {
        await nextFrame();
        pt.renderSample();
        frames++;
        if (performance.now() > deadline) throw new Error("pathtrace: OIDN did not finish before the timeout");
      }
      denoiseMs = performance.now() - t1;
    }
    // Keep presenting the converged (or denoised) image so a capture reads a full frame.
    this.startPresenting();
    return {
      samples: { min: counts.min, max: counts.max, avg: counts.avg },
      samplesPerSecond: counts.samplesPerSecond,
      traceMs,
      denoiseMs,
      denoised: d?.complete ?? false,
      frames,
    };
  }

  /**
   * The presented image as a PNG data URL: one more present and the read in
   * the same task (a WebGPU canvas reads back only while its frame is current).
   */
  capture(): string {
    this.tracer.renderSample();
    return (this.renderer.domElement as HTMLCanvasElement).toDataURL("image/png");
  }

  private startPresenting(): void {
    if (this.presenting) return;
    this.presenting = true;
    const loop = () => {
      if (!this.presenting) return;
      this.tracer.renderSample();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  dispose(): void {
    this.presenting = false;
    this.tracer.dispose();
  }
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

let envData: Promise<THREE.DataTexture> | null = null;

/**
 * The studio panorama as a linear float `DataTexture` (the tracer builds its
 * importance-sampling CDF from `image.data`; an image-backed texture throws
 * in `setScene`, RL1 pitfall). Loaded once per page.
 */
export function loadStudioEnvironmentData(url: string): Promise<THREE.DataTexture> {
  envData ??= (async () => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("render still: no 2d context");
    ctx.drawImage(bitmap, 0, 0);
    const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const f = new Float32Array(px.length);
    const lin = (v: number) => {
      const x = v / 255;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    for (let i = 0; i < px.length; i += 4) {
      f[i] = lin(px[i]!);
      f[i + 1] = lin(px[i + 1]!);
      f[i + 2] = lin(px[i + 2]!);
      f[i + 3] = 1;
    }
    const tex = new THREE.DataTexture(f, bitmap.width, bitmap.height, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.flipY = true;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  })();
  envData.catch(() => (envData = null));
  return envData;
}
