/**
 * Bar scoreboard aggregator (M1.18): `make bar`.
 *
 * Reads whatever bar outputs exist under the bar output root
 * (`artifacts/reviews/rocketwright_bar/`, else `target/bar/`) and writes one
 * row per bar item to `scoreboard.{md,json}` there. Every row is `pass`,
 * `red`, or `not-run`; a missing input is `not-run`, an unreadable one `red`.
 *
 * | Bar | Rows | Input (relative to the root unless noted) |
 * |---|---|---|
 * | B1 | pages 01-06 | `visual/<p>.tokens.json` (else `dist/bar-visual/<p>/tokens.json` in the repo), `visual/<p>.critics/c{1,2,3}.{json,md}` |
 * | B2 | cases 1-7, generic matrix (the gate, D25) | `parity/scoreboard.json` (`make bar-parity`) |
 * | B3 | tasks T1-T5 | `agent-loop/T<n>/score.json` (`{pass, tool_calls?, reasons?}`, RL4) |
 * | B4 | (a) stand-in e2e, (b) live smoke | `e2e/report.json` (Playwright JSON, `make e2e`), `live/b4b/result.json` (`make bar-live`) |
 *
 * B1 passes only when the token report passes, every checklist item is
 * `present` for at least 2 of 3 critics, and typography gets at least 2 of 3
 * `agree` (S:170). The largest remaining gap is the bar with the most
 * non-passing rows. Report mode only: exits 0, or 2 on bad arguments.
 * `--self-test` checks an empty root (all not-run) and planted inputs.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { B4A_SPEC_FILE, B4A_TITLE } from "../../app/e2e/b4a.ts";
import { barOutDir, CHECKLIST_DIR, PAGES, REPO_ROOT, stableStringify, type PageId } from "../../app/e2e/bar/paths.ts";
import type { TokenReport } from "../../app/e2e/visual-tokens.ts";
import type { Scoreboard as ParityScoreboard } from "./parity.ts";
import { B4B_PROMPT, type B4bResult } from "./live-smoke.ts";

export type RowStatus = "pass" | "red" | "not-run";
export type Bar = "B1" | "B2" | "B3" | "B4";
export const BARS: readonly Bar[] = ["B1", "B2", "B3", "B4"];

export interface BarRow {
  bar: Bar;
  id: string;
  title: string;
  status: RowStatus;
  detail: string;
  /** Input file read, relative to the root (or repo for `dist/`), or null. */
  source: string | null;
}

export interface BarScoreboard {
  schema: "rw/1";
  rows: BarRow[];
  totals: Record<RowStatus, number>;
  /** The bar with the most non-passing rows (ties: bar order); null when all pass. */
  largest_gap: { bar: Bar; remaining: number; of: number } | null;
}

export interface Inputs {
  /** The bar output root to read. */
  root: string;
  /** Repo root for `dist/bar-visual/` fallbacks and checklists. */
  repo?: string;
  checklistDir?: string;
}

// ---- input helpers ----------------------------------------------------------------

type Read<T> = { ok: true; value: T; source: string } | { ok: false; error: string; source: string } | undefined;

/** Reads JSON (a fenced ```json block is accepted, for critic .md files); undefined when absent. */
function readInput<T>(root: string, rel: string): Read<T> {
  const path = join(root, rel);
  if (!existsSync(path)) return undefined;
  try {
    let text = readFileSync(path, "utf8");
    const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text);
    if (fenced && !text.trimStart().startsWith("{")) text = fenced[1]!;
    return { ok: true, value: JSON.parse(text) as T, source: rel };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), source: rel };
  }
}

function unreadable(bar: Bar, id: string, title: string, r: { error: string; source: string }): BarRow {
  return { bar, id, title, status: "red", detail: `unreadable ${r.source}: ${r.error}`, source: r.source };
}

// ---- B1 -----------------------------------------------------------------------------

interface CriticReply {
  items?: { id: string; verdict: string }[];
  typography?: { verdict: string };
}

