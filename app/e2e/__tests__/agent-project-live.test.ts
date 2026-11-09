/**
 * B2-b's scorer and its gate (U41). The trials themselves need a provider
 * login and run only with `RW_LIVE=1`; this runs the self-test on the recorded
 * transcripts and proves report mode does nothing without it.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_PATHS, RECORDED_DIR, TRIALS_PER_PATH, loadRecord, main, modelProblems, parseArgs, scoreTrial, selfTest, snapshotTree, treeDiff } from "../../../scripts/bar/agent-project-live.ts";

describe("B2-b live scorer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes its self-test on the recorded transcripts and planted faults", () => {
    expect(selfTest()).toEqual([]);
  });

  it("scores each recorded path as a pass", () => {
    for (const path of LIVE_PATHS) expect(scoreTrial(loadRecord(join(RECORDED_DIR, `${path}.json`))).reasons).toEqual([]);
  });

  it("exempts only what rw init wrote, and the new thread's edit", () => {
    const accept = scoreTrial(loadRecord(join(RECORDED_DIR, "accept.json")));
    expect(accept.exempt.every((e) => e.endsWith("(rw init)"))).toBe(true);
    const remaining = scoreTrial(loadRecord(join(RECORDED_DIR, "remaining.json")));
    expect(remaining.exempt).toContain("rocket.rw.toml (the new thread's edit)");
  });

  it("ignores .rw and artifacts in a tree diff", () => {
    expect(treeDiff({ a: "1" }, { a: "1", "artifacts/x": "2", ".rw/y": "3", b: "4" })).toEqual([{ path: "b", change: "added" }]);
  });

  it("does not walk .rw and reports a missing folder as null", () => {
    expect(snapshotTree("/tmp/rw-b2l-no-such-folder")).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "rw-b2l-tree-"));
    try {
      mkdirSync(join(dir, ".rw"));
      mkdirSync(join(dir, "configs"));
      writeFileSync(join(dir, ".rw/state"), "x");
      writeFileSync(join(dir, "configs/a.toml"), "x");
      expect(Object.keys(snapshotTree(dir)!)).toEqual(["configs/a.toml"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds nothing between a model and itself but the absent nose", () => {
    const record = loadRecord(join(RECORDED_DIR, "remaining.json"));
    expect(modelProblems(record.control!.model, record.target_model!)).toEqual([]);
    expect(modelProblems(record.control!.model, record.control!.model)).toEqual(["added 0 components, want exactly one nose cone"]);
  });

});

describe("B2-b report mode", () => {
  afterEach(() => vi.restoreAllMocks());

  it("skips without RW_LIVE=1 and writes nothing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), "rw-b2l-skip-"));
    const out = join(dir, "report.json");
    try {
      await expect(main(["--out", out], {})).resolves.toBe(0);
      await expect(main(["--out", out], { RW_LIVE: "0" })).resolves.toBe(0);
      expect(existsSync(out)).toBe(false);
      expect(log.mock.calls.flat().join("\n")).toContain("skipped (set RW_LIVE=1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-scores a saved record offline, and writes only where told", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), "rw-b2l-score-"));
    const out = join(dir, "report.json");
    try {
      await expect(main(["--score", join(RECORDED_DIR, "accept.json"), "--out", out], {})).resolves.toBe(0);
      expect(existsSync(out)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses its arguments and refuses bad ones", () => {
    const a = parseArgs(["--trials", "2", "--paths", "cancel,accept", "--model", "claudeAgent/m", "--timeout-min", "9"]);
    expect(a).toMatchObject({ trials: 2, paths: ["cancel", "accept"], model: { instanceId: "claudeAgent", model: "m" }, timeoutMs: 540_000 });
    expect(parseArgs([])).toMatchObject({ trials: TRIALS_PER_PATH, paths: LIVE_PATHS });
    expect(parseArgs(["--paths", "maybe"])).toBe("unknown path maybe");
    expect(parseArgs(["--trials", "0"])).toBe("--trials needs a whole number");
    expect(parseArgs(["--provider", "other"])).toBe("--provider is claude or codex");
    expect(parseArgs(["--nope", "1"])).toBe("unknown argument --nope");
  });
});
