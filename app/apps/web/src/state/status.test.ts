/** M1.48 `statusOf()` vocabulary (C §5.2): fixed labels, icons, tones; never green for unvalidated work. */
import type { CheckReport, JobInfo, PatchOp, RunListOut } from "@rw/contracts";
import { describe, expect, it } from "vitest";
import { isMissingInput, STATUS_TONE_COLOR, statusOf, type StatusSubject, type StatusView } from "./status.ts";

type Run = RunListOut["runs"][number];
const H = "a".repeat(64);
const OLD = "b".repeat(64);
const run = (over: Partial<Run>): Run => ({ sim: "baseline", sim_name: "Baseline", config: "baseline", kind: "flight", status: "complete", run_id: "r1", model_hash: H, ...over });
const job = (over: Partial<JobInfo>): JobInfo => ({ job_id: "job-1", kind: "simulate", state: "running", progress: 0.4, sim: "baseline", ...over });
const diag = (code: string, severity: "error" | "warning" | "info") => ({ code, severity, message: code });
const report = (diagnostics: ReturnType<typeof diag>[], model_hash = H) => ({ model_hash, diagnostics }) as unknown as CheckReport;
const pick = (v: StatusView) => ({ kind: v.kind, label: v.label, icon: v.icon, tone: v.tone });

describe("statusOf: runs (computed against the current model hash, I7)", () => {
  it("Complete is a teal check only on the current hash", () => {
    expect(pick(statusOf({ kind: "run", run: run({}), modelHash: H }))).toEqual({ kind: "complete", label: "Complete", icon: "check", tone: "teal" });
  });

  it("a stored `complete` on another hash is Outdated (amber warning)", () => {
    const v = statusOf({ kind: "run", run: run({ model_hash: OLD }), modelHash: H });
    expect(pick(v)).toEqual({ kind: "outdated", label: "Outdated", icon: "warning", tone: "amber" });
    expect(v.reason).toMatch(/Baseline uses an outdated model/);
  });

  it("a stored `outdated` on the current hash is Complete (status is never trusted as stored)", () => {
    expect(statusOf({ kind: "run", run: run({ status: "outdated" }), modelHash: H }).kind).toBe("complete");
  });

  it("an unknown current hash or missing run hash cannot be Complete", () => {
    expect(statusOf({ kind: "run", run: run({}), modelHash: null }).kind).toBe("outdated");
    expect(statusOf({ kind: "run", run: run({ model_hash: null }), modelHash: H }).kind).toBe("outdated");
    expect(statusOf({ kind: "run", run: run({ run_id: null }), modelHash: H }).kind).toBe("outdated");
  });

  it("Not run is a muted circle; so is a missing entry", () => {
    expect(pick(statusOf({ kind: "run", run: run({ status: "not_run", run_id: null }), modelHash: H }))).toEqual({ kind: "not_run", label: "Not run", icon: "circle", tone: "muted" });
    expect(statusOf({ kind: "run", run: undefined, modelHash: H }).kind).toBe("not_run");
  });

  it("a live job overrides the stored entry and carries progress", () => {
    const v = statusOf({ kind: "run", run: run({}), modelHash: H, job: job({}) });
    expect(v).toMatchObject({ kind: "running", label: "Running 40%", progress: 0.4, tone: "muted" });
    expect(statusOf({ kind: "run", run: run({}), modelHash: H, job: job({ state: "complete", progress: 1 }) }).kind).toBe("complete");
    expect(statusOf({ kind: "job", job: job({ state: "failed", error: "diverged" }) })).toMatchObject({ kind: "failed", tone: "danger", reason: "diverged" });
    expect(statusOf({ kind: "job", job: job({ state: "queued", progress: 0 }) }).kind).toBe("queued");
    expect(statusOf({ kind: "job", job: job({ state: "cancelled" }) }).kind).toBe("cancelled");
  });
});

