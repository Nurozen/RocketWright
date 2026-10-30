/**
 * M3.1 studio look for the live viewport (`engine.ts`): the studio
 * environment (`public/env/studio-environment.png`, baked with HDR softboxes
 * into the BC5 studio rig, `STUDIO_RIG`), the crisp 2 px teal selection
 * outline, and the output probes the e2e and the bar capture read (luminance
 * and alpha on the final canvas output, never the linear RT: environment
 * pitfalls).
 *
 * - Shadow (BC5): baked on the floor under the model (`stage.ts`): one broad,
 *   soft shade with no per-part fringe, plus a light pool on the backdrop.
 *   No shadow maps; `STUDIO.shadow.opacity` is the reference strength for
 *   `setShadowOpacity`.
 * - Outline: three's `OutlineNode` blurs its edge at half resolution (a soft
 *   halo). We keep its selection mask pass (full resolution, `r` = 0 inside
 *   the selection, `g` = 1 where the selected surface is hidden) and draw the
 *   edge ourselves: pixels outside the mask with a selected pixel within 2 px.
 * - No bloom anywhere in the pipeline.
 */
import type { outline } from "three/addons/tsl/display/OutlineNode.js";
import { float, max, mix, screenUV, texture, textureSize, uniform, vec2, vec4 } from "three/tsl";
import * as THREE from "three/webgpu";
import type { Frame } from "./outputProbe.ts";

type OutlinePass = ReturnType<typeof outline>;
type FloatNode = ReturnType<typeof float>;
type Vec4Node = ReturnType<typeof vec4>;
/** `max` over float nodes (the TSL overloads do not unify across node kinds). */
const fmax = (a: unknown, b: unknown): FloatNode => max(a as FloatNode, b as FloatNode) as unknown as FloatNode;

/** Tuned against image 01 (live captures, apple metal-3). */
export const STUDIO = {
  /** Relative to the page (`base: "./"`; the desktop serves the bundle over http or app://). */
  envUrl: "env/studio-environment.png",
  envIntensity: 1.0,
  hemisphere: 1.1,
  key: 2.4,
  rim: 0.8,
  shadow: {
    /** Reference strength of the floor shadow (`ViewportEngine.setShadowOpacity` scales against it). */
    opacity: 0.55,
  },
  outline: {
    /** Line width outside the silhouette (px). */
    widthPx: 2,
    /** Edge where the selected surface is hidden behind another part. */
    hiddenGain: 0.35,
  },
} as const;

/**
 * A softbox in the studio rig: a rounded rectangle of light on the sphere
 * (world directions, Y up), `along` the long axis, `across` the short one.
 */
export interface Softbox {
  /** World direction of the box centre (need not be unit). */
  dir: readonly [number, number, number];
  /** World direction of the box's long axis (projected perpendicular to `dir`). */
  long: readonly [number, number, number];
  /** Angular half sizes (deg) along the long and short axes. */
  halfLong: number;
  halfShort: number;
  /** Linear radiance (the panorama's walls are about 0.1-0.3 after `wallGain`). */
  intensity: number;
}

/**
 * The page 01 studio rig (BC5 fidelity): the panorama, darkened, is the room;
 * HDR softboxes on top give machined aluminium bright rims and streaks, the
 * satin composite a soft sheen falloff, and gloss black a crisp reflection.
 * Placed for the Iso camera (from fore-above-side, `views.ts`): a long key
 * strip overhead along the body axis, two rim strips behind the model, a
 * broad dim fill near the camera, and a dark floor.
 */