export function b1Row(page: PageId, inp: Inputs): BarRow {
  const id = `B1.${page}`;
  const title = `page ${page} visual bar`;
  const repo = inp.repo ?? REPO_ROOT;
  const tokens = readInput<TokenReport>(inp.root, `visual/${page}.tokens.json`) ?? readInput<TokenReport>(repo, `dist/bar-visual/${page}/tokens.json`);
  if (!tokens) return { bar: "B1", id, title, status: "not-run", detail: "no token report", source: null };
  if (!tokens.ok) return unreadable("B1", id, title, tokens);
  const reasons: string[] = [];
  if (!tokens.value.pass) reasons.push(`tokens ${tokens.value.failures} failing`);

  const critics: CriticReply[] = [];
  for (const n of [1, 2, 3]) {
    const c = readInput<CriticReply>(inp.root, `visual/${page}.critics/c${n}.json`) ?? readInput<CriticReply>(inp.root, `visual/${page}.critics/c${n}.md`);
    if (c?.ok) critics.push(c.value);
    else if (c) reasons.push(`critic c${n} unreadable`);
  }
  if (critics.length < 3) {
    reasons.push(`${critics.length}/3 critics`);
  } else {
    const checklist = readInput<{ items: { id: string }[] }>(inp.checklistDir ?? CHECKLIST_DIR, `${page}.json`);
    const ids = checklist?.ok ? checklist.value.items.map((i) => i.id) : [];
    if (!checklist?.ok) reasons.push("checklist unreadable");
    const absent = ids.filter((item) => critics.filter((c) => c.items?.some((i) => i.id === item && i.verdict === "present")).length < 2);
    if (absent.length > 0) reasons.push(`${absent.length}/${ids.length} items below 2/3 present`);
    if (critics.filter((c) => c.typography?.verdict === "agree").length < 2) reasons.push("typography below 2/3 agree");
  }
  return {
    bar: "B1",
    id,
    title,
    status: reasons.length === 0 ? "pass" : "red",
    detail: reasons.length === 0 ? "tokens pass; critics 2/3 on every item and typography" : reasons.join("; "),
    source: tokens.source,
  };
}

// ---- B2 -----------------------------------------------------------------------------

