/**
 * `pnpm -C app bar:lint-checklists`: validates `tests/bar/checklists/NN.json`.
 *
 * - Shape: `{id, kind, testid, milestone, source, text, level}` per item, ids
 *   unique and page-prefixed, enums valid, `region` items name a region from
 *   regions.json, and every region with an exemplar rect has a region item.
 * - Art numbers (`tests/bar/art-numbers.txt`) and concepts.md §6 art defects
 *   (`tests/bar/art-defects.json`) never appear in item text (D23, R17).
 * - When `FROZEN.sha256` exists (M1.15b, BC0), every checklist matches its frozen
 *   hash, and every commit after the freeze commit that touches
 *   `tests/bar/checklists/` cites a plan D-row (`D<n>`) in its message (D23).
 *   A post-freeze change is: edit, `pnpm bar:lint-checklists --freeze`, commit
 *   with a D-row id.
 *
 * Before linting the real checklists it plants a §6 defect item and an art-number
 * item into a copy and requires both to be rejected, so a lint that silently
 * passes everything cannot go green.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ART_DEFECTS_PATH,
  ART_NUMBERS_PATH,
  CHECKLIST_DIR,
  CRITIC_PROMPT_PATH,
  PAGES,
  REPO_ROOT,
  findArtifactsDir,
  readJson,
} from "./paths.ts";
import {
  ITEM_KINDS,
  LEVELS,
  MILESTONES,
  loadChecklists,
  loadRegions,
  loadTokens,
  type Checklist,
  type ChecklistItem,
  type RegionsSpec,
} from "./spec.ts";

export interface ArtDefect {
  id: string;
  page: string;
  defect: string;
  pattern: string;
}

export interface LintContext {
  regions: RegionsSpec;
  /** Compiled art-number matchers with their source line. */
  artNumbers: { label: string; re: RegExp }[];
  defects: { id: string; defect: string; re: RegExp }[];
  /** `<sha256>  <file>` lines from FROZEN.sha256, when frozen. */
  frozen?: Map<string, string>;
}

const ITEM_KEYS = ["id", "kind", "testid", "milestone", "source", "text", "level"].sort();
const ID_RE = /^(\d\d)\.[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const TESTID_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
/** A source must cite concepts.md (C§), the spec (S:), a plan D-row, a U-gap, or an invariant. */
const SOURCE_RE = /(C§|S:\d|\bD\d+\b|\bU\d+\b|\bI\d+\b)/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parses art-numbers.txt. Plain lines match as whole tokens (not inside longer numbers or words). */
export function parseArtNumbers(text: string): { label: string; re: RegExp }[] {
  const out: { label: string; re: RegExp }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("re:")) {
      out.push({ label: line, re: new RegExp(line.slice(3), "iu") });
    } else {
      out.push({ label: line, re: new RegExp(`(?<![\\p{L}\\p{N}.])${escapeRe(line)}(?![\\p{L}\\p{N}]|\\.\\d)`, "iu") });
    }
  }
  return out;
}

export function parseFrozen(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split("\n")) {
    const hit = /^([0-9a-f]{64}) [ *]?(.+)$/.exec(line.trim());
    if (hit) m.set(hit[2]!, hit[1]!);
  }
  return m;
}

export function loadLintContext(): LintContext {
  const defects = readJson<{ defects: ArtDefect[] }>(ART_DEFECTS_PATH).defects;
  const ctx: LintContext = {
    regions: loadRegions(),
    artNumbers: parseArtNumbers(readFileSync(ART_NUMBERS_PATH, "utf8")),
    defects: defects.map((d) => ({ id: d.id, defect: d.defect, re: new RegExp(d.pattern, "iu") })),
  };
  const frozen = join(CHECKLIST_DIR, "FROZEN.sha256");
  if (existsSync(frozen)) ctx.frozen = parseFrozen(readFileSync(frozen, "utf8"));
  return ctx;
}