export const STUDIO_RIG = {
  /** Equirect size of the baked environment. */
  width: 512,
  height: 256,
  /** Panorama radiance scale (linear) and the floor's (below the horizon). */
  wallGain: 0.27,
  floorGain: 0.06,
  softboxes: [
    { dir: [0.1, 1, 0.25], long: [1, 0, 0], halfLong: 48, halfShort: 11, intensity: 3.2 },
    { dir: [0.55, 0.32, -1], long: [0, 1, 0], halfLong: 30, halfShort: 7, intensity: 5 },
    { dir: [-0.9, 0.38, -0.55], long: [0, 1, 0], halfLong: 30, halfShort: 7, intensity: 3.5 },
    { dir: [-0.5, 0.75, 1], long: [1, 0, 0], halfLong: 40, halfShort: 22, intensity: 0.8 },
    { dir: [1, 0.22, 0.5], long: [0, 1, 0], halfLong: 22, halfShort: 9, intensity: 2 },
    // Floor bounce: a broad dim card below, so undersides keep a soft rim instead of going black.
    { dir: [0.2, -1, 0.5], long: [1, 0, 0], halfLong: 45, halfShort: 25, intensity: 0.2 },
  ] satisfies Softbox[],
  envIntensity: 1.0,
  /** Direct lights under the rig (the softboxes carry most of the light): sky/ground fill, key, cool rim. */
  hemisphere: 0.32,
  key: 1.4,
  /** Key light direction from the model (world): above, toward the Iso camera's side. */
  keyDir: [-0.35, 1, 0.55],
  rim: 0.9,
  /** Environment reflection gain on clear glass (the rig's room is darker than the panorama). */
  glassReflection: 2.2,
  /** Floor below the body underside, in body radii (the soft shadow falls clear of the parts). */
  floorGap: 1.25,
} as const;

