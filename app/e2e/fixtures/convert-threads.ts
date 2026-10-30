/**
 * `node app/e2e/fixtures/convert-threads.ts [--check] [--pages 01,06]`
 * (plan B13, spec W5.1): the capture thread fixtures
 * (`app/e2e/fixtures/threads/<page>.json`, seeded into the old chat through
 * `app_seed_thread`) as Lecturn thread bundles
 * (`tests/fixtures/lecturn/<page>.bundle.json`, Lecturn
 * `ConnectedAppThreadBundleV1`, imported with `apps.importThreads`).
 *
 * - Thread names, order and page bindings are kept (D30): one bundle project
 *   per page, its threads in fixture order (the last one is the thread a
 *   capture opens, pinned so Lecturn imports it active, not Settled); the
 *   binding is the thread's `appData`
 *   (`{"page":…}`, as the web's `appDataOf` writes it).
 * - The project is the `{workspaceRoot}` / `{projectName}` template, and
 *   every timestamp is relative to `FIXTURE_CLOCK` (a thread's `updatedAt` is
 *   the clock minus its `ageMs`); `app_seed_thread` substitutes both at
 *   import (`apps/server/src/lecturn/bundle.ts`).
 * - Each user message opens a turn and the next assistant message closes it.
 *   `[@label](rw:…)` links and the message's mentions become plain `rw:`
 *   refs in the text (Lecturn draws app refs as chips).
 * - Every app tool row is the item a live call leaves (CPW1R4A, captured from
 *   a live scripted turn: `fixtures/lecturn-live/tool-items.json`): the
 *   scripted provider's `toolName` `lecturn.rw_<tool>`, the presentation
 *   Lecturn's server stamps (`mcpToolPresentation`: the tool's declared MCP
 *   `title`, e.g. "Find motors" (CPW1R4B, Lecturn FIXH; the CLI's from the
 *   tool-parity golden, the window tools' `BROKER_OP_TITLES`), the app
 *   `toolSource`; the icon only when its data URL fits Lecturn's 4096-char
 *   cap, which the 128 px app icon does not), and as its output the
 *   CallToolResult AppToolkit returns (`content`, `structuredContent`,
 *   `_meta["lecturn/summary"]`, the only `lecturn/*` key it keeps since pin16,
 *   which also stopped stamping `_meta["lecturn/toolSource"]`: the row reads
 *   the item's `toolSource`; for a card tool, AppCardEnvelope's
 *   `structuredContent: { lecturnMcpApp, result }`, `prefersBorder` as the
 *   card's `resources/read` says).
 * - Not modelled: the other result `_meta` keys AppToolkit keeps from a live
 *   RocketWright result (the echoed `lecturn/context` and `lecturn/approval`,
 *   `rw/ctx`, `rw/error`). They carry the recording's project, thread and
 *   turn ids, and no client sees them (the wire projection,
 *   `compactDynamicToolOutput`, keeps only the summary of `_meta`).
 * - The row summary (`_meta["lecturn/summary"]`, the row's secondary text) is
 *   the fixture's: every step and card carries `summary`, phrased as the
 *   tool's live summary would read on the seeded project ("3 candidates",
 *   "Apogee 305 m"; `crates/rw-cli/src/mcp/presentation.rs`).
 * - An assistant's `steps` become app tool rows in order. A step's `card`
 *   is that call's MCP Apps card (the tool must draw that card,
 *   `TOOL_CARDS`): the real `ui://rw/step-card` or `ui://rw/run-card`
 *   document as a captured asset, so the imported thread shows the card
 *   (a step card's Compare goes to `rw:step/<n>`; a run card, ref
 *   `rw:sim/<sim>`, loads the sim's complete run, `{runId:<sim>}` filled in
 *   at import because run ids hash the model and core version, and its Open
 *   goes to `rw:run/<id>`, D8; on `run_diff` it draws the sims `a` and `b`,
 *   its ref naming `b`). A message's own `cards` (the old chat's
 *   result cards) still become an `rw_model_patch` (step) or `rw_simulate`
 *   (run) row with the card after the steps. Render cards are never
 *   captured (their picture is a stored render the seeded project lacks).
 * - Every thread carries Supervised (`runtimeMode: "approval-required"`) and
 *   the default interaction mode (Lecturn pin8, FIXM: a copy keeps its
 *   source's modes), as every W-B2 thread runs; a capture's scripted turn
 *   sets the same mode again. No `modelSelection`: the scripted provider's
 *   instance is not one an importing server always has, and a missing one
 *   makes Lecturn add a model-fallback notice row to the thread (the
 *   scripted turn sets the model itself).
 * - Lecturn imports a bundle as run-less history, so it never keeps an
 *   imported turn open: card-less rows next to each other fold into one
 *   "Used RocketWright integration" row, and the agent's text between calls
 *   goes behind a turn fold. The opened turns keep their rows apart with
 *   cards (`capture/pane-budget.ts` checks it).
 *
 * `--check` regenerates in memory and exits 1 when a committed bundle differs
 * (for example after an edit to a thread fixture, `step-card.html` or
 * `run-card.html`);
 * without it the bundles are written.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_OPS, BROKER_OP_TITLES, type BrokerOp } from "../../packages/contracts/src/broker.ts";
import {
  FIXTURE_CLOCK,
  PROJECT_NAME_TEMPLATE,
  WORKSPACE_ROOT_TEMPLATE,
  parseThreadBundle,
  type BundleAsset,
  type BundleInteractionMode,
  type BundleRuntimeMode,
  type BundleThread,
  type JsonObject,
  type JsonValue,
  type ThreadBundle,
  runIdTemplate,
} from "../../apps/server/src/lecturn/bundle.ts";
import { PAGES, REPO_ROOT, type PageId } from "../bar/paths.ts";
import type { SeedThread as CannedThread } from "../capture/hooks.ts";
import { TOOL_CARDS } from "../capture/scripted.ts";

/** `RW_APP_ID` and `RW_APP_NAME` (`apps/server/src/lecturn/registration.ts`). */
export const FIXTURE_APP_ID = "dev.rocketwright.app";
export const FIXTURE_APP_NAME = "RocketWright";
/** The registration's icon (`APP_ICON_PATH`). */
export const APP_ICON_PATH = join(REPO_ROOT, "app/apps/desktop/assets/app-icon-128.png");
/** Lecturn's cap on a tool row's icon URL (`MAX_APP_TOOL_ICON_URL_LENGTH`). */
export const TOOL_ICON_URL_MAX = 4096;
export const FIXTURE_ENVIRONMENT_ID = "rw-fixtures";
/** Every fixture thread's modes (Supervised, the default interaction mode). */
export const FIXTURE_RUNTIME_MODE = "approval-required" satisfies BundleRuntimeMode;
export const FIXTURE_INTERACTION_MODE = "default" satisfies BundleInteractionMode;
export const THREADS_DIR = join(REPO_ROOT, "app/e2e/fixtures/threads");
export const BUNDLE_DIR = join(REPO_ROOT, "tests/fixtures/lecturn");
export const STEP_CARD_PATH = join(REPO_ROOT, "crates/rw-cli/src/mcp/cards/step-card.html");
export const STEP_CARD_URI = "ui://rw/step-card";
export const RUN_CARD_PATH = join(REPO_ROOT, "crates/rw-cli/src/mcp/cards/run-card.html");
export const RUN_CARD_URI = "ui://rw/run-card";

