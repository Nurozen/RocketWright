/**
 * Output probes on the final canvas pixels (M3.1 verify; pure, no three or
 * DOM, so the e2e drive imports it): the contact shadow's mass near the model
 * silhouette and the selection outline's width, crispness, and colour, from
 * three readbacks of one frame (`ViewportEngine.probeOutput`).
 */
/** RGBA (unpremultiplied, 0-255) of one canvas readback. */
/** GTAO probe (M3.1): pixels the AO term darkens by more than 2 levels on the final output. */
export interface AoProbe {
  darkened: number;
  meanDelta: number;
  maxDelta: number;
}

/** Floor on AO-darkened pixels for the page 01 framing (contact creases at the joints, fins, and bays). */
export const AO_MIN_DARKENED_PX = 1500;

/** Failures of the GTAO probe (empty when ambient occlusion visibly shades the model). */
export function aoProbeFailures(p: AoProbe | null, minPx = AO_MIN_DARKENED_PX): string[] {
  if (p === null) return ["ao: no GTAO in the pipeline"];
  const f: string[] = [];
  if (p.darkened < minPx) f.push(`ao: darkens ${p.darkened} px (want >= ${minPx})`);
  if (p.maxDelta > 120) f.push(`ao: a ${p.maxDelta.toFixed(0)}-level darkening is a black artefact, not occlusion`);
  return f;
}

export interface Frame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface ShadowStats {
  /** Summed darkening outside the model (fraction of the backdrop's luminance the floor removes, 0-1 per pixel). */
  mass: number;
  /** Fraction of that mass within `nearPx` of the model's silhouette. */
  near: number;
  nearPx: number;
  /** Mass-weighted mean distance from the silhouette (px). */
  meanDist: number;
  /** Peak darkening (0-1). */
  peak: number;
  /** Mean luminance drop the shadow causes on the composited output (0-255 levels), over shadowed pixels. */
  lumaDrop: number;
  /** Spread: the distance (px) from the silhouette within which 90% of the shadow mass lies. */
  spread: number;
  /**
   * Softness: the largest darkening step between neighbouring shadow pixels
   * (0-1, away from the silhouette). A hard per-part fringe steps by about
   * its peak; a soft penumbra by a few hundredths.
   */
  maxStep: number;
}

/** The studio light pool: pixels the floor brightens. */
export interface PoolStats {
  pixels: number;
  /** Summed brightening (0-255 levels). */
  mass: number;
  /** Peak brightening (levels). */
  peak: number;
}

export interface OutlineStats {
  /** Pixels the outline changes (over the background or the model). */
  pixels: number;
  /** Median line thickness: per outline pixel, min of its horizontal and vertical run (px). */
  medianWidth: number;
  /** Fraction of outline pixels with a run of at most 3 px. */
  crisp: number;
  /** Fraction of changed pixels that are faint (alpha 0.04-0.35): a blurred halo shows up here. */
  faint: number;
  /** Mean colour of strong outline pixels over the background (`#rrggbb`), or null. */
  color: string | null;
  /** Colour distance to the selection teal (0-255 RGB euclidean), or null. */
  tealDistance: number | null;
}

export interface OutputProbe {
  width: number;
  height: number;
  /** Pixels covered by the model (the bare frame's alpha). */
  modelPixels: number;
  shadow: ShadowStats;
  pool: PoolStats;
  outline: OutlineStats;
}

const alphaAt = (f: Frame, i: number) => f.data[i * 4 + 3]! / 255;

