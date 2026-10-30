/**
 * Token script for the visual bar (S:169): measures what critics cannot.
 *
 * - Colours: sampled colours compared with the token table (`tests/bar/tokens.json`,
 *   concepts.md §2) by CIEDE2000; pass at ΔE00 <= 3 against the closest accepted
 *   reference of the bound token.
 * - Proportions: region sizes against the exemplar rects (`tests/bar/regions.json`), ±5%.
 * - Typography: font sizes per role (reported for the critics; not gating, S:170).
 *
 * Two modes:
 * - DOM mode, `measureDom(page, pageId, …, embed)`: computed styles and bounding boxes from a
 *   Playwright-compatible page (the live app). With the Lecturn embed as the agent
 *   pane (D31), bindings, roles and regions that name an `embed` selector are read
 *   in the embed's webContents instead (boxes offset by the embed rect), and the
 *   pane probes (`paneProbes`) are located there; `measurePanePixels` then samples
 *   them from the composite capture.
 * - Image mode, `measureImage(img, pageId)`: median pixel samples at the page's
 *   probe rects plus hairline-detected region rects (exemplars, or a PNG capture).
 *
 * CLI (image mode): `node e2e/visual-tokens.ts --image <png> --page 01 [--out report.json]`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { colorAlpha, deltaE, parseColor, toHex, type Rgb } from "./bar/color.ts";
import { isPageId, round, stableStringify, type PageId } from "./bar/paths.ts";
import { decodePng, type Image } from "./bar/png.ts";
import { appliesTo, loadRegions, loadTokens, type Rect, type RegionsSpec, type TokensSpec } from "./bar/spec.ts";
import { checkProportions, detectRegionRects, embeddedRegions, measureDomRegions, type EmbedContext, type PageLike, type ProportionResult } from "./regions.ts";

export type { EmbedContext } from "./regions.ts";

export { ciede2000, deltaE, parseColor, rgbToLab, toHex } from "./bar/color.ts";

export interface ColorResult {
  token: string;
  /** Region, selector, or probe rect the colour came from. */
  where: string;
  property: string;
  measured: string | null;
  /** The accepted reference closest to the measurement. */
  ref: string | null;
  deltaE: number | null;
  pass: boolean;
}

export interface TypographyResult {
  role: string;
  selector: string;
  expectedPx: [number, number];
  measuredPx: number | null;
  family: string | null;
  pass: boolean;
}

export interface TokenReport {
  page: PageId;
  mode: "dom" | "image";
  tolerance: { deltaE2000: number; proportion: number };
  colors: ColorResult[];
  proportions: ProportionResult[];
  /** Informational: critics judge the typography scale (S:170). */
  typography: TypographyResult[];
  /**
   * D31: pane probes located in the embed, waiting for the composite capture
   * (`measurePanePixels` samples them and drops this field). A null rect is a
   * probe whose element the embed did not render.
   */
  panePixels?: PanePixelRequest[];
  failures: number;
  pass: boolean;
}

/** One located pane probe (absolute capture px). */
export interface PanePixelRequest {
  name: string;
  token: string;
  rect: Rect | null;
  note: string;
}

/** All accepted references of a token: its value, then its `accept` list. */
export function tokenRefs(tokens: TokensSpec, token: string): string[] {
  const t = tokens.colors[token];
  if (!t) throw new Error(`tokens.json: unknown colour token ${token}`);
  return [t.value, ...t.accept];
}

/** Scores one measured colour against a token (closest accepted reference). */
export function scoreColor(
  tokens: TokensSpec,
  token: string,
  measured: Rgb | string | null,
  where: string,
  property: string,
): ColorResult {
  const refs = tokenRefs(tokens, token);
  if (measured === null) return { token, where, property, measured: null, ref: null, deltaE: null, pass: false };
  const rgb = typeof measured === "string" ? parseColor(measured) : measured;
  let best = { ref: refs[0]!, d: Infinity };
  for (const ref of refs) {
    const d = deltaE(rgb, ref);
    if (d < best.d) best = { ref, d };
  }
  return {
    token,
    where,
    property,
    measured: toHex(rgb),
    ref: best.ref,
    deltaE: round(best.d),
    pass: best.d <= tokens.tolerance.deltaE2000,
  };
}

