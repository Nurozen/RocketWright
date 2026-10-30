/**
 * BC2-results: comparing two runs (concept 04) by their manifests'
 * conditions hash (`2 runs · Same environment`), as the history strip's
 * Compare shows them. (B17 removed the old chat's comparison card; the agent's
 * run cards are Lecturn's MCP Apps cards.)
 */
import type { Mention, ProjectSnapshot } from "@rw/contracts";
import { MockRpc } from "@rw/contracts/mock";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import type { DeepReadonly } from "../../state/types.ts";
import { environmentMatch, runComparison, runEntryOf } from "./comparison.ts";
import { RunComparePanel, runDelta } from "./RunComparePanel.tsx";

const mock = new MockRpc({ testHooks: false });
afterAll(() => mock.dispose());

const BASE: Mention = { ref: "rw:sim/baseline", label: "Baseline" };
const HIGHER: Mention = { ref: "rw:sim/higher_altitude", label: "Higher altitude" };

/** The mock project with Baseline and Higher altitude Complete; `hashes` sets each run's conditions hash. */
function snapshot(hashes: { baseline?: string | null; higher_altitude?: string | null }): DeepReadonly<ProjectSnapshot> {
  const snap = mock.snapshot();
  const base = snap.runs.runs.find((r) => r.sim === "baseline")!;
  const higher = { ...structuredClone(base), sim: "higher_altitude", sim_name: "Higher altitude", config: "higher_altitude", run_id: "a1b2c3d4e5f6" };
  higher.summary = { ...higher.summary!, apogee_m: base.summary!.apogee_m * 1.1 };
  base.conditions_hash = hashes.baseline ?? null;
  higher.conditions_hash = hashes.higher_altitude ?? null;
  snap.runs.runs = [base, higher, ...snap.runs.runs.filter((r) => r.sim !== "baseline" && r.sim !== "higher_altitude")];
  return snap as DeepReadonly<ProjectSnapshot>;
}

describe("environment match (run manifests' conditions hash)", () => {
  it("is same, different, or unknown", () => {
    expect(environmentMatch(["sha256:a", "sha256:a"])).toBe("same");
    expect(environmentMatch(["sha256:a", "sha256:b"])).toBe("different");
    expect(environmentMatch(["sha256:a", null])).toBe("unknown");
    expect(environmentMatch(["sha256:a"])).toBe("unknown");
  });

  it("labels the comparison from the runs in the mirror", () => {
    const same = runComparison(snapshot({ baseline: "sha256:x", higher_altitude: "sha256:x" }), [BASE, HIGHER]);
    expect(same.label).toBe("2 runs · Same environment");
    expect(same.environment).toBe("same");
    expect(same.runs.map((r) => r.key)).toEqual(["baseline", "higher_altitude"]);
    const diff = runComparison(snapshot({ baseline: "sha256:x", higher_altitude: "sha256:y" }), [BASE, HIGHER]);
    expect(diff.label).toBe("2 runs · Different environments");
    // A sim that never ran has no run (and no hash) to compare.
    const notRun = runComparison(snapshot({ baseline: "sha256:x" }), [BASE, { ref: "rw:sim/recovery_test", label: "Recovery test" }]);
    expect(notRun.environment).toBe("unknown");
    expect(runEntryOf(null, BASE.ref)).toBeNull();
  });
});

describe("Compare with two runs (history strip)", () => {
  it("shows run A → run B, the environment match, and the summary deltas", () => {
    const view = runComparison(snapshot({ baseline: "sha256:x", higher_altitude: "sha256:x" }), [BASE, HIGHER]);
    const html = renderToStaticMarkup(<RunComparePanel view={view} onClose={() => {}} />);
    expect(html).toContain("Baseline → Higher altitude");
    expect(html).toMatch(/data-testid="history\.run-compare" data-environment="same"/);
    expect(html).toContain("Same environment");
    expect(html).toContain("Apogee +10.0%");
    expect(runDelta(100, 92)).toBe("-8.0%");
    expect(runDelta(null, 1)).toBe("—");
    expect(runDelta(0, 0)).toBe("0%");
  });
});
