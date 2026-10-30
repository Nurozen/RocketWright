/**
 * B13 (W5.1): the Lecturn thread bundles and the live visual scenarios.
 * - The committed bundles are the converter's output (what
 *   `node app/e2e/fixtures/convert-threads.ts --check` checks), keep the D30
 *   thread names, order and page bindings, and carry the real step card.
 * - The scripted scenarios use Lecturn's D22 grammar, and the harness's
 *   decisions (`nextStep`, `scriptsFor`) and the pane checks
 *   (`paneFailures`) behave on canned projections and guest facts.
 * - Each bar page gets its own temp Lecturn dirs with the scripted provider.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_CLOCK, parseThreadBundle, type ThreadBundle } from "../../apps/server/src/lecturn/bundle.ts";
import { APP_ICON_PATH as RW_APP_ICON_PATH, RW_APP_ID, RW_APP_NAME, iconDataUrl } from "../../apps/server/src/lecturn/registration.ts";
import { PAGES } from "../bar/paths.ts";
import { driveLines } from "../bar/visual.ts";
import { bundleTitles, loadBundle } from "../capture/hooks.ts";
import { paneFailures, type CardFrameFacts, type PaneMainFacts } from "../capture/pane-checks.ts";
import { SCRIPTED_SETTINGS, loadScenario, nextStep, scenarioProblems, scriptProblems, scriptsFor, type ProjectionLike } from "../capture/scripted.ts";
import { APP_ICON_PATH, FIXTURE_APP_ID, FIXTURE_APP_NAME, LIVE_TOOL_PREFIX, TOOL_ICON_URL_MAX, TOOL_SUMMARY_MAX, TOOL_SUMMARY_META_KEY, TOOL_TITLE_MAX, agentTools, appToolSource, plainLine, rowTitle, toolTitle, RUN_CARD_PATH, RUN_CARD_URI, STEP_CARD_PATH, STEP_CARD_URI, convertThread, driftedPages, loadFixture, messageText, sourceThreadId } from "../fixtures/convert-threads.ts";
import { lecturnEnv } from "../lecturn-env.ts";

const bundle = (page: string): ThreadBundle => parseThreadBundle(loadBundle(page));
const LIVE_ITEMS = new URL("../fixtures/lecturn-live/tool-items.json", import.meta.url);
type CardOutput = { structuredContent: { lecturnMcpApp: { attachmentId: string; server: string; tool: string; resourceUri: string; prefersBorder?: boolean }; result: { structuredContent: Record<string, unknown> } } };
/** The MCP Apps reference a row's output carries (AppCardEnvelope), if any. */
const cardOf = (i: Record<string, unknown>) => (i["output"] as Partial<CardOutput> | undefined)?.structuredContent?.lecturnMcpApp;

