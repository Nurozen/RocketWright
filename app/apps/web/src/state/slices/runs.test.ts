/** R2.7: Cancel and Delete in the runs slice, and the row a cancelled job leaves. */
import type { JobInfo, ProjectSnapshot, RunListOut, SimulateOut } from "@rw/contracts";
import { MockRpc } from "@rw/contracts/mock";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createAppStore } from "../store.ts";
import type { AppState, DeepReadonly, RunsSlice, SliceCtx } from "../types.ts";
import { createRunsSlice, runRows } from "./runs.ts";

const mock = new MockRpc({ testHooks: false });
afterAll(() => mock.dispose());

type Entry = RunListOut["runs"][number];

function harness(over: { snap?: (s: ProjectSnapshot) => void; call?: (method: string, params: unknown) => unknown; overlay?: string[]; refs?: string[] } = {}) {
  const snap = structuredClone(mock.snapshot());
  over.snap?.(snap);
  const base = createAppStore({ loadWasm: () => Promise.reject(new Error("no wasm in tests")) }).getState();
  const select = vi.fn<AppState["selection"]["select"]>((refs) => {
    state = { ...state, selection: { ...state.selection, refs: [...refs] } };
  });
  let state: AppState = {
    ...base,
    project: { ...base.project, projectId: "p", snapshot: snap as DeepReadonly<ProjectSnapshot> },
    selection: { ...base.selection, refs: over.refs ?? [], select },
  };
  const call = vi.fn<(method: string, params: unknown) => Promise<unknown>>(async (method, params) => over.call?.(method, params));
  const ctx = {
    conn: () => ({ client: { call }, projectId: "p" }),
    get: () => state,
    patch: (key: "runs", p: Partial<RunsSlice> | ((r: RunsSlice) => Partial<RunsSlice>)) => {
      state = { ...state, runs: { ...state.runs, ...(typeof p === "function" ? p(state.runs) : p) } };
    },
  } as unknown as SliceCtx;
  state = { ...state, runs: { ...createRunsSlice(ctx), overlay: over.overlay ?? [] } };
  return { runs: () => state.runs, state: () => state, call, select, snap };
}

describe("cancel", () => {
  it("goes through job.cancel", async () => {
    const { runs, call } = harness({ call: () => ({ job_id: "j-1", state: "running" }) as unknown as JobInfo });
    await runs().cancel("j-1");
    expect(call).toHaveBeenCalledWith("job.cancel", { projectId: "p", jobId: "j-1" });
    expect(runs().error).toBeNull();
  });

  it("records why it could not cancel", async () => {
    const { runs } = harness({
      call: () => {
        throw new Error("no job `j-1`");
      },
    });
    await expect(runs().cancel("j-1")).rejects.toThrow("no job");
    expect(runs().error).toBe("no job `j-1`");
  });
});

describe("deleteRun", () => {
  it("names the run exactly and drops it from the overlay", async () => {
    const { runs, call } = harness({ overlay: ["baseline", "fin_revision"] });
    await runs().deleteRun({ key: "baseline", sim: "baseline", runId: "abc123abc123" });
    expect(call).toHaveBeenCalledWith("run.delete", { projectId: "p", run: "baseline/abc123abc123" });
    expect(runs().overlay).toEqual(["fin_revision"]);
  });

  it("also drops the run the deleted one had replaced, whose row key is about to change", async () => {
    const { runs } = harness({ overlay: ["baseline", "baseline@0ld"] });
    await runs().deleteRun({ key: "baseline", sim: "baseline", runId: "abc123abc123" });
    expect(runs().overlay).toEqual([]);
  });

  it("keeps the rest of the overlay when an older run goes", async () => {
    const { runs } = harness({ overlay: ["baseline", "baseline@0ld"] });
    await runs().deleteRun({ key: "baseline@0ld", sim: "baseline", runId: "0ld" });
    expect(runs().overlay).toEqual(["baseline"]);
  });

  it("drops a selection that named the deleted run", async () => {
    const { runs, select } = harness({ refs: ["rw:run/abc123abc123"] });
    await runs().deleteRun({ key: "baseline@abc123abc123", sim: "baseline", runId: "abc123abc123" });
    expect(select).toHaveBeenCalledWith([], "table");
  });

  it("keeps a selected sim that still exists and drops one that does not", async () => {
    const kept = harness({ refs: ["rw:sim/baseline"] });
    await kept.runs().deleteRun({ key: "baseline", sim: "baseline", runId: "abc123abc123" });
    expect(kept.select).not.toHaveBeenCalled();

    const gone = harness({
      refs: ["rw:sim/baseline"],
      snap: (s) => {
        delete (s.evaluated!.sims as Record<string, unknown>)["baseline"];
      },
    });
    await gone.runs().deleteRun({ key: "baseline", sim: "baseline", runId: "abc123abc123" });
    expect(gone.select).toHaveBeenCalledWith([], "table");
  });

  it("leaves everything alone when the sidecar refuses", async () => {
    const { runs } = harness({
      overlay: ["baseline"],
      call: () => {
        throw new Error("simulation `baseline` has a job in progress");
      },
    });
    await expect(runs().deleteRun({ key: "baseline", sim: "baseline", runId: "abc123abc123" })).rejects.toThrow("job in progress");
    expect(runs().overlay).toEqual(["baseline"]);
  });
});

describe("the row a cancelled job leaves", () => {
  const cancelledBaseline = (s: ProjectSnapshot) => {
    s.jobs = [{ job_id: "j-1", kind: "simulate", sim: "baseline", state: "cancelled", progress: 0.4 }] as never;
    (s.runs.runs.find((r) => r.sim === "baseline") as Entry).job_id = "j-1";
  };
  const baseline = (s: AppState) => runRows(s).find((r) => r.sim === "baseline")!;

  it("reads Cancelled", () => {
    expect(baseline(harness({ snap: cancelledBaseline }).state()).status.kind).toBe("cancelled");
  });

  it("goes back to the stored run's status once Run answers from the cache", () => {
    const h = harness({ snap: cancelledBaseline });
    const entry = h.snap.runs.runs.find((r) => r.sim === "baseline")!;
    const answer = { sim: "baseline", run_id: entry.run_id!, status: "complete", cached: true } as SimulateOut;
    const state: AppState = { ...h.state(), runs: { ...h.state().runs, started: { baseline: answer } } };
    expect(baseline(state).status.kind).toBe("complete");
  });

  it("stays Cancelled when the last answer started a job", () => {
    const h = harness({ snap: cancelledBaseline });
    const entry = h.snap.runs.runs.find((r) => r.sim === "baseline")!;
    const answer = { sim: "baseline", run_id: entry.run_id!, status: "running", cached: false, job_id: "j-1" } as SimulateOut;
    const state: AppState = { ...h.state(), runs: { ...h.state().runs, started: { baseline: answer } } };
    expect(baseline(state).status.kind).toBe("cancelled");
  });
});