/** Two-pass 3-4 chamfer distance (px) to the nearest `true` cell. */
export function distanceField(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? INF : d[y * w + x]!);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      d[i] = Math.min(d[i]!, at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      d[i] = Math.min(d[i]!, at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  for (let i = 0; i < d.length; i++) d[i] = d[i]! / 3;
  return d;
}

const luma = (f: Frame, i: number, bg: [number, number, number]) => {
  // Composite over the vignette colour (the canvas is transparent over it).
  const a = alphaAt(f, i);
  const c = (k: number) => f.data[i * 4 + k]! * a + bg[k]! * (1 - a);
  return 0.2126 * c(0) + 0.7152 * c(1) + 0.0722 * c(2);
};

/**
 * Shadow and outline statistics from three readbacks of the same frame:
 * `full` (as shown), `noGround` (catcher hidden), `bare` (catcher hidden, no
 * selection outline). The model silhouette is `bare`'s alpha.
 */
export function analyzeOutput(full: Frame, noGround: Frame, bare: Frame, teal: string, bg: [number, number, number] = [30, 35, 39], nearPx = 40): OutputProbe {
  const { width: w, height: h } = full;
  const n = w * h;
  // Silhouette: anything the model draws, translucent glass and anti-aliased rims included.
  const model = new Uint8Array(n);
  let modelPixels = 0;
  for (let i = 0; i < n; i++) {
    model[i] = alphaAt(bare, i) > 0.04 ? 1 : 0;
    if (alphaAt(bare, i) > 0.5) modelPixels++;
  }
  const dist = distanceField(model, w, h);

  // Shadow: what the catcher adds (outline pixels excluded: they are not ground).
  let mass = 0, nearMass = 0, distMass = 0, peak = 0, drop = 0, dropN = 0;
  const outlinePx = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const ao = Math.abs(alphaAt(noGround, i) - alphaAt(bare, i));
    let dc = 0;
    for (let k = 0; k < 3; k++) dc = Math.max(dc, Math.abs(noGround.data[i * 4 + k]! - bare.data[i * 4 + k]!));
    if (ao > 0.04 || (alphaAt(bare, i) > 0.04 && dc > 10)) outlinePx[i] = 1;
  }
  // Floor: luminance change the floor makes over the backdrop (darker: shadow, brighter: light pool).
  const dark = new Float32Array(n);
  let poolPx = 0, poolMass = 0, poolPeak = 0;
  for (let i = 0; i < n; i++) {
    // Floor pixels only: nothing else drawn there (clear glass composites over the floor differently).
    if (model[i] || outlinePx[i] || alphaAt(noGround, i) > 0.04) continue;
    const before = luma(noGround, i, bg);
    const d = before - luma(full, i, bg);
    if (d < -1) {
      poolPx++;
      poolMass += -d;
      poolPeak = Math.max(poolPeak, -d);
      continue;
    }
    if (d <= 1) continue;
    const s = Math.min(1, d / Math.max(1, before));
    dark[i] = s;
    mass += s;
    if (dist[i]! <= nearPx) nearMass += s;
    distMass += s * Math.min(dist[i]!, 1e4);
    peak = Math.max(peak, s);
    drop += d;
    dropN++;
  }
  // Spread: the mass-weighted 90th percentile of the distance to the silhouette.
  let spread = 0;
  if (mass > 0) {
    const rows: [number, number][] = [];
    for (let i = 0; i < n; i++) if (dark[i]! > 0) rows.push([dist[i]!, dark[i]!]);
    rows.sort((a, b) => a[0] - b[0]);
    let acc = 0;
    for (const [d, w] of rows) {
      acc += w;
      if (acc >= 0.9 * mass) {
        spread = d;
        break;
      }
    }
  }
  // Softness: steps between neighbours, both clear of the silhouette and the outline (3 px).
  let maxStep = 0;
  const clear = (i: number) => dist[i]! > 3 && !outlinePx[i];
  for (let y = 0; y < h - 1; y++)
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      if (!clear(i)) continue;
      if (dark[i] === 0 && dark[i + 1] === 0 && dark[i + w] === 0) continue;
      if (clear(i + 1)) maxStep = Math.max(maxStep, Math.abs(dark[i]! - dark[i + 1]!));
      if (clear(i + w)) maxStep = Math.max(maxStep, Math.abs(dark[i]! - dark[i + w]!));
    }
  const shadow: ShadowStats = {
    mass: round(mass, 1),
    near: mass > 0 ? round(nearMass / mass, 3) : 0,
    nearPx,
    meanDist: mass > 0 ? round(distMass / mass, 1) : 0,
    peak: round(peak, 3),
    lumaDrop: dropN > 0 ? round(drop / dropN, 2) : 0,
    spread: round(spread, 1),
    maxStep: round(maxStep, 3),
  };
  const pool: PoolStats = { pixels: poolPx, mass: round(poolMass, 1), peak: round(poolPeak, 2) };

  // Outline: pixels the selection changes, their run lengths, and their colour over the background.
  let pixels = 0, faint = 0, changed = 0;
  const runs: number[] = [];
  const hRun = new Uint16Array(n);
  const vRun = new Uint16Array(n);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!outlinePx[y * w + x]) {
        x++;
        continue;
      }
      let e = x;
      while (e < w && outlinePx[y * w + e]) e++;
      for (let k = x; k < e; k++) hRun[y * w + k] = e - x;
      x = e;
    }
  }
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!outlinePx[y * w + x]) {
        y++;
        continue;
      }
      let e = y;
      while (e < h && outlinePx[e * w + x]) e++;
      for (let k = y; k < e; k++) vRun[k * w + x] = e - y;
      y = e;
    }
  }
  let r = 0, g = 0, b = 0, cn = 0, crisp = 0;
  for (let i = 0; i < n; i++) {
    if (!outlinePx[i]) continue;
    changed++;
    const a = alphaAt(noGround, i);
    const overBg = alphaAt(bare, i) < 0.04;
    if (overBg && a < 0.35) {
      faint++;
      continue;
    }
    pixels++;
    const t = Math.min(hRun[i]!, vRun[i]!);
    runs.push(t);
    if (t <= 3) crisp++;
    if (overBg && a > 0.6) {
      r += noGround.data[i * 4]!;
      g += noGround.data[i * 4 + 1]!;
      b += noGround.data[i * 4 + 2]!;
      cn++;
    }
  }
  runs.sort((p, q) => p - q);
  const color = cn > 0 ? hex(r / cn, g / cn, b / cn) : null;
  const ref = rgbOf(teal);
  const tealDistance = cn > 0 ? round(Math.hypot(r / cn - ref[0], g / cn - ref[1], b / cn - ref[2]), 1) : null;
  const outline: OutlineStats = {
    pixels,
    medianWidth: runs.length > 0 ? runs[Math.floor(runs.length / 2)]! : 0,
    crisp: pixels > 0 ? round(crisp / pixels, 3) : 0,
    faint: changed > 0 ? round(faint / changed, 3) : 0,
    color,
    tealDistance,
  };
  return { width: w, height: h, modelPixels, shadow, pool, outline };
}