describe("Lecturn thread bundles (convert-threads.ts)", () => {
  it("are the converter's output for every page (convert-threads --check)", () => {
    expect(driftedPages()).toEqual([]);
    expect(FIXTURE_APP_ID).toBe(RW_APP_ID);
  });

  it("stamp every app tool row with the declared title, the call's summary and the app toolSource a live row gets (Lecturn FIXH; pin4 draws the success check only on app rows)", () => {
    expect(FIXTURE_APP_NAME).toBe(RW_APP_NAME);
    expect(APP_ICON_PATH).toBe(RW_APP_ICON_PATH);
    // Lecturn's appToolSource: the 128 px icon's data URL is over the row icon cap, so no icon.
    expect(iconDataUrl().length).toBeGreaterThan(TOOL_ICON_URL_MAX);
    const source = { key: `app:${RW_APP_ID}`, name: RW_APP_NAME, kind: "integration" };
    expect(appToolSource()).toEqual(source);
    expect(appToolSource("data:image/png;base64,AA")).toEqual({ ...source, icon: { _tag: "themed-logo", logoUrl: "data:image/png;base64,AA" } });
    let rows = 0;
    for (const page of PAGES) {
      for (const t of bundle(page).projects[0]!.threads) {
        for (const item of t.turnItems.filter((i) => i["type"] === "dynamic_tool")) {
          rows++;
          const id = `${page} ${String(item["id"])}`;
          expect(item["toolSource"], id).toEqual(source);
          const name = String(item["toolName"]).slice(LIVE_TOOL_PREFIX.length);
          expect(String(item["toolName"]), id).toBe(`${LIVE_TOOL_PREFIX}${name}`);
          // CPW1R4B: the row reads the tool's declared MCP title, never the raw id.
          expect(item["title"], id).toBe(toolTitle(name));
          expect(String(item["title"]), id).not.toMatch(/^rw_|_/);
          expect(item).not.toHaveProperty("toolIcon");
          const meta = (item["output"] as { _meta: Record<string, unknown> })._meta;
          // Pin16's AppToolkit keeps no lecturn/* key but the summary, and stamps no lecturn/toolSource: the row reads the item's.
          expect(Object.keys(meta), id).toEqual([TOOL_SUMMARY_META_KEY]);
          // The summary Lecturn keeps: one plain line within its cap.
          const summary = meta[TOOL_SUMMARY_META_KEY];
          expect(typeof summary, id).toBe("string");
          expect((summary as string).length, id).toBeLessThanOrEqual(TOOL_SUMMARY_MAX);
          expect(summary as string, id).toMatch(/^\S(?:.*\S)?$/);
          expect(summary as string, id).not.toMatch(/\s{2}|[\n\r\t]/);
        }
      }
    }
    expect(rows).toBeGreaterThan(10);
  });

  it("titles every tool an agent sees: the CLI's from the tool-parity golden, the window tools' from BROKER_OP_TITLES (CPW1R4B)", () => {
    for (const name of agentTools()) {
      const title = toolTitle(name);
      expect(title, name).not.toBe(`rw_${name}`);
      expect(title.length, name).toBeLessThanOrEqual(TOOL_TITLE_MAX);
    }
    expect(["design_check", "simulate", "engine_simulate", "motor_search", "model_patch", "model_get", "run_list", "run_diff", "job_status", "history_show", "render", "viewport_render"].map(toolTitle)).toEqual([
      "Check design",
      "Run simulation",
      "Simulate engine",
      "Find motors",
      "Edit model",
      "Read model",
      "List runs",
      "Compare runs",
      "Check run",
      "Show history step",
      "Render view",
      "Render view",
    ]);
    const motors = bundle("03").projects[0]!.threads.flatMap((t) => t.turnItems).find((i) => i["toolName"] === "lecturn.rw_motor_search")!;
    expect([motors["title"], (motors["output"] as { _meta: Record<string, unknown> })._meta[TOOL_SUMMARY_META_KEY]]).toEqual(["Find motors", "3 candidates"]);
    const reply = (steps: object[]) => ({ thread: "x", messages: [{ role: "user" as const, text: "q" }, { role: "assistant" as const, text: "a", steps: steps as never }] });
    expect(() => convertThread("04", reply([{ tool: "run_list", input: {} }]), { step: "", run: "" })).toThrow(/run_list has no summary/);
    expect(() => convertThread("04", reply([{ tool: "run_list", input: {}, summary: "two\nlines" }]), { step: "", run: "" })).toThrow(/one plain line/);
    expect(() => convertThread("04", reply([{ tool: "run_list", input: {}, summary: "x".repeat(TOOL_SUMMARY_MAX + 1) }]), { step: "", run: "" })).toThrow(/one plain line/);
  });

  it("keep the D30 thread names, order and page bindings, as one templated project at the fixture clock", () => {
    for (const page of PAGES) {
      const fixture = loadFixture(page);
      const b = bundle(page);
      expect(b).toMatchObject({ version: 1, appId: RW_APP_ID, exportedAt: FIXTURE_CLOCK });
      expect(b.projects.map((p) => [p.workspaceRoot, p.title])).toEqual([["{workspaceRoot}", "{projectName}"]]);
      expect(bundleTitles(loadBundle(page))).toEqual(fixture.threads.map((t) => t.thread));
      for (const [i, t] of b.projects[0]!.threads.entries()) {
        const src = fixture.threads[i]!;
        expect(t.appData).toBe(JSON.stringify(src.binding));
        expect(Date.parse(FIXTURE_CLOCK) - Date.parse(t.updatedAt)).toBe(src.ageMs);
        expect(t.historyRevision).toBe(t.messages.length + t.turnItems.length);
        // Supervised, as every W-B2 thread runs; no model (a missing provider adds a fallback notice row).
        expect([t.runtimeMode, t.interactionMode, "modelSelection" in t]).toEqual(["approval-required", "default", false]);
      }
    }
    expect(bundleTitles(loadBundle("01")).at(-1)).toBe("Assembly review");
    expect(bundleTitles(loadBundle("06")).at(-1)).toBe("Tank motion");
  });

  it("writes mentions as plain rw: refs and steps as app tool rows", () => {
    expect(messageText({ text: "Can the fins get a little more span? [@Fin can](rw:c/fin_can)", mentions: [{ ref: "rw:c/fin_can", label: "Fin can" }] })).toBe("Can the fins get a little more span? rw:c/fin_can");
    expect(messageText({ text: "Show how the recovery bay fits.", mentions: [{ ref: "rw:c/recovery_bay", label: "Recovery bay" }] })).toBe("Show how the recovery bay fits. rw:c/recovery_bay");
    const review = bundle("01").projects[0]!.threads.find((t) => t.title === "Assembly review")!;
    expect(review.sourceThreadId).toBe(sourceThreadId("01", "Assembly review"));
    expect(review.turnItems.map((i) => [i["type"], i["toolName"] ?? null])).toEqual([
      ["user_message", null],
      ["dynamic_tool", "lecturn.rw_viewport_select"],
      ["dynamic_tool", "lecturn.rw_viewport_set_camera"],
      ["dynamic_tool", "lecturn.rw_viewport_render"],
      ["dynamic_tool", "lecturn.rw_model_patch"],
      ["assistant_message", null],
    ]);
  });

  it("carries the real step card as the captured MCP Apps document of each step card", () => {
    const b = bundle("01");
    const html = readFileSync(STEP_CARD_PATH);
    const review = b.projects[0]!.threads.find((t) => t.title === "Assembly review")!;
    const card = review.turnItems.find((i) => i["toolName"] === "lecturn.rw_model_patch")!;
    const out = card["output"] as CardOutput;
    expect(out.structuredContent.lecturnMcpApp).toMatchObject({ server: "lecturn", tool: "rw_model_patch", resourceUri: STEP_CARD_URI, prefersBorder: true });
    expect(out.structuredContent.result.structuredContent["step"]).toBe("2");
    expect(card["input"]).toEqual({ label: "Assembly layout", ops: [] });
    const asset = b.assets.find((a) => a.sourceAttachmentId === out.structuredContent.lecturnMcpApp.attachmentId)!;
    expect(Buffer.from(asset.dataBase64, "base64").equals(html)).toBe(true);
  });

  it("gives page 04's opened thread rows to list and compare the runs, a step card with Compare and the comparison's run card with Open (B14, CPW1R4A, POL)", () => {
    const b = bundle("04");
    const flights = b.projects[0]!.threads.at(-1)!;
    expect(flights.title).toBe("Flight comparison");
    expect(flights.turnItems.filter((i) => i["type"] === "dynamic_tool").map((i) => i["toolName"])).toEqual(["lecturn.rw_run_list", "lecturn.rw_history_show", "lecturn.rw_run_diff"]);
    const apps = flights.turnItems.filter((i) => cardOf(i) !== undefined);
    expect(apps.map((i) => i["toolName"])).toEqual(["lecturn.rw_history_show", "lecturn.rw_run_diff"]);
    const run = apps[1]!["output"] as CardOutput;
    expect(run.structuredContent.lecturnMcpApp.resourceUri).toBe(RUN_CARD_URI);
    // Both runs, Baseline first (teal) and Higher altitude second (sand), filled in at import.
    expect(run.structuredContent.result.structuredContent).toEqual({ a: "baseline/{runId:baseline}", b: "higher_altitude/{runId:higher_altitude}", mismatches: [], rows: [], pass: true });
    expect(apps[1]!["input"]).toEqual({ a: "baseline", b: "higher_altitude" });
    const asset = b.assets.find((a) => a.sourceAttachmentId === run.structuredContent.lecturnMcpApp.attachmentId)!;
    expect(Buffer.from(asset.dataBase64, "base64").equals(readFileSync(RUN_CARD_PATH))).toBe(true);
    expect((apps[0]!["output"] as CardOutput).structuredContent.result.structuredContent["step"]).toMatchObject({ seq: 4, title: "Flight runs" });
    const diff = (input: object, ref: string) => ({ thread: "x", messages: [{ role: "user" as const, text: "q" }, { role: "assistant" as const, text: "a", steps: [{ tool: "run_diff", input, card: { kind: "run", ref, title: "t" }, summary: "2 runs" }] as never }] });
    expect(() => convertThread("04", diff({ a: "baseline", b: "higher_altitude" }, "rw:sim/baseline"), { step: "", run: "" })).toThrow(/names baseline, not b/);
    expect(() => convertThread("04", diff({ a: "baseline" }, "rw:sim/baseline"), { step: "", run: "" })).toThrow(/needs sim ids a and b/);
    expect(() => convertThread("04", { thread: "x", messages: [{ role: "user", text: "q" }, { role: "assistant", text: "a", cards: [{ kind: "run", ref: "rw:run/abc", title: "t" }] }] }, { step: "", run: "" })).toThrow(/rw:sim/);
  });

  it("reads titles and summaries as pin5's appToolTitle and sanitizeResult do (plainLine: one line, capped, else the prefixed name)", () => {
    expect(plainLine("  Find\tmotors \n", TOOL_TITLE_MAX)).toBe("Find motors");
    expect(plainLine("Find\u202Emotors", TOOL_TITLE_MAX)).toBe("Find motors");
    expect(plainLine("x".repeat(TOOL_TITLE_MAX + 1), TOOL_TITLE_MAX)).toBeUndefined();
    expect(plainLine("   ", TOOL_SUMMARY_MAX)).toBeUndefined();
    expect(plainLine(3, TOOL_SUMMARY_MAX)).toBeUndefined();
    expect(toolTitle("motor_search")).toBe("Find motors");
    expect(toolTitle("viewport_render")).toBe("Render view");
    expect(rowTitle("motor_search", " Find  motors ")).toBe("Find motors");
    expect(rowTitle("motor_search", "x".repeat(TOOL_TITLE_MAX + 1))).toBe("rw_motor_search");
    expect(rowTitle("motor_search", null)).toBe("rw_motor_search");
    // A summary the fixture gives must already be the line Lecturn keeps.
    const reply = (summary: string) => ({ thread: "x", messages: [{ role: "user" as const, text: "q" }, { role: "assistant" as const, text: "a", steps: [{ tool: "motor_search", input: {}, output: {}, summary }] as never }] });
    expect(() => convertThread("04", reply("3  candidates"), { step: "", run: "" })).toThrow(/not one plain line/);
    expect(() => convertThread("04", reply("3 candidates\u202E"), { step: "", run: "" })).toThrow(/not one plain line/);
    expect(() => convertThread("04", reply("3 candidates"), { step: "", run: "" })).not.toThrow();
  });

  it("refuses a card on a tool that does not draw it, a render card, and a tool an agent cannot call", () => {
    const reply = (steps: object[]) => ({ thread: "x", messages: [{ role: "user" as const, text: "q" }, { role: "assistant" as const, text: "a", steps: steps as never }] });
    expect(() => convertThread("04", reply([{ tool: "run_list", input: {}, card: { kind: "run", ref: "rw:sim/baseline", title: "t" } }]), { step: "", run: "" })).toThrow(/run_list does not draw a run card/);
    expect(() => convertThread("04", reply([{ tool: "model_patch", input: {}, card: { kind: "run", ref: "rw:sim/baseline", title: "t" } }]), { step: "", run: "" })).toThrow(/draws a step card/);
    expect(() => convertThread("04", reply([{ tool: "render", input: {}, card: { kind: "render", ref: "rw:c/fins", title: "t" } }]), { step: "", run: "" })).toThrow(/render cards are not captured/);
    expect(() => convertThread("04", reply([{ tool: "run_series", input: {} }]), { step: "", run: "" })).toThrow(/not a tool an agent sees/);
  });

  it("keeps page 05's view renders apart with the step card's row (CPW1R4A: an imported turn folds card-less neighbours)", () => {
    const feed = bundle("05").projects[0]!.threads.at(-1)!;
    expect(feed.turnItems.map((i) => (i["type"] === "dynamic_tool" ? String(i["toolName"]) : String(i["type"])))).toEqual(["user_message", "lecturn.rw_viewport_render", "lecturn.rw_history_show", "lecturn.rw_viewport_render", "assistant_message"]);
    expect(feed.turnItems.filter((i) => i["type"] === "dynamic_tool").map((i) => [i["title"], (i["output"] as { _meta: Record<string, unknown> })._meta[TOOL_SUMMARY_META_KEY]])).toEqual([
      ["Render view", "Iso view"],
      ["Show history step", "Step 4 · Flight runs"],
      ["Render view", "Side view"],
    ]);
  });

  it("emits each app tool row with a live row's field set (fixtures/lecturn-live/tool-items.json, a live scripted turn's rows)", () => {
    const live = (JSON.parse(readFileSync(LIVE_ITEMS, "utf8")) as { items: Record<string, unknown>[] }).items;
    // The icon is the source's, and only under Lecturn's cap: compare the rest.
    const fields = (i: Record<string, unknown>) => Object.keys(i).filter((k) => k !== "toolIcon").sort();
    const liveCard = live.find((i) => cardOf(i) !== undefined)!;
    const rows = PAGES.flatMap((p) => bundle(p).projects[0]!.threads.flatMap((t) => t.turnItems.filter((i) => i["type"] === "dynamic_tool")));
    const cards = rows.filter((i) => cardOf(i) !== undefined);
    const plain = rows.filter((i) => cardOf(i) === undefined);
    expect(cards.length).toBeGreaterThan(3);
    expect(plain.length).toBeGreaterThan(3);
    // The capture predates pin16: the Embed Host tools return no summary, so its _meta holds only the
    // lecturn/toolSource that pin16's AppToolkit stopped stamping. A RocketWright row's holds the summary only.
    const liveMeta = (liveCard["output"] as { _meta: Record<string, unknown> })._meta;
    expect(liveMeta).toEqual({ "lecturn/toolSource": liveCard["toolSource"] });
    for (const i of rows) {
      expect(fields(i), String(i["id"])).toEqual(fields(liveCard));
      // The scripted provider's name and the declared title (FIXH).
      const name = String(i["toolName"]);
      expect(name.startsWith(LIVE_TOOL_PREFIX), name).toBe(true);
      expect(i["title"], name).toBe(toolTitle(name.slice(LIVE_TOOL_PREFIX.length)));
      const meta = (i["output"] as { _meta: Record<string, unknown> })._meta;
      expect(Object.keys(meta), name).toEqual([TOOL_SUMMARY_META_KEY]);
    }
    // Pin5 rows (FIXH): the tool's declared MCP title, never the prefixed name it was called by.
    expect(live.map((l) => [l["toolName"], l["title"]])).toEqual([
      ["lecturn.ex_counter_increment", "Increment counter"],
      ["lecturn.ex_counter_increment", "Increment counter"],
      ["lecturn.ex_window_flash", "Flash window"],
    ]);
    for (const l of live) expect(l["toolIcon"] === undefined).toBe((l["toolSource"] as { icon?: unknown }).icon === undefined);
    // A card tool's row: AppCardEnvelope's output, key for key.
    const env = (o: CardOutput) => ({ out: Object.keys(o).sort(), sc: Object.keys(o.structuredContent).sort(), app: Object.keys(o.structuredContent.lecturnMcpApp).sort(), result: Object.keys(o.structuredContent.result).sort() });
    for (const c of cards) {
      expect(env(c["output"] as CardOutput), String(c["id"])).toEqual(env(liveCard["output"] as CardOutput));
      expect(c["toolName"]).toBe(`lecturn.${cardOf(c)!.tool}`);
    }
    // A plain row: AppToolkit's sanitized result (content, structuredContent when the app gave one, _meta).
    for (const p of plain) expect(Object.keys(p["output"] as object).filter((k) => k !== "isError").sort(), String(p["id"])).toEqual(["_meta", "content", "structuredContent"]);
  });

  it("refuses a fixture thread whose reply has no question", () => {
    expect(() => convertThread("01", { thread: "x", messages: [{ role: "assistant", text: "hi" }] }, { step: "", run: "" })).toThrow(/without a user message/);
  });
});

