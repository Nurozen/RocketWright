/**
 * B16b: W-B2 step 3 (`scripts/bar/mention.ts`): the span strings a turn's
 * `rw_model_get` / `rw_design_check` results carry, the evaluator (pass;
 * span missing; span from a different turn; chip not selecting; chip not
 * inserted), `driveMention` against a fake embed session, the guest and
 * page readers on jsdom, the rehearsal fixture and `--no-mention`.
 */
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalDecision, TimelineEvent } from "../../../scripts/bar/transcript-events.ts";
import type { JsonObject, JsonValue } from "../../packages/contracts/src/types.ts";
import type { ApprovalAnswerer, RuntimeMode } from "../../../scripts/bar/lecturn-admin.ts";
import { B4B_REHEARSAL_FIXTURE, parseArgs, transcriptOf, type Transcript } from "../../../scripts/bar/live-smoke.ts";
import {
  containsExact,
  driveMention,
  foldedPrompt,
  isMentionSession,
  judgeMention,
  MENTION_PROMPT,
  MENTION_REF,
  MENTION_REHEARSAL_FIXTURE,
  readAppSelection,
  replyOf,
  selectsOnly,
  spanStrings,
  spansOfTurn,
  type AppSelection,
  type MentionObservation,
  type MentionSession,
  type StripChip,
} from "../../../scripts/bar/mention.ts";
import { REPO_ROOT } from "../bar/paths.ts";
import type { CardFrameFacts } from "../capture/pane-checks.ts";
import { loadTurnFixture, mergeTurnFixtures, readStripChips, replyChipPoint, type ApprovalCardView, type TrustedClick } from "../embed.ts";

const FINS = { id: "fins", name: "fins", parent: "body", shape: { type: "trapezoidal_fin_set", count: 3, root_chord: 0.06, tip_chord: 0.03, span: 0.045, sweep: 0.03 } };
const BODY = { id: "body", name: "body", shape: { type: "body_tube", length: 0.35 } };
const WHOLE: JsonObject = { model_hash: "h", path: "", model: { components: [BODY, FINS] } };
const SUBTREE: JsonObject = { model_hash: "h", path: "/components/4", value: FINS };
const CHECK: JsonObject = { dims: { length: 0.45, max_diameter: 0.0248, fin_span: 0.1148 }, diagnostics: [] };
const FOLDED = foldedPrompt(MENTION_PROMPT, [MENTION_REF]);

/** A transcript of one turn: the user's text, tool calls with outputs, the reply. */
function turn(o: { prompt?: string; calls?: Array<{ tool: string; output: JsonValue; isError?: boolean }>; reply?: string; status?: "complete" | "interrupted" | null }): Transcript {
  const turnId = "r2";
  const prompt = o.prompt ?? FOLDED;
  const events: TimelineEvent[] = [{ type: "user_message", turnId, text: prompt, mentions: [] }];
  (o.calls ?? []).forEach((c, i) => {
    events.push({ type: "tool_call", turnId, callId: `c${i}`, tool: c.tool, input: {} });
    events.push({ type: "tool_result", turnId, callId: `c${i}`, isError: c.isError ?? false, output: c.output });
  });
  if (o.reply !== undefined) events.push({ type: "assistant_text", turnId, text: o.reply, final: false });
  if (o.status !== null) events.push({ type: "turn_end", turnId, status: o.status ?? "complete" });
  return transcriptOf("th", events, prompt);
}

const sel = (viewport: string[] | null, inspector: string | null = viewport?.[0] ?? null): AppSelection => ({ page: "assembly", viewport, inspector, labels: viewport ?? [] });
const CLICKED: TrustedClick = { clicked: true, detail: "(120, 640), the last of 1" };
const STRIP: StripChip[] = [{ ref: MENTION_REF, label: "fins" }];

function obs(o: Partial<MentionObservation> = {}): MentionObservation {
  return {
    strip: STRIP,
    transcript: turn({ calls: [{ tool: "model_get", output: SUBTREE }], reply: "The span of rw:c/fins is 0.045 (m)." }),
    timedOut: false,
    wallMs: 1200,
    selectionBefore: sel(["body"]),
    chipClick: CLICKED,
    selectionAfterClick: sel(["fins"]),
    errors: [],
    ...o,
  };
}