describe("statusOf: check, inputs, drafts", () => {
  it("Missing inputs · N counts W200-249 only", () => {
    expect(isMissingInput({ code: "RW-W200" })).toBe(true);
    expect(isMissingInput({ code: "RW-W249" })).toBe(true);
    expect(isMissingInput({ code: "RW-W250" })).toBe(false);
    expect(isMissingInput({ code: "RW-W151" })).toBe(false);
    const v = statusOf({ kind: "inputs", diagnostics: [diag("RW-W201", "warning"), diag("RW-W210", "warning"), diag("RW-W151", "warning")] as never });
    expect(v).toEqual({ kind: "missing_inputs", label: "Missing inputs · 2", icon: "warning", tone: "amber", count: 2 });
  });

  it("check: errors > missing inputs > warnings > Checked; stale or absent reports are not checked", () => {
    expect(statusOf({ kind: "check", report: report([diag("RW-E021", "error"), diag("RW-W201", "warning")]), modelHash: H })).toMatchObject({ kind: "errors", label: "1 error", tone: "danger" });
    expect(statusOf({ kind: "check", report: report([diag("RW-W201", "warning")]), modelHash: H }).kind).toBe("missing_inputs");
    expect(statusOf({ kind: "check", report: report([diag("RW-W151", "warning"), diag("RW-W152", "warning")]), modelHash: H })).toMatchObject({ kind: "warnings", label: "2 warnings", tone: "amber" });
    expect(statusOf({ kind: "check", report: report([diag("RW-I900", "info")]), modelHash: H })).toMatchObject({ kind: "checked", icon: "check", tone: "teal" });
    expect(statusOf({ kind: "check", report: report([], OLD), modelHash: H })).toMatchObject({ kind: "outdated", tone: "amber" });
    expect(statusOf({ kind: "check", report: null, modelHash: H })).toMatchObject({ kind: "unchecked", tone: "muted" });
  });

  it("Modified (amber dot) for drafts and touched components; Saved is muted, not a check", () => {
    const ops: PatchOp[] = [{ op: "replace", path: "/c/fins/span", value: "90 mm" }];
    expect(pick(statusOf({ kind: "draft", ops }))).toEqual({ kind: "modified", label: "Modified", icon: "dot", tone: "amber" });
    expect(pick(statusOf({ kind: "draft", ops: [] }))).toEqual({ kind: "saved", label: "Saved", icon: "cloud", tone: "muted" });
    expect(statusOf({ kind: "component", id: "fins", ops }).kind).toBe("modified");
    expect(statusOf({ kind: "component", id: "fin", ops }).kind).toBe("saved");
    expect(statusOf({ kind: "component", id: "nose", ops: [{ op: "move", from: "/c/nose/x", path: "/c/body/x" }] }).kind).toBe("modified");
  });
});

describe("never green", () => {
  const subjects: StatusSubject[] = [
    { kind: "run", run: run({}), modelHash: H },
    { kind: "run", run: run({ model_hash: OLD }), modelHash: H },
    { kind: "run", run: run({ status: "not_run" }), modelHash: H },
    { kind: "run", run: run({ status: "failed" }), modelHash: H },
    { kind: "run", run: run({ status: "running" }), modelHash: H },
    { kind: "job", job: job({ state: "complete" }) },
    { kind: "check", report: report([]), modelHash: H },
    { kind: "inputs", diagnostics: [] },
    { kind: "draft", ops: [] },
  ];

  it("no status uses a green tone or a green-dominant colour", () => {
    for (const s of subjects) {
      const v = statusOf(s);
      expect(Object.keys(STATUS_TONE_COLOR)).toContain(v.tone);
      expect(v.tone).not.toMatch(/green|success/);
    }
    for (const hex of Object.values(STATUS_TONE_COLOR)) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
      // Green-dominant: g clearly above both r and b. Teal (#61b5ad) has b close to g.
      expect(g - Math.max(r, b), hex).toBeLessThan(16);
    }
  });

  it("only Complete and Checked earn a teal check", () => {
    const checks = subjects.map(statusOf).filter((v) => v.icon === "check");
    expect(new Set(checks.map((v) => v.kind))).toEqual(new Set(["complete", "checked"]));
  });
});
