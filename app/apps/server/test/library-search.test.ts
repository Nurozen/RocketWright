/**
 * U44 (R2.1): `library.search` through the real RPC and a real session. The
 * catalog is read from `lib/presets`, so these tests follow it as it changes.
 */
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestClient, makeValidator } from "@rw/contracts/mock/harness";
import { AppServer } from "../src/rpc/AppServer.ts";
import { sidecarBin, tempProject } from "./helpers/harness.ts";

const PRESETS = join(dirname(fileURLToPath(import.meta.url)), "../../../../lib/presets");

interface CatalogPart {
  id: string;
  manufacturer: string;
  component: { type: string };
}

/** Every catalog part with the id `library.search` gives it. */
function catalog(): { id: string; manufacturer: string; type: string }[] {
  return readdirSync(PRESETS)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      const doc = JSON.parse(readFileSync(join(PRESETS, f), "utf8")) as { presets: CatalogPart[] };
      const stem = f.replace(/\.json$/, "");
      return doc.presets.map((p) => ({ id: `preset:${stem}/${p.id}`, manufacturer: p.manufacturer, type: p.component.type }));
    });
}

describe("library.search (U44)", () => {
  const parts = catalog();
  let server: AppServer;
  let c: TestClient;
  let dir: string;
  let projectId: string;

  beforeAll(async () => {
    dir = tempProject("rwlib", "fixtures/simple");
    server = await AppServer.start({ bin: sidecarBin(), stderr: "ignore", testHooks: false, jobPollMs: 50, backoff: { initialMs: 50, maxMs: 400 } });
    c = await TestClient.connect(server.rpcUrl, makeValidator());
    projectId = (await server.openProject(dir)).projectId;
  }, 600_000);

  afterAll(async () => {
    c?.close();
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("filters by manufacturer and component type, and reports facets", async () => {
    const want = parts.filter((p) => p.manufacturer === "Estes" && p.type === "body_tube");
    expect(want.length).toBeGreaterThan(0);
    const out = await c.call("library.search", { projectId, kind: "preset", manufacturer: "Estes", component_type: "body_tube", limit: 500 });
    expect(out.total).toBe(want.length);
    expect(out.items.map((i) => i.id).sort()).toEqual(want.map((p) => p.id).sort());

    // A facet ignores its own filter, so the other manufacturers stay listed with their tube counts.
    const makers = new Map(out.facets.manufacturers.map((f) => [f.value, f.count]));
    for (const maker of new Set(parts.filter((p) => p.type === "body_tube").map((p) => p.manufacturer))) {
      expect(makers.get(maker)).toBe(parts.filter((p) => p.type === "body_tube" && p.manufacturer === maker).length);
    }
    const types = new Map(out.facets.component_types.map((f) => [f.value, f.count]));
    expect(types.get("body_tube")).toBe(want.length);
    expect(types.get("nose_cone")).toBe(parts.filter((p) => p.manufacturer === "Estes" && p.type === "nose_cone").length);
  });

  it("pages past the preset and limit caps to the last catalog item", async () => {
    expect(parts.length).toBeGreaterThan(500);
    const seen: string[] = [];
    for (;;) {
      const page = await c.call("library.search", { projectId, kind: "preset", limit: 500, offset: seen.length });
      expect(page.total).toBe(parts.length);
      if (page.items.length === 0) break;
      seen.push(...page.items.map((i) => i.id));
    }
    expect(seen.length).toBe(parts.length);
    expect([...seen].sort()).toEqual(parts.map((p) => p.id).sort());

    const last = await c.call("library.search", { projectId, kind: "preset", limit: 500, offset: parts.length - 1 });
    expect(last.items.map((i) => i.id)).toEqual([seen[seen.length - 1]]);
  });

  it("keeps a search with no limit to one window and says how many there are", async () => {
    const out = await c.call("library.search", { projectId, kind: "preset" });
    expect(out.items.length).toBe(100);
    expect(out.total).toBe(parts.length);
  });

  it("refuses bad params before calling the sidecar", async () => {
    for (const bad of [{ offset: -1 }, { offset: 1.5 }, { offset: "2" as never }, { manufacturer: 7 as never }, { component_type: 7 as never }]) {
      expect(await c.request("library.search", { projectId, ...bad })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    }
  });
});
