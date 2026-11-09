// @vitest-environment jsdom
/**
 * D22: a value typed on Configurations and not yet committed. An accelerator
 * fires with no blur, so the registry has to reach it; the write must be one
 * a flush can wait for and report on.
 */
import type { ProjectSnapshot } from "@rw/contracts";
import { MockRpc } from "@rw/contracts/mock";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { flushDirtyFields, resetDirtyFields } from "../../state/dirtyFields.ts";
import type { RpcLike } from "../../state/rpc.ts";
import { createAppStore, type AppStore } from "../../state/store.ts";
import type { AppState, DeepReadonly } from "../../state/types.ts";
import { configurationsSlots, createConfigurationsUi } from "./ConfigurationsPage.tsx";

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

function appStore(snap: ProjectSnapshot): AppStore {
  const base = createAppStore({ loadWasm: () => Promise.reject(new Error("no wasm in tests")) }).getState();
  const state: AppState = { ...base, project: { ...base.project, projectId: "research-vehicle", snapshot: snap as DeepReadonly<ProjectSnapshot> }, selection: { ...base.selection, refs: ["rw:cfg/baseline"] } };
  return createStore<AppState>()(() => state);
}

async function recovery(call: RpcLike["call"]) {
  const snap = structuredClone(mock.snapshot());
  const model = snap.evaluated!;
  const device = model.components.find((c) => c.shape.type === "parachute" || c.shape.type === "streamer")!;
  const cfg = model.configs["baseline"]!;
  cfg.deployments = [{ ...(cfg.deployments.find((d) => d.component === device.id) ?? { component: device.id }), event: "altitude", altitude: 100 } as (typeof cfg.deployments)[number]];
  const ui = createConfigurationsUi();
  ui.setState({ subtab: "Recovery" });
  const client = { call, on: () => () => undefined, onClose: () => () => undefined } as unknown as RpcLike;
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const { content } = configurationsSlots(appStore(snap), client, ui);
  await act(async () => root!.render(<>{content}</>));
  return { input: el.querySelector<HTMLInputElement>('[data-testid="recovery.altitude"]')!, ui };
}

const type = async (input: HTMLInputElement, value: string) =>
  act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("a Configurations field still focused when the project is left", () => {
  it("writes the typed value and waits for it", async () => {
    let answer!: () => void;
    const call = vi.fn<() => Promise<unknown>>(() => new Promise((ok) => (answer = () => ok({})))) as unknown as RpcLike["call"];
    const { input } = await recovery(call);
    await type(input, "250");
    let flushed: string[] | null = null;
    await act(async () => {
      void flushDirtyFields().then((p) => (flushed = p));
    });
    expect(call).toHaveBeenCalledOnce();
    expect(vi.mocked(call).mock.calls[0]![0]).toBe("model.patch");
    expect(flushed).toBeNull();
    await act(async () => answer());
    expect(flushed).toEqual([]);
  });

  it("does not write it twice when the blur follows", async () => {
    const call = vi.fn<() => Promise<unknown>>(() => Promise.resolve({})) as unknown as RpcLike["call"];
    const { input } = await recovery(call);
    await type(input, "250");
    await act(async () => void (await flushDirtyFields()));
    await act(async () => input.blur());
    expect(call).toHaveBeenCalledOnce();
  });

  it("reports a value that cannot be saved as typed", async () => {
    const call = vi.fn<() => Promise<unknown>>(() => Promise.resolve({})) as unknown as RpcLike["call"];
    const { input } = await recovery(call);
    await type(input, "high");
    let problems: string[] = [];
    await act(async () => void (problems = await flushDirtyFields()));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("deployment altitude");
    expect(call).not.toHaveBeenCalled();
  });

  it("still reports a refused value after a blur has put the model's value back, and writes nothing", async () => {
    const call = vi.fn<() => Promise<unknown>>(() => Promise.resolve({})) as unknown as RpcLike["call"];
    const { input } = await recovery(call);
    await type(input, "high");
    await act(async () => input.blur());
    let problems: string[] = [];
    await act(async () => void (problems = await flushDirtyFields()));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("deployment altitude");
    expect(call).not.toHaveBeenCalled();
  });

  it("reports a write the server refused", async () => {
    const call = vi.fn<() => Promise<unknown>>(() => Promise.reject(new Error("locked by another writer"))) as unknown as RpcLike["call"];
    const { input } = await recovery(call);
    await type(input, "250");
    let problems: string[] = [];
    await act(async () => void (problems = await flushDirtyFields()));
    expect(problems).toEqual(["locked by another writer"]);
  });

  it("has nothing to flush when the field holds the model's value", async () => {
    const call = vi.fn<() => Promise<unknown>>(() => Promise.resolve({})) as unknown as RpcLike["call"];
    const { input } = await recovery(call);
    await act(async () => input.focus());
    await expect(flushDirtyFields()).resolves.toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });
});