export function b2Rows(inp: Inputs, cases: readonly number[] = [1, 2, 3, 4, 5, 6, 7]): BarRow[] {
  const sb = readInput<ParityScoreboard>(inp.root, "parity/scoreboard.json");
  return cases.map((c): BarRow => {
    const id = `B2.case${c}`;
    const title = `parity case ${c} (generic matrix)`;
    if (!sb) return { bar: "B2", id, title, status: "not-run", detail: "no parity scoreboard", source: null };
    if (!sb.ok) return unreadable("B2", id, title, sb);
    const gated = (sb.value.rows ?? []).filter((r) => r.matrix === sb.value.gate_matrix && r.case === c && r.tol !== null);
    const count = (s: string) => gated.filter((r) => r.status === s).length;
    if (gated.length === 0 || count("not-run") === gated.length) {
      const reason = gated[0]?.reason;
      return { bar: "B2", id, title, status: "not-run", detail: gated.length === 0 ? "case not in scoreboard" : `not-run (${reason ?? ""})`, source: sb.source };
    }
    const pass = count("pass");
    const others = ["fail", "mismatch", "missing", "not-run"]
      .map((s) => [s, count(s)] as const)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${s}`);
    return {
      bar: "B2",
      id,
      title,
      status: pass === gated.length ? "pass" : "red",
      detail: `${pass}/${gated.length} toleranced keys pass` + (others.length ? `; ${others.join(", ")}` : ""),
      source: sb.source,
    };
  });
}

// ---- B3 -----------------------------------------------------------------------------

interface TaskScore {
  pass: boolean;
  tool_calls?: number;
  reasons?: string[];
}

export function b3Rows(inp: Inputs): BarRow[] {
  return [1, 2, 3, 4, 5].map((n): BarRow => {
    const id = `B3.T${n}`;
    const title = `agent loop T${n}`;
    const s = readInput<TaskScore>(inp.root, `agent-loop/T${n}/score.json`);
    if (!s) return { bar: "B3", id, title, status: "not-run", detail: "no score.json", source: null };
    if (!s.ok) return unreadable("B3", id, title, s);
    const calls = s.value.tool_calls === undefined ? "" : `${s.value.tool_calls} tool calls`;
    const detail = [calls, ...(s.value.reasons ?? [])].filter(Boolean).join("; ");
    return { bar: "B3", id, title, status: s.value.pass === true ? "pass" : "red", detail: detail || (s.value.pass ? "pass" : "fail"), source: s.source };
  });
}

// ---- B4 -----------------------------------------------------------------------------

interface PwTest {
  status?: string;
  annotations?: { type: string }[];
}
interface PwSpec {
  title: string;
  file?: string;
  tests?: PwTest[];
}
interface PwSuite {
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

function findSpec(suites: PwSuite[] | undefined, file: string, title: string): PwSpec | undefined {
  for (const s of suites ?? []) {
    const hit = (s.specs ?? []).find((sp) => sp.title === title && (sp.file ?? s.file ?? "").endsWith(file));
    if (hit) return hit;
    const deeper = findSpec(s.suites, file, title);
    if (deeper) return deeper;
  }
  return undefined;
}

export function b4aRow(inp: Inputs): BarRow {
  const id = "B4.a";
  const title = "B4(a) stand-in chat drives a simulation (e2e)";
  const rep = readInput<{ suites?: PwSuite[] }>(inp.root, "e2e/report.json");
  if (!rep) return { bar: "B4", id, title, status: "not-run", detail: "no e2e report (make e2e)", source: null };
  if (!rep.ok) return unreadable("B4", id, title, rep);
  const spec = findSpec(rep.value.suites, B4A_SPEC_FILE, B4A_TITLE);
  if (!spec) return { bar: "B4", id, title, status: "not-run", detail: `${B4A_SPEC_FILE} not in report`, source: rep.source };
  const statuses = (spec.tests ?? []).map((t) => t.status ?? "");
  if (statuses.length > 0 && statuses.every((s) => s === "expected")) {
    return { bar: "B4", id, title, status: "pass", detail: "passed", source: rep.source };
  }
  if (statuses.every((s) => s === "skipped")) {
    const fixme = (spec.tests ?? []).some((t) => t.annotations?.some((a) => a.type === "fixme"));
    return { bar: "B4", id, title, status: "not-run", detail: fixme ? "test.fixme" : "skipped", source: rep.source };
  }
  return { bar: "B4", id, title, status: "red", detail: `test ${statuses.join(", ")}`, source: rep.source };
}

export function b4bRow(inp: Inputs): BarRow {
  const id = "B4.b";
  const title = "B4(b) live smoke (non-gating until Q2)";
  const r = readInput<B4bResult>(inp.root, "live/b4b/result.json");
  if (!r) return { bar: "B4", id, title, status: "not-run", detail: "no live result (RW_LIVE=1 make bar-live)", source: null };
  if (!r.ok) return unreadable("B4", id, title, r);
  const status: RowStatus = r.value.status === "pass" ? "pass" : r.value.status === "not-run" ? "not-run" : "red";
  if (r.value.prompt !== undefined && r.value.prompt !== B4B_PROMPT) {
    return { bar: "B4", id, title, status: "red", detail: "result is for a different prompt", source: r.source };
  }
  return { bar: "B4", id, title, status, detail: (r.value.reasons ?? []).join("; ") || status, source: r.source };
}

// ---- aggregate ------------------------------------------------------------------------

export function buildBarScoreboard(inp: Inputs): BarScoreboard {
  const rows = [...PAGES.map((p) => b1Row(p, inp)), ...b2Rows(inp), ...b3Rows(inp), b4aRow(inp), b4bRow(inp)];
  const totals: Record<RowStatus, number> = { pass: 0, red: 0, "not-run": 0 };
  for (const r of rows) totals[r.status] += 1;
  let largest_gap: BarScoreboard["largest_gap"] = null;
  for (const bar of BARS) {
    const of = rows.filter((r) => r.bar === bar);
    const remaining = of.filter((r) => r.status !== "pass").length;
    if (remaining > 0 && (largest_gap === null || remaining > largest_gap.remaining)) largest_gap = { bar, remaining, of: of.length };
  }
  return { schema: "rw/1", rows, totals, largest_gap };
}

const MARK: Record<RowStatus, string> = { pass: "pass", red: "RED", "not-run": "not-run" };

export function formatMarkdown(sb: BarScoreboard): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    "# RocketWright bar scoreboard",
    "",
    `Rows: ${sb.rows.length} · pass ${sb.totals.pass} · red ${sb.totals.red} · not-run ${sb.totals["not-run"]}`,
    "",
    sb.largest_gap
      ? `Largest remaining gap: **${sb.largest_gap.bar}**, ${sb.largest_gap.remaining} of ${sb.largest_gap.of} rows not passing.`
      : "Largest remaining gap: none (every row passes).",
    "",
    "| Row | Item | Status | Detail | Source |",
    "|---|---|---|---|---|",
    ...sb.rows.map((r) => `| ${r.id} | ${esc(r.title)} | ${MARK[r.status]} | ${esc(r.detail)} | ${r.source ?? ""} |`),
    "",
  ];
  return lines.join("\n");
}

export function writeScoreboard(sb: BarScoreboard, outDir: string): { md: string; json: string } {
  mkdirSync(outDir, { recursive: true });
  const md = join(outDir, "scoreboard.md");
  const json = join(outDir, "scoreboard.json");
  writeFileSync(md, formatMarkdown(sb));
  writeFileSync(json, stableStringify(sb));
  return { md, json };
}

// ---- self-test ----------------------------------------------------------------------------

/** Returns error strings; empty means pass. */
export function selfTest(): string[] {
  const errors: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "rw-bar-sb-"));
  const emptyRepo = mkdtempSync(join(tmpdir(), "rw-bar-repo-"));
  try {
    const inp: Inputs = { root, repo: emptyRepo };
    const empty = buildBarScoreboard(inp);
    if (empty.rows.length !== 20) errors.push(`empty root: ${empty.rows.length} rows, want 20`);
    if (!empty.rows.every((r) => r.status === "not-run")) errors.push("empty root: every row must be not-run");
    if (empty.largest_gap?.bar !== "B2") errors.push(`empty root: largest gap ${String(empty.largest_gap?.bar)}, want B2 (7 rows)`);

    const put = (rel: string, v: unknown) => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), typeof v === "string" ? v : JSON.stringify(v));
    };
    const pw = (status: string) => ({
      suites: [{ file: B4A_SPEC_FILE, specs: [], suites: [{ file: B4A_SPEC_FILE, specs: [{ title: B4A_TITLE, file: B4A_SPEC_FILE, tests: [{ status, annotations: [] }] }] }] }],
    });
    put("e2e/report.json", pw("expected"));
    if (b4aRow(inp).status !== "pass") errors.push("B4(a): expected test should pass");
    put("e2e/report.json", pw("unexpected"));
    if (b4aRow(inp).status !== "red") errors.push("B4(a): unexpected test should be red");

    const row = (status: string, tol: string | null) => ({ matrix: "generic", case: 1, key: "k", status, tol });
    put("parity/scoreboard.json", { gate_matrix: "generic", rows: [row("pass", "3%"), row("report", null)] });
    if (b2Rows(inp, [1])[0]?.status !== "pass") errors.push("B2: all toleranced rows pass should pass");
    put("parity/scoreboard.json", { gate_matrix: "generic", rows: [row("pass", "3%"), row("mismatch", "3%")] });
    if (b2Rows(inp, [1])[0]?.status !== "red") errors.push("B2: a mismatch should be red");

    put("agent-loop/T1/score.json", "{not json");
    if (b3Rows(inp)[0]?.status !== "red") errors.push("B3: unreadable score should be red");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(emptyRepo, { recursive: true, force: true });
  }
  return errors;
}

function main(argv: string[]): number {
  if (argv.includes("--self-test")) {
    const errors = selfTest();
    for (const e of errors) console.error(`scoreboard self-test: ${e}`);
    console.log(`scoreboard self-test: ${errors.length === 0 ? "ok" : "FAILED"}`);
    return errors.length === 0 ? 0 : 1;
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  for (const name of ["--root", "--out"]) {
    if (argv.includes(name) && flag(name) === undefined) {
      console.error(`scoreboard: ${name} needs a path`);
      return 2;
    }
  }
  const root = resolve(flag("--root") ?? barOutDir());
  const out = resolve(flag("--out") ?? root);
  const sb = buildBarScoreboard({ root });
  const { md } = writeScoreboard(sb, out);
  console.log(formatMarkdown(sb));
  console.log(`wrote ${md}`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
