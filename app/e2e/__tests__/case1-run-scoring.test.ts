/** D29: the flight numbers come from the one run the app made, and nothing flies after quit. */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunManifest } from "../../packages/contracts/src/generated/index.ts";
import { assertPostQuitArgs, checkCell, createPostQuitReader, judgeRebuild, listRunManifests, runsTree, scoreRun, type PostQuitReader, type RunScoreInput, type TableRead } from "../case1-compare.ts";
import { loadCase1Plan, readEnv } from "../case1-plan.ts";
import { FIXTURE_DIR } from "../case1-script.ts";
import { SCRATCH, sidecarBinary } from "../live.ts";

let bin = "";
let root = "";
let flown = "";
let runId = "";
let next = 0;

const NOW = Date.parse("2026-11-08T12:00:30Z");
const CLICK = NOW - 10_000;
const QUIT = NOW + 10_000;

const TABLE: TableRead = {
  apogee: { header: "Apogee (m)", shown: "348" },
  maxSpeed: { header: "Max speed (m/s)", shown: "105" },
  flightTime: { header: "Flight time (s)", shown: "91" },
};

const manifestPath = (project: string) => join(project, "runs/simulation_5", runId, "manifest.json");
const patchManifest = (project: string, patch: Partial<RunManifest>) => {
  const file = manifestPath(project);
  writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as RunManifest), ...patch }));
};

/** A fresh copy of a project flown once by the CLI. */
const copy = (from: string = flown): string => {
  const to = join(root, `c${next++}`);
  cpSync(from, to, { recursive: true });
  return to;
};

/** A copy whose run the app appears to have made: `thread: "ui"`, started in the window. */
const appFlown = (): string => {
  const project = copy();
  patchManifest(project, { thread: "ui", started: new Date(NOW).toISOString().replace(/\.\d+Z$/, "Z") });
  return project;
};

const input = (project: string, over: Partial<RunScoreInput> = {}): RunScoreInput => ({
  project,
  reader: createPostQuitReader(bin, project),
  runClickedAtMs: CLICK,
  quitAtMs: QUIT,
  table: [TABLE, TABLE],
  ...over,
});

beforeAll(() => {
  bin = sidecarBinary();
  root = mkdtempSync(join(SCRATCH, "rw-case1-score-"));
  flown = join(root, "flown");
  cpSync(FIXTURE_DIR, flown, { recursive: true });
  // Flying here is the fixture being set up: this test file is not the scanned reader.
  execFileSync(bin, ["-C", flown, "sim", "--json", "simulation_5"], { encoding: "utf8", env: readEnv(), maxBuffer: 64 * 1024 * 1024 });
  runId = readdirSync(join(flown, "runs/simulation_5"))[0]!;
}, 300_000);

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

