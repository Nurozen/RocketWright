// @vitest-environment jsdom
/** Export CSV goes through the host: a native save dialog on the desktop, a download in a browser (R3.5: CSV stays SI). */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ProjectSnapshot, SaveCsvRequest, SaveCsvResult } from "@rw/contracts";
import { MockRpc } from "@rw/contracts/mock";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { createAppStore, type AppStore } from "../../state/store.ts";
import type { AppState, DeepReadonly } from "../../state/types.ts";
import { ResultsPage } from "./ResultsPage.tsx";
import type { RunData, RunDataSource } from "./source.ts";

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
});

function appStore(): AppStore {
  const snap = structuredClone(mock.snapshot()) as ProjectSnapshot;
  const base = createAppStore({ loadWasm: () => Promise.reject(new Error("no wasm in tests")) }).getState();
  const state: AppState = { ...base, project: { ...base.project, projectId: "p", snapshot: snap as DeepReadonly<ProjectSnapshot> } };
  return createStore<AppState>()((set, get) => ({ ...state, runs: { ...state.runs, toggleOverlay: (k: string) => set({ runs: { ...get().runs, overlay: [...get().runs.overlay, k] } }) } })) as unknown as AppStore;
}

const SERIES: RunData = {
  series: { columns: [{ name: "t", dim: "time" }, { name: "altitude", dim: "length" }], rows: [[0, 0], [1, 12.5]] } as unknown as RunData["series"],
  events: [],
  diagnostics: [],
};
const source: RunDataSource = { load: () => Promise.resolve(SERIES) };

async function mount(saveCsv?: (r: SaveCsvRequest) => Promise<SaveCsvResult>) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<ResultsPage app={appStore()} source={source} saveCsv={saveCsv} />));
  await act(async () => undefined);
  const button = el.querySelector<HTMLButtonElement>('[data-testid="results.export-csv"]')!;
  return { el, button };
}

const click = (b: HTMLButtonElement) =>
  act(async () => {
    b.click();
  });

describe("Export CSV", () => {
  it("hands the host the default name and SI text", async () => {
    const saveCsv = vi.fn<(r: SaveCsvRequest) => Promise<SaveCsvResult>>(() => Promise.resolve({ canceled: true }));
    const { button } = await mount(saveCsv);
    expect(button.disabled).toBe(false);
    await click(button);
    expect(saveCsv).toHaveBeenCalledOnce();
    const request = saveCsv.mock.calls[0]![0];
    expect(request.defaultName).toMatch(/^results-.*\.csv$/);
    expect(request.text.split("\n")[0]).toBe("run,sim,run_id,t,altitude");
    expect(request.text).toContain(",1,12.5");
  });

  it("shows nothing and writes nothing on cancel", async () => {
    const { el, button } = await mount(() => Promise.resolve({ canceled: true }));
    await click(button);
    expect(el.querySelector('[data-testid="results.error"]')).toBeNull();
    expect(el.querySelector('[data-testid="results.export-notice"]')).toBeNull();
  });

  it("says where the file went", async () => {
    const { el, button } = await mount(() => Promise.resolve({ canceled: false, path: "/Users/x/results.csv" }));
    await click(button);
    expect(el.querySelector('[data-testid="results.export-notice"]')?.textContent).toContain("/Users/x/results.csv");
  });

  it("shows why a failed write failed, without Electron's prefix", async () => {
    const { el, button } = await mount(() => Promise.reject(new Error("Error invoking remote method 'rw-desktop:save-csv': Error: EACCES: permission denied")));
    await click(button);
    const banner = el.querySelector('[data-testid="results.error"]')?.textContent ?? "";
    expect(banner).toContain("The CSV could not be saved: Error: EACCES: permission denied");
    expect(banner).not.toContain("invoking remote method");
  });

  it("falls back to a download when the page has no host", async () => {
    const blobs: Blob[] = [];
    const created = vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
      blobs.push(b as Blob);
      return "blob:x";
    });
    URL.revokeObjectURL = vi.fn<typeof URL.revokeObjectURL>();
    const clicks: string[] = [];
    const anchor = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
    const { button } = await mount();
    await click(button);
    expect(clicks[0]).toMatch(/^results-.*\.csv$/);
    expect(blobs).toHaveLength(1);
    created.mockRestore();
    anchor.mockRestore();
  });
});