/** The card documents a bundle captures (`ui://rw/step-card`, `ui://rw/run-card`). */
export interface CardDocs {
  step: string;
  run: string;
}

export function readCardDocs(paths: { step?: string; run?: string } = {}): CardDocs {
  return { step: readFileSync(paths.step ?? STEP_CARD_PATH, "utf8"), run: readFileSync(paths.run ?? RUN_CARD_PATH, "utf8") };
}
/** The scripted provider's name for an app tool row (Lecturn `ScriptedAdapterV2`: `lecturn.<prefix>_<tool>`). */
export const LIVE_TOOL_PREFIX = "lecturn.rw_";
/** The result `_meta` key of an app's per-call row summary (Lecturn `APP_TOOL_SUMMARY_META_KEY`), and its cap. */
export const TOOL_SUMMARY_META_KEY = "lecturn/summary";
export const TOOL_SUMMARY_MAX = 120;
/** Lecturn's cap on a declared tool title (`MAX_APP_TOOL_TITLE_LENGTH`). */
export const TOOL_TITLE_MAX = 80;
/** The tools an agent sees in Lecturn: the MCP catalog (minus app-only tools) and the live window tools. */
export const TOOL_PARITY_GOLDEN = join(REPO_ROOT, "app/apps/server/test/fixtures/tool-parity.golden.json");