const norm3 = (v: readonly [number, number, number]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot3 = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/** Smooth 0..1 inside |t| < 1 with a soft rim (the last 25%). */
const boxEdge = (t: number) => {
  const a = Math.abs(t);
  if (a >= 1) return 0;
  if (a <= 0.75) return 1;
  const x = (1 - a) / 0.25;
  return x * x * (3 - 2 * x);
};

/** Radiance of the rig's softboxes toward world direction `d` (unit). Pure. */
export function softboxRadiance(d: readonly [number, number, number], boxes: readonly Softbox[] = STUDIO_RIG.softboxes): number {
  let sum = 0;
  for (const b of boxes) {
    const c = norm3(b.dir);
    const cos = dot3(d, c);
    if (cos <= 0) continue;
    // Gnomonic coordinates on the box's tangent plane.
    const l0 = norm3(b.long);
    const lp = norm3([l0[0] - c[0] * dot3(l0, c), l0[1] - c[1] * dot3(l0, c), l0[2] - c[2] * dot3(l0, c)]);
    const s: [number, number, number] = [c[1] * lp[2] - c[2] * lp[1], c[2] * lp[0] - c[0] * lp[2], c[0] * lp[1] - c[1] * lp[0]];
    const u = dot3(d, lp) / cos;
    const v = dot3(d, s) / cos;
    sum += b.intensity * boxEdge(u / Math.tan((b.halfLong * Math.PI) / 180)) * boxEdge(v / Math.tan((b.halfShort * Math.PI) / 180));
  }
  return sum;
}

/** World direction of equirect texel centre (i, j), row 0 at the bottom (y = -1), three's `equirectUV`. */
export function equirectDir(i: number, j: number, w: number, h: number): [number, number, number] {
  const u = (i + 0.5) / w;
  const v = (j + 0.5) / h;
  const phi = (u - 0.5) * 2 * Math.PI;
  const theta = (v - 0.5) * Math.PI;
  return [Math.cos(theta) * Math.cos(phi), Math.sin(theta), Math.cos(theta) * Math.sin(phi)];
}

/**
 * Bakes the rig: linear RGB (Float32, RGBA, row 0 at the bottom) from the
 * panorama's linear pixels (`pano`, RGBA 0-255, row 0 at the top, any size;
 * null: a neutral grey room) plus the softboxes.
 */
export function bakeStudioRig(pano: { data: Uint8ClampedArray; width: number; height: number } | null, rig = STUDIO_RIG): Float32Array {
  const { width: w, height: h } = rig;
  const out = new Float32Array(w * h * 4);
  const lin = (x: number) => {
    const c = x / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const d = equirectDir(i, j, w, h);
      const gain = d[1] < 0 ? rig.floorGain + (rig.wallGain - rig.floorGain) * Math.max(0, 1 + d[1] * 6) : rig.wallGain;
      let r = 0.35, g = 0.35, b = 0.36;
      if (pano) {
        const pi = Math.min(pano.width - 1, Math.floor(((i + 0.5) / w) * pano.width));
        const pj = Math.min(pano.height - 1, Math.floor(((h - 1 - j + 0.5) / h) * pano.height));
        const o = (pj * pano.width + pi) * 4;
        r = lin(pano.data[o]!);
        g = lin(pano.data[o + 1]!);
        b = lin(pano.data[o + 2]!);
      }
      const box = softboxRadiance(d, rig.softboxes);
      const o = (j * w + i) * 4;
      out[o] = r * gain + box;
      out[o + 1] = g * gain + box;
      out[o + 2] = b * gain + box * 1.02;
      out[o + 3] = 1;
    }
  return out;
}

/** The baked rig as an equirect environment (half float, linear), the panorama read through a 2D canvas. */
export async function loadStudioRig(url: string = new URL(STUDIO.envUrl, document.baseURI).href): Promise<THREE.DataTexture> {
  let pano: { data: Uint8ClampedArray; width: number; height: number } | null = null;
  try {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const c = document.createElement("canvas");
    c.width = STUDIO_RIG.width;
    c.height = STUDIO_RIG.height;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (g) {
      g.drawImage(bitmap, 0, 0, c.width, c.height);
      pano = { data: g.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
    }
  } catch {
    pano = null;
  }
  const f = bakeStudioRig(pano);
  const half = new Uint16Array(f.length);
  for (let i = 0; i < f.length; i++) half[i] = THREE.DataUtils.toHalfFloat(Math.min(f[i]!, 60000));
  const tex = new THREE.DataTexture(half, STUDIO_RIG.width, STUDIO_RIG.height, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** The studio panorama as an equirect environment (the node renderer prefilters it). */
export async function loadStudioEnvironment(url: string = new URL(STUDIO.envUrl, document.baseURI).href): Promise<THREE.Texture> {
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Integer pixel offsets within `radius` px (0 excluded), with a weight for the anti-aliased rim. */
export function outlineKernel(radius: number = STUDIO.outline.widthPx): { dx: number; dy: number; w: number }[] {
  const out: { dx: number; dy: number; w: number }[] = [];
  const r = Math.ceil(radius);
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.hypot(dx, dy);
      if (d === 0 || d > radius + 0.25) continue;
      // Full weight inside the line, a softer step on its outer rim (no stair-stepping, no halo).
      out.push({ dx, dy, w: d <= radius - 0.5 ? 1 : 0.6 });
    }
  return out;
}

export interface CrispOutline {
  /** The pipeline output node. */
  output: Vec4Node;
  /**
   * 1 while something is selected. OutlineNode skips its mask pass for an
   * empty selection and leaves the last mask behind, so the engine zeroes this.
   */
  enabled: { value: number };
}

/**
 * The final output: `scene` with a crisp teal line outside the selection.
 * The colour is mixed in (not added), so tone mapping keeps it teal.
 */
export function crispOutline(o: OutlinePass, scene: Vec4Node, color: THREE.ColorRepresentation): CrispOutline {
  const rt = (o as unknown as { _renderTargetMaskBuffer: THREE.RenderTarget })._renderTargetMaskBuffer;
  rt.texture.minFilter = THREE.NearestFilter;
  rt.texture.magFilter = THREE.NearestFilter;
  const mask = texture(rt.texture);
  const texel = vec2(1).div(vec2(textureSize(mask) as unknown as ReturnType<typeof vec2>));
  let visible = float(0) as unknown as FloatNode;
  let any = float(0) as unknown as FloatNode;
  for (const k of outlineKernel()) {
    const s = mask.sample(screenUV.add(vec2(k.dx, k.dy).mul(texel)));
    const inside = s.r.oneMinus();
    any = fmax(any, inside.mul(k.w));
    // `g` is OutlineNode's depth test: 1 where the selected surface lies behind another part.
    visible = fmax(visible, inside.mul(s.g.oneMinus()).mul(k.w));
  }
  const outside = mask.sample(screenUV).r;
  const enabled = uniform(0);
  const edge = fmax(visible, any.mul(uniform(STUDIO.outline.hiddenGain))).mul(outside).mul(enabled).min(1);
  // Keep the OutlineNode in the graph: its updateBefore renders the mask (its own blurred edge is unused).
  const keep = o.visibleEdge.mul(0);
  const teal = uniform(new THREE.Color(color));
  return { output: vec4(mix(scene.rgb, teal, edge).add(keep), fmax(scene.a, edge)), enabled };
}

/** Reads the canvas (the final tone-mapped output) into RGBA; call in the same task as the render. */
export function readCanvas(src: HTMLCanvasElement): Frame {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) throw new Error("no 2d context for the probe");
  g.drawImage(src, 0, 0);
  return { data: g.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
}
