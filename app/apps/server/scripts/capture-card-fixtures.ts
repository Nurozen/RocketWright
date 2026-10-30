/**
 * B3: captures the MCP Apps card fixtures (`test/fixtures/cards/*.json`) from
 * real runs: `node scripts/capture-card-fixtures.ts` (from app/apps/server).
 *
 * Drives `rocketwright mcp --project <tmp>` over stdio (newline JSON-RPC) on
 * temp copies of two projects, the way Lecturn proxies calls
 * (`_meta["lecturn/approval"]`):
 *
 * - flight: `simulate` of the B4(b) design (`test/fixtures/cards/b4b-design`,
 *   the C-motor rocket the B4(b) turn designed), then `job_status` until the
 *   job completes, then `run_series` for `t` and `altitude`;
 * - engine: `engine_simulate` of `fixtures/research-vehicle` engine `demo`
 *   with no duration: first unapproved (the approval-required answer), then
 *   approved (the synchronous result, `job_id: null`), then `run_series` for
 *   `t_s`, `thrust_n`, and `chamber_pressure_pa`;
 * - step and render: a `model_patch` (fin span 45 -> 50 mm) and a `profile`
 *   `render` of the B4(b) design.
 *
 * The binary is `$RW_BIN`, else the workspace's `target/debug/rocketwright`
 * (`cargo build -p rw-cli`). Only temp dirs are written besides the fixtures.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../..");
const OUT = join(HERE, "../test/fixtures/cards");
const BIN = process.env.RW_BIN ?? join(REPO, "target/debug/rocketwright");

type Json = Record<string, unknown>;

class Mcp {
  private next = 1;
  private waiting = new Map<number, (v: Json) => void>();
  private child: ChildProcessWithoutNullStreams;
  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.trim() === "") return;
      const v = JSON.parse(line) as Json;
      const id = v.id as number | undefined;
      if (id !== undefined && v.method === undefined) this.waiting.get(id)?.(v);
    });
  }

  static async start(project: string): Promise<Mcp> {
    const child = spawn(BIN, ["mcp", "--project", project], { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume();
    const m = new Mcp(child);
    await m.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "capture-card-fixtures", version: "0" } });
    m.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return m;
  }

  request(method: string, params: Json): Promise<Json> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method}: no answer`)), 120_000);
      this.waiting.set(id, (v) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        if (v.error !== undefined) reject(new Error(`${method}: ${JSON.stringify(v.error)}`));
        else resolve(v.result as Json);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** A `tools/call` the way Lecturn proxies it. */
  call(name: string, args: Json, approved: boolean): Promise<Json> {
    return this.request("tools/call", { name, arguments: args, _meta: { "lecturn/approval": { approved } } });
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

const sc = (r: Json): Json => (r.structuredContent ?? {}) as Json;

async function flight(): Promise<void> {
  const dir = mkdtempSync("/tmp/rwcard-flight-");
  cpSync(join(HERE, "../test/fixtures/cards/b4b-design"), dir, { recursive: true });
  const m = await Mcp.start(dir);
  try {
    const input = { sim: "default" };
    const result = await m.call("simulate", input, false);
    const jobId = sc(result).job_id as string;
    const jobStatus: Json[] = [];
    for (;;) {
      const st = await m.call("job_status", { job_id: jobId }, false);
      jobStatus.push(st);
      const state = sc(st).state;
      if (state === "complete" || state === "failed" || state === "cancelled") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const done = sc(jobStatus.at(-1)!);
    if (done.state !== "complete") throw new Error(`flight job ${String(done.state)}`);
    // The first poll answer and the final one; the card polls until complete.
    const polls = jobStatus.length > 1 ? [jobStatus[0]!, jobStatus.at(-1)!] : jobStatus;
    const seriesInput = { sim: done.sim, run_id: done.run_id, fields: ["t", "altitude"], max_points: 400 };
    const series = await m.call("run_series", seriesInput, false);
    const summary = done.summary as Json;
    writeFileSync(
      join(OUT, "flight.json"),
      `${JSON.stringify({ note: "Captured by scripts/capture-card-fixtures.ts from a real simulate run of test/fixtures/cards/b4b-design.", tool: "simulate", input, result, calls: { job_status: polls, run_series: { input: seriesInput, result: series } }, apogee_m: summary.apogee_m }, null, 2)}\n`,
    );
    console.log(`flight: run ${String(done.run_id)} apogee ${String(summary.apogee_m)} m, ${String(sc(series).points)} points`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function engine(): Promise<void> {
  const dir = mkdtempSync("/tmp/rwcard-engine-");
  cpSync(join(REPO, "fixtures/research-vehicle"), dir, { recursive: true });
  const m = await Mcp.start(dir);
  try {
    const input = { engine: "demo" };
    const gated = await m.call("engine_simulate", input, false);
    const result = await m.call("engine_simulate", input, true);
    const out = sc(result);
    const seriesInput = { sim: out.sim, run_id: out.run_id, fields: ["t_s", "thrust_n", "chamber_pressure_pa"], max_points: 400 };
    const series = await m.call("run_series", seriesInput, false);
    writeFileSync(
      join(OUT, "engine.json"),
      `${JSON.stringify({ note: "Captured by scripts/capture-card-fixtures.ts from a real engine_simulate run (no duration, approved) of fixtures/research-vehicle engine demo.", tool: "engine_simulate", input, gated, result, calls: { run_series: { input: seriesInput, result: series } } }, null, 2)}\n`,
    );
    console.log(`engine: run ${String(out.run_id)}, ${String(sc(series).points)} points`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function edits(): Promise<void> {
  const dir = mkdtempSync("/tmp/rwcard-edit-");
  cpSync(join(HERE, "../test/fixtures/cards/b4b-design"), dir, { recursive: true });
  const m = await Mcp.start(dir);
  try {
    const patch = { ops: [{ op: "replace", path: "/c/fins/span", value: "50 mm" }] };
    const step = await m.call("model_patch", patch, false);
    if (step.isError === true) throw new Error(`model_patch: ${JSON.stringify(step)}`);
    writeFileSync(
      join(OUT, "step.json"),
      `${JSON.stringify({ note: "Captured by scripts/capture-card-fixtures.ts from a real model_patch of test/fixtures/cards/b4b-design.", tool: "model_patch", input: patch, result: step }, null, 2)}\n`,
    );
    const view = { view: "profile", width: 480, height: 160 };
    const render = await m.call("render", view, false);
    if (render.isError === true) throw new Error(`render: ${JSON.stringify(render)}`);
    writeFileSync(
      join(OUT, "render.json"),
      `${JSON.stringify({ note: "Captured by scripts/capture-card-fixtures.ts from a real profile render of test/fixtures/cards/b4b-design.", tool: "render", input: view, result: render }, null, 2)}\n`,
    );
    console.log(`step: ${String(sc(step).step)}; render: ${(render.content as unknown[]).length} content blocks`);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

await flight();
await engine();
await edits();