describe("live visual scenarios (scripted.ts)", () => {
  it("visual-01 and visual-06 are valid D22 scenarios for the page's opened thread", () => {
    for (const [name, page] of [
      ["visual-01", "01"],
      ["visual-06", "06"],
    ] as const) {
      const s = loadScenario(name);
      expect(s.runtimeMode).toBe("approval-required");
      expect(s.mention.ref).toBe("rw:c/fins");
      expect(bundleTitles(loadBundle(page)).at(-1)).toBe(s.thread);
    }
    // CPW1R3A: 01 is the mockup set (design check and Baseline rows, ONE run card, no job polling rows;
    // a step card naming seeded step 04; CP-W1 r3 dropped it under pin4, B7e brings it back under pin5's FIXJ); 06 is the tank-motion turn
    // (Study 01 and render rows, the view card).
    const v1 = loadScenario("visual-01");
    expect(v1.cards).toEqual(["flight", "step"]);
    expect(v1.approve).toBe(0);
    expect(v1.user).toMatch(/rw:c\/fins/);
    expect(v1.script.filter((s) => "toolCall" in s).map((s) => ("toolCall" in s ? s.toolCall.name : ""))).toEqual(["rw_design_check", "rw_simulate", "rw_history_show", "rw_engine_simulate"]);
    expect(v1.script.some((s) => "poll" in s)).toBe(false);
    expect(v1.script).toContainEqual({ toolCall: { name: "rw_history_show", arguments: { version: "step:4" } } });
    expect(v1.script.at(-1)).toEqual({ toolCall: { name: "rw_engine_simulate", arguments: { engine: "demo" } } });
    const v6 = loadScenario("visual-06");
    expect(v6).toMatchObject({ cards: ["visual", "render"], approve: 0 });
    expect(v6.user).toMatch(/rw:eng\/demo\/feed\/node\/tank_a/);
    expect(v6.script.filter((s) => "toolCall" in s).map((s) => ("toolCall" in s ? s.toolCall.name : ""))).toEqual(["rw_simulate", "rw_render", "rw_engine_simulate"]);
    expect(v6.script[0]).toEqual({ toolCall: { name: "rw_simulate", arguments: { sim: "study_01" } } });
  });

  it("checks the step grammar and the scenario's approvals", () => {
    expect(scriptProblems([{ toolCall: { name: "rw_x" }, saveAs: "a-1" }, { poll: { toolCall: { name: "rw_y" }, until: { path: "state", equals: "complete" }, maxTries: 3 } }, { hold: { until: "/tmp/x" } }])).toEqual([]);
    expect(scriptProblems([])).toHaveLength(1);
    expect(scriptProblems([{ toolCall: { name: "" } }])[0]).toMatch(/toolCall.name/);
    expect(scriptProblems([{ assistantText: "x", saveAs: "y" }])[0]).toMatch(/assistantText/);
    expect(scriptProblems([{ poll: { toolCall: { name: "a" }, until: { path: "x" } } }])[0]).toMatch(/until/);
    expect(scriptProblems([{ toolCall: { name: "a" }, saveAs: "1bad" }])[0]).toMatch(/saveAs/);
    const ok = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/scripted/visual-06.json"), "utf8")) as Record<string, unknown>;
    expect(scenarioProblems(ok)).toEqual([]);
    expect(scenarioProblems({ ...ok, approve: 1 })[0]).toMatch(/expectApproval/);
    expect(scenarioProblems({ ...ok, runtimeMode: "full-access" })[0]).toMatch(/Supervised/);
  });

  it("checks the pane composition: one row per call, a card per card tool in order, the pending call last (CPW1R3A)", () => {
    const base = { description: "d", thread: "t", runtimeMode: "approval-required", user: "u", approve: 0, mention: { ref: "rw:c/fins", label: "Fins" } };
    const sim = { toolCall: { name: "rw_simulate", arguments: { sim: "baseline" } } };
    const show = { toolCall: { name: "rw_history_show", arguments: { version: "step:4" } } };
    const pending = { toolCall: { name: "rw_engine_simulate", arguments: { engine: "demo" } } };
    expect(scenarioProblems({ ...base, cards: ["flight", "step"], script: [{ toolCall: { name: "rw_design_check" } }, sim, show, { assistantText: "a" }, pending] })).toEqual([]);
    // The old visual-01: polling job_status drew a row and a run card per try.
    const poll = { poll: { toolCall: { name: "rw_job_status", arguments: { job_id: "j" } }, until: { path: "result.structuredContent.state", equals: "complete" }, maxTries: 120 } };
    expect(scenarioProblems({ ...base, cards: ["flight"], script: [sim, poll, pending] })).toContainEqual(expect.stringMatching(/poll renders one tool row/));
    expect(scenarioProblems({ ...base, cards: ["step", "flight"], script: [sim, show, pending] })).toEqual([expect.stringMatching(/rw_simulate draws a run card, not step/), expect.stringMatching(/rw_history_show draws a step card, not flight/)]);
    expect(scenarioProblems({ ...base, cards: ["flight"], script: [sim, show, pending] })[0]).toMatch(/draw 2 cards/);
    expect(scenarioProblems({ ...base, cards: ["flight"], script: [sim, { assistantText: "a" }] })).toContainEqual(expect.stringMatching(/ends with the call/));
    expect(scenarioProblems({ ...base, cards: [], script: [sim, pending] })[0]).toMatch(/cards: a non-empty list/);
  });

  const projection = (over: Partial<ProjectionLike> = {}): ProjectionLike => ({ runs: [{ id: "r1", ordinal: 1, status: "running" }], runtimeRequests: [], turnItems: [], messages: [], ...over });
  const appRequest = (id: string, status = "pending") => ({ id, status, connectedAppTool: { appId: RW_APP_ID } });

  it("approves the scenario's approvals in order, then settles on the next one", () => {
    expect(nextStep(projection(), [], 1)).toEqual({ kind: "wait" });
    expect(nextStep(projection({ runtimeRequests: [appRequest("q1")] }), [], 1)).toEqual({ kind: "approve", requestId: "q1" });
    // q1 is still pending in the projection right after the answer: it is not counted again.
    expect(nextStep(projection({ runtimeRequests: [appRequest("q1")] }), ["q1"], 1)).toEqual({ kind: "wait" });
    expect(nextStep(projection({ runtimeRequests: [appRequest("q1", "resolved"), appRequest("q2")] }), ["q1"], 1)).toEqual({ kind: "settled", requestId: "q2" });
    expect(nextStep(projection({ runtimeRequests: [appRequest("q1")] }), [], 0)).toEqual({ kind: "settled", requestId: "q1" });
    // Provider approvals (no connectedAppTool) are not the app's.
    expect(nextStep(projection({ runtimeRequests: [{ id: "p1", status: "pending" }] }), [], 0)).toEqual({ kind: "wait" });
  });

  it("fails a turn that ended early or completed without a pending approval; earlier runs do not count", () => {
    expect(nextStep(projection({ runs: [{ id: "r1", status: "failed" }] }), [], 0)).toMatchObject({ kind: "failed", reason: expect.stringMatching(/ended failed/) });
    expect(nextStep(projection({ runs: [{ id: "r1", status: "completed" }] }), [], 0)).toMatchObject({ kind: "failed" });
    expect(nextStep(projection({ runs: [{ id: "old", status: "failed" }, { id: "r1", status: "running" }] }), [], 0, new Set(["old"]))).toEqual({ kind: "wait" });
  });

  it("keys the script by the thread's next run ordinal", () => {
    expect(Object.keys(scriptsFor({ runs: [] }, [{ assistantText: "x" }]))).toEqual(["1"]);
    expect(Object.keys(scriptsFor({ runs: [{ id: "a", ordinal: 3, status: "completed" }] }, [{ assistantText: "x" }]))).toEqual(["4"]);
  });
});