// Control and bidi-override characters (Lecturn `appToolPresentation` UNSAFE_TEXT).
// oxlint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]+/gu;
/**
 * Lecturn's `plainLine` (pin5 `packages/shared/src/appToolPresentation.ts`,
 * which `appToolTitle` and `appToolSummaryFromMeta` read titles and
 * summaries through): unsafe characters become spaces, whitespace runs one
 * space, trimmed; undefined when empty or over `maxLength`.
 */
export function plainLine(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(UNSAFE_TEXT, " ").replace(/\s+/gu, " ").trim();
  return text.length > 0 && text.length <= maxLength ? text : undefined;
}

let agentToolCache: Map<string, string | null> | undefined;
/**
 * Agent-visible tool → its declared title (null when it declares none).
 * Headless (CLI) tools win a name both tiers list, as in Lecturn's
 * `toolTitlesOf` (pin5 AppRegistryService).
 */
function agentToolTitles(): Map<string, string | null> {
  if (agentToolCache !== undefined) return agentToolCache;
  const golden = JSON.parse(readFileSync(TOOL_PARITY_GOLDEN, "utf8")) as { tools: { name: string; title?: string | null; appOnly?: boolean }[] };
  const titles = new Map<string, string | null>();
  for (const [name, title] of [
    ...golden.tools.filter((t) => t.appOnly !== true).map((t) => [t.name, t.title ?? null] as const),
    ...AGENT_OPS.map((op) => [op, BROKER_OP_TITLES[op as BrokerOp]] as const),
  ]) {
    if (!titles.has(name)) titles.set(name, title);
  }
  agentToolCache = titles;
  return agentToolCache;
}
export function agentTools(): Set<string> {
  return new Set(agentToolTitles().keys());
}
/**
 * The title a live row of `name` reads (pin5 `mcpToolPresentation` for an
 * app tool: the declared title as `appToolTitle` keeps it, one plain line of
 * at most `TOOL_TITLE_MAX`; else the prefixed name).
 */
export function toolTitle(name: string): string {
  return rowTitle(name, agentToolTitles().get(name));
}
/** `toolTitle` for a tool that declares `declared`. */
export function rowTitle(name: string, declared: string | null | undefined): string {
  return plainLine(declared, TOOL_TITLE_MAX) ?? `rw_${name}`;
}
/**
 * The `toolSource` Lecturn stamps on RocketWright's tool rows (Lecturn
 * `appToolSource`): `app:<appId>`, the app's name, kind `integration`, and the
 * icon as a themed logo only when its data URL is at most `TOOL_ICON_URL_MAX`.
 */
export function appToolSource(iconDataUrl: string = `data:image/png;base64,${readFileSync(APP_ICON_PATH).toString("base64")}`): JsonObject {
  return {
    key: `app:${FIXTURE_APP_ID}`,
    name: FIXTURE_APP_NAME,
    kind: "integration",
    ...(iconDataUrl.length > 0 && iconDataUrl.length <= TOOL_ICON_URL_MAX ? { icon: { _tag: "themed-logo", logoUrl: iconDataUrl } } : {}),
  };
}

/** A live app tool row's presentation (`mcpToolPresentation` for an app tool): the declared title, the icon when there is one, and the source. */
function appToolPresentation(name: string, source: JsonObject): JsonObject {
  return { title: toolTitle(name), ...(source["icon"] !== undefined ? { toolIcon: source["icon"] } : {}), toolSource: source };
}
/** A turn's span: the user message 20 s before the reply; turns 60 s apart. */
const TURN_MS = 20_000;
const TURN_GAP_MS = 60_000;

