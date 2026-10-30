/**
 * W-B2 step 3 (CP-W2 step 3, B16b): the `rw:c/fins` mention and the span
 * question, then the reply's chip. Spec: "insert `rw:c/fins` from the
 * viewport and ask for that part's span; pass if the reply contains the
 * exact span string returned by an `rw_model_get` or `rw_design_check`
 * result in the same turn; clicking `rw:c/fins` in the reply selects the
 * fins (checked via the app's selection state)".
 *
 * `driveMention` runs in the B4(b) thread, as its next turn, before the app
 * closes (`live-smoke.ts` main; `--rehearse` replays
 * `app/e2e/fixtures/scripted/b4b-mention.json` as run 2):
 *
 * 1. the user's viewport path (`EmbedSession.mentionFromViewport`): Design >
 *    Assembly, a click on the fins' leader label (the viewport pick), then
 *    its `@` (`vp.mention`): the app's `MENTION_EVENT` → `insertMention`
 *    (`apps/web/src/embed/wiring.ts`) puts the chip in the composer strip
 *    above the input (`[data-testid="app-ref-chip"]`);
 * 2. the question as the draft (`composer.setDraft`) and Send: Lecturn folds
 *    the chip into the message (`rw:c/fins\n\n<question>`,
 *    `promptWithAppReferences`), so the turn is found by that text;
 * 3. after the turn: the span strings from the turn's own `rw_model_get` /
 *    `rw_design_check` results (`spanStrings`) and the reply's text;
 * 4. another part is picked (the selection is not the fins), then the
 *    reply's `rw:c/fins` chip gets the user's trusted click
 *    (`sendInputEvent`, `embed.ts` `trustedClickInGuest`): the guest's
 *    `lecturn/navigate` → `openRef`, read back from the app's selection
 *    state (`readAppSelection`: the viewport's `data-selected`, the
 *    inspector, the selected leader labels).
 *
 * Recorded in `result.mention` and `<out>/mention/mention.json`, apart from
 * the B4(b) turn's limits.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "../../app/packages/contracts/src/types.ts";
import { round, stableStringify } from "../../app/e2e/bar/paths.ts";
import type { TrustedClick } from "../../app/e2e/embed.ts";
import { checkTurn, type EmbedTurnSession, type Transcript } from "./live-smoke.ts";

/** The part and its ref (spec W-B2 step 3). */
export const MENTION_PART = "fins";
export const MENTION_REF = `rw:c/${MENTION_PART}`;
/** A part the driver picks before the chip click, so the click has to move the selection to the fins. */
export const MENTION_OTHER_PART = "body";
/**
 * The question typed beside the chip. It names the tool, so the span comes
 * from this turn's result, and asks for the part's ref in the reply (the
 * chip to click). It never names the ref itself: the chip carries it.
 */
export const MENTION_PROMPT = "What is the span of this part? Read it now with rw_model_get, quote the span value exactly as the tool returns it, and name the part by the rw: reference I attached.";
/** `--rehearse`: run 2 of the B4(b) thread replays `app/e2e/fixtures/scripted/<this>.json`. */
export const MENTION_REHEARSAL_FIXTURE = "b4b-mention";
export const MENTION_TIMEOUT_MS = 5 * 60_000;
/** Tools whose results may carry the span (spec). */
export const SPAN_TOOLS: readonly string[] = ["model_get", "design_check"];

/**
 * The message text Lecturn sends for a prompt with chips (Lecturn
 * `promptWithAppReferences`, `@lecturn/shared/appReferences`): each ref the
 * prompt does not already name, on one line ahead of it.
 */
export function foldedPrompt(prompt: string, refs: readonly string[]): string {
  const present = new Set(prompt.split(/\s+/u));
  const added = [...new Set(refs)].filter((r) => r.length > 0 && !present.has(r));
  if (added.length === 0) return prompt;
  const line = added.join(" ");
  return prompt.trim().length === 0 ? line : `${line}\n\n${prompt}`;
}