describe("the span a turn's results carry (mention.ts)", () => {
  it("folds the strip's refs ahead of the prompt the way Lecturn sends them", () => {
    expect(foldedPrompt("How long?", ["rw:c/fins"])).toBe("rw:c/fins\n\nHow long?");
    expect(foldedPrompt("How long is rw:c/fins ?", ["rw:c/fins"])).toBe("How long is rw:c/fins ?");
    expect(foldedPrompt("Q", ["rw:c/fins", "rw:c/body", "rw:c/fins"])).toBe("rw:c/fins rw:c/body\n\nQ");
    expect(foldedPrompt(" ", ["rw:c/fins"])).toBe("rw:c/fins");
    // The live question never names the ref itself: the chip has to carry it.
    expect(MENTION_PROMPT.split(/\s+/)).not.toContain(MENTION_REF);
    expect(FOLDED.startsWith(`${MENTION_REF}\n\n`)).toBe(true);
  });

  it("reads the fins' span from model_get (whole model, subtree, below the component) and design_check", () => {
    expect(spanStrings("model_get", WHOLE)).toEqual(["0.045"]);
    expect(spanStrings("model_get", SUBTREE)).toEqual(["0.045"]);
    expect(spanStrings("model_get", { model_hash: "h", path: "/components/4/shape", value: FINS.shape })).toEqual(["0.045"]);
    // CP-W3 1-claude-a3: the span leaf itself.
    expect(spanStrings("model_get", { model_hash: "h", path: "/components/4/shape/span", value: 0.045 })).toEqual(["0.045"]);
    expect(spanStrings("model_get", { model_hash: "h", path: "/components/4/id", value: "fins" })).toEqual([]);
    expect(spanStrings("model_get", { model_hash: "h", path: "/components/1", value: BODY })).toEqual([]);
    expect(spanStrings("design_check", CHECK)).toEqual(["0.1148"]);
    expect(spanStrings("model_get", { model_hash: "h", path: "", model: { components: [{ ...FINS, shape: { ...FINS.shape, span: "45 mm" } }] } })).toEqual(["45 mm"]);
    // Only the span tools count.
    expect(spanStrings("model_patch", WHOLE)).toEqual([]);
    expect(spanStrings("model_get", null)).toEqual([]);
  });

  it("takes only the turn's successful results and its assistant text", () => {
    const t = turn({ calls: [{ tool: "model_get", output: SUBTREE }, { tool: "design_check", output: CHECK }, { tool: "model_get", output: { ...SUBTREE, value: { ...FINS, shape: { ...FINS.shape, span: 0.05 } } }, isError: true }], reply: "a" });
    expect(spansOfTurn(t)).toEqual(["0.045", "0.1148"]);
    expect(replyOf(turn({ reply: "one" }))).toBe("one");
    expect(spansOfTurn(null)).toEqual([]);
  });

  it("matches the span as a whole value only", () => {
    expect(containsExact("The span is 0.045 (m).", "0.045")).toBe(true);
    expect(containsExact("span=0.045", "0.045")).toBe(true);
    expect(containsExact("span 10.045 m", "0.045")).toBe(false);
    expect(containsExact("span 0.0451 m", "0.045")).toBe(false);
    expect(containsExact("span 45 mm", "0.045")).toBe(false);
    expect(containsExact("it is 45 mm", "45 mm")).toBe(true);
    expect(containsExact("anything", "")).toBe(false);
  });
});

