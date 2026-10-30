/**
 * B4 (W1.2, D5): `pnpm --filter @rw/server test -- tool-parity`.
 *
 * Every tool the app's own sidecar (`rocketwright mcp --app`) lists is served
 * by the headless `rocketwright mcp --project <dir>` (no `--app`, the way
 * Lecturn's `headlessTools` spawns it) under the same name, input schema, and
 * output schema. Window tools (the `ViewportBroker`'s `viewport_*`,
 * `plot_render`, `app_*`) are never in either list: Lecturn's live tier gets
 * them from the app server's `/mcp/live`.
 *
 * The committed golden (`fixtures/tool-parity.golden.json`) is the proxied
 * set at B4: each tool's name and the sha256 of its canonical (key-sorted)
 * input and output schema JSON, and `appOnly: true` for tools hidden from
 * the model (`_meta.ui.visibility: ["app"]`, B3's `run_series`, which MCP
 * Apps cards call), and each tool's display `title` (CPW1R4B: Lecturn's
 * tool rows read it; the thread-bundle converter stamps it on fixture rows). The full registry schemas are published in
 * `schema/tools/<name>.{input,output}.json`. The golden keeps the check
 * meaningful now that B17 removed the app's HTTP MCP proxy: the headless
 * list must still equal it. Regenerate it after an intended tool or schema
 * change with `RW_UPDATE_GOLDEN=1 pnpm --filter @rw/server test -- tool-parity`.
 */
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ViewportBroker } from "../src/broker/ViewportBroker.ts";
import { SidecarClient, type SidecarTool } from "../src/sidecar/SidecarClient.ts";
import { APP_ONLY_TOOLS, appOnly, sidecarBin, tempProject } from "./helpers/harness.ts";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "fixtures/tool-parity.golden.json");

/** The parity-relevant part of a tool definition. */
interface ParityTool {
  name: string;
  title?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  appOnly?: true;
}

/** A golden row: the name and the schema digests. */
interface GoldenTool {
  name: string;
  title: string | null;
  input: string;
  output: string | null;
  appOnly?: true;
}

interface Golden {
  note: string;
  tools: GoldenTool[];
}

function parity(t: SidecarTool): ParityTool {
  const out: ParityTool = { name: t.name, inputSchema: t.inputSchema };
  if (t.title !== undefined) out.title = t.title;
  if (t.outputSchema !== undefined) out.outputSchema = t.outputSchema;
  if (appOnly(t)) out.appOnly = true;
  return out;
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

/** JSON with object keys sorted at every level. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

const digest = (v: unknown): string => `sha256:${createHash("sha256").update(canonical(v)).digest("hex")}`;

function goldenRow(t: ParityTool): GoldenTool {
  const row: GoldenTool = { name: t.name, title: t.title ?? null, input: digest(t.inputSchema), output: t.outputSchema === undefined ? null : digest(t.outputSchema) };
  if (t.appOnly === true) row.appOnly = true;
  return row;
}

describe("tool parity: headless rocketwright mcp vs the app's sidecar (B4)", () => {
  let app: SidecarClient;
  let appDir: string;
  let broker: ViewportBroker;
  let headless: SidecarClient;
  let headlessDir: string;

  beforeAll(async () => {
    sidecarBin();
    broker = new ViewportBroker({ testHooks: true, timeoutMs: 300 });
    appDir = tempProject("rwpap");
    app = new SidecarClient();
    await app.start({ projectDir: appDir, bin: sidecarBin(), stderr: "ignore" });
    headlessDir = tempProject("rwpar");
    headless = new SidecarClient();
    await headless.start({ projectDir: headlessDir, bin: sidecarBin(), app: false, stderr: "ignore" });
  }, 600_000);

  afterAll(async () => {
    await headless?.stop();
    if (headlessDir !== undefined) rmSync(headlessDir, { recursive: true, force: true });
    await app?.stop();
    if (appDir !== undefined) rmSync(appDir, { recursive: true, force: true });
  });

  function golden(current: ParityTool[]): Golden {
    if (process.env.RW_UPDATE_GOLDEN === "1") {
      const g: Golden = {
        note: "B4 tool parity golden: every non-window tool's name, display title, and sha256 of its canonical input/output schema (schema/tools/<name>.*.json); appOnly marks tools hidden from the model (MCP Apps visibility [\"app\"]). Regenerate: RW_UPDATE_GOLDEN=1 pnpm --filter @rw/server test -- tool-parity",
        tools: current.map(goldenRow).sort(byName),
      };
      writeFileSync(GOLDEN, `${JSON.stringify(g, null, 2)}\n`);
      return g;
    }
    return JSON.parse(readFileSync(GOLDEN, "utf8")) as Golden;
  }

  it("the headless server lists exactly the golden tools, names and schemas", async () => {
    const tools = (await headless.listTools()).map(parity).sort(byName);
    const g = golden(tools);
    expect(tools.map((t) => t.name)).toEqual(g.tools.map((t) => t.name));
    expect(tools.map(goldenRow)).toEqual(g.tools);
    expect(g.tools.filter((t) => t.appOnly === true).map((t) => t.name)).toEqual([...APP_ONLY_TOOLS].sort());
    // The headless server never lists window tools.
    expect(tools.filter((t) => broker.serves(t.name)).map((t) => t.name)).toEqual([]);
  });

  it("every tool of the app's sidecar is served headless with the same schemas; neither lists window tools", async () => {
    const all = await app.listTools();
    expect(all.filter((t) => broker.serves(t.name)).map((t) => t.name)).toEqual([]);
    const proxied = all.map(parity).sort(byName);
    const head = new Map((await headless.listTools()).map((t) => [t.name, parity(t)]));
    const missing = proxied.filter((t) => !head.has(t.name)).map((t) => t.name);
    expect(missing, "app sidecar tools missing from headless rocketwright mcp").toEqual([]);
    for (const t of proxied) expect(head.get(t.name), t.name).toEqual(t);
    // The app's sidecar list is the golden set too.
    const g = golden([...head.values()]);
    const gold = new Map(g.tools.map((t) => [t.name, t]));
    for (const t of proxied) expect(gold.get(t.name), `${t.name} is not in the golden`).toEqual(goldenRow(t));
  });
});
