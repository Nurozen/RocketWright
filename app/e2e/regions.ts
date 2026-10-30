/**
 * Region geometry for the bar (S:169: "region proportions from DOM bounding
 * boxes (±5%)").
 *
 * - DOM mode: `measureDomRegions(page)` reads `getBoundingClientRect()` of each
 *   `[data-rw-region]` element through any Playwright-compatible `page.evaluate`.
 *   With the Lecturn embed (D31), regions with an `embed` selector are read in
 *   the embed's webContents and offset by the embed rect, against the page's
 *   `embed` rects (`embeddedRegions`).
 * - Image mode: `detectRegionRects(img, page)` finds the 1 px hairline dividers
 *   near each expected edge in a PNG (used by `bar:calibrate` on the exemplars and
 *   on captures without a DOM).
 * - `checkProportions()` compares measured rects with the exemplar rects in
 *   `tests/bar/regions.json`, relative to the expected size.
 */
import type { Image } from "./bar/png.ts";
import { round, type PageId } from "./bar/paths.ts";
import type { Dim, PageRegions, Rect, RegionsSpec } from "./bar/spec.ts";

/** The subset of Playwright's `Page` the bar scripts use. */
export interface PageLike {
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
}

/** D31: the embedded Lecturn pane: its webContents, and the embed rect's top-left in the main page (the guest's 0,0). */
export interface EmbedContext {
  page: PageLike;
  origin: { x: number; y: number };
}

export interface ProportionResult {
  region: string;
  dim: Dim;
  expected: number;
  measured: number | null;
  /** |measured - expected| / expected, or null when the region is missing. */
  error: number | null;
  pass: boolean;
}

/** Browser-side probe: bounding boxes of each selector (null when absent or not rendered). */
function domRectsProbe(selectors: Record<string, string>): Record<string, [number, number, number, number] | null> {
  const out: Record<string, [number, number, number, number] | null> = {};
  for (const [name, sel] of Object.entries(selectors)) {
    const el = document.querySelector(sel);
    if (!el) {
      out[name] = null;
      continue;
    }
    const r = el.getBoundingClientRect();
    out[name] = r.width > 0 && r.height > 0 ? [r.x, r.y, r.width, r.height] : null;
  }
  return out;
}

/**
 * The regions spec as DOM mode uses it with the embed (D31): the page's
 * `embed.rects` replace (or add to) its exemplar rects and `embed.check` its
 * checks, region by region. A page without an `embed` block is unchanged.
 */
export function embeddedRegions(spec: RegionsSpec, pageId: PageId): RegionsSpec {
  const page = spec.pages[pageId];
  if (page.embed === undefined) return spec;
  const merged = { ...page, rects: { ...page.rects, ...page.embed.rects }, check: { ...page.check, ...page.embed.check } };
  return { ...spec, pages: { ...spec.pages, [pageId]: merged } };
}

/** Measures every region named in the page's rects from the live DOM (with `embed`, `embed`-selector regions in the guest). */
export async function measureDomRegions(
  page: PageLike,
  spec: RegionsSpec,
  pageId: PageId,
  embed: EmbedContext | null = null,
): Promise<Record<string, Rect | null>> {
  const selectors: Record<string, string> = {};
  const inGuest: Record<string, string> = {};
  for (const name of Object.keys(spec.pages[pageId].rects)) {
    const def = spec.regions[name];
    if (!def) throw new Error(`regions.json: page ${pageId} uses undefined region ${name}`);
    if (embed !== null && def.embed !== undefined) inGuest[name] = def.embed;
    else selectors[name] = def.selector;
  }
  const out = await page.evaluate(domRectsProbe, selectors);
  if (embed === null || Object.keys(inGuest).length === 0) return out;
  const guest = await embed.page.evaluate(domRectsProbe, inGuest);
  for (const [name, r] of Object.entries(guest)) out[name] = r === null ? null : [r[0] + embed.origin.x, r[1] + embed.origin.y, r[2], r[3]];
  return out;
}

function dimOf(rect: Rect, dim: Dim): number {
  return dim === "w" ? rect[2] : rect[3];
}