type SeedThreadArgs = CannedThread;
type SeedMessageArgs = SeedThreadArgs["messages"][number];
type SeedStep = NonNullable<SeedMessageArgs["steps"]>[number];
/** A result card (`SeedMessage.cards`); `summary` is its row's (the old chat ignores it). */
export type FixtureCard = NonNullable<SeedMessageArgs["cards"]>[number] & { summary?: string };
/**
 * A tool call of a fixture reply; beyond the old chat's step (which ignores
 * them), `card`: the call's MCP Apps card, and `summary`: the row summary
 * the call's result carries (`_meta["lecturn/summary"]`).
 */
export type FixtureStep = SeedStep & { card?: Omit<FixtureCard, "summary">; summary?: string };
export type SeedMessage = Omit<SeedMessageArgs, "steps" | "cards"> & { steps?: FixtureStep[]; cards?: FixtureCard[] };
export type SeedThread = Omit<SeedThreadArgs, "messages"> & { messages: SeedMessage[] };

export interface ThreadFixture {
  description: string;
  threads: SeedThread[];
}

export const bundlePath = (page: PageId, dir = BUNDLE_DIR): string => join(dir, `${page}.bundle.json`);

export function loadFixture(page: PageId, dir = THREADS_DIR): ThreadFixture {
  return JSON.parse(readFileSync(join(dir, `${page}.json`), "utf8")) as ThreadFixture;
}