describe("pane checks (pane-checks.ts)", () => {
  const main = (over: Partial<PaneMainFacts> = {}): PaneMainFacts => ({
    cards: 3,
    approvals: [{ title: "Approve rw_engine_simulate", buttons: ["Decline", "Approve"], visible: true }],
    chips: [{ ref: "rw:c/fins", removable: true }],
    footerButtons: ["Scripted", "Supervised", "Contextual · Off"],
    switcher: false,
    assistantMessages: 2,
    view: { box: [125, 598], out: [] },
    ...over,
  });
  const card = (over: Partial<CardFrameFacts> = {}): CardFrameFacts => ({ kind: "flight", phase: "complete", layout: "narrow", chip: "Saved", title: "Baseline run ›", stats: 3, points: 240, ...over });
  const step = (over: Partial<CardFrameFacts> = {}): CardFrameFacts => ({ kind: "step", phase: "complete", layout: "compact", chip: null, title: "Flight runs Step 4 · 3 changed Compare", stats: 0, points: 0, ...over });
  const want = { cards: ["flight"] as const, mention: "rw:c/fins" };

  it("passes the staged state", () => {
    expect(paneFailures(main(), [null, card(), null], want)).toEqual([]);
    expect(paneFailures(main(), [step(), card(), step({ title: "Assembly layout" })], { ...want, cards: ["flight", "step"] })).toEqual([]);
    const view = card({ kind: "visual", layout: "narrow", chip: null, title: "Section view · Study 01 Open", stats: 0, points: 0 });
    expect(paneFailures(main(), [view, { ...step(), kind: "render", title: "Profile view" }], { ...want, cards: ["visual", "render"] })).toEqual([]);
    // Out of view is reported in the facts, not failed.
    expect(paneFailures(main({ view: { box: [125, 598], out: ["user bubble (-40..10 of 473)"] } }), [card()], want)).toEqual([]);
  });

  it("wants one run card (no duplicate per poll) and each wanted card ready (CPW1R3A)", () => {
    expect(paneFailures(main(), [card(), card(), card()], want)[0]).toMatch(/3 flight run cards, not one/);
    expect(paneFailures(main(), [card()], { ...want, cards: ["flight", "step"] })[0]).toMatch(/no step card/);
    expect(paneFailures(main(), [card(), step({ phase: "waiting" })], { ...want, cards: ["flight", "step"] })[0]).toMatch(/step card is not ready/);
    expect(paneFailures(main(), [card({ kind: "visual", phase: "complete", title: "" })], { ...want, cards: ["visual"] })[0]).toMatch(/visual run card is not ready/);
  });

  it("names each missing piece", () => {
    expect(paneFailures(null, [], want)).toEqual(["no embedded Lecturn pane"]);
    expect(paneFailures(main(), [card({ kind: "engine" })], want)[0]).toMatch(/no flight run card/);
    expect(paneFailures(main(), [card({ phase: "running", points: 0 })], want)[0]).toMatch(/not ready/);
    expect(paneFailures(main(), [card({ layout: "wide", chip: null })], want)).toEqual([expect.stringMatching(/wide form/), expect.stringMatching(/chip reads null/)]);
    expect(paneFailures(main(), [card({ stats: 2 })], want)[0]).toMatch(/2 stats/);
    expect(paneFailures(main({ approvals: [] }), [card()], want)[0]).toMatch(/0 app approval cards/);
    expect(paneFailures(main({ approvals: [{ title: "x", buttons: ["Approve"], visible: true }] }), [card()], want)[0]).toMatch(/buttons/);
    expect(paneFailures(main({ chips: [] }), [card()], want)[0]).toMatch(/no rw:c\/fins chip/);
    expect(paneFailures(main({ chips: [{ ref: "rw:c/fins", removable: false }] }), [card()], want)[0]).toMatch(/remove button/);
    expect(paneFailures(main({ footerButtons: ["Full access"] }), [card()], want)[0]).toMatch(/Supervised/);
    expect(paneFailures(main({ switcher: true }), [card()], want)[0]).toMatch(/switcher/);
  });
});

