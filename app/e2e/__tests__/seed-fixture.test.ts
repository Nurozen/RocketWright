/** M1.55: `fixtures/research-vehicle/seed.sh` and `seed.expected.json` agree (no `rw` run; `make seed-fixture` runs it). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadExpected, SEED_SCRIPT } from "../../../scripts/fixtures/seed.ts";

const script = readFileSync(SEED_SCRIPT, "utf8");
const expected = loadExpected();

describe("seeded research vehicle (D10a)", () => {
  it("expects steps 01-04 with the seed's titles and RW_CLOCK times, in order", () => {
    expect(expected.steps.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
    expect(expected.steps.map((s) => s.title)).toEqual(["Initial concept", "Assembly layout", "Fin revision", "Flight runs"]);
    let at = 0;
    for (const s of expected.steps) {
      const i = script.indexOf(`at ${s.ts} `);
      expect(i, s.ts).toBeGreaterThan(at);
      expect(script.slice(i).split("\n").slice(0, 2).join(" ")).toContain(`"${s.title}"`);
      at = i;
    }
  });

  it("tags Rev 07 at step 04 and leaves Recovery test Not run", () => {
    expect(expected.revisions).toEqual([{ number: 7, name: "Flight-ready fins", step: 4 }]);
    expect(script).toMatch(/history tag "Flight-ready fins" --number 7/);
    expect(expected.runs["recovery_test"]).toEqual({ status: "not_run" });
    expect(script).not.toMatch(/sim recovery_test/);
  });

  it("flies Fin revision before the fin edit and the current runs right after step 04", () => {
    const pos = (s: string) => script.indexOf(s);
    expect(pos("sim fin_revision")).toBeLessThan(pos('"Fin revision"'));
    expect(pos('"Flight runs"')).toBeLessThan(pos("sim baseline"));
    expect(pos('"Flight runs"')).toBeLessThan(pos("sim higher_altitude"));
    // Step 04 is a real model edit of both flights it precedes, and only the
    // Rev 07 tag sits between it and the runs.
    const cmds = script.slice(pos('"Flight runs"')).split(/\n(?=at )/);
    expect(cmds[0]).toContain("sims.baseline.");
    expect(cmds[0]).toContain("sims.higher_altitude.");
    expect(cmds[1]).toMatch(/history tag "Flight-ready fins"/);
    expect(cmds[2]).toMatch(/sim baseline/);
    expect(cmds[3]).toMatch(/sim higher_altitude/);
    expect(expected.runs["fin_revision"]).toMatchObject({ status: "outdated", model_step: 2 });
    expect(expected.runs["baseline"]).toMatchObject({ status: "complete", model_step: 4 });
    expect(expected.runs["higher_altitude"]).toMatchObject({ status: "complete", model_step: 4 });
  });
});
