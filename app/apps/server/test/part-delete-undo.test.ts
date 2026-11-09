/**
 * R2.2 against the real sidecar: deleting a part from the app is one history
 * step that also clears its motor and deploy entries, and the one undo the app
 * issues (`history.restore` of the step before) brings all of it back.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestClient, makeValidator } from "@rw/contracts/mock/harness";
import { AppServer } from "../src/rpc/AppServer.ts";
import { sidecarBin, tempProject } from "./helpers/harness.ts";

const validator = makeValidator();

describe("deleting a part (U48)", () => {
  let server: AppServer;
  let c: TestClient;
  let dir: string;
  let projectId: string;
  const config = () => readFileSync(join(dir, "configs/baseline.rw.toml"), "utf8");
  const model = () => readFileSync(join(dir, "rocket.rw.toml"), "utf8");

  beforeAll(async () => {
    dir = tempProject("rwdel", "fixtures/research-vehicle");
    server = await AppServer.start({ bin: sidecarBin(), stderr: "ignore", jobPollMs: 50, backoff: { initialMs: 50, maxMs: 400 } });
    c = await TestClient.connect(server.rpcUrl, validator);
    projectId = (await c.call("project.open", { dir })).project.projectId;
  }, 600_000);

  afterAll(async () => {
    c?.close();
    await server?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it("removes attached parts and config entries in one step, and one undo restores them", async () => {
    // A step to return to: the undo target is the step before the delete.
    const rename = await c.call("model.patch", { projectId, ops: [{ op: "add", path: "/c/nose/name", value: "Renamed nose" }], label: "Rename nose" });
    const before = { model: model(), config: config() };
    expect(before.config).toContain("[deploy.chute]");
    expect(before.config).toContain("[motors.motor_casing]");

    const out = await c.call("component.remove", { projectId, id: "recovery_bay", recursive: true, label: "Delete Recovery bay" });
    const seq = (step: string | null | undefined) => Number(String(step).replace("step:", ""));
    expect(seq(out.step)).toBe(seq(rename.step) + 1);
    expect(model()).not.toContain("[c.recovery_bay]");
    expect(model()).not.toContain("[c.chute]");
    expect(model()).not.toContain("[c.airframe]");
    expect(config()).not.toContain("[deploy.chute]");
    expect(config()).not.toContain("[motors.motor_casing]");

    await c.call("history.restore", { projectId, version: rename.step! });
    expect(model()).toBe(before.model);
    expect(config()).toBe(before.config);
  }, 120_000);

  it("removes several selected parts, listed with a descendant, in one step that one undo restores", async () => {
    const rename = await c.call("model.patch", { projectId, ops: [{ op: "add", path: "/c/nose/name", value: "Renamed again" }], label: "Rename again" });
    const before = { model: model(), config: config() };

    // `flight_computer` hangs under `ebay`; listing it too is not a failure.
    const out = await c.call("component.remove", { projectId, id: "ebay", also: ["flight_computer", "streamer"], recursive: true, label: "Delete 3 parts" });
    const seq = (step: string | null | undefined) => Number(String(step).replace("step:", ""));
    expect(seq(out.step)).toBe(seq(rename.step) + 1);
    expect(model()).not.toContain("[c.ebay]");
    expect(model()).not.toContain("[c.flight_computer]");
    expect(model()).not.toContain("[c.streamer]");
    expect(model()).toContain("[c.nose]");

    expect(await c.request("component.remove", { projectId, id: "nose", also: "fins" })).toMatchObject({ ok: false, error: { code: "invalid_params" } });

    await c.call("history.restore", { projectId, version: rename.step! });
    expect(model()).toBe(before.model);
    expect(config()).toBe(before.config);
  }, 120_000);
});