describe("bar report (visual.ts)", () => {
  it("names the embedded pane's checked scenario", () => {
    expect(driveLines({ state: { view: "iso" }, pane: { scenario: "visual-01", run: { tools: ["a", "b", "c"] } } })).toEqual(['  state {"view":"iso"}', "  pane visual-01 checked (3 tool rows, one approval pending)"]);
  });

  it("says whether the live turn is in view (CPW1R3A)", () => {
    const at = (out: string[]) => driveLines({ state: {}, pane: { scenario: "visual-06", run: { tools: [] }, pane: { main: { view: { box: [125, 598], out } } } } }).at(-1);
    expect(at([])).toBe("  pane live turn in view");
    expect(at(["user bubble (-40..10 of 473)", "card 1 (-12..250 of 473)"])).toBe("  pane out of view: user bubble (-40..10 of 473); card 1 (-12..250 of 473)");
  });
});

describe("bar Lecturn dirs (lecturn-env.ts)", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("gives a page fresh dirs with the scripted provider on", () => {
    const l = lecturnEnv({ LECTURN_HOME: "/x/home", RW_LECTURN_BASE_DIR: "/x/base" }, "rw-b13-test-", { scripted: true });
    made.push(l.dir!);
    expect(l.env["LECTURN_HOME"]).not.toBe("/x/home");
    expect(l.env["LECTURN_TEST_PROVIDERS"]).toBe("1");
    expect(l.env["LECTURN_SCRIPTED_PROVIDER_SCRIPTS"]).toBe(join(l.env["RW_LECTURN_BASE_DIR"]!, "rw-scripted.json"));
    expect(JSON.parse(readFileSync(join(l.env["RW_LECTURN_BASE_DIR"]!, "userdata", "settings.json"), "utf8"))).toEqual(SCRIPTED_SETTINGS);
    l.cleanup();
    expect(existsSync(l.dir!)).toBe(false);
  });

  it("keeps the caller's pair unless asked for fresh dirs", () => {
    const kept = lecturnEnv({ LECTURN_HOME: "/x/home", RW_LECTURN_BASE_DIR: "/x/base" }, "rw-b13-test-");
    expect(kept).toMatchObject({ env: { LECTURN_HOME: "/x/home", RW_LECTURN_BASE_DIR: "/x/base" }, dir: null });
    const made1 = lecturnEnv({}, "rw-b13-test-");
    made.push(made1.dir!);
    expect(made1.env["RW_LECTURN_BASE_DIR"]).toBe(join(made1.dir!, "base"));
    expect(made1.env["LECTURN_TEST_PROVIDERS"]).toBeUndefined();
    kept.cleanup();
  });

  it("names a temp Electron profile every time, never the real userData (CPW2B)", () => {
    const fresh = lecturnEnv({}, "rw-b13-test-", { scripted: true });
    made.push(fresh.dir!);
    expect(fresh.env["RW_USER_DATA_DIR"]).toBe(join(fresh.dir!, "electron"));
    const kept = lecturnEnv({ LECTURN_HOME: "/x/home", RW_LECTURN_BASE_DIR: "/x/base" }, "rw-b13-test-");
    const profile = kept.env["RW_USER_DATA_DIR"]!;
    expect(profile.startsWith(tmpdir())).toBe(true);
    expect(existsSync(profile)).toBe(true);
    kept.cleanup();
    expect(existsSync(profile)).toBe(false);
    const callers = lecturnEnv({ LECTURN_HOME: "/x/home", RW_LECTURN_BASE_DIR: "/x/base", RW_USER_DATA_DIR: "/x/electron" }, "rw-b13-test-");
    expect(callers.env["RW_USER_DATA_DIR"]).toBe("/x/electron");
    for (const l of [fresh, kept, callers]) expect(l.env["RW_USER_DATA_DIR"]).not.toMatch(/Application Support/);
  });
});
