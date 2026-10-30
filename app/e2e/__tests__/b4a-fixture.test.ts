/**
 * B14 (W5.2): the scripted B4(a) turn and the B4(b) rehearsal are valid D22
 * scripts against the published tool schemas (they were ported from the old
 * engine's stand-in scripts, which B17 removed); plus the pure parts of the
 * embed driver (`embed.ts`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { B4B_PROMPT, B4B_REHEARSAL_FIXTURE } from "../../../scripts/bar/live-smoke.ts";
import { MENTION_REHEARSAL_FIXTURE } from "../../../scripts/bar/mention.ts";
import { B4A_FIXTURE, B4A_PROMPT, B4A_SCRIPT } from "../b4a.ts";
import { REPO_ROOT, readJson } from "../bar/paths.ts";
import type { ScriptStep, ScriptToolCall } from "../capture/scripted.ts";
import { isEmbedGuestUrl, loadTurnFixture, turnFixtureProblems, turnSettled, turnStates, type PaneEventRecord } from "../embed.ts";

interface ObjSchema {
  properties?: Record<string, unknown>;
  required?: string[];
  $defs?: Record<string, { enum?: string[] }>;
}

const toolSchema = (tool: string, dir: "input" | "output") => readJson<ObjSchema>(join(REPO_ROOT, "schema/tools", `${tool}.${dir}.json`));
const bare = (name: string): string => name.replace(/^rw_/, "");

/** The tool calls of a script, with what each saves. */
interface Call {
  kind: "toolCall" | "poll";
  call: ScriptToolCall;
  saveAs?: string;
  until?: { path: string; equals: unknown };
}

function callsOf(script: ScriptStep[]): Call[] {
  return script.flatMap((s): Call[] => {
    if ("toolCall" in s) return [{ kind: "toolCall", call: s.toolCall, ...(s.saveAs === undefined ? {} : { saveAs: s.saveAs }) }];
    if ("poll" in s) return [{ kind: "poll", call: s.poll.toolCall, until: s.poll.until, ...(s.saveAs === undefined ? {} : { saveAs: s.saveAs }) }];
    return [];
  });
}

const PLACEHOLDER = /\$\{([A-Za-z_][\w-]*)((?:\.[\w-]+)*)\}/g;
/**
 * A tool with a `ui://rw/*` card answers inside Lecturn's card envelope
 * (`structuredContent: {lecturnMcpApp, result}`, Lecturn `AppCardEnvelope`),
 * so what `saveAs` and `poll.until` read starts with this.
 */
const ENVELOPE = "result.structuredContent.";
const CARD_TOOLS = new Set(["simulate", "engine_simulate", "job_status", "run_diff", "component_add", "component_remove", "model_patch", "import_file", "history_restore", "render"]);

/** The tool output field a saved-value path names (null when the path misses the envelope a card tool needs). */
function outputField(tool: string, path: string): string | null {
  if (!CARD_TOOLS.has(tool)) return path.split(".")[0] ?? null;
  return path.startsWith(ENVELOPE) ? (path.slice(ENVELOPE.length).split(".")[0] ?? null) : null;
}

/** Checks the D22 script against the tool schemas: tools exist, required inputs, `${name.path}` names a saved tool's output field. */
function schemaProblems(script: ScriptStep[]): string[] {
  const out: string[] = [];
  const saved = new Map<string, string>();
  for (const c of callsOf(script)) {
    const tool = bare(c.call.name);
    if (!c.call.name.startsWith("rw_")) out.push(`${c.call.name}: not an rw_ tool`);
    const input = toolSchema(tool, "input");
    const args = c.call.arguments ?? {};
    for (const key of input.required ?? []) if (!(key in args)) out.push(`${tool}: input.${key} missing`);
    for (const key of Object.keys(args)) if (!(key in (input.properties ?? {}))) out.push(`${tool}: unknown input ${key}`);
    for (const m of JSON.stringify(args).matchAll(PLACEHOLDER)) {
      const from = saved.get(m[1]!);
      if (from === undefined) out.push(`${tool}: \${${m[1]}${m[2]}} names no earlier saveAs`);
      else if (!Object.hasOwn(toolSchema(from, "output").properties ?? {}, outputField(from, m[2]!.slice(1)) ?? "")) out.push(`${tool}: ${from} has no output ${m[2]}`);
    }
    if (c.until !== undefined && !Object.hasOwn(toolSchema(tool, "output").properties ?? {}, outputField(tool, c.until.path) ?? "")) out.push(`${tool}: poll path ${c.until.path} is not an output field`);
    if (c.saveAs !== undefined) saved.set(c.saveAs, tool);
  }
  return out;
}

const portedCalls = (script: ScriptStep[]) => callsOf(script).map((c) => ({ tool: bare(c.call.name), input: JSON.stringify(c.call.arguments ?? {}) }));
const texts = (script: ScriptStep[]) => script.flatMap((s) => ("assistantText" in s ? [s.assistantText] : []));