/** Compares measured rects with the exemplar rects for each checked dimension. */
export function checkProportions(
  spec: RegionsSpec,
  pageId: PageId,
  measured: Record<string, Rect | null | undefined>,
): ProportionResult[] {
  const page = spec.pages[pageId];
  const tol = spec.tolerance.proportion;
  const out: ProportionResult[] = [];
  for (const [region, dims] of Object.entries(page.check).sort(([a], [b]) => a.localeCompare(b))) {
    const exp = page.rects[region];
    if (!exp) throw new Error(`regions.json: page ${pageId} checks ${region} without a rect`);
    for (const dim of dims) {
      const expected = dimOf(exp, dim);
      const m = measured[region];
      if (!m) {
        out.push({ region, dim, expected, measured: null, error: null, pass: false });
        continue;
      }
      const value = dimOf(m, dim);
      const error = Math.abs(value - expected) / expected;
      out.push({ region, dim, expected, measured: round(value, 1), error: round(error, 4), pass: error <= tol });
    }
  }
  return out;
}

// ---- image mode: hairline detection ---------------------------------------------

/** Sum of RGB at (x, y). */
function lum(img: Image, x: number, y: number): number {
  const o = (y * img.width + x) * 4;
  return img.data[o]! + img.data[o + 1]! + img.data[o + 2]!;
}

/** Contrast (summed RGB) a hairline pixel needs over both neighbours 3 px away. */
const LINE_CONTRAST = 6;
/** Fraction of the scanned span that must show the line. */
const LINE_COVERAGE = 0.3;

/**
 * Fraction of the span along which a 1-2 px line brighter than its surroundings
 * runs at `pos` (a column for axis "x", a row for axis "y").
 */
export function lineScore(img: Image, axis: "x" | "y", pos: number, from: number, to: number): number {
  const limit = axis === "x" ? img.width : img.height;
  if (pos - 3 < 0 || pos + 3 >= limit) return 0;
  let hits = 0;
  let n = 0;
  for (let t = Math.max(0, from); t < Math.min(to, axis === "x" ? img.height : img.width); t++) {
    n++;
    const at = axis === "x" ? lum(img, pos, t) : lum(img, t, pos);
    const lo = axis === "x" ? lum(img, pos - 3, t) : lum(img, t, pos - 3);
    const hi = axis === "x" ? lum(img, pos + 3, t) : lum(img, t, pos + 3);
    if (at > lo + LINE_CONTRAST && at > hi + LINE_CONTRAST) hits++;
  }
  return n === 0 ? 0 : hits / n;
}

/**
 * Finds the divider nearest `expected` within ±`window` px. Returns the line
 * position (the boundary coordinate), or null when no line covers enough of the span.
 */
export function findEdge(
  img: Image,
  axis: "x" | "y",
  expected: number,
  window: number,
  from: number,
  to: number,
): number | null {
  let best: { pos: number; score: number } | null = null;
  for (let p = Math.round(expected - window); p <= Math.round(expected + window); p++) {
    const score = lineScore(img, axis, p, from, to);
    if (score < LINE_COVERAGE) continue;
    // Prefer the strongest line; break near-ties (2 px lines) toward the expected edge.
    if (!best || score > best.score + 0.05 || (Math.abs(score - best.score) <= 0.05 && Math.abs(p - expected) < Math.abs(best.pos - expected))) {
      best = { pos: p, score };
    }
  }
  return best ? best.pos : null;
}

/** Detects each checked region's rect from the hairlines of an image (DPR 1 capture or exemplar). */
export function detectRegionRects(img: Image, page: PageRegions): Record<string, Rect | null> {
  const out: Record<string, Rect | null> = {};
  for (const [region, dims] of Object.entries(page.check)) {
    const r = page.rects[region];
    if (!r) continue;
    let [x, y, w, h] = r;
    let ok = true;
    const edge = (axis: "x" | "y", at: number, size: number, from: number, to: number): number => {
      const border = axis === "x" ? img.width : img.height;
      if (at <= 0 || at >= border) return Math.max(0, Math.min(at, border));
      const inset = Math.min(10, Math.floor((to - from) / 4));
      const found = findEdge(img, axis, at, Math.max(6, Math.ceil(size * 0.05)), from + inset, to - inset);
      if (found === null) ok = false;
      return found ?? at;
    };
    if (dims.includes("w")) {
      const left = edge("x", x, w, y, y + h);
      const right = edge("x", x + w, w, y, y + h);
      x = left;
      w = right - left;
    }
    if (dims.includes("h")) {
      const top = edge("y", y, h, x, x + w);
      const bottom = edge("y", y + h, h, x, x + w);
      y = top;
      h = bottom - top;
    }
    out[region] = ok ? [x, y, w, h] : null;
  }
  return out;
}
