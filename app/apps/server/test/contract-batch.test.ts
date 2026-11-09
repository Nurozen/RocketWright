/**
 * The U13 contract batch against the real sidecar: the thin wrappers over
 * existing tools, `export.file`'s role check on `allow_outside`, and the stubs
 * that answer `internal` until their step lands. Every frame is validated
 * against the IF10 schemas (`TestClient`).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcMethod } from "@rw/contracts";
import { TestClient, makeValidator } from "@rw/contracts/mock/harness";
import { AppServer } from "../src/rpc/AppServer.ts";
import { sidecarBin, tempProject } from "./helpers/harness.ts";

const validator = makeValidator();
const SEED = "fixtures/research-vehicle";

describe("contract batch (U13)", () => {
  let server: AppServer;
  let c: TestClient;
  let dir: string;
  let outside: string;
  let projectId: string;

  beforeAll(async () => {
    dir = tempProject("rwc", SEED);
    outside = mkdtempSync("/tmp/rwc-out-");
    server = await AppServer.start({ bin: sidecarBin(), stderr: "ignore", jobPollMs: 50, backoff: { initialMs: 50, maxMs: 400 } });
    c = await TestClient.connect(server.rpcUrl, validator);
    projectId = (await c.call("project.open", { dir })).project.projectId;
  }, 600_000);

  afterAll(async () => {
    c?.close();
    await server?.close();
    for (const d of [dir, outside]) if (d !== undefined) rmSync(d, { recursive: true, force: true });
  });

  it("refuses export.file with allow_outside and writes nothing", async () => {
    const path = join(outside, "out.csv");
    const r = await c.request("export.file", { projectId, format: "ork", path, allow_outside: true });
    expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(existsSync(path)).toBe(false);
  });

  it("export.file with allow_outside writes outside the project on main's socket only (D11)", async () => {
    const main = await TestClient.connect(server.rpcUrl, validator);
    try {
      await main.call("host.register", { token: server.mainToken });
      const path = join(outside, "from-main.ork");
      await main.call("export.file", { projectId, format: "ork", path, allow_outside: true });
      expect(existsSync(path)).toBe(true);
      const again = join(outside, "from-page.ork");
      expect(await c.request("export.file", { projectId, format: "ork", path: again, allow_outside: true })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(existsSync(again)).toBe(false);
    } finally {
      main.close();
    }
  });

  it("export.file writes inside the project without allow_outside", async () => {
    const out = await c.call("export.file", { projectId, format: "ork", path: "exports/rocket.ork" });
    expect(out.bytes).toBeGreaterThan(0);
    expect(existsSync(join(dir, out.path))).toBe(true);
    expect(await c.request("export.file", { projectId, format: "nope" as never, path: "exports/a" })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });

  it("motor.search answers the built-in library", async () => {
    const { motors } = await c.call("motor.search", { projectId, query: "C6", limit: 5 });
    expect(motors.length).toBeGreaterThan(0);
    expect(motors[0]!.id).toMatch(/:/);
  });

  it("import.file reads a motor from outside the project", async () => {
    const path = join(outside, "Acme_T1.eng");
    writeFileSync(path, "; test motor\nT1 18 70 0 0.0125 0.0242 RW\n0.05 10.0\n0.5 8.0\n1.0 0.0\n");
    const out = await c.call("import.file", { projectId, path, kind: "motor", dry_run: true });
    expect(out.dry_run).toBe(true);
    expect(await c.request("import.file", { projectId, path, kind: "nope" as never })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });

  it("component.remove previews through the sidecar and refuses an unknown part", async () => {
    const { components } = (await c.call("model.get", { projectId })).model!;
    const leaf = components.find((x) => !components.some((y) => y.parent === x.id))!;
    const dry = await c.call("component.remove", { projectId, id: leaf.id, dry_run: true });
    expect(dry.dry_run).toBe(true);
    expect(await c.request("component.remove", { projectId, id: "no-such-part" })).toMatchObject({ ok: false, error: { code: "api_error" } });
  });

  it("render draws a 2D view and validates the view", async () => {
    const out = await c.call("render", { projectId, view: "profile", width: 320, height: 200 });
    expect(out.path).toMatch(/\.png$/);
    expect(await c.request("render", { projectId, view: "nope" as never })).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  }, 60_000);

  it("motor.show returns a motor and its curve", async () => {
    const { info, curve } = await c.call("motor.show", { projectId, id: "generic:RW_C6G" });
    expect(info.id).toBe("generic:RW_C6G");
    expect(curve.points.length).toBeGreaterThan(2);
    expect(await c.request("motor.show", { projectId, id: "generic:NOPE" })).toMatchObject({ ok: false, error: { code: "api_error" } });
  });

  it("run.delete reaches the sidecar and validates its params", async () => {
    expect(await c.request("run.delete", { projectId, run: "baseline/aaaaaaaaaaaa", dry_run: true })).toMatchObject({ ok: false, error: { code: "api_error", api: { code: "not_found" } } });
    expect(await c.request("run.delete", { projectId } as never)).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  });

  it("the unimplemented methods answer internal until their steps land", async () => {
    const stubs: [RpcMethod, Record<string, unknown>][] = [
      ["project.restartSidecar", { projectId }],
    ];
    for (const [method, params] of stubs) {
      expect(await c.request(method, params as never), method).toMatchObject({ ok: false, error: { code: "internal" } });
    }
  });

  it("every frame matched the IF10 schemas", () => {
    expect(c.violations).toEqual([]);
  });
});
