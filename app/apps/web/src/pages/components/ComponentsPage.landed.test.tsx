// @vitest-environment jsdom
/** A direct write from Components (Apply preset): Undo has to wait for the push that shows it. */
import type { ProjectSnapshot } from "@rw/contracts";
import { MockRpc } from "@rw/contracts/mock";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import { componentRef } from "../../state/index.ts";
import type { RpcLike } from "../../state/rpc.ts";
import { createAppStore, type AppStore } from "../../state/store.ts";
import type { AppState, DeepReadonly } from "../../state/types.ts";
import type { GlbDeps } from "../../viewport/glb-source.ts";
import { componentsSlots, createComponentsUi } from "./ComponentsPage.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has none, and the profile view measures itself.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

const mock = new MockRpc({ testHooks: false });
afterAll(() => mock.dispose());

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function appStore(snap: ProjectSnapshot, id: string): AppStore {
  const base = createAppStore({ loadWasm: () => Promise.reject(new Error("no wasm in tests")) }).getState();
  const state: AppState = { ...base, project: { ...base.project, projectId: "research-vehicle", snapshot: snap as DeepReadonly<ProjectSnapshot> }, selection: { ...base.selection, refs: [componentRef(id)] } };
  return createStore<AppState>()(() => state);
}

it("Apply preset records the answered hash", async () => {
  const snap = structuredClone(mock.snapshot());
  const tube = snap.evaluated!.components.find((c) => c.shape.type === "body_tube")!;
  const patches: unknown[] = [];
  const client = {
    call: (method: string, params: unknown) => {
      if (method === "library.search") return Promise.resolve({ items: [{ id: "p1", name: "Preset", source: "builtin", kind: "preset", data: { type: "body_tube", length: "123 mm" } }] });
      if (method === "model.patch") {
        patches.push(params);
        return Promise.resolve({ model_hash: "h-after" });
      }
      return Promise.resolve({});
    },
    on: () => () => undefined,
    onClose: () => () => undefined,
  } as unknown as RpcLike;
  const store = appStore(snap, tube.id);
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const { content } = componentsSlots(store, client, {} as GlbDeps, createComponentsUi());
  await act(async () => root!.render(<>{content}</>));
  await act(async () => el.querySelector<HTMLButtonElement>('[data-testid="editor.parts-library"]')!.click());
  await act(async () => el.querySelector<HTMLButtonElement>('[data-testid="editor.library-item"]')!.click());
  expect(patches).toHaveLength(1);
  await expect(store.getState().draft.settled()).resolves.toBe("h-after");
});
