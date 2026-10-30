/**
 * CPW2A: W-B2.4's closed flow (`app/e2e/b4b-attach.ts` check `closed`), its
 * pure parts: the Apps > RocketWright listing from a shell snapshot, the
 * body length before and after, the scripted turn (valid D22, and its patch
 * applies to the research vehicle: a dry run through the real CLI), and the
 * judgement of the turn's calls (headless tools ran, live tools closed).
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { appThreads, RW_APP_ID, type ShellLike } from "../../../scripts/bar/lecturn-admin.ts";
import { FOLLOW_UP_FIXTURE } from "../../../scripts/bar/live-smoke.ts";
import { BODY_DELTA_MM, BODY_ID, CLOSED_PROMPT, closedSteps, componentLengthMm, evaluatedLength, judgeClosedTurn } from "../b4b-attach.ts";
import { scriptProblems } from "../capture/scripted.ts";
import { sidecarBinary } from "../live.ts";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

describe("the Apps > RocketWright listing (shell snapshot)", () => {
  const shell: ShellLike = {
    projects: [
      { id: "p1", title: "Research vehicle", appBinding: { appId: RW_APP_ID, workspaceRoot: "/private/tmp/x/Research vehicle" } },
      { id: "p2", title: "Other app", appBinding: { appId: "dev.other.app", workspaceRoot: "/private/tmp/x/Research vehicle" } },
      { id: "p3", title: "Plain project" },
    ],
    threads: [
      { id: "copy:e:t1", projectId: "p1", title: "Live switch" },
      { id: "t2", projectId: "p1", title: "Gone", deletedAt: "2026-10-26T00:00:00.000Z" },
      { id: "t3", projectId: "p2", title: "Elsewhere" },
      { id: "t4", projectId: "p3", title: "Not an app thread" },
    ],
  };

  it("lists the app's workspace threads at that root only", () => {
    expect(appThreads(shell, RW_APP_ID, "/private/tmp/x/Research vehicle/")).toEqual({ projectId: "p1", projectTitle: "Research vehicle", threads: [{ id: "copy:e:t1", title: "Live switch" }] });
    expect(appThreads(shell, RW_APP_ID, "/private/tmp/y")).toBeNull();
    expect(appThreads({ projects: [], threads: [] }, RW_APP_ID, "/r")).toBeNull();
  });
});

describe("the body length", () => {
  const toml = readFileSync(join(FOLLOW_UP_FIXTURE, "rocket.rw.toml"), "utf8");

  it("reads [c.airframe]'s length from the rocket file, not another table's", () => {
    expect(componentLengthMm(toml, BODY_ID)).toBe(300);
    expect(componentLengthMm(toml, "nose")).toBe(150);
    expect(componentLengthMm(toml, "nope")).toBeNull();
    expect(componentLengthMm('[c.a]\nname = "A"\n[c.b]\nlength = "5 mm"\n', "a")).toBeNull();
  });

  it("reads an evaluated component's length (shape, else stations)", () => {
    expect(evaluatedLength({ components: [{ id: "airframe", shape: { type: "body_tube", length: 0.32 } }] }, "airframe")).toBe(0.32);
    expect(evaluatedLength({ components: [{ id: "airframe", x_fore: 0.26, x_aft: 0.58 }] }, "airframe")).toBeCloseTo(0.32);
    expect(evaluatedLength({ components: [] }, "airframe")).toBeNull();
    expect(evaluatedLength(null, "airframe")).toBeNull();
  });
});

describe("the closed turn", () => {
  it("is the spec's message and a valid script: patch, check, fly, then a live tool", () => {
    expect(CLOSED_PROMPT).toBe("lengthen the body by 20 mm and re-run the sim");
    const steps = closedSteps(300 + BODY_DELTA_MM);
    expect(scriptProblems(steps)).toEqual([]);
    const names = steps.flatMap((s) => {
      const o = s as { toolCall?: { name: string }; poll?: { toolCall: { name: string } } };
      return o.toolCall ? [o.toolCall.name] : o.poll ? [o.poll.toolCall.name] : [];
    });
    expect(names).toEqual(["rw_model_patch", "rw_design_check", "rw_simulate", "rw_job_status", "rw_viewport_set_camera"]);
    expect(JSON.stringify(steps[0])).toContain('"value":"320 mm"');
  });

  it("its patch applies to the research vehicle (a dry run through the CLI)", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "rw-closed-")), "Research vehicle");
    temps.push(join(dir, ".."));
    cpSync(FOLLOW_UP_FIXTURE, dir, { recursive: true });
    const patch = (closedSteps(320)[0] as { toolCall: { arguments: Record<string, unknown> } }).toolCall.arguments;
    const out = JSON.parse(execFileSync(sidecarBinary(), ["-C", dir, "call", "model_patch", JSON.stringify({ ...patch, dry_run: true })], { encoding: "utf8", env: { ...process.env, RW_OFFLINE: "1" } })) as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain("airframe");
    // A dry run writes nothing.
    expect(componentLengthMm(readFileSync(join(dir, "rocket.rw.toml"), "utf8"), BODY_ID)).toBe(300);
  }, 120_000);

  it("passes when the headless tools ran and the live tool answered the closed error", () => {
    const ok = (tool: string, output: unknown = {}) => ({ tool, isError: false, output: output as never });
    const closed = { tool: "viewport_set_camera", isError: true, output: "RocketWright is closed; open it to use rw_viewport_set_camera." as never };
    const job = ok("job_status", { state: "complete", sim: "baseline", run_id: "abc123abc123" });
    expect(judgeClosedTurn([ok("model_patch"), ok("design_check"), ok("simulate"), ok("job_status", { state: "running" }), job, closed])).toEqual({ reasons: [], runId: "abc123abc123", sim: "baseline" });
    const r = judgeClosedTurn([ok("model_patch"), { ...ok("simulate"), isError: true }, ok("job_status", { state: "failed" }), { ...closed, isError: false, output: {} as never }]);
    expect(r.runId).toBeNull();
    expect(r.reasons).toEqual([
      "rw_design_check did not run",
      expect.stringMatching(/^rw_simulate failed with RocketWright closed/),
      expect.stringMatching(/^the run did not complete headless/),
      expect.stringMatching(/^rw_viewport_set_camera did not answer the closed error/),
    ]);
    expect(judgeClosedTurn([ok("model_patch"), ok("design_check"), ok("simulate"), job]).reasons).toEqual(["no rw_viewport_* call was made"]);
  });
});