/** Content checks for one item. Returns error strings prefixed with the item id. */
export function lintItem(item: ChecklistItem, page: string, ctx: LintContext): string[] {
  const errors: string[] = [];
  const where = `${page}:${typeof item.id === "string" ? item.id : "<no id>"}`;
  const keys = Object.keys(item).sort();
  if (keys.join(",") !== ITEM_KEYS.join(",")) errors.push(`${where}: keys must be exactly ${ITEM_KEYS.join(", ")} (got ${keys.join(", ")})`);
  const m = typeof item.id === "string" ? ID_RE.exec(item.id) : null;
  if (!m) errors.push(`${where}: id must look like '${page}.<area>.<name>'`);
  else if (m[1] !== page) errors.push(`${where}: id prefix must be the page ${page}`);
  if (!(ITEM_KINDS as readonly string[]).includes(item.kind)) errors.push(`${where}: kind '${String(item.kind)}' not in ${ITEM_KINDS.join("|")}`);
  if (!(MILESTONES as readonly string[]).includes(item.milestone)) errors.push(`${where}: milestone '${String(item.milestone)}' not in ${MILESTONES.join("|")}`);
  if (!(LEVELS as readonly string[]).includes(item.level)) errors.push(`${where}: level '${String(item.level)}' not in ${LEVELS.join("|")}`);
  if (typeof item.testid !== "string" || !TESTID_RE.test(item.testid)) errors.push(`${where}: testid '${String(item.testid)}' must be dotted kebab-case`);
  else if (item.kind === "region" && !ctx.regions.regions[item.testid]) errors.push(`${where}: region item testid '${item.testid}' is not a region in regions.json`);
  if (typeof item.source !== "string" || !SOURCE_RE.test(item.source)) errors.push(`${where}: source must cite C§, S:, a D-row, a U-gap, or an invariant`);
  const text = typeof item.text === "string" ? item.text : "";
  if (text.trim().length < 8) errors.push(`${where}: text is missing or too short`);
  for (const a of ctx.artNumbers) {
    if (a.re.test(text)) errors.push(`${where}: art number '${a.label}' in text (the art's values are illustrative)`);
  }
  for (const d of ctx.defects) {
    if (d.re.test(text)) errors.push(`${where}: copies concepts.md §6 art defect ${d.id} (${d.defect})`);
  }
  return errors;
}

/** Lints all checklists. `files` maps `NN.json` to its parsed content; `raw` maps it to its bytes (hash check). */
export function lintChecklists(files: Map<string, Checklist>, ctx: LintContext, raw?: Map<string, Buffer>): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();
  for (const page of PAGES) {
    if (!files.has(`${page}.json`)) errors.push(`checklists/${page}.json is missing`);
  }
  for (const [file, cl] of files) {
    const page = file.slice(0, 2);
    if (cl.page !== page) errors.push(`${file}: page field '${String(cl.page)}' does not match the file name`);
    for (const k of ["title", "exemplar", "captureState", "source"] as const) {
      if (typeof cl[k] !== "string" || cl[k].length === 0) errors.push(`${file}: '${k}' is required`);
    }
    if (!Array.isArray(cl.items) || cl.items.length === 0) {
      errors.push(`${file}: items must be a non-empty array`);
      continue;
    }
    for (const item of cl.items) {
      errors.push(...lintItem(item, page, ctx));
      if (typeof item.id === "string") {
        const prev = seen.get(item.id);
        if (prev) errors.push(`${page}:${item.id}: duplicate id (also in ${prev})`);
        seen.set(item.id, file);
      }
    }
    const pr = ctx.regions.pages[page as keyof RegionsSpec["pages"]];
    if (pr) {
      const regionItems = new Set(cl.items.filter((i) => i.kind === "region").map((i) => i.testid));
      for (const region of Object.keys(pr.rects)) {
        if (!regionItems.has(region)) errors.push(`${file}: region '${region}' has an exemplar rect but no region item`);
      }
    }
  }
  if (ctx.frozen && raw) {
    for (const [file, bytes] of raw) {
      const want = ctx.frozen.get(file);
      const got = createHash("sha256").update(bytes).digest("hex");
      if (!want) errors.push(`${file}: not listed in FROZEN.sha256`);
      else if (want !== got)
        errors.push(
          `${file}: changed after the BC0 freeze (sha256 ${got.slice(0, 12)} != ${want.slice(0, 12)}); re-freeze with 'pnpm bar:lint-checklists --freeze' and cite a D-row in the commit (D23)`,
        );
    }
    for (const file of ctx.frozen.keys()) {
      if (!raw.has(file)) errors.push(`FROZEN.sha256: lists ${file}, which is not a checklist`);
    }
  }
  return errors;
}

export const FROZEN_FILE = "FROZEN.sha256";
/** Repo-relative path of the checklists (git pathspec). */
export const CHECKLIST_PATHSPEC = "tests/bar/checklists";

/** `sha256sum`-format manifest of the checklists, sorted by file name. */
export function renderFrozen(raw: Map<string, Buffer>): string {
  return (
    [...raw.keys()]
      .sort()
      .map((f) => `${createHash("sha256").update(raw.get(f)!).digest("hex")}  ${f}`)
      .join("\n") + "\n"
  );
}

export interface CommitInfo {
  sha: string;
  message: string;
}

const D_ROW_RE = /\bD(\d+)\b/g;

