/** M1.18: bar scoreboard aggregator and the B4(b) rule. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateB4b } from "../../../scripts/bar/live-smoke.ts";
import { b1Row, b4aRow, b4bRow, buildBarScoreboard, formatMarkdown, selfTest, writeScoreboard } from "../../../scripts/bar/scoreboard.ts";
import { B4A_SPEC_FILE, B4A_TITLE } from "../b4a.ts";

function tmpRoot(): { root: string; repo: string; put: (rel: string, v: unknown) => void } {
  const root = mkdtempSync(join(tmpdir(), "rw-sb-test-"));
  const repo = mkdtempSync(join(tmpdir(), "rw-sb-repo-"));
  const put = (rel: string, v: unknown) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), typeof v === "string" ? v : JSON.stringify(v));
  };
  return { root, repo, put };
}

describe("scoreboard", () => {
  it("self-test passes", () => {
    expect(selfTest()).toEqual([]);
  });

  it("an empty root gives 20 not-run rows and writes md + json", () => {
    const { root, repo } = tmpRoot();
    const sb = buildBarScoreboard({ root, repo });
    expect(sb.rows.map((r) => r.id)).toEqual([
      ...["01", "02", "03", "04", "05", "06"].map((p) => `B1.${p}`),
      ...[1, 2, 3, 4, 5, 6, 7].map((c) => `B2.case${c}`),
      ...[1, 2, 3, 4, 5].map((n) => `B3.T${n}`),
      "B4.a",
      "B4.b",
    ]);
    expect(sb.totals).toEqual({ pass: 0, red: 0, "not-run": 20 });
    const { md, json } = writeScoreboard(sb, join(root, "out"));
    expect(readFileSync(md, "utf8")).toContain("| B4.a |");
    expect(JSON.parse(readFileSync(json, "utf8")).totals["not-run"]).toBe(20);
    expect(formatMarkdown(sb)).toContain("Largest remaining gap: **B2**, 7 of 7");
  });

  it("a fixme B4(a) test is not-run", () => {
    const { root, repo, put } = tmpRoot();
    put("e2e/report.json", {
      suites: [{ file: B4A_SPEC_FILE, suites: [{ file: B4A_SPEC_FILE, specs: [{ title: B4A_TITLE, file: B4A_SPEC_FILE, tests: [{ status: "skipped", annotations: [{ type: "fixme" }] }] }] }] }],
    });
    expect(b4aRow({ root, repo })).toMatchObject({ status: "not-run", detail: "test.fixme" });
  });

  it("B1 is red with a passing token report but no critics, pass with 3 agreeing critics", () => {
    const { root, repo, put } = tmpRoot();
    const checklistDir = join(root, "checklists");
    put("checklists/01.json", { items: [{ id: "01.a" }, { id: "01.b" }] });
    put("visual/01.tokens.json", { pass: true, failures: 0 });
    expect(b1Row("01", { root, repo, checklistDir })).toMatchObject({ status: "red", detail: "0/3 critics" });
    const yes = { items: [{ id: "01.a", verdict: "present" }, { id: "01.b", verdict: "present" }], typography: { verdict: "agree" } };
    const no = { items: [{ id: "01.a", verdict: "present" }, { id: "01.b", verdict: "missing" }], typography: { verdict: "disagree" } };
    put("visual/01.critics/c1.json", yes);
    put("visual/01.critics/c2.md", "Critic 2\n\n```json\n" + JSON.stringify(yes) + "\n```\n");
    put("visual/01.critics/c3.json", no);
    expect(b1Row("01", { root, repo, checklistDir }).status).toBe("pass");
    put("visual/01.critics/c2.json", no);
    expect(b1Row("01", { root, repo, checklistDir })).toMatchObject({ status: "red" });
  });

  it("B4(b) reads the live result and rejects another prompt", () => {
    const { root, repo, put } = tmpRoot();
    put("live/b4b/result.json", evaluateB4b({ run_status: "Complete", apogee_m: 310, results_visible: true }));
    expect(b4bRow({ root, repo }).status).toBe("pass");
    put("live/b4b/result.json", { status: "pass", reasons: [], prompt: "something else" });
    expect(b4bRow({ root, repo }).status).toBe("red");
  });
});

describe("evaluateB4b (S:199)", () => {
  it("passes a Complete run within 20% of 300 m shown on Results", () => {
    expect(evaluateB4b({ run_status: "Complete", apogee_m: 240, results_visible: true }).status).toBe("pass");
    expect(evaluateB4b({ run_status: "Complete", apogee_m: 360, results_visible: true }).status).toBe("pass");
  });
  it("fails outside 20%, non-Complete, missing apogee, or not visible", () => {
    expect(evaluateB4b({ run_status: "Complete", apogee_m: 361, results_visible: true }).status).toBe("red");
    expect(evaluateB4b({ run_status: "Outdated", apogee_m: 300, results_visible: true }).status).toBe("red");
    expect(evaluateB4b({ run_status: "Complete", apogee_m: null, results_visible: true }).status).toBe("red");
    expect(evaluateB4b({ run_status: "Complete", apogee_m: 300, results_visible: false }).reasons).toEqual(["run not visible on the Results page"]);
  });
});
