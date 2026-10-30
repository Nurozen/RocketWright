import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COLOR_TOKENS, FONT_VARS, LAYOUT_VARS, cssVar, parseCustomProperties } from "./tokens.ts";

const here = import.meta.dirname;
const css = parseCustomProperties(readFileSync(resolve(here, "../tokens.css"), "utf8"));
const bar = JSON.parse(readFileSync(resolve(here, "../../../../tests/bar/tokens.json"), "utf8")) as {
  colors: Record<string, { value: string }>;
  spacing: { headerPx: number };
};

describe("tokens.css", () => {
  it("maps every bar colour token, and nothing else", () => {
    expect(Object.keys(COLOR_TOKENS).sort()).toEqual(Object.keys(bar.colors).sort());
  });

  it("carries the dark values from tests/bar/tokens.json", () => {
    for (const [token, prop] of Object.entries(COLOR_TOKENS)) {
      expect(css[prop]?.toLowerCase(), `${token} (${prop})`).toBe(bar.colors[token]!.value.toLowerCase());
    }
  });

  it("uses theme-agnostic names (no hue words)", () => {
    for (const name of Object.keys(css)) expect(name).not.toMatch(/teal|amber|orange|green|charcoal|dark/);
  });

  it("defines the shell layout variables, header at the spec height", () => {
    for (const v of LAYOUT_VARS) expect(css[v], v).toMatch(/^\d+px$/);
    expect(css["--rw-header-h"]).toBe(`${String(bar.spacing.headerPx)}px`);
  });

  it("defines the sans and mono font stacks, Inter first", () => {
    for (const v of Object.values(FONT_VARS)) expect(css[v], v).toMatch(/^"[^"]+",/);
    expect(css[FONT_VARS.sans]).toMatch(/^"Inter",/);
    expect(css[FONT_VARS.mono]).toMatch(/monospace$/);
  });

  it("builds var() references", () => {
    expect(cssVar("accent/teal")).toBe("var(--rw-accent)");
  });
});