/** `rw-<page>-<title slug>`: stable source ids, so a re-import of the same bundle is skipped. */
export function sourceThreadId(page: PageId, title: string): string {
  return `rw-${page}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

/** The message text with `[@label](rw:…)` links as bare refs, then any mention the text does not name. */
export function messageText(m: Pick<SeedMessage, "text" | "mentions">): string {
  const text = m.text.replace(/\[@[^\]]*\]\((rw:[^)\s]+)\)/g, "$1");
  const missing = (m.mentions ?? []).map((x) => x.ref).filter((ref, i, all) => all.indexOf(ref) === i && !text.includes(ref));
  return missing.length === 0 ? text : `${text} ${missing.join(" ")}`;
}

/** The web's `appDataOf` (`apps/web/src/embed/threads.ts`). */
function appDataOf(binding: SeedThread["binding"]): string {
  const b = binding ?? { page: "assembly" };
  return JSON.stringify("page" in b ? { page: b.page } : { artifact: b.artifact });
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** An MCP `CallToolResult` for a canned output (text plus structured content when it is an object). */
function toolResult(output: JsonValue | undefined, isError = false): JsonObject {
  const value = output ?? {};
  const structured = typeof value === "object" && value !== null && !Array.isArray(value) ? { structuredContent: value } : {};
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...structured, ...(isError ? { isError: true } : {}) };
}

/** The result `_meta` AppToolkit's `sanitizeResult` leaves of a RocketWright result: the app's summary. */
export function liveToolMeta(summary: string): JsonObject {
  return { [TOOL_SUMMARY_META_KEY]: summary };
}

/** What AppToolkit returns for an app call (`sanitizeResult`): the app's result with the summary in `_meta`. */
export function liveToolOutput(result: JsonObject, summary: string): JsonObject {
  return { ...result, _meta: liveToolMeta(summary) };
}

/** The card's `resources/read` `_meta.ui.prefersBorder` (`crates/rw-cli/src/mcp/server.rs` `ui_card`). */
export const CARD_PREFERS_BORDER = true;

/** What AppCardEnvelope returns for a card tool's call: the result's content and `_meta`, and `structuredContent: { lecturnMcpApp, result }`. */
export function liveCardOutput(result: JsonObject, reference: JsonObject, summary: string): JsonObject {
  const { content, isError } = result;
  return {
    content: content ?? [],
    ...(isError === undefined ? {} : { isError }),
    _meta: liveToolMeta(summary),
    structuredContent: { lecturnMcpApp: { ...reference, prefersBorder: CARD_PREFERS_BORDER }, result },
  };
}

function asset(id: string, html: string): BundleAsset {
  const bytes = Buffer.from(html, "utf8");
  return { sourceAttachmentId: id, mimeType: "text/html", byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), dataBase64: bytes.toString("base64") };
}

interface Turn {
  user: SeedMessage;
  assistant: SeedMessage | null;
}

function turnsOf(t: SeedThread): Turn[] {
  const turns: Turn[] = [];
  for (const m of t.messages) {
    if (m.role === "user") turns.push({ user: m, assistant: null });
    else {
      const open = turns.at(-1);
      if (open === undefined || open.assistant !== null) throw new Error(`${t.thread}: an assistant message without a user message before it`);
      open.assistant = m;
    }
  }
  if (turns.length === 0) throw new Error(`${t.thread}: no user message`);
  return turns;
}

/** One fixture thread as a bundle thread, plus the card assets it references. */
export function convertThread(page: PageId, t: SeedThread, docs: CardDocs, clock = Date.parse(FIXTURE_CLOCK), source: JsonObject = appToolSource()): { thread: BundleThread; assets: BundleAsset[] } {
  const tid = sourceThreadId(page, t.thread);
  const updated = clock - (t.ageMs ?? 0);
  const turns = turnsOf(t);
  const messages: JsonObject[] = [];
  const items: JsonObject[] = [];
  const assets: BundleAsset[] = [];
  let ordinal = 0;
  turns.forEach((turn, i) => {
    const k = i + 1;
    const end = updated - (turns.length - k) * TURN_GAP_MS;
    const start = end - TURN_MS;
    const runId = `${tid}:run:${k}`;
    const nodeId = `${tid}:node:${k}`;
    const item = (id: string, at: number, until: number, body: JsonObject): JsonObject => ({
      id,
      threadId: tid,
      runId,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: ++ordinal,
      status: "completed",
      title: null,
      startedAt: iso(at),
      completedAt: iso(until),
      updatedAt: iso(until),
      ...body,
    });
    const message = (role: "user" | "assistant", text: string, at: number): JsonObject => ({
      createdBy: role === "user" ? "user" : "agent",
      creationSource: "web",
      id: `${tid}:t${k}:${role}`,
      threadId: tid,
      runId,
      nodeId: null,
      role,
      text,
      attachments: [],
      streaming: false,
      createdAt: iso(at),
      updatedAt: iso(at),
    });
    const userText = messageText(turn.user);
    messages.push(message("user", userText, start));
    items.push(item(`${tid}:t${k}:user`, start, start, { createdBy: "user", creationSource: "web", type: "user_message", messageId: `${tid}:t${k}:user`, inputIntent: "turn_start", text: userText, attachments: [] }));
    const a = turn.assistant;
    if (a === null) return;
    let at = start;
    const tool = (id: string, name: string, input: JsonObject, output: JsonObject, failed = false): void => {
      at += 1_000;
      items.push(item(id, at, at + 500, { ...(failed ? { status: "failed" } : {}), ...appToolPresentation(name, source), type: "dynamic_tool", toolName: `${LIVE_TOOL_PREFIX}${name}`, input, output }));
    };
    /** A row's summary: the fixture's, one plain line within Lecturn's cap. */
    const summaryOf = (what: string, summary: string | undefined): string => {
      if (summary === undefined || summary.trim() === "") throw new Error(`${t.thread}: ${what} has no summary (the row's lecturn/summary)`);
      // Lecturn keeps a summary only as `plainLine` reads it (AppToolkit sanitizeResult); the fixture's must already be that line.
      if (plainLine(summary, TOOL_SUMMARY_MAX) !== summary) throw new Error(`${t.thread}: ${what}'s summary is not one plain line of at most ${TOOL_SUMMARY_MAX} characters`);
      return summary;
    };
    /** A card tool's row: its result envelope names the captured card document. */
    const cardRow = (id: string, attachmentId: string, name: string, input: JsonObject, sc: JsonObject, uri: string, html: string, summary: string): void => {
      assets.push(asset(attachmentId, html));
      tool(id, name, input, liveCardOutput(toolResult(sc), { attachmentId, server: "lecturn", tool: `rw_${name}`, resourceUri: uri }, summary));
    };
    const stepOfRef = (ref: string): string => {
      const n = /(\d+)$/.exec(ref)?.[1];
      if (n === undefined) throw new Error(`${t.thread}: step card ref ${ref} has no step number`);
      return String(Number(n));
    };
    /** A run_diff of two sims' runs (`input.a`, `input.b`; the card's ref names `b`, the run its Open goes to). */
    const runDiffResult = (input: JsonObject, sim: string): JsonObject => {
      const [a, b] = [input["a"], input["b"]];
      const ok = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.-]+$/.test(v);
      if (!ok(a) || !ok(b)) throw new Error(`${t.thread}: run_diff's run card needs sim ids a and b`);
      if (b !== sim) throw new Error(`${t.thread}: run_diff's run card ref names ${sim}, not b (${b})`);
      return { a: `${a}/${runIdTemplate(a)}`, b: `${b}/${runIdTemplate(b)}`, mismatches: [], rows: [], pass: true };
    };
    const simOfRef = (ref: string): string => {
      const sim = /^rw:sim\/([A-Za-z0-9_.-]+)$/.exec(ref)?.[1];
      if (sim === undefined) throw new Error(`${t.thread}: run card ref ${ref} is not rw:sim/<sim>`);
      return sim;
    };
    (a.steps ?? []).forEach((s, j) => {
      const id = `${tid}:t${k}:tool${j + 1}`;
      if (!agentTools().has(s.tool)) throw new Error(`${t.thread}: ${s.tool} is not a tool an agent sees in Lecturn (the catalog or the live window tools)`);
      const c = s.card;
      // Checked after the row's shape, so a misplaced card says so first.
      const summary = (): string => summaryOf(s.tool, s.summary);
      if (c === undefined) {
        tool(id, s.tool, s.input, liveToolOutput(toolResult(s.output, s.isError === true), summary()), s.isError === true);
      } else {
        if (s.isError === true) throw new Error(`${t.thread}: ${s.tool} failed, so it draws no card`);
        if (TOOL_CARDS[s.tool] !== c.kind) throw new Error(`${t.thread}: ${s.tool} does not draw a ${c.kind} card${TOOL_CARDS[s.tool] === undefined ? "" : ` (it draws a ${TOOL_CARDS[s.tool]} card)`}`);
        const extra = typeof s.output === "object" && s.output !== null && !Array.isArray(s.output) ? s.output : {};
        const attachmentId = `${tid}-t${k}-tool${j + 1}-html`;
        if (c.kind === "step") {
          const step = stepOfRef(c.ref);
          const sc: JsonObject =
            s.tool === "history_show"
              ? { step: { seq: Number(step), title: c.title }, diff: { a: `step:${Number(step) - 1}`, b: `step:${step}`, added: [], removed: [], changed: [] } }
              : { step, dry_run: false, delta: { step, status: "clean", changed: {} } };
          cardRow(id, attachmentId, s.tool, s.input, { ...extra, ...sc }, STEP_CARD_URI, docs.step, summary());
        } else if (c.kind === "run") {
          const sim = simOfRef(c.ref);
          const sc: JsonObject =
            s.tool === "job_status"
              ? { job_id: `job-${sim}`, kind: "simulate", state: "complete", progress: 1, sim, run_id: runIdTemplate(sim) }
              : s.tool === "run_diff"
                ? runDiffResult(s.input, sim)
                : { sim, run_id: runIdTemplate(sim), status: "complete", cached: true };
          cardRow(id, attachmentId, s.tool, s.input, { ...extra, ...sc }, RUN_CARD_URI, docs.run, summary());
        } else {
          throw new Error(`${t.thread}: ${s.tool}: render cards are not captured in a bundle (no stored picture)`);
        }
      }
    });
    (a.cards ?? []).forEach((c, j) => {
      const id = `${tid}:t${k}:card${j + 1}`;
      const attachmentId = `${tid}-t${k}-card${j + 1}-html`;
      const summary = (): string => summaryOf(`the ${c.kind} card ${c.ref}`, c.summary);
      if (c.kind === "step") {
        const step = stepOfRef(c.ref);
        cardRow(id, attachmentId, "model_patch", { label: c.title, ops: [] }, { step, dry_run: false, delta: { step, status: "clean", changed: {} } }, STEP_CARD_URI, docs.step, summary());
      } else if (c.kind === "run") {
        const sim = simOfRef(c.ref);
        cardRow(id, attachmentId, "simulate", { sim }, { sim, run_id: runIdTemplate(sim), status: "complete", cached: true }, RUN_CARD_URI, docs.run, summary());
      } else {
        tool(id, "render", { ref: c.ref }, liveToolOutput(toolResult({ ref: c.ref, title: c.title }), summary()));
      }
    });
    const replyText = messageText(a);
    messages.push(message("assistant", replyText, end));
    items.push(item(`${tid}:t${k}:assistant`, end, end, { type: "assistant_message", messageId: `${tid}:t${k}:assistant`, text: replyText, streaming: false }));
  });
  const first = updated - (turns.length - 1) * TURN_GAP_MS - TURN_MS;
  return {
    thread: {
      sourceThreadId: tid,
      title: t.thread,
      createdAt: iso(first),
      updatedAt: iso(updated),
      historyRevision: messages.length + items.length,
      appData: appDataOf(t.binding),
      subtitle: null,
      pinned: false,
      runtimeMode: FIXTURE_RUNTIME_MODE,
      interactionMode: FIXTURE_INTERACTION_MODE,
      messages,
      turnItems: items,
    },
    assets,
  };
}

