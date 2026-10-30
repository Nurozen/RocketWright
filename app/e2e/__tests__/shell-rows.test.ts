import { describe, expect, it } from "vitest";
import { colorScope, gateReport, proportionScope } from "../bar/shell-rows.ts";
import { parseArgs } from "../bar/visual.ts";
import type { ColorResult, TokenReport } from "../visual-tokens.ts";

const color = (where: string, pass: boolean): ColorResult => ({
  token: "bg/canvas",
  where,
  property: "background-color",
  measured: pass ? "#1b1e20" : "#ffffff",
  ref: "#1b1e20",
  deltaE: pass ? 0 : 50,
  pass,
});

const report = (colors: ColorResult[]): TokenReport => ({
  page: "01",
  mode: "dom",
  tolerance: { deltaE2000: 3, proportion: 0.05 },
  colors,
  proportions: [
    { region: "header", dim: "h", expected: 57, measured: 57, error: 0, pass: true },
    { region: "inspector", dim: "w", expected: 224, measured: null, error: null, pass: false },
  ],
  typography: [],
  failures: 0,
  pass: false,
});

describe("shell rows (M1.19)", () => {
  it("scopes shell regions and header/pane-title/thread-age selectors as shell", () => {
    expect(colorScope(color("region header", true))).toBe("shell");
    expect(colorScope(color("region inspector", true))).toBe("later");
    expect(colorScope(color('[data-testid="header.tab"][aria-selected="true"]', true))).toBe("shell");
    expect(colorScope(color('[data-testid="agent.title"]', true))).toBe("shell");
    expect(colorScope(color('[data-testid="rail.thread-age"]', true))).toBe("shell");
    expect(colorScope(color('[data-testid="agent.user-bubble"]', true))).toBe("later");
    expect(colorScope(color('[data-testid="runs.table-row"][data-series="a"]', true))).toBe("later");
    expect(proportionScope({ region: "composer", dim: "h", expected: 45, measured: 45, error: 0, pass: true })).toBe("shell");
  });

  it("scopes the D31 embed rows: the pane background probe is shell, other pane probes and embed bindings later", () => {
    expect(colorScope(color("pane pane-background (embed gutter) rect 1156,136,6,200", true))).toBe("shell");
    expect(colorScope(color("pane user-bubble (bubble) rect 1,2,3,4", true))).toBe("later");
    expect(colorScope(color("pane composer (composer surface)", true))).toBe("later");
    expect(colorScope(color('embed [data-message-role="user"] [data-chat-user-message-bubble]', true))).toBe("later");
    expect(colorScope(color('[data-testid="agent.title"]', true))).toBe("shell");
    expect(proportionScope({ region: "agent-pane", dim: "w", expected: 382, measured: 382, error: 0, pass: true })).toBe("shell");
    const g = gateReport(report([color("pane pane-background (gutter)", false)]), "shell");
    expect(g.pass).toBe(false);
  });

  it("gates only shell rows by default, everything with rows=all", () => {
    const r = report([color("region header", true), color('[data-testid="agent.user-bubble"]', false)]);
    const shell = gateReport(r, "shell");
    expect(shell).toMatchObject({ pass: true, failures: 0, pending: 2 });
    expect(shell.lines[0]).toMatch(/PASS, 2 later-step rows pending/);
    expect(gateReport(r, "all")).toMatchObject({ pass: false, failures: 2, pending: 0 });
  });

  it("fails a broken shell row", () => {
    const g = gateReport(report([color("region left-rail", false)]), "shell");
    expect(g.pass).toBe(false);
    expect(g.lines.some((l) => l.includes("FAIL  shell colour"))).toBe(true);
  });

  it("parses PAGES and ROWS", () => {
    expect(parseArgs(["--pages", "01,04", "--rows", "all"])).toMatchObject({
      pages: [
        { page: "01", variant: null },
        { page: "04", variant: null },
      ],
      rows: "all",
    });
    expect(parseArgs([])).toMatchObject({ pages: [{ page: "01", variant: null }], rows: "shell" });
    expect(parseArgs(["--pages", "05,06-engineering"]).pages).toEqual([
      { page: "05", variant: null },
      { page: "06", variant: "engineering" },
    ]);
    expect(() => parseArgs(["--pages", "07"])).toThrow(/unknown page/);
    expect(() => parseArgs(["--pages", "06_x"])).toThrow(/unknown page/);
    expect(() => parseArgs(["--rows", "some"])).toThrow(/shell or all/);
  });
});