/** Per-channel median of a rect (clipped to the image). Robust to sparse text and icons. */
export function sampleMedian(img: Image, rect: Rect): Rgb {
  const [x0, y0, w, h] = rect;
  const ch: [number[], number[], number[]] = [[], [], []];
  for (let y = Math.max(0, y0); y < Math.min(img.height, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x0 + w); x++) {
      const o = (y * img.width + x) * 4;
      ch[0].push(img.data[o]!);
      ch[1].push(img.data[o + 1]!);
      ch[2].push(img.data[o + 2]!);
    }
  }
  if (ch[0].length === 0) throw new Error(`sample rect ${JSON.stringify(rect)} is outside the image`);
  const med = (a: number[]): number => {
    a.sort((p, q) => p - q);
    return a[a.length >> 1]!;
  };
  return [med(ch[0]), med(ch[1]), med(ch[2])];
}

function finish(
  page: PageId,
  mode: "dom" | "image",
  tokens: TokensSpec,
  regions: RegionsSpec,
  colors: ColorResult[],
  proportions: ProportionResult[],
  typography: TypographyResult[],
): TokenReport {
  const failures = colors.filter((c) => !c.pass).length + proportions.filter((p) => !p.pass).length;
  return {
    page,
    mode,
    tolerance: { deltaE2000: tokens.tolerance.deltaE2000, proportion: regions.tolerance.proportion },
    colors,
    proportions,
    typography,
    failures,
    pass: failures === 0,
  };
}

/** Image mode: probe medians against tokens, hairline-detected rects against the exemplar rects. */
export function measureImage(
  img: Image,
  page: PageId,
  tokens: TokensSpec = loadTokens(),
  regions: RegionsSpec = loadRegions(),
): TokenReport {
  const { width, height } = regions.viewport;
  if (img.width !== width || img.height !== height) {
    throw new Error(`image is ${String(img.width)}x${String(img.height)}; the bar captures at ${String(width)}x${String(height)} DPR 1`);
  }
  const colors = (tokens.probes[page] ?? []).map((p) =>
    scoreColor(tokens, p.token, sampleMedian(img, p.rect), `rect ${p.rect.join(",")} (${p.note})`, "pixel-median"),
  );
  const proportions = checkProportions(regions, page, detectRegionRects(img, regions.pages[page]));
  return finish(page, "image", tokens, regions, colors, proportions, []);
}

interface DomProbeArg {
  colors: { selector: string; property: string }[];
  fonts: { selector: string }[];
  /** Element boxes (viewport px), shrunk by `inset`; null when absent or empty. */
  boxes?: { selector: string; inset: number }[];
}

interface DomProbeResult {
  colors: (string | null)[];
  fonts: ({ px: number; family: string } | null)[];
  boxes?: ([number, number, number, number] | null)[];
}

/**
 * Browser-side probe. Transparent backgrounds resolve to the nearest painted
 * ancestor, which is the colour a viewer sees.
 */
function domTokensProbe(arg: DomProbeArg): DomProbeResult {
  const clear = (c: string): boolean => c === "transparent" || /^rgba\(.*,\s*0\)$/.test(c) || /\/\s*0\)$/.test(c);
  const colors = arg.colors.map(({ selector, property }) => {
    let el: Element | null = document.querySelector(selector);
    if (!el) return null;
    let v = getComputedStyle(el).getPropertyValue(property);
    // oxlint-disable-next-line no-unmodified-loop-condition -- `el` and `v` change each pass
    while (property === "background-color" && clear(v) && el.parentElement) {
      el = el.parentElement;
      v = getComputedStyle(el).getPropertyValue(property);
    }
    return v || null;
  });
  const fonts = arg.fonts.map(({ selector }) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { px: parseFloat(cs.fontSize), family: cs.fontFamily };
  });
  const boxes = (arg.boxes ?? []).map(({ selector, inset }): [number, number, number, number] | null => {
    // The match most in view (CP-W1 r3: a thread's first user bubble is scrolled out of the pane; the live turn's is in it).
    const shown = (e: Element) => {
      const b = e.getBoundingClientRect();
      return Math.max(0, Math.min(b.right, innerWidth) - Math.max(b.left, 0)) * Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0));
    };
    let el: Element | null = null;
    for (const e of Array.from(document.querySelectorAll(selector))) if (el === null || shown(e) > shown(el)) el = e;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const w = Math.round(r.width) - 2 * inset;
    const h = Math.round(r.height) - 2 * inset;
    return w > 0 && h > 0 ? [Math.round(r.x) + inset, Math.round(r.y) + inset, w, h] : null;
  });
  return { colors, fonts, boxes };
}