/** A page's fixture as its bundle: one templated project holding every thread, in fixture order. */
export function convertFixture(page: PageId, fixture: ThreadFixture, docs: CardDocs): ThreadBundle {
  const source = appToolSource();
  const converted = fixture.threads.map((t) => convertThread(page, t, docs, Date.parse(FIXTURE_CLOCK), source));
  return parseThreadBundle({
    version: 1,
    appId: FIXTURE_APP_ID,
    sourceEnvironmentId: FIXTURE_ENVIRONMENT_ID,
    exportedAt: FIXTURE_CLOCK,
    // The opened (last) thread is pinned: Lecturn imports unpinned threads as Settled, and a
    // settled thread shows the Settled banner where the pane's composer belongs.
    projects: [{ workspaceRoot: WORKSPACE_ROOT_TEMPLATE, title: PROJECT_NAME_TEMPLATE, threads: converted.map((c, i) => (i === converted.length - 1 ? { ...c.thread, pinned: true } : c.thread)) }],
    assets: converted.flatMap((c) => c.assets),
  });
}

export const bundleText = (b: ThreadBundle): string => `${JSON.stringify(b, null, 2)}\n`;

/** The pages whose committed bundle differs from the converter's output (missing counts). */
export function driftedPages(pages: readonly PageId[] = PAGES, dirs: { threads?: string; bundles?: string; stepCard?: string; runCard?: string } = {}): PageId[] {
  const html = readCardDocs({ ...(dirs.stepCard === undefined ? {} : { step: dirs.stepCard }), ...(dirs.runCard === undefined ? {} : { run: dirs.runCard }) });
  return pages.filter((p) => {
    const path = bundlePath(p, dirs.bundles);
    return !existsSync(path) || readFileSync(path, "utf8") !== bundleText(convertFixture(p, loadFixture(p, dirs.threads), html));
  });
}

function main(argv: string[]): number {
  const i = argv.indexOf("--pages");
  const pages = (i >= 0 ? (argv[i + 1] ?? "") : PAGES.join(",")).split(",").filter(Boolean) as PageId[];
  for (const p of pages) if (!(PAGES as readonly string[]).includes(p)) throw new Error(`--pages: unknown page ${p}`);
  if (argv.includes("--check")) {
    const drift = driftedPages(pages);
    if (drift.length > 0) {
      console.error(`convert-threads: ${drift.map((p) => bundlePath(p)).join(", ")} out of date; run node app/e2e/fixtures/convert-threads.ts`);
      return 1;
    }
    console.log(`convert-threads: ${pages.length} bundles up to date`);
    return 0;
  }
  const html = readCardDocs();
  mkdirSync(BUNDLE_DIR, { recursive: true });
  for (const p of pages) writeFileSync(bundlePath(p), bundleText(convertFixture(p, loadFixture(p), html)));
  console.log(`convert-threads: wrote ${pages.map((p) => bundlePath(p)).join(", ")}`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  }
}
