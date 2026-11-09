// @vitest-environment jsdom
/** R2.5/R2.7: the conditions sheet and the Not run row, against a mock project. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MutationOut, ProjectSnapshot } from "@rw/contracts";
import { MockRpc } from "@rw/contracts/mock";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { resetDirtyFields } from "../../state/dirtyFields.ts";
import { createAppStore, type AppStore } from "../../state/store.ts";
import type { AppState } from "../../state/types.ts";
import { resultsUiStore } from "./resultsUi.ts";
import { RunTable } from "./RunTable.tsx";
import { newSimulation, SimConditionsSheet } from "./SimConditionsSheet.tsx";

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
  const select = vi.fn<AppState["selection"]["select"]>();
  const state: AppState = {
    ...base,
    project: { ...base.project, projectId: "p", snapshot: snap as never },
    draft: { ...base.draft, dryRun, mutate },
    runs: { ...base.runs, run },
    selection: { ...base.selection, select },
  };
  const app = createStore<AppState>()(() => state) as unknown as AppStore;
  return { app, snap, dryRun, mutate, run, select };
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

describe("the sheet", () => {
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