describe("scoreRun", () => {
  it("passes the app's one run, shown as the record says, inside the oracle", () => {
    const score = scoreRun(input(appFlown()));
    expect(score.problems).toEqual([]);
    expect(score.summary?.apogee_m).toBeGreaterThan(300);
    expect(score.oracle?.map((r) => r.key)).toEqual(["apogee_m", "max_velocity_ms", "time_to_apogee_s"]);
    expect(score.oracle?.every((r) => r.pass)).toBe(true);
  });

  it("fails a project never flown", () => {
    const project = join(root, `never${next++}`);
    cpSync(FIXTURE_DIR, project, { recursive: true });
    expect(scoreRun(input(project)).problems.join()).toMatch(/exactly one flight run in runs\/, found 0/);
  });

  it("fails a run flown by rw sim: a CLI flight has no thread", () => {
    const project = copy();
    patchManifest(project, { started: new Date(NOW).toISOString() });
    expect(scoreRun(input(project)).problems.join()).toMatch(/not flown by the app: manifest.thread is null/);
  });

  it("fails two run directories", () => {
    const project = appFlown();
    const other = join(project, "runs/simulation_5/aaaaaaaaaaaa");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "manifest.json"), readFileSync(manifestPath(project), "utf8"));
    expect(listRunManifests(project)).toHaveLength(2);
    expect(scoreRun(input(project)).problems.join()).toMatch(/exactly one flight run in runs\/, found 2/);
  });

  it("fails a run whose model_hash is not the final model", () => {
    const project = appFlown();
    patchManifest(project, { model_hash: "0".repeat(64) });
    expect(scoreRun(input(project)).problems.join()).toMatch(/is not the final model/);
  });

  it("fails a run started outside the Run click and the quit", () => {
    const project = appFlown();
    expect(scoreRun(input(project, { runClickedAtMs: NOW + 5_000 })).problems.join()).toMatch(/outside the Run click and the quit/);
    expect(scoreRun(input(project, { quitAtMs: NOW - 5_000 })).problems.join()).toMatch(/outside the Run click and the quit/);
  });

  it("allows the one-second resolution of started at both ends", () => {
    const project = appFlown();
    expect(scoreRun(input(project, { runClickedAtMs: NOW + 400, quitAtMs: NOW + 900 })).problems).toEqual([]);
    expect(scoreRun(input(project, { runClickedAtMs: NOW - 900, quitAtMs: NOW - 400 })).problems).toEqual([]);
  });

  it("fails a table value off by more than its displayed digit", () => {
    const project = appFlown();
    const off = (shown: string): TableRead => ({ ...TABLE, apogee: { ...TABLE.apogee, shown } });
    expect(scoreRun(input(project, { table: [off("347")] })).problems.join()).toMatch(/Apogee: the table shows 347 m/);
    expect(scoreRun(input(project, { table: [off("349")] })).problems.join()).toMatch(/Apogee: the table shows 349 m/);
  });

  it("fails a dash in the table", () => {
    const project = appFlown();
    const dash: TableRead = { ...TABLE, flightTime: { ...TABLE.flightTime, shown: "—" } };
    expect(scoreRun(input(project, { table: [dash] })).problems.join()).toMatch(/Flight time: the table shows "—", not a number/);
  });

  it("fails a table that changed between the run and the reopen", () => {
    const project = appFlown();
    const later: TableRead = { ...TABLE, maxSpeed: { ...TABLE.maxSpeed, shown: "105.2" } };
    expect(scoreRun(input(project, { table: [TABLE, later] })).problems.join()).toMatch(/changed between the run and the reopen/);
  });

  it("fails when the table was never read", () => {
    expect(scoreRun(input(appFlown(), { table: [] })).problems.join()).toMatch(/never read/);
  });

  it("fails a runs/ tree that changes during the post-quit reads", () => {
    const project = appFlown();
    const real = createPostQuitReader(bin, project);
    const reader: PostQuitReader = {
      calls: real.calls,
      model: () => real.model(),
      check: () => {
        const out = real.check();
        writeFileSync(join(project, "runs/simulation_5", runId, "summary.json"), `${readFileSync(join(project, "runs/simulation_5", runId, "summary.json"), "utf8")}\n`);
        return out;
      },
      runSummary: (id) => real.runSummary(id),
    };
    expect(scoreRun(input(project, { reader })).problems.join()).toMatch(/runs\/ changed during the post-quit reads/);
  });

  it("fails when a reader already ran before the runs were listed", () => {
    const project = appFlown();
    const reader = createPostQuitReader(bin, project);
    reader.check();
    expect(scoreRun(input(project, { reader })).problems.join()).toMatch(/before the run directories were listed/);
  });

  it("fails a flight number outside the oracle", () => {
    const project = appFlown();
    const real = createPostQuitReader(bin, project);
    const reader: PostQuitReader = {
      ...real,
      calls: real.calls,
      check: () => real.check(),
      model: () => real.model(),
      runSummary: (id) => {
        const out = real.runSummary(id);
        out.summary.apogee_m = 300;
        return out;
      },
    };
    const problems = scoreRun(input(project, { reader, table: [{ ...TABLE, apogee: { ...TABLE.apogee, shown: "300" } }] })).problems;
    expect(problems.join()).toMatch(/apogee_m 300 is outside/);
  });
});

