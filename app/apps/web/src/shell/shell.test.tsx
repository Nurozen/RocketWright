/**
 * M1.19 shell render test: static markup (react-dom/server, no browser) must
 * carry every region and test id the bar measures, the header content, and a
 * token-only stylesheet whose layout sizes match tests/bar/regions.json.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildIconModule, ICON_MODULE, readIconFiles } from "../../scripts/gen-icons.ts";
import { parseCustomProperties } from "../../../../packages/ui/src/tokens.ts";
import { Icon, ICON_NAMES } from "./Icon.tsx";
import { Header } from "./Header.tsx";
import { BAR_PAGES, PLACEHOLDER_HEAD, PLACEHOLDER_SHELL, TOP_TABS, type BarPage, type CheckStatus } from "./model.ts";
import { ShellApp } from "./ShellApp.tsx";

const here = import.meta.dirname;
const repo = resolve(here, "../../../../..");
const regions = JSON.parse(readFileSync(resolve(repo, "tests/bar/regions.json"), "utf8")) as {
  viewport: { width: number; height: number };
  tolerance: { proportion: number };
  regions: Record<string, { selector: string }>;
  pages: Record<string, { rects: Record<string, [number, number, number, number]> }>;
};
const tokens = JSON.parse(readFileSync(resolve(repo, "tests/bar/tokens.json"), "utf8")) as {
  bindings: { token: string; region?: string; selector?: string; pages: string | string[] }[];
};

type Tag = { name: string; attrs: Record<string, string>; text: string };

/** Opening tags with their attributes and the text right after them (enough for static markup). */
function tags(html: string): Tag[] {
  const out: Tag[] = [];
  for (const m of html.matchAll(/<([a-z0-9]+)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>([^<]*)/g)) {
    const attrs: Record<string, string> = {};
    for (const a of m[2]!.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs[a[1]!] = a[2] ?? "";
    out.push({ name: m[1]!, attrs, text: m[3]! });
  }
  return out;
}

/** Tags matching a `[a="b"][c="d"]` selector (attribute selectors only). */
function select(all: Tag[], selector: string): Tag[] {
  const conds = [...selector.matchAll(/\[([\w-]+)=\\?"([^"\\]*)\\?"\]/g)].map((m) => [m[1]!, m[2]!] as const);
  expect(conds.length, `unsupported selector ${selector}`).toBeGreaterThan(0);
  return all.filter((t) => conds.every(([k, v]) => t.attrs[k] === v));
}

const render = (page: BarPage) => tags(renderToStaticMarkup(<ShellApp model={PLACEHOLDER_SHELL} page={page} />));

/**
 * Regions the shell owns at M1.19 (page bodies such as the inspector come
 * later). The composer is Lecturn's since B17 (measured in the embed, its
 * `embed` selector in regions.json); the static shell draws one in its
 * placeholder picture.
 */
const SHELL_REGIONS = ["header", "left-rail", "workspace", "agent-pane", "history-strip", "local-tabs", "viewport-toolbar", "viewport"];

describe("AppShell (page 01)", () => {
  const all = render("01");

  it("renders every shell region once with the regions.json selector", () => {
    for (const name of SHELL_REGIONS) {
      expect(regions.regions[name]?.selector).toBe(`[data-rw-region="${name}"]`);
      expect(select(all, regions.regions[name]!.selector), name).toHaveLength(1);
    }
  });

  it("shows the wordmark, the four tabs with Design active, and Check model", () => {
    expect(select(all, '[data-testid="header.wordmark"]')[0]?.text).toBe("RocketWright");
    const tabs = select(all, '[data-testid="header.tab"]');
    expect(tabs.map((t) => t.text)).toEqual(["Design", "Propulsion", "Simulate", "Results"]);
    expect(tabs.filter((t) => t.attrs["aria-selected"] === "true").map((t) => t.text)).toEqual(["Design"]);
    const check = select(all, '[data-testid="header.check-model"]');
    expect(check).toHaveLength(1);
    expect(renderToStaticMarkup(<ShellApp model={PLACEHOLDER_SHELL} />)).toMatch(/Check model/);
    for (const id of ["header.project-switcher", "header.save-state", "header.settings", "header.help"]) {
      expect(select(all, `[data-testid="${id}"]`), id).toHaveLength(1);
    }
    expect(select(all, '[data-testid="workspace.local-tab"]').map((t) => t.text)).toEqual(["Assembly", "Components", "Configurations"]);
  });

  it("carries every element a page-01 colour binding needs, except later page bodies", () => {
    const later = new Set(["inspector", '[data-testid="agent.user-bubble"]']);
    for (const b of tokens.bindings) {
      const pages = b.pages === "*" ? ["01"] : b.pages;
      if (!pages.includes("01")) continue;
      const selector = b.selector ?? regions.regions[b.region!]!.selector;
      if (later.has(b.region ?? b.selector ?? "")) continue;
      expect(select(all, selector).length, `${b.token} on ${selector}`).toBeGreaterThan(0);
    }
  });

  it("references the brand mark from public/brand", () => {
    const mark = all.find((t) => t.name === "img" && t.attrs.src?.endsWith("brand/rocketwright-mark.svg"));
    expect(mark).toBeDefined();
  });
});

describe("BC0 polish (concept 01)", () => {
  const all = render("01");

  it("puts a true provenance footer bottom-right of the agent pane", () => {
    const foot = select(all, '[data-testid="agent.provenance-footer"]');
    expect(foot.map((t) => t.text)).toEqual(["Offline preview · canned exchange"]);
    expect(foot[0]!.text).not.toMatch(/illustrative|concept/i);
  });

  it("draws the history as sequential numbered steps joined by hairlines, the head current", () => {
    const steps = select(all, '[data-testid="history.step"]');
    expect(steps.length).toBeGreaterThan(1);
    expect(steps.map((t) => t.attrs["data-ref"])).toEqual(PLACEHOLDER_SHELL.history.map((h) => h.ref));
    expect(steps.filter((t) => t.attrs["aria-current"] === "step").map((t) => t.attrs["data-ref"])).toEqual([PLACEHOLDER_HEAD.ref]);
    const css = readFileSync(resolve(here, "shell.css"), "utf8");
    // One connector between each pair of steps, a flex item of its own with an equal share of the width.
    expect(select(all, '[data-testid="history.link"]')).toHaveLength(steps.length - 1);
    expect(css).toMatch(/\.rw-step__link \{[^}]*flex: 1 1 0;[^}]*height: var\(--rw-hairline\);[^}]*margin: 0 12px;/);
    // Step text never truncates: it wraps within the step's width instead of running into Compare.
    expect(css).toMatch(/\.rw-step__name,\s*\.rw-step__date \{[^}]*overflow-wrap: anywhere;/);
    expect(css).not.toMatch(/\.rw-step__(name|date)[^{]*\{[^}]*text-overflow: ellipsis;/);
  });

  it("Check model: check-in-circle icon, live status text, and the issue count", () => {
    const html = (status: CheckStatus, issues = 0, label?: string) =>
      renderToStaticMarkup(<Header projectName="p" saveState="s" activeTab="design" check={{ status, issues, ...(label ? { label } : {}) }} />);
    for (const st of ["unknown", "ok", "issues", "errors", "outdated"] as const) expect(html(st, 2), st).toContain('data-icon="check-disc"');
    expect(html("running")).toContain('data-icon="spinner"');
    expect(html("ok")).not.toContain("header.check-count");
    expect(html("ok")).toMatch(/data-testid="header.check-status">Model check passed</);
    expect(html("issues", 3, "3 warnings")).toMatch(/data-testid="header.check-count">3</);
    expect(html("issues", 3, "3 warnings")).toMatch(/data-testid="header.check-status">3 warnings</);
    expect(html("errors", 1, "1 error")).toMatch(/data-tone="danger" data-testid="header.check-count">1</);
    expect(html("outdated")).toContain('data-testid="header.check-outdated"');
    expect(html("unknown")).toMatch(/data-testid="header.check-status">Model not checked yet</);
  });
});

describe("AppShell (other pages)", () => {
  it.each(Object.entries(BAR_PAGES))("page %s selects its header tab", (page, { tab }) => {
    const all = render(page as BarPage);
    const label = TOP_TABS.find((t) => t.id === tab)!.label;
    expect(select(all, '[data-testid="header.tab"][aria-selected="true"]').map((t) => t.text)).toEqual([label]);
    expect(select(all, '[data-rw-region="local-tabs"]')).toHaveLength(tab === "design" ? 1 : 0);
  });

  it("drops the viewport toolbar on Results", () => {
    expect(select(render("04"), '[data-rw-region="viewport-toolbar"]')).toHaveLength(0);
  });
});

describe("shell.css", () => {
  const css = readFileSync(resolve(here, "shell.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const vars = parseCustomProperties(readFileSync(resolve(here, "../../../../packages/ui/tokens.css"), "utf8"));
  const px = (name: string) => Number(/^(\d+)px$/.exec(vars[name] ?? "")?.[1]);

  it("uses tokens only (no literal colours)", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });

  it("sizes the shell regions within the bar tolerance of the page-01 exemplar", () => {
    const rects = regions.pages["01"]!.rects;
    const tol = regions.tolerance.proportion;
    const hair = px("--rw-hairline");
    const rail = px("--rw-rail-w") + hair;
    const agent = px("--rw-agent-w") + hair;
    const sizes: [string, number, number][] = [
      ["header", px("--rw-header-h") + hair, rects.header![3]],
      ["left-rail", rail, rects["left-rail"]![2]],
      ["agent-pane", agent, rects["agent-pane"]![2]],
      ["workspace", regions.viewport.width - rail - agent, rects.workspace![2]],
      ["viewport-toolbar", px("--rw-toolbar-h") + hair, rects["viewport-toolbar"]![3]],
      ["history-strip", px("--rw-history-h") + hair, rects["history-strip"]![3]],
      ["local-tabs", px("--rw-local-tabs-h") + hair, rects["local-tabs"]![3]],
    ];
    for (const [name, ours, theirs] of sizes) {
      expect(Math.abs(ours - theirs) / theirs, `${name}: ${String(ours)} vs ${String(theirs)}`).toBeLessThanOrEqual(tol);
    }
  });

  it("drops the composer's history-height band with the embed, so the rect runs to the pane bottom on every page (CPW1R3B)", () => {
    // Without an embed (the static shell) the pane keeps the band level with the history strip; the embed runs to the bottom.
    expect(css).toMatch(/\.rw-agent \{[^}]*padding-bottom: calc\(var\(--rw-history-h\) \+ var\(--rw-hairline\)\);/);
    expect(css).toMatch(/\.rw-agent\[data-embedded="true"\] \{\s*padding-bottom: 0;\s*\}/);
    expect(css).toMatch(/\.rw-embed \{[^}]*flex: 1;/);
  });
});

describe("Icon", () => {
  it("types every brand icon in public/brand/icons, generated module in sync", () => {
    const files = readIconFiles();
    expect(readFileSync(ICON_MODULE, "utf8")).toBe(buildIconModule(files));
    for (const { name } of files) expect(ICON_NAMES).toContain(name);
    expect(readdirSync(resolve(here, "../../public/brand")).sort()).toEqual(["icons", "rocketwright-mark.svg", "rocketwright-wordmark.svg"].concat(["PROVENANCE.md"]).sort());
  });

  it("renders inline currentColor SVG, decorative unless labelled", () => {
    const decorative = renderToStaticMarkup(<Icon name="fin-set" />);
    expect(decorative).toMatch(/^<svg[^>]*stroke="currentColor"[^>]*aria-hidden="true"/);
    expect(decorative).toContain('<path d="M8 3h4v14H8ZM8 7l-5 6v4h5M12 7l5 6v4h-5M10 11v6"/>');
    const labelled = renderToStaticMarkup(<Icon name="settings" label="Settings" size={24} />);
    expect(labelled).toMatch(/role="img"/);
    expect(labelled).toMatch(/aria-label="Settings"/);
    expect(labelled).toMatch(/width="24"/);
  });
});
