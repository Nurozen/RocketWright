import { describe, expect, it } from "vitest";
import { ciede2000, colorAlpha, deltaE, parseColor, rgbToLab, type Rgb } from "../bar/color.ts";
import { fillRect, solidImage, type Image } from "../bar/png.ts";
import { loadRegions, loadTokens, type Rect } from "../bar/spec.ts";
import type { PageLike } from "../regions.ts";
import measureEntry, { measureCapture } from "../bar/measure-dom.ts";
import { encodePng } from "../bar/png.ts";
import { embeddedRegions } from "../regions.ts";
import { measureDom, measureImage, measurePanePixels, sampleMedian, scoreColor, tokenRefs } from "../visual-tokens.ts";

// Sharma, Wu, Dalal (2005), Table 1: the 34 CIEDE2000 test pairs.
const SHARMA: [number, number, number, number, number, number, number][] = [
  [50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425],
  [50, 3.1571, -77.2803, 50, 0, -82.7485, 2.8615],
  [50, 2.8361, -74.02, 50, 0, -82.7485, 3.4412],
  [50, -1.3802, -84.2814, 50, 0, -82.7485, 1.0],
  [50, -1.1848, -84.8006, 50, 0, -82.7485, 1.0],
  [50, -0.9009, -85.5211, 50, 0, -82.7485, 1.0],
  [50, 0, 0, 50, -1, 2, 2.3669],
  [50, -1, 2, 50, 0, 0, 2.3669],
  [50, 2.49, -0.001, 50, -2.49, 0.0009, 7.1792],
  [50, 2.49, -0.001, 50, -2.49, 0.001, 7.1792],
  [50, 2.49, -0.001, 50, -2.49, 0.0011, 7.2195],
  [50, 2.49, -0.001, 50, -2.49, 0.0012, 7.2195],
  [50, -0.001, 2.49, 50, 0.0009, -2.49, 4.8045],
  [50, -0.001, 2.49, 50, 0.001, -2.49, 4.8045],
  [50, -0.001, 2.49, 50, 0.0011, -2.49, 4.7461],
  [50, 2.5, 0, 50, 0, -2.5, 4.3065],
  [50, 2.5, 0, 73, 25, -18, 27.1492],
  [50, 2.5, 0, 61, -5, 29, 22.8977],
  [50, 2.5, 0, 56, -27, -3, 31.903],
  [50, 2.5, 0, 58, 24, 15, 19.4535],
  [50, 2.5, 0, 50, 3.1736, 0.5854, 1.0],
  [50, 2.5, 0, 50, 3.2972, 0, 1.0],
  [50, 2.5, 0, 50, 1.8634, 0.5757, 1.0],
  [50, 2.5, 0, 50, 3.2592, 0.335, 1.0],
  [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
  [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
  [61.2901, 3.7196, -5.3901, 61.4292, 2.248, -4.962, 1.8731],
  [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
  [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
  [36.4612, 47.858, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
  [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
  [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
  [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
  [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
];

describe("CIEDE2000", () => {
  it.each(SHARMA.map((r, i) => [i + 1, r] as const))("matches Sharma et al. pair %i", (_, r) => {
    const [L1, a1, b1, L2, a2, b2, want] = r;
    expect(ciede2000({ L: L1, a: a1, b: b1 }, { L: L2, a: a2, b: b2 })).toBeCloseTo(want, 4);
    expect(ciede2000({ L: L2, a: a2, b: b2 }, { L: L1, a: a1, b: b1 })).toBeCloseTo(want, 4);
  });

  it("is zero for identical colours", () => {
    expect(deltaE("#1b1e20", "#1b1e20")).toBe(0);
  });
});

describe("sRGB to CIELAB (D65)", () => {
  it("maps white, black, and primaries to reference values", () => {
    const w = rgbToLab([255, 255, 255]);
    expect(w.L).toBeCloseTo(100, 2);
    expect(w.a).toBeCloseTo(0, 2);
    expect(w.b).toBeCloseTo(0, 2);
    expect(rgbToLab([0, 0, 0]).L).toBeCloseTo(0, 6);
    const r = rgbToLab([255, 0, 0]);
    expect(r.L).toBeCloseTo(53.24, 1);
    expect(r.a).toBeCloseTo(80.09, 1);
    expect(r.b).toBeCloseTo(67.2, 1);
    const b = rgbToLab([0, 0, 255]);
    expect(b.L).toBeCloseTo(32.3, 1);
    expect(b.b).toBeCloseTo(-107.86, 1);
  });
});

describe("CSS colour parsing", () => {
  it("parses hex and rgb() forms", () => {
    expect(parseColor("#abc")).toEqual([170, 187, 204]);
    expect(parseColor("#1B1E20")).toEqual([27, 30, 32]);
    expect(parseColor("#1b1e20ff")).toEqual([27, 30, 32]);
    expect(parseColor("rgb(27, 30, 32)")).toEqual([27, 30, 32]);
    expect(parseColor("rgba(27, 30, 32, 0.5)")).toEqual([27, 30, 32]);
    expect(parseColor("rgb(27 30 32 / 50%)")).toEqual([27, 30, 32]);
    expect(() => parseColor("teal")).toThrow(/unparseable/);
  });

  it("reads alpha", () => {
    expect(colorAlpha("rgba(0, 0, 0, 0)")).toBe(0);
    expect(colorAlpha("transparent")).toBe(0);
    expect(colorAlpha("rgb(1, 2, 3)")).toBe(1);
    expect(colorAlpha("rgba(1, 2, 3, 0.25)")).toBe(0.25);
    expect(colorAlpha("#00000080")).toBeCloseTo(0.5, 2);
  });
});

const tokens = loadTokens();
const regions = loadRegions();

describe("scoreColor", () => {
  it("scores against the closest accepted reference of the token", () => {
    const r = scoreColor(tokens, "bg/canvas", "#181e21", "x", "background-color");
    expect(r.ref).toBe("#181e21");
    expect(r.deltaE).toBe(0);
    expect(r.pass).toBe(true);
  });

  it("fails beyond ΔE00 3 and on a missing element", () => {
    const off = scoreColor(tokens, "bg/canvas", "#3a3e44", "x", "background-color");
    expect(off.pass).toBe(false);
    expect(off.deltaE).toBeGreaterThan(3);
    expect(scoreColor(tokens, "bg/canvas", null, "x", "background-color").pass).toBe(false);
    expect(() => tokenRefs(tokens, "nope")).toThrow(/unknown colour token/);
  });

  it("separates tokens that must stay distinct (teal fill vs canvas)", () => {
    expect(scoreColor(tokens, "accent/teal-fill", "#1b1e20", "x", "background-color").pass).toBe(false);
    expect(scoreColor(tokens, "success", "#3fb950", "x", "color").pass).toBe(false); // green is never success
  });
});

describe("sampleMedian", () => {
  it("ignores sparse text pixels", () => {
    const img = solidImage(20, 20, [27, 30, 32]);
    fillRect(img, [2, 2, 3, 3], [230, 233, 234]);
    expect(sampleMedian(img, [0, 0, 20, 20])).toEqual([27, 30, 32]);
  });
});

function hex(h: string): Rgb {
  return parseColor(h);
}

/** A synthetic page-01 frame that follows the token and region tables; `shift` moves the rail/workspace divider right. */
function syntheticPage01(shift = 0): Image {
  const { width, height } = regions.viewport;
  const img = solidImage(width, height, hex(tokens.colors["bg/canvas"]!.value));
  for (const p of tokens.probes["01"] ?? []) {
    if (p.token !== "line") fillRect(img, p.rect, hex(tokens.colors[p.token]!.value));
  }
  const line = hex(tokens.colors["line"]!.accept[0]!);
  const page = regions.pages["01"];
  for (const [name, dims] of Object.entries(page.check)) {
    let [x, y, w, h] = page.rects[name]!;
    if (name === "left-rail") w += shift;
    if (name === "workspace") [x, w] = [x + shift, w - shift];
    if (dims.includes("w")) {
      if (x > 0) fillRect(img, [x, y, 1, h], line);
      if (x + w < width) fillRect(img, [x + w, y, 1, h], line);
    }
    if (dims.includes("h")) {
      if (y > 0) fillRect(img, [x, y, w, 1], line);
      if (y + h < height) fillRect(img, [x, y + h, w, 1], line);
    }
  }
  return img;
}

describe("image mode", () => {
  it("passes a frame that follows the tables", () => {
    const r = measureImage(syntheticPage01(), "01", tokens, regions);
    expect(r.colors.filter((c) => !c.pass)).toEqual([]);
    expect(r.proportions.filter((p) => !p.pass)).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.mode).toBe("image");
  });

  it("measures a divider moved within ±5%", () => {
    const r = measureImage(syntheticPage01(10), "01", tokens, regions);
    const rail = r.proportions.find((p) => p.region === "left-rail");
    expect(rail).toMatchObject({ measured: 271, pass: true });
    expect(rail?.error).toBeCloseTo(10 / 261, 3);
  });

  it("fails when a region is more than 5% off", () => {
    const r = measureImage(syntheticPage01(40), "01", tokens, regions);
    const rail = r.proportions.find((p) => p.region === "left-rail");
    // The divider moved outside the search window, so the edge is not found.
    expect(rail).toMatchObject({ measured: null, pass: false });
    expect(r.pass).toBe(false);
  });

  it("fails a colour outside ΔE 3", () => {
    const img = syntheticPage01();
    fillRect(img, [0, 0, 1536, 56], [60, 20, 90]);
    const r = measureImage(img, "01", tokens, regions);
    expect(r.colors.some((c) => c.token === "bg/canvas" && !c.pass)).toBe(true);
    expect(r.pass).toBe(false);
  });

  it("rejects a capture at the wrong size or DPR", () => {
    expect(() => measureImage(solidImage(3072, 2048, [0, 0, 0]), "01", tokens, regions)).toThrow(/1536x1024 DPR 1/);
  });
});

interface FakeEl {
  rect?: Rect;
  styles: Record<string, string>;
}

/** Runs browser-side probes against a fake DOM keyed by selector. */
function fakePage(dom: Record<string, FakeEl>): PageLike {
  return {
    async evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> {
      const g = globalThis as Record<string, unknown>;
      const mk = (sel: string) => {
        const e = dom[sel];
        if (!e) return null;
        return {
          parentElement: null,
          styles: e.styles,
          getBoundingClientRect: () => {
            const [x, y, width, height] = e.rect ?? [0, 0, 0, 0];
            return { x, y, width, height };
          },
        };
      };
      g["document"] = { querySelector: mk, querySelectorAll: (sel: string) => { const e = mk(sel); return e === null ? [] : [e]; } };
      g["getComputedStyle"] = (el: { styles: Record<string, string> }) => ({
        getPropertyValue: (p: string) => el.styles[p] ?? "",
        fontSize: el.styles["font-size"] ?? "",
        fontFamily: el.styles["font-family"] ?? "",
      });
      try {
        return await fn(arg);
      } finally {
        delete g["document"];
        delete g["getComputedStyle"];
      }
    },
  };
}

function css(h: string): string {
  const [r, g, b] = parseColor(h);
  return `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
}

/** A DOM that satisfies every page-01 binding, region, and typography role. */
function goodDom01(): Record<string, FakeEl> {
  const dom: Record<string, FakeEl> = {};
  const el = (sel: string): FakeEl => (dom[sel] ??= { styles: {} });
  for (const [name, rect] of Object.entries(regions.pages["01"].rects)) {
    el(regions.regions[name]!.selector).rect = rect;
  }
  for (const b of tokens.bindings) {
    if (b.pages !== "*" && !b.pages.includes("01")) continue;
    const sel = b.selector ?? regions.regions[b.region!]!.selector;
    el(sel).styles[b.property] = css(tokens.colors[b.token]!.value);
  }
  for (const r of Object.values(tokens.typography.roles)) {
    el(r.selector).styles["font-size"] = `${String(r.px[0])}px`;
    el(r.selector).styles["font-family"] = "Inter";
  }
  return dom;
}

describe("DOM mode", () => {
  it("passes a DOM that follows the tables", async () => {
    const r = await measureDom(fakePage(goodDom01()), "01", tokens, regions);
    expect(r.colors.filter((c) => !c.pass)).toEqual([]);
    expect(r.proportions.filter((p) => !p.pass)).toEqual([]);
    expect(r.typography.every((t) => t.pass)).toBe(true);
    expect(r.pass).toBe(true);
    expect(r.mode).toBe("dom");
  });

  it("fails on a missing region, a wrong colour, or a transparent background", async () => {
    const dom = goodDom01();
    delete dom['[data-rw-region="inspector"]'];
    dom['[data-testid="header.check-model"]']!.styles["background-color"] = "rgb(40, 160, 80)";
    dom['[data-rw-region="header"]']!.styles["background-color"] = "rgba(0, 0, 0, 0)";
    const r = await measureDom(fakePage(dom), "01", tokens, regions);
    expect(r.proportions.find((p) => p.region === "inspector")).toMatchObject({ measured: null, pass: false });
    expect(r.colors.find((c) => c.where.includes("check-model"))?.pass).toBe(false);
    expect(r.colors.find((c) => c.where === "region header" && c.property === "background-color")?.pass).toBe(false);
    expect(r.pass).toBe(false);
  });

  it("fails a column more than 5% narrower than the exemplar", async () => {
    const dom = goodDom01();
    dom['[data-rw-region="left-rail"]']!.rect = [0, 57, 240, 784];
    const r = await measureDom(fakePage(dom), "01", tokens, regions);
    const rail = r.proportions.find((p) => p.region === "left-rail");
    expect(rail?.pass).toBe(false);
    expect(rail?.error).toBeGreaterThan(0.05);
  });

  it("reports typography without gating on it", async () => {
    const dom = goodDom01();
    dom['[data-testid="agent.title"]']!.styles["font-size"] = "30px";
    const r = await measureDom(fakePage(dom), "01", tokens, regions);
    expect(r.typography.find((t) => t.role === "pane-title")?.pass).toBe(false);
    expect(r.pass).toBe(true);
  });
});

/** The embed rect on page 01 (the guest's 0,0) for the D31 tests. */
const EMBED_AT: Rect = [1154, 120, 382, 860];
const BUBBLE: Rect = [100, 20, 260, 60];

/** Main DOM for page 01 with the embed: the host's regions and bindings, the embed rect, and no old-chat elements. */
function embedMainDom01(): Record<string, FakeEl> {
  const dom = goodDom01();
  delete dom['[data-testid="agent.user-bubble"]'];
  delete dom['[data-testid="agent.reply"]'];
  delete dom['[data-rw-region="composer"]'];
  dom['[data-testid="agent.embed"]'] = { rect: EMBED_AT, styles: {} };
  return dom;
}

/** The guest's DOM (guest px): Lecturn's own hooks only. */
function guestDom01(): Record<string, FakeEl> {
  const comp = regions.pages["01"].embed!.rects["composer"]!;
  return {
    '[data-message-role="user"] [data-chat-user-message-bubble]': { rect: BUBBLE, styles: { "background-color": css("#253c3f") } },
    '[data-message-role="assistant"] [data-thread-find-text]': { rect: [10, 120, 340, 40], styles: { "font-size": "13px", "font-family": "Inter" } },
    '[data-slot="composer-shell"]': { rect: [comp[0] - EMBED_AT[0], comp[1] - EMBED_AT[1], comp[2], comp[3]], styles: {} },
  };
}

/** A composite capture that follows the pane tables: canvas background, the bubble and composer surfaces. */
function compositeImage(): Image {
  const img = solidImage(1536, 1024, [0x1b, 0x1e, 0x20]);
  fillRect(img, [EMBED_AT[0] + BUBBLE[0], EMBED_AT[1] + BUBBLE[1], BUBBLE[2], BUBBLE[3]], parseColor("#253c3f"));
  fillRect(img, regions.pages["01"].embed!.rects["composer"]!, parseColor("#25292c"));
  return img;
}

describe("DOM mode with the Lecturn embed (D31)", () => {
  const embed = () => ({ page: fakePage(guestDom01()), origin: { x: EMBED_AT[0], y: EMBED_AT[1] } });

  it("reads the embed bindings, roles and regions in the guest and locates the pane probes", async () => {
    const r = await measureDom(fakePage(embedMainDom01()), "01", tokens, regions, embed());
    const bubble = r.colors.find((c) => c.token === "bubble/user")!;
    expect(bubble.where).toBe('embed [data-message-role="user"] [data-chat-user-message-bubble]');
    expect(bubble.pass).toBe(true);
    expect(r.typography.find((t) => t.role === "body")).toMatchObject({ selector: 'embed [data-message-role="assistant"] [data-thread-find-text]', measuredPx: 13, pass: true });
    // The composer is Lecturn's composer shell, offset by the embed rect, against the mockup's box.
    expect(r.proportions.find((p) => p.region === "composer")).toMatchObject({ expected: 247, measured: 247, pass: true });
    // The host-rendered head keeps its RocketWright binding (D10).
    expect(r.colors.find((c) => c.where === '[data-testid="agent.title"]')?.pass).toBe(true);
    expect(r.panePixels?.map((p) => p.name)).toEqual(["pane-background", "user-bubble", "composer"]);
    expect(r.panePixels?.find((p) => p.name === "user-bubble")?.rect).toEqual([EMBED_AT[0] + BUBBLE[0] + 3, EMBED_AT[1] + BUBBLE[1] + 3, BUBBLE[2] - 6, BUBBLE[3] - 6]);
    expect(r.panePixels?.find((p) => p.name === "pane-background")?.rect).toEqual([EMBED_AT[0] + 2, EMBED_AT[1] + 16, 6, 200]);
    expect(r.pass).toBe(true);
  });

  it("samples the pane probes from the composite and gates on them", async () => {
    const r = await measureDom(fakePage(embedMainDom01()), "01", tokens, regions, embed());
    const ok = measurePanePixels(r, compositeImage(), tokens);
    expect(ok.panePixels).toBeUndefined();
    const pane = ok.colors.filter((c) => c.where.startsWith("pane "));
    expect(pane.map((c) => c.where.split(" ")[1])).toEqual(["pane-background", "user-bubble", "composer"]);
    expect(pane.every((c) => c.pass)).toBe(true);
    expect(ok.pass).toBe(true);
    // A pane background that is not the app canvas fails the row.
    const bad = compositeImage();
    fillRect(bad, EMBED_AT, [0x0b, 0x0b, 0x10]);
    const failed = measurePanePixels(r, bad, tokens);
    expect(failed.colors.find((c) => c.where.startsWith("pane pane-background"))?.pass).toBe(false);
    expect(failed.pass).toBe(false);
    expect(failed.failures).toBe(3);
  });

  it("fails a pane probe whose element the guest did not render", async () => {
    const guest = guestDom01();
    delete guest['[data-message-role="user"] [data-chat-user-message-bubble]'];
    const r = await measureDom(fakePage(embedMainDom01()), "01", tokens, regions, { page: fakePage(guest), origin: { x: EMBED_AT[0], y: EMBED_AT[1] } });
    expect(r.colors.find((c) => c.token === "bubble/user")?.pass).toBe(false);
    const sampled = measurePanePixels(r, compositeImage(), tokens);
    expect(sampled.colors.find((c) => c.where.startsWith("pane user-bubble"))).toMatchObject({ measured: null, pass: false });
  });

  it("without the embed, keeps the old chat's selectors and the exemplar rects", async () => {
    const r = await measureDom(fakePage(goodDom01()), "01", tokens, regions, null);
    expect(r.panePixels).toBeUndefined();
    expect(r.colors.find((c) => c.token === "bubble/user")?.where).toBe('[data-testid="agent.user-bubble"]');
    expect(r.proportions.find((p) => p.region === "composer")?.expected).toBe(45);
    expect(measurePanePixels(r, compositeImage(), tokens)).toBe(r);
  });

  it("merges the page's embed rects over its exemplar rects", () => {
    const spec = embeddedRegions(regions, "02");
    expect(spec.pages["02"].rects["composer"]).toEqual(regions.pages["02"].embed!.rects["composer"]);
    expect(spec.pages["02"].rects["header"]).toEqual(regions.pages["02"].rects["header"]);
    expect(regions.pages["02"].rects["composer"]).toEqual([1167, 853, 356, 45]);
  });

  it("measure-dom.ts finds the embed rect in the page and samples the composite PNG", async () => {
    const main = embedMainDom01();
    const page = fakePage(main);
    const wrapped: typeof page = {
      evaluate: async (fn, arg) => {
        (globalThis as Record<string, unknown>)["window"] = { __rwShell: { status: "ready", page: "01" } };
        try {
          return await page.evaluate(fn, arg);
        } finally {
          delete (globalThis as Record<string, unknown>)["window"];
        }
      },
    };
    const r = await measureEntry(wrapped, fakePage(guestDom01()));
    expect(r.panePixels?.length).toBe(3);
    const done = measureCapture(r, encodePng(compositeImage()));
    expect(done.panePixels).toBeUndefined();
    expect(done.colors.filter((c) => c.where.startsWith("pane ")).every((c) => c.pass)).toBe(true);
    // No embed rect in the page: the old chat's single pass.
    delete main['[data-testid="agent.embed"]'];
    const legacy = await measureEntry(wrapped, fakePage(guestDom01()));
    expect(legacy.panePixels).toBeUndefined();
  });
});
