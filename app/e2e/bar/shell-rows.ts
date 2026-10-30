/**
 * Which token-report rows the app shell owns (M1.19). `make bar-visual`
 * gates on these by default (`ROWS=shell`); page-body rows (inspector, chat
 * bubble, tree selection, …) are reported as `later` until their steps land
 * and `ROWS=all` gates everything.
 *
 * D31 (the Lecturn embed as the agent pane): `agent-pane` stays the host's
 * region, `composer` is measured in the embed (Lecturn's composer shell) and
 * stays a shell row, `agent.title` stays the host-rendered pane head (D10);
 * the pane background probe (`pane pane-background`, sampled from the
 * composite) is a shell row, the other pane probes and the `embed …`
 * bindings are page-body rows.
 */
import type { ProportionResult } from "../regions.ts";
import type { ColorResult, TokenReport } from "../visual-tokens.ts";

export type RowScope = "shell" | "later";
export type RowsMode = "shell" | "all";

/** Regions the shell renders on every page (tests/bar/regions.json names). */
export const SHELL_REGIONS: ReadonlySet<string> = new Set([
  "header",
  "left-rail",
  "workspace",
  "agent-pane",
  "history-strip",
  "viewport-toolbar",
  "local-tabs",
  "composer",
]);

/** Shell-owned test ids among the colour bindings (header chrome, pane title, thread ages). */
const SHELL_TESTID = /^(header\..+|agent\.title|rail\.thread-age)$/;

/** Pane probes (D31) the shell owns: the embed's background must be the app canvas. */
export const SHELL_PANE_PROBES: ReadonlySet<string> = new Set(["pane-background"]);

function testidOf(selector: string): string | null {
  return /\[data-testid=\\?"([^"\\]+)\\?"\]/.exec(selector)?.[1] ?? null;
}

export function colorScope(c: ColorResult): RowScope {
  const region = /^region (.+)$/.exec(c.where)?.[1];
  if (region !== undefined) return SHELL_REGIONS.has(region) ? "shell" : "later";
  const probe = /^pane (\S+)/.exec(c.where)?.[1];
  if (probe !== undefined) return SHELL_PANE_PROBES.has(probe) ? "shell" : "later";
  if (c.where.startsWith("embed ")) return "later";
  const id = testidOf(c.where);
  return id !== null && SHELL_TESTID.test(id) ? "shell" : "later";
}

export function proportionScope(p: ProportionResult): RowScope {
  return SHELL_REGIONS.has(p.region) ? "shell" : "later";
}

export interface GatedReport {
  page: string;
  rows: RowsMode;
  /** Failing rows inside the gate. */
  failures: number;
  /** Failing rows outside the gate (reported, not gating). */
  pending: number;
  pass: boolean;
  lines: string[];
}

/** Applies the row gate to a DOM token report and formats it. */
export function gateReport(r: TokenReport, rows: RowsMode): GatedReport {
  let failures = 0;
  let pending = 0;
  const lines: string[] = [];
  const mark = (pass: boolean, scope: RowScope): string => {
    if (pass) return "ok   ";
    if (rows === "all" || scope === "shell") {
      failures++;
      return "FAIL ";
    }
    pending++;
    return "later";
  };
  for (const c of r.colors) {
    const scope = colorScope(c);
    lines.push(
      `  ${mark(c.pass, scope)} ${scope.padEnd(5)} colour ${c.token.padEnd(18)} ${String(c.measured).padEnd(8)} ref ${String(c.ref).padEnd(8)} dE ${String(c.deltaE).padStart(6)}  ${c.where} ${c.property}`,
    );
  }
  for (const p of r.proportions) {
    const scope = proportionScope(p);
    lines.push(
      `  ${mark(p.pass, scope)} ${scope.padEnd(5)} region ${p.region.padEnd(18)} ${p.dim} expected ${String(p.expected).padStart(5)} measured ${String(p.measured).padStart(6)} err ${String(p.error)}`,
    );
  }
  for (const t of r.typography) {
    lines.push(`  ${t.pass ? "ok   " : "info "} info  type ${t.role.padEnd(16)} ${String(t.measuredPx)}px in [${t.expectedPx.join(", ")}] ${String(t.family)}`);
  }
  const pass = failures === 0;
  const head = `page ${r.page} (${r.mode}, rows=${rows}): ${pass ? "PASS" : `FAIL (${String(failures)})`}${pending ? `, ${String(pending)} later-step rows pending` : ""}`;
  return { page: r.page, rows, failures, pending, pass, lines: [head, ...lines] };
}