describe("scripted/b4a.json (B14, D22)", () => {
  const f = loadTurnFixture(B4A_FIXTURE);
  const script = f.scripts["1"]!;

  it("is the S:198 prompt with one script for the thread's first turn", () => {
    expect(turnFixtureProblems(JSON.parse(readFileSync(B4A_SCRIPT, "utf8")))).toEqual([]);
    expect(f.prompt).toBe(B4A_PROMPT);
    expect(Object.keys(f.scripts)).toEqual(["1"]);
  });

  it("patches the fin span, simulates baseline, and polls job_status with the saved job id until complete", () => {
    const calls = callsOf(script);
    expect(calls.map((c) => `${c.kind}:${c.call.name}`)).toEqual(["toolCall:rw_model_patch", "toolCall:rw_simulate", "poll:rw_job_status"]);
    expect(calls[0]?.call.arguments?.["ops"]).toEqual([{ op: "replace", path: "/c/fins/span", value: "90 mm" }]);
    expect(calls[1]?.call.arguments).toMatchObject({ sim: "baseline" });
    expect(calls[2]?.call.arguments).toEqual({ job_id: "${sim.result.structuredContent.job_id}" });
    expect(calls[2]?.until).toEqual({ path: "result.structuredContent.state", equals: "complete" });
    expect(toolSchema("job_status", "output").$defs?.["JobState"]?.enum ?? []).toContain("complete");
  });

  it("uses only published tools, their required inputs, and saved output fields (through the card envelope)", () => {
    expect(schemaProblems(script)).toEqual([]);
    // Without the envelope, a card tool's job id is not where saveAs puts it.
    const bare = script.map((st) => JSON.parse(JSON.stringify(st).replaceAll(ENVELOPE, "")) as ScriptStep);
    expect(schemaProblems(bare)).toEqual(["job_status: simulate has no output .job_id", "job_status: poll path state is not an output field"]);
  });

  it("the visual-01 scenario reads its run through the card envelope too", () => {
    const v1 = JSON.parse(readFileSync(join(REPO_ROOT, "app/e2e/fixtures/scripted/visual-01.json"), "utf8")) as { script: ScriptStep[] };
    expect(schemaProblems(v1.script)).toEqual([]);
  });
});

describe("scripted/b4b.json (the --rehearse turn, B14)", () => {
  const f = loadTurnFixture(B4B_REHEARSAL_FIXTURE);
  const script = f.scripts["1"]!;

  it("is the B4(b) prompt, valid against the tool schemas: patch, check, simulate, poll, between two lines of text", () => {
    expect(f.prompt).toBe(B4B_PROMPT);
    expect(Object.keys(f.scripts)).toEqual(["1"]);
    expect(schemaProblems(script)).toEqual([]);
    expect(portedCalls(script).map((c) => c.tool)).toEqual(["model_patch", "design_check", "simulate", "job_status"]);
    expect(texts(script)).toHaveLength(2);
  });
});

describe("scripted/b4b-mention.json (the --rehearse mention turn, B16b)", () => {
  it("is valid against the tool schemas", () => {
    const f = loadTurnFixture(MENTION_REHEARSAL_FIXTURE);
    expect(schemaProblems(f.scripts["2"]!)).toEqual([]);
  });
});

describe("turn fixtures (embed.ts)", () => {
  it("rejects a bad shape, bad ordinals and bad D22 steps", () => {
    expect(turnFixtureProblems(null)).toEqual(["not an object"]);
    expect(turnFixtureProblems({ description: "d", prompt: "p" })).toEqual(["scripts: an object keyed by run ordinal"]);
    expect(turnFixtureProblems({ description: "d", prompt: "p", scripts: { "0": [{ assistantText: "x" }] } })).toEqual(["scripts.0: keys are 1-based run ordinals"]);
    expect(turnFixtureProblems({ description: "", prompt: "p", scripts: { "1": [{ say: "x" }] } })).toEqual(["description: a non-empty string", "scripts.1.script[0]: unknown step (say)"]);
  });
});

describe("the embed driver's pure parts (embed.ts)", () => {
  const ev = (event: string, payload: Record<string, unknown>): PaneEventRecord => ({ event, payload, at: 0 });

  it("finds the guest by its loopback /embed/ URL only", () => {
    expect(isEmbedGuestUrl("http://127.0.0.1:4310/embed/env/proj/thread")).toBe(true);
    expect(isEmbedGuestUrl("http://localhost:1/embed/x")).toBe(true);
    expect(isEmbedGuestUrl("http://127.0.0.1:5173/?page=04")).toBe(false);
    expect(isEmbedGuestUrl("https://example.com/embed/x")).toBe(false);
    expect(isEmbedGuestUrl("not a url")).toBe(false);
  });

  it("reads the thread's turn states and settles only after it was busy and is idle again", () => {
    const events = [ev("lecturn/turn.state", { threadId: "t", state: "idle" }), ev("lecturn/ready", { threadId: "t" }), ev("lecturn/turn.state", { threadId: "u", state: "running" }), ev("lecturn/turn.state", { threadId: "t", state: "running" })];
    expect(turnStates(events, "t")).toEqual(["idle", "running"]);
    expect(turnSettled(["idle", "running"])).toBe(false);
    expect(turnSettled(["idle"])).toBe(false);
    expect(turnSettled(["idle", "running", "awaiting-approval", "running", "idle"])).toBe(true);
    expect(turnSettled(["running", "idle", "running"])).toBe(false);
  });
});
