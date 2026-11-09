/**
 * B2-a's scripted fixture (U40): `turnFixtureProblems` cannot see the inner
 * script a `request` carries, and a wrong inner script fails only deep in a
 * live run, so the grammar and the fence format are checked here.
 */
import { describe, expect, it } from "vitest";
import { loadTurnFixture } from "../embed.ts";
import { scriptProblems } from "../capture/scripted.ts";
import { fencedScript, PROJECT_NEW_FIXTURE, WITH_REQUEST, BARE } from "../agent-project.ts";

const fixture = loadTurnFixture(PROJECT_NEW_FIXTURE);
const call = (ordinal: string) => {
  const step = fixture.scripts[ordinal]!.find((s) => "toolCall" in s) as { toolCall: { name: string; arguments?: Record<string, unknown> } };
  return step.toolCall;
};

describe("project-new.json", () => {
  it("calls rw_project_new in both scripts", () => {
    expect(call(WITH_REQUEST).name).toBe("rw_project_new");
    expect(call(BARE).name).toBe("rw_project_new");
  });

  it("carries no request in the no-request script, so the new thread takes no turn", () => {
    expect(call(BARE).arguments).not.toHaveProperty("request");
  });

  it("fences the inner script in a block Lecturn's scripted provider reads", () => {
    const request = call(WITH_REQUEST).arguments!["request"] as string;
    expect(request).toMatch(/```scripted\n/);
    const inner = fencedScript(request);
    expect(scriptProblems(inner)).toEqual([]);
    expect(JSON.stringify(inner)).not.toMatch(/\$\{/);
  });

  it("the inner script does not call a project tool", () => {
    const inner = fencedScript(call(WITH_REQUEST).arguments!["request"] as string) as { toolCall?: { name: string } }[];
    expect(inner.flatMap((s) => (s.toolCall === undefined ? [] : [s.toolCall.name]))).toEqual(["rw_model_get"]);
  });
});