describe("judgeRebuild", () => {
  const verdictFor = (project: string, over: { reader?: PostQuitReader } = {}) => {
    const reader = over.reader ?? createPostQuitReader(bin, project);
    return judgeRebuild({ plan: loadCase1Plan(bin), project, reader, run: { runClickedAtMs: CLICK, quitAtMs: QUIT, table: [TABLE, TABLE] } });
  };

  it("passes the app's flight of the finished model and reports its numbers", () => {
    const verdict = verdictFor(appFlown());
    expect(verdict).toMatchObject({ diffs: [], problems: [] });
    expect(verdict.flight?.oracle.map((r) => r.key)).toEqual(["apogee_m", "max_velocity_ms", "time_to_apogee_s"]);
  });

  it("scores the run: a project never flown fails however good the model is", () => {
    const project = join(root, `never${next++}`);
    cpSync(FIXTURE_DIR, project, { recursive: true });
    const verdict = verdictFor(project);
    expect(verdict.problems.join()).toMatch(/exactly one flight run/);
    expect(verdict.flight).toBeUndefined();
  });

  it("fails a runs/ tree that changes during the reads after the run is scored", () => {
    const project = appFlown();
    const real = createPostQuitReader(bin, project);
    let evals = 0;
    const reader: PostQuitReader = {
      ...real,
      calls: real.calls,
      check: () => real.check(),
      runSummary: (id) => real.runSummary(id),
      model: () => {
        evals += 1;
        writeFileSync(join(project, "runs/simulation_5", runId, "stray"), "x");
        return real.model();
      },
    };
    expect(verdictFor(project, { reader }).problems.join()).toMatch(/runs\/ changed during the post-quit reads/);
    expect(evals).toBe(1);
  });
});

describe("checkCell", () => {
  it("converts the record to the header's unit and takes half the last digit", () => {
    expect(checkCell("A", { header: "Apogee (ft)", shown: "1,140" }, 347.575)).toBeNull();
    expect(checkCell("A", { header: "Apogee (m)", shown: "347.6" }, 347.575)).toBeNull();
    expect(checkCell("A", { header: "Apogee (m)", shown: "347.5" }, 347.575)).toMatch(/shows 347.5 m/);
  });

  it("names a header with no unit it knows", () => {
    expect(checkCell("A", { header: "Apogee", shown: "1" }, 1)).toMatch(/no known unit/);
    expect(checkCell("A", { header: "Apogee (parsec)", shown: "1" }, 1)).toMatch(/no known unit/);
  });
});

describe("the post-quit reader", () => {
  it("allows only eval, check and run summary", () => {
    for (const ok of [["eval", "--json"], ["check", "--json"], ["run", "summary", "s/r", "--json"]]) expect(() => assertPostQuitArgs(ok)).not.toThrow();
    for (const bad of [["sim", "--json", "s"], ["simulate", "s"], ["sim", "s", "--force"], ["run", "summary", "--json"], ["check", "--json", "--sim", "quick"], ["call", "simulate"], ["run", "summary", "--force", "--json"], ["eval"]]) {
      expect(() => assertPostQuitArgs(bad), bad.join(" ")).toThrow(/post-quit reader refuses/);
    }
  });

  it("refuses before spawning, and logs only what it ran", () => {
    const project = copy();
    const reader = createPostQuitReader(bin, project);
    reader.model();
    reader.check();
    expect(reader.calls).toEqual([["eval", "--json"], ["check", "--json"]]);
  });

  it("the snapshot sees path, size and mtime", () => {
    const project = copy();
    const before = runsTree(project);
    expect(before.length).toBeGreaterThan(3);
    writeFileSync(join(project, "runs/simulation_5", runId, "extra"), "x");
    expect(runsTree(project)).not.toEqual(before);
    expect(runsTree(join(root, "absent"))).toEqual([]);
  });
});
