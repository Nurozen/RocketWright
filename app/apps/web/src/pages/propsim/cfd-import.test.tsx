// @vitest-environment jsdom
/** U57/R3.2: the CFD import uses a native picker on the desktop and keeps the typed path for a browser (D18). */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { HostApi } from "../../host/HostApi.ts";
import type { RpcLike } from "../../state/rpc.ts";
import { createAppStore, type AppStore } from "../../state/store.ts";
import type { AppState } from "../../state/types.ts";
import { CfdTab, createCfdUi } from "./cfd.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function makeStore(): AppStore {
  const base = createAppStore({ loadWasm: () => Promise.reject(new Error("no wasm in tests")) }).getState();
  const state: AppState = { ...base, project: { ...base.project, projectId: "p" } };
  return createStore<AppState>()(() => state) as unknown as AppStore;
}

function client() {
  const call = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async (method) => (method === "cfd.list" ? { datasets: [] } : { dataset: { id: "tank" } }));
  return { rpc: { call } as unknown as RpcLike, call };
}

async function mount(rpc: RpcLike, host: HostApi | null) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<CfdTab store={makeStore()} client={rpc} ui={createCfdUi()} httpBase="" host={host} />));
  await act(async () => new Promise<void>((r) => setTimeout(r, 0)));
}

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
const flush = () => act(async () => new Promise<void>((r) => setTimeout(r, 0)));
const host = (over: Partial<HostApi>) => ({ kind: "desktop", ...over }) as unknown as HostApi;

describe("the CFD import form", () => {
  it("imports the file a desktop picker returns", async () => {
    const { rpc, call } = client();
    const pickFile = vi.fn<HostApi["pickFile"]>(() => Promise.resolve("/data/tank_t0.5.csv"));
    await mount(rpc, host({ pickFile }));
    await act(async () => byId("cfd.choose-file")!.click());
    await flush();
    expect(pickFile).toHaveBeenCalledWith({ title: "Import CFD points", filters: [{ name: "CSV point data", extensions: ["csv"] }] });
    expect(call).toHaveBeenCalledWith("cfd.import", { projectId: "p", path: "/data/tank_t0.5.csv" });
  });
  it("imports a directory of steps from the folder picker", async () => {
    const { rpc, call } = client();
    await mount(rpc, host({ pickFolder: () => Promise.resolve("/data/steps") }));
    await act(async () => byId("cfd.choose-directory")!.click());
    await flush();
    expect(call).toHaveBeenCalledWith("cfd.import", { projectId: "p", path: "/data/steps" });
  });
  it("does nothing when the picker is cancelled", async () => {
    const { rpc, call } = client();
    await mount(rpc, host({ pickFile: () => Promise.resolve(null) }));
    await act(async () => byId("cfd.choose-file")!.click());
    await flush();
    expect(call.mock.calls.filter((c) => c[0] === "cfd.import")).toEqual([]);
  });
  it("keeps the picked path and shows why when the import is refused", async () => {
    const call = vi.fn<(method: string) => Promise<unknown>>(async (method) => {
      if (method === "cfd.list") return { datasets: [] };
      throw new Error("no x column");
    });
    await mount({ call } as unknown as RpcLike, host({ pickFile: () => Promise.resolve("/data/bad.csv") }));
    await act(async () => byId("cfd.choose-file")!.click());
    await flush();
    expect(byId<HTMLInputElement>("cfd.import-path")!.value).toBe("/data/bad.csv");
    expect(byId("cfd.import-error")!.textContent).toBe("no x column");
  });
  it("offers a browser only the typed path, which still imports", async () => {
    const { rpc, call } = client();
    await mount(rpc, host({ kind: "browser" } as Partial<HostApi>));
    expect(byId("cfd.choose-file")).toBeNull();
    const input = byId<HTMLInputElement>("cfd.import-path")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "/typed/steps");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => byId<HTMLButtonElement>("cfd.import")!.click());
    await flush();
    expect(call).toHaveBeenCalledWith("cfd.import", { projectId: "p", path: "/typed/steps" });
  });
});