/** DOM mode: computed colours of bound elements, region bounding boxes, and font sizes. */
export async function measureDom(
  page: PageLike,
  pageId: PageId,
  tokens: TokensSpec = loadTokens(),
  regions: RegionsSpec = loadRegions(),
  embed: EmbedContext | null = null,
): Promise<TokenReport> {
  const bindings = tokens.bindings
    .filter((b) => appliesTo(b.pages, pageId))
    .map((b) => {
      const inEmbed = embed !== null && b.embed !== undefined;
      const selector = inEmbed ? b.embed : (b.selector ?? (b.region ? regions.regions[b.region]?.selector : undefined));
      if (!selector) throw new Error(`tokens.json: binding for ${b.token} has no resolvable selector`);
      return { b, inEmbed, selector, where: inEmbed ? `embed ${selector}` : (b.selector ?? `region ${String(b.region)}`) };
    });
  const roles = Object.entries(tokens.typography.roles)
    .filter(([, r]) => appliesTo(r.pages, pageId))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, r]) => {
      const inEmbed = embed !== null && r.embed !== undefined;
      return { role, r, inEmbed, selector: inEmbed ? r.embed! : r.selector };
    });
  const paneProbes = embed === null ? [] : (tokens.paneProbes ?? []).filter((p) => appliesTo(p.pages, pageId));
  const probeIn = async (inEmbed: boolean): Promise<{ colors: (string | null)[]; fonts: ({ px: number; family: string } | null)[]; boxes: ([number, number, number, number] | null)[] }> => {
    const target = inEmbed ? embed : null;
    const cs = bindings.filter((x) => x.inEmbed === inEmbed);
    const fs = roles.filter((x) => x.inEmbed === inEmbed);
    const bx = inEmbed ? paneProbes.filter((p) => p.embed !== undefined) : [];
    if (cs.length + fs.length + bx.length === 0) return { colors: [], fonts: [], boxes: [] };
    const res = await (target === null ? page : target.page).evaluate(domTokensProbe, {
      colors: cs.map((x) => ({ selector: x.selector, property: x.b.property })),
      fonts: fs.map((x) => ({ selector: x.selector })),
      boxes: bx.map((p) => ({ selector: p.embed!, inset: p.inset ?? 0 })),
    });
    return { colors: res.colors, fonts: res.fonts, boxes: res.boxes ?? [] };
  };
  const main = await probeIn(false);
  const guest = embed === null ? { colors: [], fonts: [], boxes: [] } : await probeIn(true);
  const take = { main: { c: 0, f: 0 }, guest: { c: 0, f: 0, b: 0 } };
  const colors = bindings.map(({ b, inEmbed, where }) => {
    const raw = (inEmbed ? guest.colors[take.guest.c++] : main.colors[take.main.c++]) ?? null;
    if (raw !== null && colorAlpha(raw) === 0) return scoreColor(tokens, b.token, null, where, b.property);
    return scoreColor(tokens, b.token, raw, where, b.property);
  });
  const typography = roles.map(({ role, r, inEmbed, selector }): TypographyResult => {
    const f = (inEmbed ? guest.fonts[take.guest.f++] : main.fonts[take.main.f++]) ?? null;
    return {
      role,
      selector: inEmbed ? `embed ${selector}` : selector,
      expectedPx: r.px,
      measuredPx: f ? round(f.px, 1) : null,
      family: f ? f.family : null,
      pass: f !== null && f.px >= r.px[0] && f.px <= r.px[1],
    };
  });
  const panePixels: PanePixelRequest[] = paneProbes.map((p) => {
    const at = embed!.origin;
    let rect: Rect | null;
    if (p.embed !== undefined) {
      const box = guest.boxes[take.guest.b++] ?? null;
      rect = box === null ? null : [box[0] + at.x, box[1] + at.y, box[2], box[3]];
    } else if (p.rect !== undefined) rect = [p.rect[0] + at.x, p.rect[1] + at.y, p.rect[2], p.rect[3]];
    else throw new Error(`tokens.json: pane probe ${p.name} needs an embed selector or a rect`);
    return { name: p.name, token: p.token, rect, note: p.note };
  });
  const spec = embed === null ? regions : embeddedRegions(regions, pageId);
  const rects = await measureDomRegions(page, spec, pageId, embed);
  const report = finish(pageId, "dom", tokens, regions, colors, checkProportions(spec, pageId, rects), typography);
  return panePixels.length === 0 ? report : { ...report, panePixels };
}