/** D-row ids (`D23`) defined in the plan's deviations table, when the plan is reachable. */
export function planDRows(planText: string): Set<string> {
  const out = new Set<string>();
  for (const m of planText.matchAll(/^\| (D\d+) \|/gm)) out.add(m[1]!);
  return out;
}

/**
 * D-row ids a follow-on plan's "Deviations from spec" section defines or
 * names (`- **D8. …**` entries, and records such as "the D31 record" the
 * spec assigns to it). The Lecturn-embed plan writes its deviations as a
 * list, not a table; its D31 is the checklist re-lock.
 */
export function deviationSectionDRows(planText: string): Set<string> {
  const out = new Set<string>();
  const start = planText.search(/^## Deviations\b/m);
  if (start < 0) return out;
  const rest = planText.slice(start);
  const next = rest.slice(1).search(/^## /m);
  const section = next < 0 ? rest : rest.slice(0, next + 1);
  for (const m of section.matchAll(/\bD(\d+)\b/g)) out.add(`D${m[1]!}`);
  return out;
}

/** Follow-on plans whose deviation ids may also be cited (repo-relative to `artifacts/`). */
export const FOLLOW_ON_PLANS = ["features/rocketwright-lecturn/rocketwright-lecturn_plan.md"];

/**
 * Every commit after the freeze that touches the checklists must cite a D-row.
 * When `known` is given, at least one cited id must be a real plan D-row.
 */
export function checkPostFreezeCommits(commits: CommitInfo[], known?: Set<string>): string[] {
  const errors: string[] = [];
  for (const c of commits) {
    const cited = [...c.message.matchAll(D_ROW_RE)].map((m) => `D${m[1]!}`);
    const subject = c.message.split("\n")[0]!.trim();
    if (cited.length === 0) {
      errors.push(`commit ${c.sha.slice(0, 10)} ('${subject}') changes ${CHECKLIST_PATHSPEC}/ after the BC0 freeze without a D-row id (D23)`);
    } else if (known && known.size > 0 && !cited.some((d) => known.has(d))) {
      errors.push(`commit ${c.sha.slice(0, 10)} ('${subject}') cites ${cited.join(", ")}, none of which is a plan D-row (D23)`);
    }
  }
  return errors;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
}

/**
 * Reads the post-freeze commits that touch the checklists. The freeze commit is the
 * oldest commit that added FROZEN.sha256; it and its ancestors are exempt.
 * Returns `undefined` (with a reason) when git history is unavailable or the
 * freeze is not committed yet.
 */
export function postFreezeCommits(repo: string = REPO_ROOT): { commits?: CommitInfo[]; note?: string } {
  const frozenPath = `${CHECKLIST_PATHSPEC}/${FROZEN_FILE}`;
  let adds: string;
  try {
    adds = git(["log", "--diff-filter=A", "--format=%H", "--", frozenPath], repo).trim();
  } catch {
    return { note: "git history unavailable; post-freeze D-row check skipped" };
  }
  if (adds === "") return { note: `${frozenPath} not committed yet; post-freeze D-row check starts at the freeze commit` };
  const freeze = adds.split("\n").at(-1)!;
  const log = git(["log", "--format=%H%x00%B%x1e", `${freeze}..HEAD`, "--", CHECKLIST_PATHSPEC], repo);
  const commits = log
    .split("\x1e")
    .map((r) => r.trim())
    .filter((r) => r !== "")
    .map((r) => {
      const [sha, message] = r.split("\0");
      return { sha: sha!, message: (message ?? "").trim() };
    });
  return { commits };
}

/** The S:169 allowed-deviations line from the spec, when the workspace artifacts are reachable. */
export function specAllowedDeviations(): string | undefined {
  const artifacts = findArtifactsDir();
  if (!artifacts) return undefined;
  const spec = join(artifacts, "features/rocketwright/rocketwright_spec.md");
  if (!existsSync(spec)) return undefined;
  const line = readFileSync(spec, "utf8")
    .split("\n")
    .find((l) => l.startsWith("- Allowed deviations (not gaps):"));
  return line?.slice(2);
}

/**
 * critic-prompt.md must quote S:169 verbatim (checked against the spec when it is
 * reachable), list every C§2 forbidden element, and carry every C§6 defect page.
 */
export function lintCriticPrompt(prompt: string, forbidden: string[], quote: string | undefined, defectPages: string[]): string[] {
  const errors: string[] = [];
  if (!prompt.includes("Allowed deviations (not gaps):")) errors.push("critic-prompt.md: missing the S:169 allowed-deviations quote");
  if (quote !== undefined && !prompt.includes(quote)) errors.push("critic-prompt.md: the S:169 quote is not verbatim");
  for (const f of forbidden) {
    if (!prompt.includes(f)) errors.push(`critic-prompt.md: C§2 forbidden element '${f}' not listed`);
  }
  for (const page of defectPages) {
    if (page !== "*" && !new RegExp(`^- ${page}\\b`, "m").test(prompt)) errors.push(`critic-prompt.md: no C§6 defect line for page ${page}`);
  }
  return errors;
}

/** Planted items that must be rejected: a §6 defect without art numbers, and an art number without a defect. */
export const PLANTED: { item: ChecklistItem; expect: RegExp }[] = [
  {
    item: {
      id: "04.planted.parabola",
      kind: "render",
      testid: "plot.series",
      milestone: "M1",
      source: "C§4.4 Plot",
      text: "Altitude curve is a smooth symmetric parabola from liftoff to landing.",
      level: "required",
    },
    expect: /§6 art defect 04-parabola/,
  },
  {
    item: {
      id: "01.planted.fins",
      kind: "field",
      testid: "rail.nav-row",
      milestone: "M1",
      source: "C§4.1 Regions",
      text: "Tree row 'Fins (3)' under the fin can.",
      level: "required",
    },
    expect: /art number 'Fins \(3\)'/,
  },
  {
    item: {
      id: "04.planted.apogee",
      kind: "field",
      testid: "runs.table-row",
      milestone: "M1",
      source: "C§4.4 Workspace",
      text: "Baseline row shows an apogee of 850 m.",
      level: "required",
    },
    expect: /art number '850 m'/,
  },
];

/** Runs the lint on a copy of the checklists with each planted item added; every plant must be caught. */
export function selfTest(files: Map<string, Checklist>, ctx: LintContext): string[] {
  const failures: string[] = [];
  for (const { item, expect } of PLANTED) {
    const page = item.id.slice(0, 2);
    const copy = new Map(files);
    const base = copy.get(`${page}.json`);
    if (!base) {
      failures.push(`self-test: no ${page}.json to plant ${item.id} into`);
      continue;
    }
    copy.set(`${page}.json`, { ...base, items: [...base.items, item] });
    const errs = lintChecklists(copy, ctx).filter((e) => e.includes(item.id));
    if (!errs.some((e) => expect.test(e))) failures.push(`self-test: planted item ${item.id} was not rejected (${expect.source})`);
  }
  return failures;
}

function main(argv: string[]): number {
  const ctx = loadLintContext();
  const files = loadChecklists();
  const raw = new Map([...files.keys()].map((f) => [f, readFileSync(join(CHECKLIST_DIR, f))]));
  if (argv.includes("--freeze")) {
    writeFileSync(join(CHECKLIST_DIR, FROZEN_FILE), renderFrozen(raw));
    ctx.frozen = parseFrozen(renderFrozen(raw));
    console.log(`wrote ${CHECKLIST_PATHSPEC}/${FROZEN_FILE} (${String(raw.size)} checklists); commit it with a D-row id unless this is the BC0 freeze`);
  }
  const st = selfTest(files, ctx);
  if (st.length > 0) {
    for (const e of st) console.error(e);
    return 1;
  }
  console.log(`self-test ok: ${String(PLANTED.length)} planted §6/art-number items rejected`);
  const defectPages = [...new Set(readJson<{ defects: ArtDefect[] }>(ART_DEFECTS_PATH).defects.map((d) => d.page))];
  const errors = [
    ...lintChecklists(files, ctx, raw),
    ...lintCriticPrompt(readFileSync(CRITIC_PROMPT_PATH, "utf8"), loadTokens().forbidden, specAllowedDeviations(), defectPages),
  ];
  if (ctx.frozen) {
    const { commits, note } = postFreezeCommits();
    if (note) console.log(`note: ${note}`);
    if (commits) {
      const artifacts = findArtifactsDir();
      const plan = artifacts ? join(artifacts, "features/rocketwright/rocketwright_plan.md") : undefined;
      const known = plan && existsSync(plan) ? planDRows(readFileSync(plan, "utf8")) : undefined;
      if (artifacts && known) {
        for (const rel of FOLLOW_ON_PLANS) {
          const follow = join(artifacts, rel);
          if (existsSync(follow)) for (const d of deviationSectionDRows(readFileSync(follow, "utf8"))) known.add(d);
        }
      }
      errors.push(...checkPostFreezeCommits(commits, known));
    }
  }
  if (errors.length > 0) {
    console.error(`bar:lint-checklists FAILED (${String(errors.length)}):`);
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }
  const n = [...files.values()].reduce((s, c) => s + c.items.length, 0);
  console.log(
    `bar:lint-checklists ok: ${String(files.size)} checklists, ${String(n)} items${ctx.frozen ? ", frozen hashes match, post-freeze commits cite D-rows" : " (not frozen yet: M1.15b)"}`,
  );
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
