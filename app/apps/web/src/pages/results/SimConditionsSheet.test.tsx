// @vitest-environment jsdom
/** R2.5/R2.7: the conditions sheet and the Not run row, against a mock project. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MutationOut, ProjectSnapshot } from "@rw/contracts";
import { MockRpc } from "@rw/contracts/mock";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { anyDirtyField, discardDirtyFields, flushProject, resetDirtyFields } from "../../state/dirtyFields.ts";
import { blurFromWindow } from "../../testing/windowFocus.ts";
import { createAppStore, type AppStore } from "../../state/store.ts";
import type { AppState } from "../../state/types.ts";
import { resultsUiStore } from "./resultsUi.ts";
import { ResultsPage } from "./ResultsPage.tsx";
import { RunTable } from "./RunTable.tsx";
import { newSimulation, SimConditionsSheet } from "./SimConditionsSheet.tsx";

vi.mock("./TrajectoryView.tsx", () => ({ TrajectoryView: () => null }));
vi.mock("../../plots/TimePlot.tsx", () => ({ TimePlot: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mock = new MockRpc({ testHooks: false });
afterAll(() => mock.dispose());

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  resetDirtyFields();
});

const OK: MutationOut = { model_hash: "h", dry_run: false, files: [], delta: { status: "pass", model_hash: "h", changed: {}, new_diagnostics: [], resolved_diagnostics: [] } } as unknown as MutationOut;

function makeStore(edit: (snap: ProjectSnapshot) => void = () => undefined) {
  const snap = structuredClone(mock.snapshot());
  edit(snap);
  const base = createAppStore({ loadWasm: () => Promise.reject(new Error("no wasm in tests")) }).getState();
  const dryRun = vi.fn<AppState["draft"]["dryRun"]>(async () => OK);
  const mutate = vi.fn<AppState["draft"]["mutate"]>(async () => OK);
  const run = vi.fn<AppState["runs"]["run"]>(async () => ({}) as never);
  const cancel = vi.fn<AppState["runs"]["cancel"]>(async () => ({}) as never);
  const deleteRun = vi.fn<AppState["runs"]["deleteRun"]>(async () => undefined);
  const select = vi.fn<AppState["selection"]["select"]>();
  const state: AppState = {
    ...base,
    project: { ...base.project, projectId: "p", snapshot: snap as never },
    draft: { ...base.draft, dryRun, mutate },
    runs: { ...base.runs, run, cancel, deleteRun },
    selection: { ...base.selection, select },
  };
  const app = createStore<AppState>()(() => state) as unknown as AppStore;
  return { app, snap, dryRun, mutate, run, cancel, deleteRun, select };
}

async function mount(app: AppStore, sim: string | null) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => {
    resultsUiStore(app).getState().set({ conditions: sim });
    root!.render(
      <>
        <RunTable app={app} />
        <SimConditionsSheet app={app} />
      </>,
    );
  });
  return el;
}

const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]');
const group = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="group"]')].find((g) => g.querySelector("h3")?.textContent === name)!;
const input = (scope: HTMLElement, label: string) => scope.querySelector<HTMLInputElement>(`input[aria-label="${label}"], select[aria-label="${label}"]`)!;
const button = (scope: HTMLElement, name: string) => [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === name)!;

async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const click = (el: HTMLElement) => act(async () => el.click());

describe("a run row with nothing current to show", () => {
  const rowOf = (el: HTMLElement, sim: string) => el.querySelector<HTMLElement>(`[data-testid="runs.table-row"][data-sim="${sim}"]`)!;
  const failed = () =>
    makeStore((snap) => {
      const fin = snap.runs.runs.find((r) => r.sim === "fin_revision")!;
      fin.status = "failed";
      fin.job_id = "job-9";
      snap.jobs = [{ job_id: "job-9", kind: "simulate", state: "failed", progress: 1, sim: "fin_revision", error: "the integrator diverged" }] as never;
    });

  it("offers Run on an Outdated row and keeps its dashes", async () => {
    const { app, run } = makeStore();
    const el = await mount(app, null);
    const row = rowOf(el, "fin_revision");
    expect(row.querySelector<HTMLElement>('[data-testid="runs.apogee"]')!.textContent).toBe("—");
    await click(row.querySelector<HTMLElement>('button[aria-label="Run Fin revision again"]')!);
    expect(run).toHaveBeenCalledWith("fin_revision");
  });

  it("shows why a flight failed and offers Run", async () => {
    const { app, run } = failed();
    const el = await mount(app, null);
    const row = rowOf(el, "fin_revision");
    expect(row.querySelector('[data-testid="runs.failure"]')?.textContent).toBe("the integrator diverged");
    await click(button(row, "Run"));
    expect(run).toHaveBeenCalledWith("fin_revision");
  });

  it("offers no Run for a sim that was deleted", async () => {
    const { app } = makeStore((snap) => void delete (snap.evaluated!.sims as Record<string, unknown>)["fin_revision"]);
    const el = await mount(app, null);
    expect(rowOf(el, "fin_revision").querySelector('button[aria-label="Run Fin revision again"]')).toBeNull();
  });

  it("shows a cached run as Complete once it answers, though the mirror did not change", async () => {
    const { app, snap } = makeStore((s) => {
      const base = s.runs.runs.find((r) => r.sim === "baseline")!;
      base.job_id = "job-c";
      s.jobs = [{ job_id: "job-c", kind: "simulate", state: "cancelled", progress: 0.2, sim: "baseline" }] as never;
    });
    const el = await mount(app, null);
    expect(rowOf(el, "baseline").dataset["status"]).toBe("cancelled");
    const runId = snap.runs.runs.find((r) => r.sim === "baseline")!.run_id;
    await act(async () => app.setState((s) => ({ ...s, runs: { ...s.runs, started: { baseline: { cached: true, run_id: runId } as never } } })));
    expect(rowOf(el, "baseline").dataset["status"]).toBe("complete");
  });
});

describe("leaving with typed values", () => {
  const press = (el: Element, key: string) =>
    act(async () => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  const prompt = () => document.querySelector<HTMLElement>('[data-testid="sim-conditions.unsaved"]');

  it("Escape in a field that was changed reverts that field and keeps the sheet", async () => {
    const { app } = makeStore();
    await mount(app, "baseline");
    const speed = input(group("Wind"), "Speed");
    const before = speed.value;
    await type(speed, "9");
    await press(speed, "Escape");
    expect(sheet()).not.toBeNull();
    expect(prompt()).toBeNull();
    expect(input(group("Wind"), "Speed").value).toBe(before);
  });

  it("Escape with nothing typed closes the sheet at once", async () => {
    const { app } = makeStore();
    await mount(app, "baseline");
    await press(document.body, "Escape");
    expect(sheet()).toBeNull();
  });

  it("closing with typed values asks first; Keep editing keeps them", async () => {
    const { app, mutate } = makeStore();
    await mount(app, "baseline");
    await type(input(group("Wind"), "Speed"), "9");
    await press(document.body, "Escape");
    expect(prompt()).not.toBeNull();
    expect(mutate).not.toHaveBeenCalled();
    await click(button(prompt()!, "Keep editing"));
    expect(prompt()).toBeNull();
    expect(input(group("Wind"), "Speed").value).toBe("9");
  });

  it("Save from the prompt writes the typed values and closes", async () => {
    const { app, mutate } = makeStore();
    await mount(app, "baseline");
    await type(input(group("Wind"), "Speed"), "9");
    await press(document.body, "Escape");
    await click(button(prompt()!, "Save"));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(sheet()).toBeNull();
  });

  it("Don't save drops them and writes nothing", async () => {
    const { app, mutate } = makeStore();
    await mount(app, "baseline");
    await type(input(group("Wind"), "Speed"), "9");
    await press(document.body, "Escape");
    await click(button(prompt()!, "Don't save"));
    expect(sheet()).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("the close button asks too", async () => {
    const { app } = makeStore();
    await mount(app, "baseline");
    await type(input(group("Wind"), "Speed"), "9");
    await click(sheet()!.querySelector<HTMLElement>("[data-rw-close]")!);
    expect(prompt()).not.toBeNull();
  });

  it("changing page saves what was typed", async () => {
    const { app, mutate, run } = makeStore();
    await mount(app, "baseline");
    await type(input(group("Wind"), "Speed"), "9");
    await act(async () => root?.unmount());
    root = null;
    await act(async () => undefined);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("changing page with text that cannot be saved says so on Results", async () => {
    const { app, mutate } = makeStore();
    await mount(app, "baseline");
    await type(input(group("Wind"), "Speed"), "abc");
    await act(async () => root?.unmount());
    root = null;
    expect(mutate).not.toHaveBeenCalled();
    expect(resultsUiStore(app).getState().notice).toMatch(/Speed needs a number/);
  });

  it("Don't save after a failed save really drops the text: leaving does not retry it", async () => {
    const { app, mutate } = makeStore();
    mutate.mockRejectedValueOnce(new Error("disk full"));
    await mount(app, "baseline");
    await type(input(group("Wind"), "Speed"), "9");
    await act(async () => {
      await expect(flushProject(app)).resolves.toEqual(["disk full"]);
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    act(() => discardDirtyFields());
    await act(async () => root?.unmount());
    root = null;
    await act(async () => undefined);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(resultsUiStore(app).getState().notice).toBeNull();
  });

  it("Don't save with text that cannot be saved gives no notice when the sheet goes", async () => {
    const { app, mutate } = makeStore();
    await mount(app, "baseline");
    await type(input(group("Wind"), "Speed"), "abc");
    act(() => discardDirtyFields());
    await act(async () => root?.unmount());
    root = null;
    expect(mutate).not.toHaveBeenCalled();
    expect(resultsUiStore(app).getState().notice).toBeNull();
  });

  it("Don't save with the sheet still up clears what was typed", async () => {
    const { app, mutate } = makeStore();
    await mount(app, "baseline");
    const before = input(group("Wind"), "Speed").value;
    await type(input(group("Wind"), "Speed"), "9");
    act(() => discardDirtyFields());
    expect(input(group("Wind"), "Speed").value).toBe(before);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("does not save twice when Save is already on its way", async () => {
    const { app, mutate } = makeStore();
    await mount(app, "baseline");
    await type(input(group("Wind"), "Speed"), "9");
    await click(button(sheet()!, "Save"));
    await act(async () => root?.unmount());
    root = null;
    await act(async () => undefined);
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});

describe("a sim stored as JSON", () => {
  it("writes only the changed field, so its other conditions survive", async () => {
    const text = JSON.stringify({ name: "Baseline", config: "default", launch: { rail_length: "3 m", rod_angle: "4 deg" }, wind: { speed: "2 m/s", direction: "90 deg" }, atmosphere: { model: "isa_custom", base_temperature: "20 degC", base_pressure: "1000 hPa" } });
    const { app, mutate } = makeStore((snap) => {
      const files = snap.files.files as Record<string, string | undefined>;
      delete files["sims/baseline.rw.toml"];
      files["sims/baseline.rw.json"] = text;
    });
    await mount(app, "baseline");
    await type(input(group("Wind"), "Speed"), "4");
    await click(button(sheet()!, "Save"));
    const ops = (mutate.mock.calls[0] as unknown[])[0] as { op: string; path: string }[];
    expect(ops.map((o) => [o.op, o.path])).toEqual([["replace", "/sims/baseline/wind/speed"]]);
  });
});

describe("the window losing focus (a native dialog) with the sheet being typed in", () => {
  it("keeps invalid text and the dirty state, and writes nothing", async () => {
    const { app, mutate } = makeStore();
    await mount(app, "baseline");
    const rail = input(group("Launch"), "Rail length");
    await act(async () => rail.focus());
    await type(rail, "wide");
    await blurFromWindow(rail);
    expect(input(group("Launch"), "Rail length").value).toBe("wide");
    expect(anyDirtyField()).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("keeps valid text and the dirty state", async () => {
    const { app, mutate } = makeStore();
    await mount(app, "baseline");
    const rail = input(group("Launch"), "Rail length");
    await act(async () => rail.focus());
    await type(rail, "9.5");
    await blurFromWindow(rail);
    expect(input(group("Launch"), "Rail length").value).toBe("9.5");
    expect(anyDirtyField()).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("the sheet", () => {
  it("marks the page while it is open, so the shell narrows the page beside the sheet", async () => {
    const { app } = makeStore();
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<ResultsPage app={app} source={null} />));
    const page = el.querySelector<HTMLElement>('[data-testid="results-page"]')!;
    expect(page.dataset["conditions"]).toBeUndefined();
    await act(async () => resultsUiStore(app).getState().set({ conditions: "flight" }));
    expect(page.dataset["conditions"]).toBe("open");
    await act(async () => resultsUiStore(app).getState().set({ conditions: null }));
    expect(page.dataset["conditions"]).toBeUndefined();
  });

  it("shows and writes the project's units", async () => {
    const { app, mutate } = makeStore((snap) => {
      (snap.files.files as Record<string, string>)["rocketwright.toml"] = '[project]\nname = "x"\n\n[display_units]\naltitude = "ft"\n';
    });
    await mount(app, "baseline");
    const speed = input(group("Wind"), "Speed");
    expect(document.getElementById(speed.getAttribute("aria-describedby")!)!.textContent).toBe("mph");
    await type(speed, "10");
    await click(button(sheet()!, "Save"));
    const ops = (mutate.mock.calls[0] as unknown[])[0] as { path: string; value: unknown }[];
    expect(JSON.stringify(ops.filter((o) => o.path.startsWith("/sims/baseline/wind")))).toContain("10 mph");
  });

  it("is a dialog named for the sim, with labelled groups and units found by role and name (D27)", async () => {
    const { app } = makeStore();
    await mount(app, "baseline");
    const title = document.getElementById(sheet()!.getAttribute("aria-labelledby")!)!;
    expect(title.textContent).toBe("Simulation conditions: Baseline");
    expect([...sheet()!.querySelectorAll('[role="group"] h3')].map((h) => h.textContent)).toEqual(["Launch", "Site", "Wind", "Atmosphere", "Solver"]);
    const rail = input(group("Launch"), "Rail length");
    expect(document.getElementById(rail.getAttribute("aria-describedby")!)!.textContent).toBe("m");
    const speed = input(group("Wind"), "Speed");
    expect(document.getElementById(speed.getAttribute("aria-describedby")!)!.textContent).toBe("m/s");
    expect([...input(group("Atmosphere"), "Model").querySelectorAll("option")].map((o) => o.textContent)).toEqual(["USSA 1976", "ISA (custom base)"]);
    expect(["Revert", "Save", "Save and run"].every((n) => button(sheet()!, n) !== undefined)).toBe(true);
  });

  it("Save commits the conditions and flies nothing", async () => {
    const { app, dryRun, mutate, run } = makeStore();
    await mount(app, "recovery_test");
    await type(input(group("Launch"), "Rail length"), "2.5");
    await click(button(sheet()!, "Save"));
    expect(dryRun).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1);
    const ops = (mutate.mock.calls[0] as unknown[])[0] as { path: string }[];
    expect(ops.map((o) => o.path)).toEqual(expect.arrayContaining(["/sims/recovery_test/launch", "/sims/recovery_test/wind", "/sims/recovery_test/atmosphere"]));
    expect(run).not.toHaveBeenCalled();
    expect(sheet()).toBeNull();
  });

  it("Save and run commits, then flies exactly once", async () => {
    const { app, mutate, run } = makeStore();
    await mount(app, "recovery_test");
    await click(button(sheet()!, "Save and run"));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("recovery_test");
  });

  it("shows RW-E067 at the field and writes nothing", async () => {
    const { app, dryRun, mutate, run } = makeStore();
    dryRun.mockResolvedValueOnce({ ...OK, delta: { ...OK.delta, new_diagnostics: [{ code: "RW-E067", severity: "error", path: "/sims/baseline/launch/rail_length", message: "rail length must be positive (is -1 m)" }] } } as never);
    await mount(app, "baseline");
    await type(input(group("Launch"), "Rail length"), "-1");
    await click(button(sheet()!, "Save and run"));
    expect(mutate).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    const error = group("Launch").querySelector('[role="alert"][data-field="launch.rail_length"]');
    expect(error?.textContent).toBe("rail length must be positive (is -1 m)");
    expect(sheet()).not.toBeNull();
  });

  it("shows the model's own RW-E067 at the field on open", async () => {
    const { app } = makeStore((snap) => {
      (snap.evaluated!.diagnostics as unknown[]).push({ code: "RW-E067", severity: "error", path: "/sims/baseline/wind/speed", message: "wind speed must not be negative (is -1 m/s)" });
    });
    await mount(app, "baseline");
    expect(group("Wind").querySelector('[role="alert"]')?.textContent).toMatch(/wind speed must not be negative/);
  });

  it("Revert puts back what the model holds", async () => {
    const { app, mutate } = makeStore();
    await mount(app, "baseline");
    const rail = input(group("Launch"), "Rail length");
    const before = rail.value;
    await type(rail, "9.5");
    // A press on the button takes focus from the field; a bare `click()` does not.
    await act(async () => rail.blur());
    await click(button(sheet()!, "Revert"));
    expect(input(group("Launch"), "Rail length").value).toBe(before);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("disables base temperature and pressure under USSA 1976 and enables them for a custom base", async () => {
    const { app } = makeStore();
    await mount(app, "baseline");
    const atmos = group("Atmosphere");
    expect(input(atmos, "Pressure").disabled).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(input(atmos, "Model"), "isa_custom");
      input(atmos, "Model").dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(input(group("Atmosphere"), "Pressure").disabled).toBe(false);
  });

  it("blocks a value that is not a number without calling the sidecar", async () => {
    const { app, dryRun } = makeStore();
    await mount(app, "baseline");
    await type(input(group("Launch"), "Rail length"), "abc");
    await click(button(sheet()!, "Save"));
    expect(dryRun).not.toHaveBeenCalled();
    expect(group("Launch").querySelector('[role="alert"]')?.textContent).toBe("Rail length needs a number.");
  });

  it("closes when the sim is deleted under it", async () => {
    const { app, snap } = makeStore();
    await mount(app, "baseline");
    expect(sheet()).not.toBeNull();
    await act(async () => {
      const next = structuredClone(snap);
      delete next.evaluated!.sims["baseline"];
      (app as unknown as { setState(p: Partial<AppState>): void }).setState({ project: { ...app.getState().project, snapshot: next as never } });
    });
    expect(sheet()).toBeNull();
    expect(resultsUiStore(app).getState().conditions).toBeNull();
  });
});

describe("sim actions", () => {
  const openMenu = () => click(sheet()!.querySelector<HTMLElement>('[data-testid="sim-conditions.more"]')!);
  const menuItem = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.trim() === name)!;
  const dialog = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => document.getElementById(d.getAttribute("aria-labelledby")!)?.textContent === name)!;

  it("renames in place through /sims/<id>/name", async () => {
    const { app, mutate } = makeStore();
    await mount(app, "baseline");
    await openMenu();
    await click(menuItem("Rename"));
    const modal = dialog("Rename simulation");
    await type(modal.querySelector("input")!, "Windy");
    await act(async () => modal.querySelector("form")!.requestSubmit());
    expect(mutate.mock.calls[0]?.[0]).toEqual([{ op: "add", path: "/sims/baseline/name", value: "Windy" }]);
  });

  it("duplicates and opens the copy", async () => {
    const { app, mutate } = makeStore();
    await mount(app, "baseline");
    await openMenu();
    await click(menuItem("Duplicate"));
    expect(mutate.mock.calls[0]?.[0]).toEqual([
      { op: "copy", from: "/sims/baseline", path: "/sims/baseline_copy" },
      { op: "add", path: "/sims/baseline_copy/name", value: "Baseline copy" },
    ]);
    expect(resultsUiStore(app).getState().conditions).toBe("baseline_copy");
  });

  it("deletes after a confirmation, then closes", async () => {
    const { app, mutate } = makeStore();
    await mount(app, "recovery_test");
    await openMenu();
    await click(menuItem("Delete"));
    await click(button(dialog("Delete simulation"), "Delete"));
    expect(mutate.mock.calls[0]?.[0]).toEqual([{ op: "remove", path: "/sims/recovery_test" }]);
    expect(resultsUiStore(app).getState().conditions).toBeNull();
  });

  it("will not delete a flight a visual study replays", async () => {
    const { app, mutate } = makeStore((snap) => {
      (snap.evaluated!.sims as Record<string, unknown>)["study"] = { ...snap.evaluated!.sims["baseline"]!, id: "study", name: "Flow study", kind: "visual_flow", visual_flow: { replay: "baseline" } };
    });
    await mount(app, "baseline");
    await openMenu();
    await click(menuItem("Delete"));
    const modal = dialog("Delete simulation");
    expect(modal.textContent).toMatch(/Flow study replays this flight/);
    expect(button(modal, "Delete").disabled).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("New simulation", () => {
  it("creates a flight sim of the first configuration and opens it", async () => {
    const { app, mutate } = makeStore();
    await newSimulation(app);
    const ops = (mutate.mock.calls[0] as unknown[])[0] as { op: string; path: string; value: { config: string; name: string } }[];
    expect(ops[0]!.op).toBe("add");
    expect(ops[0]!.path).toMatch(/^\/sims\/simulation_\d+$/);
    expect(ops[0]!.value.config).toBe(Object.keys(app.getState().project.snapshot!.evaluated!.configs).sort()[0]);
    expect(resultsUiStore(app).getState().conditions).toBe(ops[0]!.path.split("/").at(-1));
  });

  it("says why when the project has no configuration", async () => {
    const { app, mutate } = makeStore((snap) => {
      snap.evaluated!.configs = {};
    });
    await newSimulation(app);
    expect(mutate).not.toHaveBeenCalled();
    expect(resultsUiStore(app).getState().notice).toMatch(/configuration/);
  });
});

describe("the Not run row (R2.7)", () => {
  const row = (sim: string) => document.querySelector<HTMLElement>(`[data-testid="runs.table-row"][data-sim="${sim}"]`)!;

  it("flies from its Run button without opening the sheet", async () => {
    const { app, run } = makeStore();
    await mount(app, null);
    expect(row("recovery_test").dataset["status"]).toBe("not_run");
    await click(button(row("recovery_test"), "Run"));
    expect(run).toHaveBeenCalledWith("recovery_test");
    expect(sheet()).toBeNull();
  });

  it("opens its conditions from the row", async () => {
    const { app } = makeStore();
    await mount(app, null);
    await click(row("recovery_test").querySelector<HTMLElement>(".rw-runtable__name")!);
    expect(sheet()).not.toBeNull();
    expect(document.getElementById(sheet()!.getAttribute("aria-labelledby")!)!.textContent).toBe("Simulation conditions: Recovery test");
  });

  it("does not open the sheet from a row that has run", async () => {
    const { app } = makeStore();
    await mount(app, null);
    await click(row("baseline").querySelector<HTMLElement>(".rw-runtable__name")!);
    expect(sheet()).toBeNull();
    expect(button(row("baseline"), "Run")).toBeUndefined();
  });
});

describe("run row actions (R2.7)", () => {
  const row = (sim: string) => document.querySelector<HTMLElement>(`[data-testid="runs.table-row"][data-sim="${sim}"]`)!;
  const openMenu = (sim: string) => click(row(sim).querySelector<HTMLElement>('[data-testid="runs.row-menu"]')!);
  const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  const menuItem = (name: string) => menuItems().find((i) => i.textContent?.trim() === name)!;
  const dialog = () => document.querySelector<HTMLElement>('[data-testid="delete-run"]')!;

  const runningJob = { job_id: "j-1", kind: "simulate", sim: "baseline", state: "running", progress: 0.4 };

  it("offers Cancel on a flying row and cancels its job", async () => {
    const { app, cancel, run } = makeStore((snap) => {
      snap.jobs = [runningJob] as never;
    });
    await mount(app, null);
    expect(row("baseline").dataset["status"]).toBe("running");
    await click(button(row("baseline"), "Cancel"));
    expect(cancel).toHaveBeenCalledWith("j-1");
    expect(run).not.toHaveBeenCalled();
    expect(sheet()).toBeNull();
  });

  it("reads Cancelled after the job stops and offers Run again", async () => {
    const { app, run } = makeStore((snap) => {
      snap.jobs = [{ ...runningJob, state: "cancelled" }] as never;
      snap.runs.runs.find((r) => r.sim === "baseline")!.job_id = "j-1";
    });
    await mount(app, null);
    expect(row("baseline").dataset["status"]).toBe("cancelled");
    expect(row("baseline").querySelector('[data-testid="runs.status"]')!.textContent).toBe("Cancelled");
    await click(button(row("baseline"), "Run"));
    expect(run).toHaveBeenCalledWith("baseline");
  });

  it("has no Landing dispersion entry", async () => {
    const { app } = makeStore();
    await mount(app, null);
    await openMenu("baseline");
    expect(menuItems().map((i) => i.textContent?.trim())).toEqual(["Simulation conditions", "Edit configuration", "Duplicate", "Delete"]);
  });

  it("duplicates the sim as a new, not-yet-run sim and opens its conditions", async () => {
    const { app, mutate } = makeStore();
    await mount(app, null);
    await openMenu("baseline");
    await click(menuItem("Duplicate"));
    expect(mutate.mock.calls[0]?.[0]).toEqual([
      { op: "copy", from: "/sims/baseline", path: "/sims/baseline_copy" },
      { op: "add", path: "/sims/baseline_copy/name", value: "Baseline copy" },
    ]);
    expect(resultsUiStore(app).getState().conditions).toBe("baseline_copy");
  });

  it("names a second copy so it can be told apart", async () => {
    const { app, mutate, snap } = makeStore((s) => {
      const sims = s.evaluated!.sims as Record<string, unknown>;
      sims["baseline_copy"] = { ...(sims["baseline"] as object), id: "baseline_copy", name: "Baseline copy" };
    });
    expect(snap.evaluated!.sims["baseline_copy"]).toBeDefined();
    await mount(app, null);
    await openMenu("baseline");
    await click(menuItem("Duplicate"));
    expect(mutate.mock.calls[0]?.[0]).toContainEqual({ op: "add", path: "/sims/baseline_copy_2/name", value: "Baseline copy 2" });
  });

  it("deletes a stored run after a confirmation", async () => {
    const { app, deleteRun, snap } = makeStore();
    await mount(app, null);
    const runId = snap.runs.runs.find((r) => r.sim === "baseline")!.run_id!;
    await openMenu("baseline");
    await click(menuItem("Delete"));
    expect(dialog().textContent).toContain("The simulation stays");
    expect(deleteRun).not.toHaveBeenCalled();
    await click(button(dialog(), "Delete"));
    expect(deleteRun).toHaveBeenCalledWith({ key: "baseline", sim: "baseline", runId });
    expect(document.querySelector('[data-testid="delete-run"]')).toBeNull();
  });

  it("shows the sidecar's refusal and keeps the dialog", async () => {
    const { app, deleteRun } = makeStore();
    deleteRun.mockRejectedValueOnce(new Error("simulation `baseline` has a job in progress"));
    await mount(app, null);
    await openMenu("baseline");
    await click(menuItem("Delete"));
    await click(button(dialog(), "Delete"));
    expect(dialog().querySelector('[role="alert"]')!.textContent).toContain("job in progress");
  });

  it("cannot delete a run that does not exist or is still flying", async () => {
    const { app } = makeStore((snap) => {
      snap.jobs = [runningJob] as never;
    });
    await mount(app, null);
    await openMenu("recovery_test");
    expect(menuItem("Delete").disabled).toBe(true);
    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await openMenu("baseline");
    expect(menuItem("Delete").disabled).toBe(true);
  });

  it("lets a run whose sim was deleted be removed, but not duplicated", async () => {
    const { app, deleteRun, snap } = makeStore((s) => {
      delete (s.evaluated!.sims as Record<string, unknown>)["baseline"];
    });
    await mount(app, null);
    const runId = snap.runs.runs.find((r) => r.sim === "baseline")!.run_id!;
    await openMenu("baseline");
    expect(menuItem("Duplicate").disabled).toBe(true);
    await click(menuItem("Delete"));
    expect(dialog().textContent).toContain("cannot be run again");
    await click(button(dialog(), "Delete"));
    expect(deleteRun).toHaveBeenCalledWith({ key: "baseline", sim: "baseline", runId });
  });
});
