// @vitest-environment jsdom
/** U23: the palette: every kind from the schema, root-only on Empty, attach target from the anchors. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EvaluatedModel, schema } from "@rw/contracts";
import { SCHEMA_META } from "@rw/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "../../state/index.ts";
import { addPart, AddPartPalette, type AddPartPaletteProps, unavailableReason } from "./AddPartPopover.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const evaluated = (JSON.parse(readFileSync(resolve(process.cwd(), "../../../fixtures/contracts/evaluated-model.json"), "utf8")) as { payload: EvaluatedModel }).payload;
const parts = evaluated.components;

let root: Root | null = null;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function render(ui: ReactNode): void {
  act(() => {
    root ??= createRoot(host);
    root.render(ui);
  });
}

const tile = (name: string): HTMLButtonElement => {
  const hit = [...document.querySelectorAll<HTMLButtonElement>(".rw-add-part__tile")].find((b) => b.textContent === name);
  if (hit === undefined) throw new Error(`no tile named ${name}`);
  return hit;
};

const attachSelect = (): HTMLSelectElement => {
  const label = [...document.querySelectorAll("label")].find((l) => l.textContent === "Attach to");
  if (label === undefined) throw new Error("no Attach to label");
  return document.getElementById(label.htmlFor) as HTMLSelectElement;
};

type OnAdd = AddPartPaletteProps["onAdd"];

const library: AddPartPaletteProps["library"] = {
  search: async () => ({ items: [], total: 0, facets: { manufacturers: [], component_types: [] } }),
  onAdd: async () => {},
  onReplace: async () => {},
};

const flush = () => act(async () => {
  await Promise.resolve();
});

describe("AddPartPalette", () => {
  it("shows a tile for every kind in the schema", () => {
    render(<AddPartPalette components={parts} selected={[]} onAdd={async () => {}} onDone={() => {}} library={library} />);
    const kinds = Object.keys(SCHEMA_META["Component"]!.variants!);
    expect(document.querySelectorAll(".rw-add-part__tile")).toHaveLength(kinds.length);
    expect(tile("Nose cone")).toBeDefined();
    expect(tile("Trapezoidal fin set")).toBeDefined();
    expect(tile("Mass component")).toBeDefined();
  });

  it("on an empty project allows only a body part and adds it as the root", async () => {
    const onAdd = vi.fn<OnAdd>(async () => {});
    const onDone = vi.fn<() => void>();
    render(<AddPartPalette components={[]} selected={[]} onAdd={onAdd} onDone={onDone} library={library} />);
    expect(document.querySelector("select")).toBeNull();
    expect(host.textContent).toContain("The first part starts the rocket.");
    expect(tile("Parachute").disabled).toBe(true);
    expect(tile("Parachute").title).toMatch(/Start the rocket/);
    expect(tile("Nose cone").disabled).toBe(false);
    act(() => tile("Nose cone").click());
    await flush();
    expect(onAdd).toHaveBeenCalledWith("nose_cone", null);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("attaches to the part chosen under Attach to", async () => {
    const onAdd = vi.fn<OnAdd>(async () => {});
    render(<AddPartPalette components={parts} selected={[]} onAdd={onAdd} onDone={() => {}} library={library} />);
    const select = attachSelect();
    const nose = parts.find((p) => p.shape.type === "nose_cone")!;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      set.call(select, nose.id);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(select.value).toBe(nose.id);
    act(() => tile("Body tube").click());
    await flush();
    expect(onAdd.mock.calls[0]![1]).toMatchObject({ id: nose.id });
  });

  it("disables a nose cone once the rocket has parts and says why", () => {
    render(<AddPartPalette components={parts} selected={[]} onAdd={async () => {}} onDone={() => {}} library={library} />);
    expect(tile("Nose cone").disabled).toBe(true);
    expect(tile("Nose cone").title).toBe("A nose cone can only start the rocket.");
  });

  it("keeps the palette open and shows the failure when the commit fails", async () => {
    const onDone = vi.fn<() => void>();
    render(<AddPartPalette components={[]} selected={[]} onAdd={async () => Promise.reject(new Error("rejected"))} onDone={onDone} library={library} />);
    act(() => tile("Body tube").click());
    await flush();
    expect(onDone).not.toHaveBeenCalled();
    expect(host.textContent).toContain("rejected");
    expect(tile("Body tube").disabled).toBe(false);
  });

  it("has Part types and Parts library tabs, on Part types first", () => {
    render(<AddPartPalette components={parts} selected={[]} onAdd={async () => {}} onDone={() => {}} library={library} />);
    const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(["Part types", "Parts library"]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector('[data-testid="add-part.library"]')).toBeNull();
  });

  it("offers nothing while the model cannot be evaluated", () => {
    render(<AddPartPalette components={null} selected={[]} onAdd={async () => {}} onDone={() => {}} library={library} />);
    expect(tile("Nose cone").disabled).toBe(true);
    expect(host.textContent).toContain("cannot be evaluated");
  });
});

describe("addPart", () => {
  type Mutate = (ops: { path: string; value: schema.Component }[], label: string) => Promise<null>;
  const fake = (mutate: Mutate) => {
    const select = vi.fn<(refs: readonly string[], source: string) => void>();
    const store = { getState: () => ({ draft: { mutate }, selection: { select } }) } as unknown as AppStore;
    return { store, select };
  };

  it("adds the root with no attach, names it from the kind, and selects it", async () => {
    const mutate = vi.fn<Mutate>(async () => null);
    const { store, select } = fake(mutate);
    await addPart(store, [], "nose_cone", null);
    const [ops, label] = mutate.mock.calls[0]!;
    expect(ops[0]!.path).toBe("/c/nose_cone");
    expect(ops[0]!.value).toMatchObject({ type: "nose_cone", name: "Nose cone" });
    expect(ops[0]!.value.attach).toBeUndefined();
    expect(label).toBe("Add Nose cone");
    expect(select).toHaveBeenCalledWith(["rw:c/nose_cone"], "tree");
  });

  it("numbers a repeated name and id, and attaches at the parent's anchor", async () => {
    const mutate = vi.fn<Mutate>(async () => null);
    const { store } = fake(mutate);
    const body = parts.find((p) => p.shape.type === "body_tube")!;
    await addPart(store, [...parts, { ...body, id: "body_tube", name: "Centering ring" }] as never, "centering_ring", body as never);
    const [ops] = mutate.mock.calls[0]!;
    expect(ops[0]!.value).toMatchObject({ name: "Centering ring 2", attach: { to: `${body.id}.inner` } });
  });

  it("does not select anything when the commit fails", async () => {
    const { store, select } = fake(async () => Promise.reject(new Error("no")));
    await expect(addPart(store, [], "nose_cone", null)).rejects.toThrow("no");
    expect(select).not.toHaveBeenCalled();
  });

  it("refuses a kind the parent cannot hold before it reaches the model", async () => {
    const mutate = vi.fn<Mutate>(async () => null);
    const { store } = fake(mutate);
    await expect(addPart(store, parts as never, "nose_cone", parts.find((p) => p.shape.type === "body_tube")! as never)).rejects.toThrow(/cannot attach/);
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("unavailableReason", () => {
  it("words the first-part rule from the root kinds", () => {
    expect(unavailableReason("parachute", [], null)).toBe("Start the rocket with a nose cone, body tube or transition.");
  });

  it("names the missing parent", () => {
    expect(unavailableReason("parachute", parts as never, null)).toBe("Add a body part first.");
  });
});