/** Shadow gates beyond presence (BC5): a broad penumbra and no hard fringe. */
export interface FloorGates {
  /** Minimum 90% spread (px) past the silhouette. */
  minSpreadPx?: number;
  /** Largest allowed neighbour step in darkening (a hard fringe steps by its peak). */
  maxStep?: number;
  /** Minimum model coverage of the readback (model px / all px): the framing reads chunky. */
  minCoverage?: number;
}

/**
 * Page 01 at its concept framing (BC5): a broad soft shadow (90% of it
 * spreads at least 18 px past the silhouette, no neighbour step over 0.06),
 * and the model covering at least 8% of the viewport (round 14 measured
 * about 4%). The light pool is a backdrop layer under the canvas, checked in
 * the DOM (`vp.light-pool`); `pool` here only catches a floor that glows.
 */
export const PAGE01_GATES: FloorGates = { minSpreadPx: 18, maxStep: 0.06, minCoverage: 0.08 };

/** Light-pool ceiling (levels): a subtle lift of the backdrop, never a glow. */
export const POOL_MAX_PEAK = 32;

/** The gates the e2e and the bar drive apply to `analyzeOutput` (M3.1 verify; BC5 floor gates). */
export function outputProbeFailures(p: OutputProbe, shadowsOn = true, gates: FloorGates = {}): string[] {
  const f: string[] = [];
  if (p.modelPixels < 100) f.push(`model: ${p.modelPixels} model px in the readback`);
  const coverage = p.modelPixels / Math.max(1, p.width * p.height);
  if (gates.minCoverage !== undefined && coverage < gates.minCoverage) f.push(`framing: the model covers ${(100 * coverage).toFixed(1)}% of the view (want >= ${(100 * gates.minCoverage).toFixed(0)}%)`);
  if (shadowsOn) {
    if (p.shadow.mass < 50) f.push(`shadow: no visible contact shadow (mass ${p.shadow.mass})`);
    if (p.shadow.near < 0.6) f.push(`shadow: only ${p.shadow.near} of the shadow lies within ${p.shadow.nearPx} px of the model (detached)`);
    const minSpread = gates.minSpreadPx ?? 4;
    if (p.shadow.spread < minSpread) f.push(`shadow: spreads ${p.shadow.spread} px past the silhouette (want >= ${minSpread}: a broad soft shadow)`);
    const maxStep = gates.maxStep ?? 0.08;
    if (p.shadow.maxStep > maxStep) f.push(`shadow: a ${p.shadow.maxStep} step between neighbours is a hard fringe (want <= ${maxStep})`);
  }
  if (p.pool.peak > POOL_MAX_PEAK) f.push(`pool: a ${p.pool.peak}-level lift is a glow, not a light pool (want <= ${POOL_MAX_PEAK})`);
  if (p.outline.pixels < 50) f.push(`outline: ${p.outline.pixels} outline px`);
  if (p.outline.medianWidth < 1 || p.outline.medianWidth > 3) f.push(`outline: median width ${p.outline.medianWidth} px (want 2)`);
  if (p.outline.crisp < 0.8) f.push(`outline: only ${p.outline.crisp} of the line is <= 3 px thick`);
  if (p.outline.faint > 0.25) f.push(`outline: ${p.outline.faint} of its pixels are a faint halo`);
  if (p.outline.tealDistance === null || p.outline.tealDistance > 40) f.push(`outline: colour ${p.outline.color} is not the selection teal (distance ${p.outline.tealDistance})`);
  return f;
}

function round(v: number, p: number): number {
  const k = 10 ** p;
  return Math.round(v * k) / k;
}

function hex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** `#rrggbb` -> sRGB 0-255. */
function rgbOf(hexColor: string): [number, number, number] {
  const v = Number.parseInt(hexColor.replace(/^#/, ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