describe("judgeMention (W-B2 step 3)", () => {
  it("passes: chip inserted, the reply quotes this turn's span, the chip click selects the fins", () => {
    const r = judgeMention(obs());
    expect(r.reasons).toEqual([]);
    expect(r).toMatchObject({ status: "pass", inserted: true, spanFromTool: ["0.045"], replySpan: "0.045", replyContainsSpan: true, chipClicked: true, toolCalls: 1, tools: ["model_get"], wallMs: 1200, turn_status: "complete" });
    expect(r.selectionAfterClick?.viewport).toEqual(["fins"]);
  });

  it("fails when the span is missing from the reply", () => {
    const r = judgeMention(obs({ transcript: turn({ calls: [{ tool: "model_get", output: SUBTREE }], reply: "The fins span 45 mm." }) }));
    expect(r.status).toBe("red");
    expect(r.replyContainsSpan).toBe(false);
    expect(r.reasons).toEqual([expect.stringMatching(/^mention: the reply does not contain the span the turn's results returned \(0\.045\)/)]);
  });

  it("fails when the span came from a different turn", () => {
    const earlier = turn({ prompt: "Design a rocket", calls: [{ tool: "model_get", output: WHOLE }], reply: "done" });
    const r = judgeMention(obs({ transcript: turn({ reply: "From before: rw:c/fins spans 0.045." }), earlier: [earlier] }));
    expect(r.status).toBe("red");
    expect(r.spanFromTool).toEqual([]);
    expect(r.reasons).toEqual(["mention: no rw_model_get or rw_design_check result in this turn carries the fins' span (the reply's 0.045 comes from an earlier turn)"]);
    // A failed read in the turn does not count either.
    const failed = judgeMention(obs({ transcript: turn({ calls: [{ tool: "model_get", output: SUBTREE, isError: true }], reply: "0.045" }) }));
    expect(failed.reasons).toEqual([expect.stringMatching(/no rw_model_get or rw_design_check result in this turn/)]);
  });

  it("fails when the chip click does not select the fins, or no chip could be clicked", () => {
    const stays = judgeMention(obs({ selectionAfterClick: sel(["body"]) }));
    expect(stays.status).toBe("red");
    expect(stays.reasons).toEqual([expect.stringMatching(/^mention: clicking the reply's rw:c\/fins did not select the fins/)]);
    const both = judgeMention(obs({ selectionAfterClick: sel(["fins", "body"]) }));
    expect(both.reasons).toEqual([expect.stringMatching(/did not select the fins/)]);
    const none = judgeMention(obs({ chipClick: { clicked: false, detail: "no rw:c/fins chip in the reply" }, selectionAfterClick: sel(["body"]) }));
    expect(none.chipClicked).toBe(false);
    expect(none.reasons).toEqual(["mention: no rw:c/fins chip in the reply could be clicked (no rw:c/fins chip in the reply)"]);
    const already = judgeMention(obs({ selectionBefore: sel(["fins"]) }));
    expect(already.reasons).toEqual([expect.stringMatching(/already the selection before the click/)]);
  });

  it("fails when the viewport put no chip in the strip, the message lacks the ref, or the turn did not complete", () => {
    const r = judgeMention(obs({ strip: [], transcript: turn({ prompt: MENTION_PROMPT, calls: [{ tool: "model_get", output: SUBTREE }], reply: "0.045", status: "interrupted" }) }));
    expect(r.inserted).toBe(false);
    expect(r.reasons).toEqual([
      'mention: the viewport\'s @ on fins put no rw:c/fins chip in the composer strip (strip: [])',
      "mention: the turn ended interrupted",
      "mention: the sent message does not carry rw:c/fins",
    ]);
    expect(judgeMention(obs({ transcript: null })).reasons[0]).toBe("mention: no turn carries the question with rw:c/fins folded in");
    expect(judgeMention(obs({ timedOut: true })).reasons[0]).toMatch(/did not finish within 5 min/);
  });

  it("reads selection as the viewport's sole part, with the inspector following", () => {
    expect(selectsOnly(sel(["fins"]))).toBe(true);
    expect(selectsOnly(sel(["fins"], "body"))).toBe(false);
    expect(selectsOnly(sel(null))).toBe(false);
    expect(selectsOnly(null)).toBe(false);
  });
});

/** Plays the app and Lecturn for the mention step. */
class FakeMentionSession implements MentionSession {
  readonly projectDir = "/tmp/b4b";
  threadId: string | null = "th";
  strip: StripChip[] = [];
  selected: string[] = [];
  sent: string[] = [];
  modes: RuntimeMode[] = [];
  events: TimelineEvent[] = [];
  /** Knobs. */
  chipSelects = true;
  reply = "The span of rw:c/fins is 0.045 (m).";

  async mentionFromViewport(part: string) {
    this.selected = [part];
    this.strip.push({ ref: `rw:c/${part}`, label: part });
    return { chips: [...this.strip], detail: `picked ${part}` };
  }
  async pickPart(part: string) {
    this.selected = [part];
  }
  async selection(): Promise<AppSelection> {
    return sel([...this.selected]);
  }
  async clickReplyChip(ref: string): Promise<TrustedClick> {
    if (!this.reply.includes(ref)) return { clicked: false, detail: `no ${ref} chip in the reply` };
    if (this.chipSelects) this.selected = [ref.slice("rw:c/".length)];
    return CLICKED;
  }
  async setRuntimeMode(mode: RuntimeMode) {
    this.modes.push(mode);
  }
  async sendInThread(prompt: string) {
    const text = foldedPrompt(prompt, this.strip.map((c) => c.ref));
    this.strip = [];
    this.sent.push(text);
    const turnId = "r2";
    this.events = [
      { type: "user_message", turnId, text, mentions: [] },
      { type: "tool_call", turnId, callId: "c1", tool: "model_get", input: { path: "/components/4" } },
      { type: "tool_result", turnId, callId: "c1", isError: false, output: SUBTREE },
      { type: "assistant_text", turnId, text: this.reply, final: false },
      { type: "turn_end", turnId, status: "complete" },
    ];
  }
  async promptTurn(prompt: string) {
    const u = this.events[0];
    return u?.type === "user_message" && u.text === prompt ? { threadId: "th", turnId: "r2", events: [...this.events] } : null;
  }
  async watchApprovalCards() {}
  async approvalCardsSeen(): Promise<string[]> {
    return [];
  }
  async approvalCards(): Promise<ApprovalCardView[]> {
    return [];
  }
  async runCards(): Promise<CardFrameFacts[]> {
    return [];
  }
  async answerApprovals(): Promise<ApprovalAnswerer> {
    return { log: [], provider: [], errors: [], tick: async () => undefined, stop: async () => undefined };
  }
  async send() {}
  async pendingApprovals(): Promise<string[]> {
    return [];
  }
  async respond(_id: string, _d: ApprovalDecision) {}
  async interrupt() {}
  async appRuns() {
    return { model_hash: "h", runs: [] };
  }
  async showResults() {
    return { visible: false, via: null, row: null };
  }
  async screenshot() {
    return false;
  }
  async close() {}
}

async function drive(s: FakeMentionSession) {
  const dir = mkdtempSync("/tmp/rw-mention-");
  try {
    const r = await driveMention(s, { outDir: dir, pollMs: 1, timeoutMs: 5_000, selectTimeoutMs: 20 });
    expect(JSON.parse(readFileSync(join(dir, "mention.json"), "utf8"))).toMatchObject({ status: r.status, inserted: r.inserted });
    return r;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("driveMention", () => {
  it("passes: the viewport's chip goes out folded, the reply quotes the turn's span, the click moves the selection to the fins", async () => {
    const s = new FakeMentionSession();
    expect(isMentionSession(s)).toBe(true);
    const r = await drive(s);
    expect(r.reasons).toEqual([]);
    expect(s.sent).toEqual([FOLDED]);
    expect(s.modes).toEqual(["approval-required"]);
    expect(r.selectionBefore?.viewport).toEqual(["body"]);
    expect(r.selectionAfterClick?.viewport).toEqual(["fins"]);
    expect(r).toMatchObject({ status: "pass", spanFromTool: ["0.045"], replyContainsSpan: true, chipClicked: true, toolCalls: 1 });
  });

  it("goes red when the chip click leaves the selection alone, and not-run without a thread", async () => {
    const s = new FakeMentionSession();
    s.chipSelects = false;
    const r = await drive(s);
    expect(r.status).toBe("red");
    expect(r.reasons).toEqual([expect.stringMatching(/did not select the fins/)]);
    const none = new FakeMentionSession();
    none.threadId = null;
    expect((await drive(none)).status).toBe("not-run");
    expect(isMentionSession({ setRuntimeMode() {} })).toBe(false);
  });
});

// jsdom is the server package's test dependency (not hoisted to app/).
const { JSDOM } = createRequire(join(REPO_ROOT, "app/apps/server/package.json"))("jsdom") as { JSDOM: new (html: string) => { window: unknown } };
const saved: Record<string, unknown> = {};
function page(html: string): Window {
  const w = new JSDOM(`<!doctype html><body>${html}</body>`).window as unknown as Window & typeof globalThis;
  // jsdom lays nothing out: elements marked data-box are on screen, and the point hits the last one.
  w.Element.prototype.getBoundingClientRect = function (this: Element) {
    const on = this.closest("[data-box]") !== null;
    return { width: on ? 40 : 0, height: on ? 20 : 0, top: 100, left: 10, right: 50, bottom: 120, x: 10, y: 100, toJSON: () => ({}) } as DOMRect;
  };
  w.document.elementFromPoint = () => Array.from(w.document.querySelectorAll("[data-box]")).at(-1) ?? null;
  for (const k of ["window", "document", "HTMLElement"] as const) {
    saved[k] = (globalThis as Record<string, unknown>)[k];
    (globalThis as Record<string, unknown>)[k] = k === "window" ? w : (w as unknown as Record<string, unknown>)[k];
  }
  return w;
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v;
});

describe("the guest and page readers (embed.ts, mention.ts)", () => {
  const STRIP_HTML = `<div data-testid="app-ref-chip-strip"><span data-testid="app-ref-chip" data-app-ref="rw:c/fins"><img alt=""><span>Fins</span><button aria-label="Remove Fins"></button></span></div>`;

  it("reads the composer strip's chips", () => {
    page(STRIP_HTML);
    expect(readStripChips()).toEqual([{ ref: "rw:c/fins", label: "Fins" }]);
  });

  it("finds the reply's chip, never the user's message or the strip", () => {
    page(`<div data-message-role="user"><button data-app-ref="rw:c/fins" data-box>rw:c/fins</button></div>
      <div data-message-role="assistant"><p>The span of <button data-app-ref="rw:c/body">rw:c/body</button> <button data-app-ref="rw:c/fins" data-box>rw:c/fins</button> is 0.045.</p></div>${STRIP_HTML}`);
    expect(replyChipPoint("rw:c/fins")).toEqual({ x: 30, y: 110, hit: true, count: 1 });
    expect(replyChipPoint("rw:c/nose")).toEqual({ error: "no rw:c/nose chip in the reply" });
    expect(replyChipPoint("rw:c/body")).toEqual({ error: "the reply's rw:c/body chip has no box" });
    page(`<p><button data-app-ref="rw:c/fins" data-box>rw:c/fins</button></p><div data-box>overlay</div>`);
    expect(replyChipPoint("rw:c/fins")).toMatchObject({ hit: false });
  });

  it("reads the app's selection state from the viewport, the inspector and the labels", () => {
    page(`<div data-testid="app-shell" data-page="assembly"><div data-testid="viewport" data-selected="fins"></div><aside data-testid="inspector" data-part="fins"></aside>
      <button data-testid="vp.leader-label" data-part="fins" data-selected="true"></button><button data-testid="vp.leader-label" data-part="body" data-selected="false"></button></div>`);
    expect(readAppSelection()).toEqual({ page: "assembly", viewport: ["fins"], inspector: "fins", labels: ["fins"] });
    page(`<div data-testid="app-shell" data-page="results"></div>`);
    expect(readAppSelection()).toEqual({ page: "results", viewport: null, inspector: null, labels: [] });
    page(`<div data-testid="viewport" data-selected=""></div>`);
    expect(readAppSelection().viewport).toEqual([]);
  });
});

describe("the rehearsal (scripted/b4b-mention.json) and the flag", () => {
  it("is run 2 of the B4(b) thread: rw_model_get of the fins, a reply quoting its span with the chip", () => {
    const f = loadTurnFixture(MENTION_REHEARSAL_FIXTURE);
    expect(f.prompt).toBe(MENTION_PROMPT);
    expect(Object.keys(f.scripts)).toEqual(["2"]);
    const script = f.scripts["2"]!;
    expect(script[0]).toEqual({ toolCall: { name: "rw_model_get", arguments: { path: "/components/4" } }, saveAs: "fins" });
    const text = script.flatMap((s) => ("assistantText" in s ? [s.assistantText] : [])).join("\n");
    // The minimum template's fins: span = "45 mm" → 0.045 in SI.
    expect(readFileSync(join(REPO_ROOT, "templates/minimum/rocket.rw.toml"), "utf8")).toMatch(/\[c\.fins\][^[]*span = "45 mm"/);
    expect(containsExact(text, "0.045")).toBe(true);
    expect(text.split(/\s+/)).toContain(MENTION_REF);
  });

  it("merges with the B4(b) turn and refuses a run ordinal claimed twice", () => {
    const merged = mergeTurnFixtures([B4B_REHEARSAL_FIXTURE, MENTION_REHEARSAL_FIXTURE]);
    expect(Object.keys(merged.scripts).sort()).toEqual(["1", "2"]);
    expect(merged.prompt).toBe(loadTurnFixture(B4B_REHEARSAL_FIXTURE).prompt);
    expect(() => mergeTurnFixtures([MENTION_REHEARSAL_FIXTURE, MENTION_REHEARSAL_FIXTURE])).toThrow(/run 2 is already scripted/);
    expect(() => mergeTurnFixtures([])).toThrow(/no turn fixture/);
  });

  it("--no-mention skips the step; it runs by default", () => {
    const on = parseArgs(["--rehearse"]);
    const off = parseArgs(["--rehearse", "--no-mention"]);
    expect(typeof on === "string" ? on : on.mention).toBe(true);
    expect(typeof off === "string" ? off : off.mention).toBe(false);
  });
});