/** The `where` of a sampled pane probe (`pane <name> (<note>)`); `app/e2e/bar/shell-rows.ts` scopes by it. */
export function paneWhere(name: string, note: string): string {
  return `pane ${name} (${note})`;
}

/**
 * D31: samples the report's pane probes (`panePixels`) from the composite
 * capture and adds them as colour rows; a probe whose element was missing
 * fails. Returns the report unchanged when it has none.
 */
export function measurePanePixels(report: TokenReport, img: Image, tokens: TokensSpec = loadTokens()): TokenReport {
  const requests = report.panePixels;
  if (requests === undefined) return report;
  const extra = requests.map((r) => {
    const where = paneWhere(r.name, r.note);
    if (r.rect === null) return scoreColor(tokens, r.token, null, where, "pixel-median");
    let rgb: Rgb | null;
    try {
      rgb = sampleMedian(img, r.rect);
    } catch {
      rgb = null;
    }
    return scoreColor(tokens, r.token, rgb, `${where} rect ${r.rect.join(",")}`, "pixel-median");
  });
  const rest: TokenReport = { ...report };
  delete rest.panePixels;
  const colors = [...rest.colors, ...extra];
  const failures = colors.filter((c) => !c.pass).length + rest.proportions.filter((p) => !p.pass).length;
  return { ...rest, colors, failures, pass: failures === 0 };
}

export function formatReport(r: TokenReport): string {
  const lines = [`page ${r.page} (${r.mode}): ${r.pass ? "PASS" : `FAIL (${String(r.failures)})`}`];
  for (const c of r.colors) {
    lines.push(
      `  ${c.pass ? "ok  " : "FAIL"} colour ${c.token.padEnd(20)} ${String(c.measured).padEnd(8)} ref ${String(c.ref).padEnd(8)} dE ${String(c.deltaE).padStart(6)}  ${c.where}`,
    );
  }
  for (const p of r.proportions) {
    lines.push(
      `  ${p.pass ? "ok  " : "FAIL"} region ${p.region.padEnd(20)} ${p.dim} expected ${String(p.expected).padStart(5)} measured ${String(p.measured).padStart(6)} err ${String(p.error)}`,
    );
  }
  for (const t of r.typography) {
    lines.push(`  ${t.pass ? "ok  " : "info"} type ${t.role.padEnd(16)} ${String(t.measuredPx)}px in [${t.expectedPx.join(", ")}]`);
  }
  return lines.join("\n");
}

function main(argv: string[]): number {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const image = arg("--image");
  const page = arg("--page");
  if (!image || !page || !isPageId(page)) {
    console.error("usage: node e2e/visual-tokens.ts --image <png> --page 01..06 [--out report.json]");
    return 2;
  }
  const report = measureImage(decodePng(readFileSync(image)), page);
  const out = arg("--out");
  if (out) writeFileSync(out, stableStringify(report));
  console.log(formatReport(report));
  return report.pass ? 0 : 1;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