const isObject = (v: unknown): v is Record<string, JsonValue> => typeof v === "object" && v !== null && !Array.isArray(v);
const asString = (v: JsonValue | undefined): string | null => (typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Every `key` value under `v` (numbers as JSON prints them, strings as they are). */
function valuesOf(v: JsonValue | undefined, keys: ReadonlySet<string>, out: string[]): void {
  if (Array.isArray(v)) for (const x of v) valuesOf(x, keys, out);
  else if (isObject(v)) {
    for (const [k, x] of Object.entries(v)) {
      const s = keys.has(k) ? asString(x) : null;
      if (s !== null) out.push(s);
      else valuesOf(x, keys, out);
    }
  }
}

/** The objects under `v` that are the part (`id` or `component` is `part`). */
function partObjects(v: JsonValue | undefined, part: string, out: Record<string, JsonValue>[]): void {
  if (Array.isArray(v)) for (const x of v) partObjects(x, part, out);
  else if (isObject(v)) {
    if (v["id"] === part || v["component"] === part) out.push(v);
    else for (const x of Object.values(v)) partObjects(x, part, out);
  }
}

const SPAN = new Set(["span"]);

/**
 * The span strings one tool result carries for `part`:
 * - `model_get`: `span` inside the part's component (the whole model or a
 *   subtree that holds it); a subtree read below the component (no `id`,
 *   e.g. `/components/4/shape`, or the leaf `/components/4/shape/span`)
 *   counts when its pointer is the part's;
 * - `design_check`: `dims.fin_span` (tip to tip) and any `span` of the part.
 */
export function spanStrings(tool: string, output: JsonValue | null, part: string = MENTION_PART): string[] {
  if (output === null || !SPAN_TOOLS.includes(tool)) return [];
  const out: string[] = [];
  const objs: Record<string, JsonValue>[] = [];
  partObjects(output, part, objs);
  for (const o of objs) valuesOf(o, SPAN, out);
  if (tool === "model_get" && objs.length === 0 && isObject(output) && output["value"] !== undefined && typeof output["path"] === "string" && output["path"] !== "") {
    // A read below the component (no `id` in the subtree): its span is the part's when the pointer is.
    valuesOf(output["value"], SPAN, out);
    // A read of the span leaf itself (`/components/4/shape/span` → `{value: 0.045}`).
    const leaf = output["path"].split("/").at(-1);
    const s = leaf !== undefined && SPAN.has(leaf) ? asString(output["value"]) : null;
    if (s !== null) out.push(s);
  }
  if (tool === "design_check") valuesOf(output, new Set(["fin_span"]), out);
  return [...new Set(out)];
}

/** The span strings of a turn's successful `rw_model_get` / `rw_design_check` results. */
export function spansOfTurn(t: Transcript | null, part: string = MENTION_PART): string[] {
  const out = (t?.tool_calls ?? []).filter((c) => c.isError === false).flatMap((c) => spanStrings(c.tool, c.output, part));
  return [...new Set(out)];
}

/** The turn's assistant text, in order. */
export function replyOf(t: Transcript | null): string {
  return (t?.entries ?? []).flatMap((e) => (e.kind === "assistant" ? [e.text] : [])).join("\n");
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `needle` appears in `text` as a whole value: not inside a longer number (`0.045` is not in `10.0451`). */
export function containsExact(text: string, needle: string): boolean {
  if (needle === "") return false;
  const numeric = /^[-+]?\d/.test(needle);
  const re = numeric ? new RegExp(`(?<![\\d.])${escapeRe(needle)}(?![\\d])`) : new RegExp(escapeRe(needle));
  return re.test(text);
}

/** The composer strip's chips as the guest shows them (`[data-testid="app-ref-chip"]`). */
export interface StripChip {
  ref: string;
  label: string;
}

/** The app's selection state as the window shows it (the store's `selection` drives each of these). */
export interface AppSelection {
  /** `app-shell` `data-page`. */
  page: string | null;
  /** The assembly viewport's `data-selected` part ids; null without a viewport on the page. */
  viewport: string[] | null;
  /** The inspector's part. */
  inspector: string | null;
  /** Leader labels marked selected. */
  labels: string[];
}

/** Reads the app's selection state (runs in the app's page; nothing outside its body). */
export function readAppSelection(): AppSelection {
  const vp = document.querySelector('[data-testid="viewport"]');
  return {
    page: document.querySelector('[data-testid="app-shell"]')?.getAttribute("data-page") ?? null,
    viewport: vp === null ? null : (vp.getAttribute("data-selected") ?? "").split(",").filter((s) => s !== ""),
    inspector: document.querySelector('[data-testid="inspector"]')?.getAttribute("data-part") ?? null,
    labels: Array.from(document.querySelectorAll('[data-testid="vp.leader-label"][data-selected="true"]')).map((e) => e.getAttribute("data-part") ?? ""),
  };
}

/** The selection is exactly `part` (the viewport's selection, which the inspector follows). */
export function selectsOnly(s: AppSelection | null, part: string = MENTION_PART): boolean {
  return s !== null && s.viewport !== null && s.viewport.length === 1 && s.viewport[0] === part && (s.inspector === null || s.inspector === part);
}

/** The embed session's reach for the mention step (`app/e2e/b4b-live.ts` `EmbedSession`). */
export interface MentionSession extends EmbedTurnSession {
  /** The user's viewport path: Design > Assembly, the part's leader label (the pick), its `@`; then the strip's chips. */
  mentionFromViewport(part: string): Promise<{ chips: StripChip[]; detail: string }>;
  /** Picks a part in the viewport (its leader label). */
  pickPart(part: string): Promise<void>;
  /** The app's selection state now. */
  selection(): Promise<AppSelection>;
  /** The user's trusted click on the last `ref` chip in the timeline's reply (not the user's message, not the strip). */
  clickReplyChip(ref: string): Promise<TrustedClick>;
}

export function isMentionSession(s: unknown): s is MentionSession {
  const m = s as Partial<MentionSession> | null;
  return m !== null && typeof m === "object" && typeof m.mentionFromViewport === "function" && typeof m.clickReplyChip === "function" && typeof m.selection === "function";
}

/** What the mention step observed. */
export interface MentionObservation {
  /** The strip's chips after the viewport's `@`. */
  strip: StripChip[];
  transcript: Transcript | null;
  timedOut: boolean;
  wallMs: number;
  /** Earlier turns of the thread (the B4(b) turn), to name a span that came from one of them. */
  earlier?: readonly Transcript[];
  selectionBefore: AppSelection | null;
  chipClick: TrustedClick | null;
  selectionAfterClick: AppSelection | null;
  errors: string[];
}

export interface MentionResult {
  status: "pass" | "red" | "not-run";
  reasons: string[];
  ref: string;
  prompt: string;
  /** The chip landed in the composer strip from the viewport. */
  inserted: boolean;
  /** The span strings the turn's own `rw_model_get` / `rw_design_check` results returned. */
  spanFromTool: string[];
  /** The one of them the reply quotes, or null. */
  replySpan: string | null;
  replyContainsSpan: boolean;
  chipClicked: boolean;
  chipClick?: TrustedClick | null;
  selectionBefore?: AppSelection | null;
  selectionAfterClick: AppSelection | null;
  toolCalls: number;
  tools: string[];
  wallMs: number;
  turn_status?: string | null;
  reply?: string;
  strip?: StripChip[];
}

/** Applies the W-B2 step 3 rule to what was observed. */
export function judgeMention(o: MentionObservation, ref: string = MENTION_REF, part: string = MENTION_PART): MentionResult {
  const reasons: string[] = [];
  const inserted = o.strip.some((c) => c.ref === ref);
  if (!inserted) reasons.push(`mention: the viewport's @ on ${part} put no ${ref} chip in the composer strip (strip: ${JSON.stringify(o.strip.map((c) => c.ref))})`);
  const t = o.transcript;
  if (o.timedOut) reasons.push(`mention: the turn did not finish within ${Math.round(MENTION_TIMEOUT_MS / 60_000)} min`);
  else if (t === null) reasons.push(`mention: no turn carries the question with ${ref} folded in`);
  else if (t.turn_status !== "complete") reasons.push(`mention: the turn ended ${t.turn_status ?? "without a turn_end"}`);
  if (t !== null && !t.prompt.split(/\s+/u).includes(ref)) reasons.push(`mention: the sent message does not carry ${ref}`);

  const spans = spansOfTurn(t, part);
  const reply = replyOf(t);
  const replySpan = spans.find((s) => containsExact(reply, s)) ?? null;
  if (spans.length === 0) {
    const old = (o.earlier ?? []).flatMap((e) => spansOfTurn(e, part)).filter((s) => containsExact(reply, s));
    reasons.push(`mention: no rw_model_get or rw_design_check result in this turn carries the ${part}' span${old.length > 0 ? ` (the reply's ${old.join(", ")} comes from an earlier turn)` : ""}`);
  } else if (replySpan === null) reasons.push(`mention: the reply does not contain the span the turn's results returned (${spans.join(", ")}): ${JSON.stringify(reply.slice(0, 300))}`);

  const chipClicked = o.chipClick?.clicked === true;
  if (!chipClicked) reasons.push(`mention: no ${ref} chip in the reply could be clicked (${o.chipClick?.detail ?? "not tried"})`);
  if (selectsOnly(o.selectionBefore, part)) reasons.push(`mention: the ${part} were already the selection before the click, so it proves nothing`);
  if (chipClicked && !selectsOnly(o.selectionAfterClick, part)) reasons.push(`mention: clicking the reply's ${ref} did not select the ${part} (selection ${JSON.stringify(o.selectionAfterClick)})`);
  reasons.push(...o.errors.map((e) => `mention: ${e}`));
  return {
    status: reasons.length === 0 ? "pass" : "red",
    reasons,
    ref,
    prompt: t?.prompt ?? MENTION_PROMPT,
    inserted,
    spanFromTool: spans,
    replySpan,
    replyContainsSpan: replySpan !== null,
    chipClicked,
    chipClick: o.chipClick,
    selectionBefore: o.selectionBefore,
    selectionAfterClick: o.selectionAfterClick,
    toolCalls: t?.tool_calls.length ?? 0,
    tools: t?.tool_calls.map((c) => c.tool) ?? [],
    wallMs: o.wallMs,
    turn_status: t?.turn_status ?? null,
    reply,
    strip: o.strip,
  };
}

/** A mention step that could not run (no embedded pane, no thread). */
export function mentionNotRun(reason: string): MentionResult {
  return { status: "not-run", reasons: [reason], ref: MENTION_REF, prompt: MENTION_PROMPT, inserted: false, spanFromTool: [], replySpan: null, replyContainsSpan: false, chipClicked: false, selectionAfterClick: null, toolCalls: 0, tools: [], wallMs: 0 };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Runs W-B2 step 3 in the session's open thread (see the module comment); writes `mention.json` and `transcript.json` to `o.outDir`. */
export async function driveMention(
  s: MentionSession,
  o: { outDir: string; earlier?: readonly Transcript[]; timeoutMs?: number; pollMs?: number; selectTimeoutMs?: number; log?: (line: string) => void },
): Promise<MentionResult> {
  const log = o.log ?? (() => undefined);
  const errors: string[] = [];
  mkdirSync(o.outDir, { recursive: true });
  if (s.threadId === null) {
    const r = mentionNotRun("mention: no thread to ask in (the B4(b) prompt was never sent)");
    writeFileSync(join(o.outDir, "mention.json"), stableStringify(r));
    return r;
  }

  let strip: StripChip[] = [];
  try {
    const m = await s.mentionFromViewport(MENTION_PART);
    strip = m.chips;
    log(`mention: ${m.detail}; strip ${JSON.stringify(strip.map((c) => c.ref))}`);
  } catch (e) {
    errors.push(`the viewport mention: ${msg(e)}`);
  }

  const t0 = Date.now();
  const turn = await checkTurn(s, {
    prompt: MENTION_PROMPT,
    match: foldedPrompt(MENTION_PROMPT, [MENTION_REF]),
    mode: "approval-required",
    first: false,
    decide: () => "decline",
    timeoutMs: o.timeoutMs ?? MENTION_TIMEOUT_MS,
    pollMs: o.pollMs ?? 1000,
    log,
  });
  const wallMs = Date.now() - t0;
  errors.push(...turn.errors);
  log(`mention: turn ${turn.transcript?.turn_status ?? "absent"} in ${round(wallMs / 1000, 1)} s, ${turn.transcript?.tool_calls.length ?? 0} tool calls`);

  let selectionBefore: AppSelection | null = null;
  let chipClick: TrustedClick | null = null;
  let selectionAfterClick: AppSelection | null = null;
  try {
    await s.pickPart(MENTION_OTHER_PART);
    selectionBefore = await s.selection();
    chipClick = await s.clickReplyChip(MENTION_REF);
    log(`mention: reply chip ${chipClick.clicked ? "clicked" : "not clicked"} ${chipClick.detail}`);
    if (chipClick.clicked) {
      const end = Date.now() + (o.selectTimeoutMs ?? 10_000);
      for (;;) {
        selectionAfterClick = await s.selection();
        if (selectsOnly(selectionAfterClick) || Date.now() > end) break;
        await sleep(250);
      }
    } else selectionAfterClick = await s.selection();
  } catch (e) {
    errors.push(`the reply chip: ${msg(e)}`);
  }

  const result = judgeMention({ strip, transcript: turn.transcript, timedOut: turn.timedOut, wallMs, ...(o.earlier === undefined ? {} : { earlier: o.earlier }), selectionBefore, chipClick, selectionAfterClick, errors });
  if (turn.transcript !== null) writeFileSync(join(o.outDir, "transcript.json"), stableStringify(turn.transcript));
  writeFileSync(join(o.outDir, "mention.json"), stableStringify(result));
  try {
    if (await s.screenshot("chat-pane", join(o.outDir, "mention-pane.png"))) log("mention: captured the pane");
  } catch {
    /* the record says what happened */
  }
  return result;
}
