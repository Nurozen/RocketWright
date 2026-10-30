/**
 * CPW1R3A, CPW1R4A, B7e, CP-W1 r4: each page's checklist composition fits the embedded
 * pane's timeline without scrolling (`capture/pane-budget.ts`, sizes measured
 * in the Lecturn pin4 CP-W1 r3 captures, rows as pin5 draws them), for the scenarios (01, 06) and
 * the bundle fixtures the converter turns into the opened threads (02-05),
 * whose rows Lecturn must not fold.
 */
import { describe, expect, it } from "vitest";
import { PAGES } from "../bar/paths.ts";
import { loadFixture } from "../fixtures/convert-threads.ts";
import { budgetProblems, bundleTurnItems, chipLabel, compositionHeight, foldedRows, lines, pageBudget, scenarioItems, timelineBudget, PX } from "../capture/pane-budget.ts";
import { loadScenario, type ScriptStep } from "../capture/scripted.ts";

const budgetOf = (page: (typeof PAGES)[number]) => pageBudget(page, page === "01" || page === "06" ? { scenario: loadScenario(`visual-${page}`) } : {});

describe("pane budget (pane-budget.ts)", () => {
  for (const page of PAGES) {
    it(`page ${page}: the shown turn fits the pane's timeline`, () => {
      const b = budgetOf(page);
      expect(budgetProblems(b)).toEqual([]);
      expect(b.height - PX.bubbleTopPad).toBeLessThanOrEqual(b.budget);
    });
  }

  it("01 is the mockup set: user bubble, three app rows, one run card, the step card, the reply (pin5: no working or held-call row)", () => {
    expect(budgetOf("01").items).toEqual([
      { kind: "user", text: "Check rw:c/fins and run baseline." },
      { kind: "tool", name: "rw_design_check" },
      { kind: "tool", name: "rw_simulate" },
      { kind: "card", card: "flight" },
      { kind: "tool", name: "rw_history_show" },
      { kind: "card", card: "step" },
      { kind: "reply", text: "The check flags 2 missing engine inputs." },
    ]);
  });

  it("matches the r3 captures (pin4 rows): 01's live turn was 563 px (bubble 138 to the pending row's bottom 701), 06's 533 px, 04's 631 px", () => {
    // 01 at r3: the committed scenario without the step card; 06 is unchanged; both with pin4's working and pending rows.
    const v1 = loadScenario("visual-01");
    const r3v1 = { user: v1.user, script: v1.script.filter((st) => !("toolCall" in st && st.toolCall.name === "rw_history_show")), cards: v1.cards.filter((c) => c !== "step") };
    // r3's run cards had the 130 px chart (PX.r3RunCard taller than now).
    expect(Math.abs(compositionHeight(scenarioItems(r3v1, "pin4"), true) + PX.r3RunCard - 563)).toBeLessThanOrEqual(5);
    expect(Math.abs(pageBudget("06", { scenario: loadScenario("visual-06"), rows: "pin4" }).height - 533)).toBeLessThanOrEqual(5);
    // 04 at r3: two folded rows, rw_simulate and its run card, rw_model_patch and its step card (then two lines, 56 px), a two-line reply.
    const r3: Parameters<typeof compositionHeight>[0] = [
      { kind: "user", text: "What changed between these flights? rw:sim/baseline rw:sim/higher_altitude" },
      { kind: "tool", name: "folded" },
      { kind: "tool", name: "simulate" },
      { kind: "card", card: "flight" },
      { kind: "tool", name: "model_patch" },
      { kind: "card", card: "step" },
      { kind: "reply", text: "Higher altitude climbs higher in the same launch conditions. Open a run for its details." },
    ];
    expect(Math.abs(compositionHeight(r3) + PX.r3RunCard + 56 - PX.cards.step - 631)).toBeLessThanOrEqual(5);
  });

  it("01 shows the step card under pin5 (B7e), which it could not under pin4 (CPW1R4A): FIXJ's freed rows make room for its row and 80 px frame (CP-W1 r4: with the 90 px run chart)", () => {
    const s = loadScenario("visual-01");
    const pin5 = pageBudget("01", { scenario: s });
    const pin4 = pageBudget("01", { scenario: s, rows: "pin4" });
    expect(pin5.items.some((i) => i.kind === "card" && i.card === "step")).toBe(true);
    expect(budgetProblems(pin5)).toEqual([]);
    expect(budgetProblems(pin4)).toEqual([expect.stringMatching(/01: the turn needs about \d+ px/)]);
    // Freed: the "Working for" row under the bubble (its row and gap, less the plain user gap) and the held call's row under the reply.
    const freed = PX.userGapLive + PX.working - PX.userGap + PX.rowAfterText + PX.toolRow;
    expect(pin4.height - pin5.height).toBe(freed);
    expect(freed).toBeGreaterThanOrEqual(78);
    const stepCard = PX.toolRow + PX.rowCard + PX.cards.step + PX.cardRow;
    const r3v1 = { user: s.user, script: s.script.filter((st) => !("toolCall" in st && st.toolCall.name === "rw_history_show")), cards: s.cards.filter((c) => c !== "step") };
    expect(pin5.height - pageBudget("01", { scenario: r3v1 }).height).toBe(stepCard);
    // The user bubble's text stays in view, with some room left.
    expect(pin5.height - PX.bubbleTopPad).toBeLessThanOrEqual(pin5.budget);
  });

  it("02-05 show the opened thread's last turn with a row per call (04: list, the step, the comparison's run card; 05: the views either side of the step)", () => {
    const shape = (p: "02" | "04" | "05") => bundleTurnItems(loadFixture(p)).map((i) => (i.kind === "card" ? `card:${i.card}` : i.kind === "tool" ? `tool:${i.name}` : i.kind));
    expect(shape("04")).toEqual(["user", "tool:run_list", "tool:history_show", "card:step", "tool:run_diff", "card:flight", "reply"]);
    expect(shape("02")).toEqual(["user", "tool:model_patch", "card:step", "tool:model_diff", "reply"]);
    expect(shape("05")).toEqual(["user", "tool:viewport_render", "tool:history_show", "card:step", "tool:viewport_render", "reply"]);
    // 04's user bubble names both runs as chips.
    const user = bundleTurnItems(loadFixture("04"))[0]!;
    expect(user.kind === "user" && user.text).toMatch(/rw:sim\/baseline rw:sim\/higher_altitude$/);
  });

  it("names the rows an imported turn folds (r3: 02's two edits, 05's three views, 04's list and compare)", () => {
    const tool = (name: string) => ({ kind: "tool" as const, name });
    expect(foldedRows([{ kind: "user", text: "u" }, tool("model_patch"), tool("model_patch"), { kind: "reply", text: "r" }])).toEqual([["model_patch", "model_patch"]]);
    expect(foldedRows([tool("viewport_render"), tool("viewport_render"), tool("viewport_render"), tool("model_patch"), { kind: "card", card: "step" }])).toEqual([["viewport_render", "viewport_render", "viewport_render"]]);
    expect(foldedRows([tool("run_list"), tool("run_diff"), tool("simulate"), { kind: "card", card: "flight" }, tool("model_patch"), { kind: "card", card: "step" }])).toEqual([["run_list", "run_diff"]]);
    expect(foldedRows([tool("a"), { kind: "reply", text: "s" }, tool("b"), tool("c"), { kind: "card", card: "step" }, tool("d")])).toEqual([]);
    const fixture = loadFixture("05");
    const r3 = structuredClone(fixture);
    const reply = r3.threads.at(-1)!.messages.at(-1)!;
    reply.steps = reply.steps!.filter((s) => s.tool === "viewport_render");
    expect(budgetProblems(pageBudget("05", { fixture: r3 }))).toEqual([expect.stringMatching(/05: viewport_render, viewport_render fold into one "Used RocketWright integration" row/)]);
  });

  it("the round-2 visual-01 (polled Baseline, a run card per try) did not fit", () => {
    const script: ScriptStep[] = [
      { toolCall: { name: "rw_design_check", arguments: {} } },
      { toolCall: { name: "rw_simulate", arguments: { sim: "baseline", force: true } }, saveAs: "run" },
      { poll: { toolCall: { name: "rw_job_status", arguments: { job_id: "${run.result.structuredContent.job_id}" } }, until: { path: "result.structuredContent.state", equals: "complete" }, maxTries: 2 } },
      { assistantText: "The baseline passes the design check. Fin clearance is 1.2 mm." },
      { toolCall: { name: "rw_engine_simulate", arguments: { engine: "demo" } } },
    ];
    const b = pageBudget("01", { scenario: { user: "Check the fins and simulate baseline.", script, cards: ["flight"] } });
    expect(budgetProblems(b)).toEqual([expect.stringMatching(/rw_job_status polls/), expect.stringMatching(/needs about \d+ px/)]);
  });

  it("estimates lines with rw: refs as chips, and the pane's timeline from regions.json", () => {
    expect(chipLabel("rw:c/fins")).toBe("Fins");
    expect(chipLabel("rw:sim/higher_altitude")).toBe("Higher altitude");
    expect(chipLabel("rw:step/4")).toBe("Step");
    expect(lines("Check rw:c/fins and run baseline.", 36)).toBe(1);
    expect(lines("x".repeat(37), 36)).toBe(2);
    // 01: the embed composer box (regions.json, 247 px with the approval) starts at y 723, the latest item ends 22 px above it; the embed at y 125.
    expect(timelineBudget("01")).toBe(723 - 22 - 125);
    // 04: the composer box at y 817, the latest item 69 px above it.
    expect(timelineBudget("04")).toBe(817 - 69 - 125);
    expect(compositionHeight([])).toBe(0);
    // The held (last) call's approval card is in the composer: pin5 draws no row for it and no "Working for" row; pin4 drew both.
    expect(scenarioItems({ user: "u", cards: [], script: [{ toolCall: { name: "rw_engine_simulate" } }] })).toEqual([{ kind: "user", text: "u" }]);
    expect(scenarioItems({ user: "u", cards: [], script: [{ toolCall: { name: "rw_engine_simulate" } }] }, "pin4")).toEqual([{ kind: "user", text: "u" }, { kind: "working" }, { kind: "pending", name: "rw_engine_simulate" }]);
  });
});
