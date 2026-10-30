/**
 * `pnpm -C app bar:calibrate`: runs the token script in image mode on the six
 * exemplar PNGs. The exemplars must pass their own tables; a failure means
 * `tokens.json` or `regions.json` disagrees with the art, not that the art is wrong.
 *
 * Also checks the spec data for internal consistency (every probe and binding
 * names a defined token, every page rect a defined region) and that the 01
 * column proportions match the C §2 layout fractions.
 *
 * Writes `<out>/<page>.tokens.json` reports when `--out <dir>` is given.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatReport, measureImage, type TokenReport } from "../visual-tokens.ts";
import { PAGES, exemplarDir, round, stableStringify } from "./paths.ts";
import { decodePng } from "./png.ts";
import { loadRegions, loadTokens, type RegionsSpec, type TokensSpec } from "./spec.ts";

/** Internal consistency of tokens.json and regions.json. Returns error strings. */
export function lintSpecData(tokens: TokensSpec, regions: RegionsSpec): string[] {
  const errors: string[] = [];
  const hex = /^#[0-9a-f]{6}$/;
  for (const [name, t] of Object.entries(tokens.colors)) {
    for (const v of [t.value, ...t.accept]) if (!hex.test(v)) errors.push(`tokens.json: ${name} has non-#rrggbb value ${v}`);
  }
  for (const b of tokens.bindings) {
    if (!tokens.colors[b.token]) errors.push(`tokens.json: binding uses unknown token ${b.token}`);
    if (!b.selector && !(b.region && regions.regions[b.region])) {
      errors.push(`tokens.json: binding for ${b.token} needs a selector or a defined region (got ${String(b.region)})`);
    }
  }
  for (const [page, probes] of Object.entries(tokens.probes)) {
    for (const p of probes ?? []) {
      if (!tokens.colors[p.token]) errors.push(`tokens.json: probe on ${page} uses unknown token ${p.token}`);
    }
  }
  const names = new Set<string>();
  for (const p of tokens.paneProbes ?? []) {
    if (!tokens.colors[p.token]) errors.push(`tokens.json: pane probe ${p.name} uses unknown token ${p.token}`);
    if ((p.embed === undefined) === (p.rect === undefined)) errors.push(`tokens.json: pane probe ${p.name} needs exactly one of embed and rect`);
    if (names.has(p.name)) errors.push(`tokens.json: duplicate pane probe ${p.name}`);
    names.add(p.name);
  }
  for (const page of PAGES) {
    const pr = regions.pages[page];
    if (!pr) {
      errors.push(`regions.json: page ${page} missing`);
      continue;
    }
    for (const name of Object.keys(pr.rects)) {
      if (!regions.regions[name]) errors.push(`regions.json: page ${page} rect for undefined region ${name}`);
    }
    for (const name of Object.keys(pr.check)) {
      if (!pr.rects[name]) errors.push(`regions.json: page ${page} checks ${name} without a rect`);
    }
    for (const name of Object.keys(pr.embed?.rects ?? {})) {
      if (!regions.regions[name]) errors.push(`regions.json: page ${page} embed rect for undefined region ${name}`);
    }
    for (const name of Object.keys(pr.embed?.check ?? {})) {
      if (!pr.embed?.rects[name] && !pr.rects[name]) errors.push(`regions.json: page ${page} embed checks ${name} without a rect`);
    }
  }
  return errors;
}

/** Column fractions of page 01 against the C §2 layout (about 17% / 58% / 25%). */
export function layoutFractions(tokens: TokensSpec, regions: RegionsSpec, report: TokenReport): string[] {
  const errors: string[] = [];
  const width = regions.viewport.width;
  const pairs: [string, string][] = [
    ["left-rail", "leftRail"],
    ["workspace", "workspace"],
    ["agent-pane", "agentPane"],
  ];
  for (const [region, key] of pairs) {
    const m = report.proportions.find((p) => p.region === region && p.dim === "w")?.measured;
    const want = tokens.layout[key];
    if (m === null || m === undefined || want === undefined) {
      errors.push(`layout: ${region} not measured`);
      continue;
    }
    const err = Math.abs(m / width - want) / want;
    if (err > regions.tolerance.proportion) {
      errors.push(`layout: ${region} is ${String(round(m / width, 3))} of the width; C§2 says about ${String(want)}`);
    }
  }
  return errors;
}

export function calibrate(dir: string, out?: string): { reports: TokenReport[]; errors: string[] } {
  const tokens = loadTokens();
  const regions = loadRegions();
  const errors = lintSpecData(tokens, regions);
  const reports: TokenReport[] = [];
  for (const page of PAGES) {
    const file = join(dir, regions.pages[page].exemplar);
    if (!existsSync(file)) {
      errors.push(`exemplar missing: ${file}`);
      continue;
    }
    const report = measureImage(decodePng(readFileSync(file)), page, tokens, regions);
    reports.push(report);
    if (!report.pass) errors.push(`page ${page}: ${String(report.failures)} token/region failure(s) on the exemplar`);
    if (page === "01") errors.push(...layoutFractions(tokens, regions, report));
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `${page}.tokens.json`), stableStringify(report));
    }
  }
  return { reports, errors };
}

function main(argv: string[]): number {
  const i = argv.indexOf("--out");
  const out = i >= 0 ? argv[i + 1] : undefined;
  const dir = exemplarDir();
  const { reports, errors } = calibrate(dir, out);
  for (const r of reports) console.log(formatReport(r));
  if (errors.length > 0) {
    console.error(`\nbar:calibrate FAILED (${String(errors.length)}):`);
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }
  console.log(`\nbar:calibrate ok: ${String(reports.length)} exemplars from ${dir} pass their token and region tables`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
