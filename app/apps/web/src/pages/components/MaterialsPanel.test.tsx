// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { anyDirtyField, flushDirtyFields, resetDirtyFields } from "../../state/dirtyFields.ts";
import { MaterialsPanel, type MaterialsPanelProps } from "./MaterialsPanel.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  resetDirtyFields();
});

const LIB_ITEM = { id: "preset:estes_classic/materials/fiber_bulk", kind: "material", name: "Fiber, bulk", source: "openrocket-database (Apache-2.0)", data: { density: "657.0 kg/m^3", doc: "Fiber, bulk" } } as never;

function props(over: Partial<MaterialsPanelProps> = {}): MaterialsPanelProps {
  return {
    materials: {},
    files: { "rocket.rw.toml": "" },
    units: "mm",
    diagnostics: [],
    library: { state: "ready", items: [LIB_ITEM] },
    onOpenLibrary: () => undefined,
    onMutate: vi.fn<MaterialsPanelProps["onMutate"]>(async () => null),
    ...over,
  };
}

async function mount(p: MaterialsPanelProps) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<MaterialsPanel {...p} />));
  return el;
}

const rerender = (p: MaterialsPanelProps) => act(async () => root!.render(<MaterialsPanel {...p} />));
const input = (el: HTMLElement, label: string) => el.querySelector<HTMLInputElement>(`input[aria-label="${label}"], #${CSS.escape([...el.querySelectorAll("label")].find((l) => l.textContent === label)?.htmlFor ?? "none")}`)!;
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;

async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const blur = (field: HTMLInputElement) => act(async () => void field.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
const click = (b: HTMLButtonElement) => act(async () => void b.click());

async function fillNew(el: HTMLElement, name: string, label: string, value: string) {
  await click(button(el, "New material"));
  await type(input(el, "Name"), name);
  await blur(input(el, "Name"));
  await type(input(el, label), value);
  await blur(input(el, label));
}

describe("creating a material", () => {
  it("shows every density at once, each with its unit as the description", async () => {
    const el = await mount(props());
    await click(button(el, "New material"));
    for (const [label, unit] of [["Density", "kg/m³"], ["Surface density", "g/m²"], ["Line density", "g/m"]] as const) {
      const field = input(el, label);
      expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent).toBe(unit);
    }
  });

  it("creates it once it has a name and a density, with a slug id, and no Save button", async () => {
    const p = props();
    const el = await mount(p);
    await fillNew(el, "ripstop nylon", "Surface density", "67");
    expect(p.onMutate).toHaveBeenCalledTimes(1);
    expect(p.onMutate).toHaveBeenCalledWith([{ op: "add", path: "/materials/ripstop_nylon", value: { surface_density: "67 g/m^2" } }], "Add material ripstop nylon");
    expect(el.textContent).not.toContain("Save");
  });

  it("does nothing until both are there, however the person goes about it", async () => {
    const p = props();
    const el = await mount(p);
    await click(button(el, "New material"));
    await type(input(el, "Density"), "100");
    await blur(input(el, "Density"));
    expect(p.onMutate).not.toHaveBeenCalled();
    await type(input(el, "Name"), "foam");
    await blur(input(el, "Name"));
    expect(p.onMutate).toHaveBeenCalledWith([{ op: "add", path: "/materials/foam", value: { density: "100 kg/m^3" } }], "Add material foam");
  });

  it("later edits replace the entry", async () => {
    const p = props();
    const el = await mount(p);
    await fillNew(el, "foam", "Density", "100");
    await type(input(el, "Density"), "120");
    await blur(input(el, "Density"));
    expect(p.onMutate).toHaveBeenLastCalledWith([{ op: "replace", path: "/materials/foam", value: { density: "120 kg/m^3" } }], "Edit material foam");
  });

  describe("a material that already exists", () => {
    const FILES = {
      "rocket.rw.toml": '[materials.alumnium]\ndensity = "2700 kg/m^3"\ndoc = "kept"\n\n[materials.cord]\nline_density = "2 g/m"\n\n[c.body]\nname = "Body tube"\ntype = "body_tube"\nmaterial = "alumnium"\n\n[c.chute]\ntype = "parachute"\nmaterial = "cord"\nline_material = "alumnium"\n',
      "engines/main.rw.toml": 'name = "Main"\n[feed.node.tank_a]\nkind = "tank"\nmaterial = "alumnium"\n',
    };
    const MATERIALS = { alumnium: { density: 2700 }, cord: { line_density: 0.002 } };
    const openOne = async (over: Partial<MaterialsPanelProps> = {}, id = "alumnium") => {
      const p = props({ files: FILES, materials: MATERIALS, ...over });
      const el = await mount(p);
      await click(el.querySelector<HTMLButtonElement>(`[data-testid="materials.item"][data-id="${id}"]`)!);
      return { p, el };
    };

    it("renames in one step: the entry moves and every part and tank follows", async () => {
      const { p, el } = await openOne();
      expect(input(el, "Name").disabled).toBe(false);
      await type(input(el, "Name"), "Aluminium");
      await blur(input(el, "Name"));
      expect(p.onMutate).toHaveBeenCalledTimes(1);
      expect(p.onMutate).toHaveBeenCalledWith(
        [
          { op: "add", path: "/materials/aluminium", value: { density: "2700 kg/m^3", doc: "kept" } },
          { op: "remove", path: "/materials/alumnium" },
          { op: "replace", path: "/c/body/material", value: "aluminium" },
          { op: "replace", path: "/c/chute/line_material", value: "aluminium" },
          { op: "replace", path: "/engines/main/feed/node/tank_a/material", value: "aluminium" },
        ],
        "Rename material alumnium to aluminium",
      );
      expect(input(el, "Name").value).toBe("aluminium");
    });

    it("does not rename on a change of case, a blur with no change, or a key the name cannot spell", async () => {
      const odd = { "rocket.rw.toml": '[materials.Al-6061]\ndensity = "2700 kg/m^3"\n' };
      const first = await openOne({ files: odd, materials: { "Al-6061": { density: 2700 } } }, "Al-6061");
      await blur(input(first.el, "Name"));
      expect(first.p.onMutate).not.toHaveBeenCalled();
      await act(async () => root!.unmount());
      root = null;
      const { p, el } = await openOne();
      await type(input(el, "Name"), "ALUMNIUM");
      await blur(input(el, "Name"));
      expect(p.onMutate).not.toHaveBeenCalled();
    });

    it("refuses a rename onto another material or to nothing", async () => {
      const { p, el } = await openOne();
      await type(input(el, "Name"), "cord");
      await blur(input(el, "Name"));
      expect(el.textContent).toContain("already has a material called cord");
      await type(input(el, "Name"), " ");
      await blur(input(el, "Name"));
      expect(el.textContent).toContain("A material needs a name.");
      expect(p.onMutate).not.toHaveBeenCalled();
    });

    it("waits for a new material to reach the snapshot before renaming it", async () => {
      const p = props();
      const el = await mount(p);
      await fillNew(el, "foam", "Density", "100");
      await type(input(el, "Name"), "balsa");
      await blur(input(el, "Name"));
      expect(el.textContent).toContain("still saving");
      expect(p.onMutate).toHaveBeenCalledTimes(1);
    });

    it("puts the old name back in the form when a rename fails", async () => {
      const onMutate = vi.fn<MaterialsPanelProps["onMutate"]>(async () => {
        throw new Error("no");
      });
      const { el } = await openOne({ onMutate });
      await type(input(el, "Name"), "aluminium");
      await blur(input(el, "Name"));
      expect(el.querySelector('[data-testid="materials.error"]')?.textContent).toContain("no");
      expect(input(el, "Name").value).toBe("aluminium");
    });

    it("deletes an unused material as one step and closes the form", async () => {
      const files = { "rocket.rw.toml": '[materials.spare]\ndensity = "100 kg/m^3"\n' };
      const { p, el } = await openOne({ files, materials: { spare: { density: 100 } } }, "spare");
      const del = el.querySelector<HTMLButtonElement>('[data-testid="materials.delete"]')!;
      expect(del.disabled).toBe(false);
      await click(del);
      expect(p.onMutate).toHaveBeenCalledWith([{ op: "remove", path: "/materials/spare" }], "Delete material spare");
      expect(el.querySelector('[data-testid="materials.delete"]')).toBeNull();
    });

    it("will not delete a material in use, and says who uses it", async () => {
      const { p, el } = await openOne();
      const del = el.querySelector<HTMLButtonElement>('[data-testid="materials.delete"]')!;
      expect(del.disabled).toBe(true);
      expect(el.querySelector('[data-testid="materials.used-by"]')?.textContent).toBe("Used by Body tube, chute, Main tank_a. Pick another material there to delete this one.");
      await click(del);
      expect(p.onMutate).not.toHaveBeenCalled();
    });

    it("cannot delete until the material has reached the snapshot", async () => {
      const el = await mount(props());
      await fillNew(el, "foam", "Density", "100");
      expect(el.querySelector<HTMLButtonElement>('[data-testid="materials.delete"]')!.disabled).toBe(true);
    });

    it("reopens the form when a delete fails", async () => {
      const files = { "rocket.rw.toml": '[materials.spare]\ndensity = "100 kg/m^3"\n' };
      const onMutate = vi.fn<MaterialsPanelProps["onMutate"]>(async () => {
        throw new Error("no");
      });
      const { el } = await openOne({ files, materials: { spare: { density: 100 } }, onMutate }, "spare");
      await click(el.querySelector<HTMLButtonElement>('[data-testid="materials.delete"]')!);
      expect(input(el, "Name").value).toBe("spare");
      expect(el.querySelector('[data-testid="materials.error"]')?.textContent).toContain("no");
    });
  });

  it("starts a clean form for the next one, and keeps the writes in order", async () => {
    const calls: string[] = [];
    let release = () => undefined as void;
    const gate = new Promise<void>((ok) => (release = ok));
    const onMutate = vi.fn<MaterialsPanelProps["onMutate"]>(async (ops) => {
      calls.push(`start ${ops[0]!.path}`);
      if (calls.length === 1) await gate;
      calls.push(`end ${ops[0]!.path}`);
      return null;
    });
    const el = await mount(props({ onMutate }));
    await fillNew(el, "foam", "Density", "100");
    await click(button(el, "New material"));
    expect(input(el, "Name").disabled).toBe(false);
    expect(input(el, "Name").value).toBe("");
    expect(input(el, "Density").value).toBe("");
    await type(input(el, "Name"), "card");
    await blur(input(el, "Name"));
    await type(input(el, "Density"), "680");
    await blur(input(el, "Density"));
    expect(calls).toEqual(["start /materials/foam"]);
    await act(async () => release());
    expect(calls).toEqual(["start /materials/foam", "end /materials/foam", "start /materials/card", "end /materials/card"]);
  });

  it("refuses a name that is taken, and a density that is not positive", async () => {
    const p = props({ files: { "rocket.rw.toml": '[materials.foam]\ndensity = "100 kg/m^3"\n' }, materials: { foam: { density: 100 } } });
    const el = await mount(p);
    await click(button(el, "New material"));
    await type(input(el, "Name"), "Foam");
    await type(input(el, "Density"), "-5");
    await blur(input(el, "Density"));
    expect(p.onMutate).not.toHaveBeenCalled();
    expect(el.textContent).toContain("already has a material called Foam");
    expect(el.textContent).toContain("Density must be greater than 0.");
  });

  it("gives the typed text back when the write fails", async () => {
    const onMutate = vi.fn<MaterialsPanelProps["onMutate"]>(async () => {
      throw new Error("the model refused");
    });
    const el = await mount(props({ onMutate }));
    await fillNew(el, "foam", "Density", "100");
    expect(el.querySelector("[data-testid='materials.error']")?.textContent).toContain("the model refused");
    expect(input(el, "Name").disabled).toBe(false);
    expect(input(el, "Name").value).toBe("foam");
    expect(input(el, "Density").value).toBe("100");
  });

  it("holds the project open on typed text that is not saved yet (D22)", async () => {
    const p = props();
    const el = await mount(p);
    await click(button(el, "New material"));
    expect(anyDirtyField()).toBe(false);
    await type(input(el, "Name"), "foam");
    expect(anyDirtyField()).toBe(true);
    expect(await flushDirtyFields()).toEqual(["Give the material a name and at least one density to create it."]);
    await type(input(el, "Density"), "100");
    expect(await flushDirtyFields()).toEqual([]);
    expect(p.onMutate).toHaveBeenCalledTimes(1);
    expect(anyDirtyField()).toBe(false);
  });
});

describe("editing a project material", () => {
  const FILES = { "rocket.rw.toml": '[materials.foam]\ndensity = "110 kg/m^3"\nyield_strength = "2 MPa"\ndoc = "Foam"\n' };
  const MATERIALS = { foam: { density: 110, yield_strength: 2e6 } };

  it("keeps what the form does not show, and writes nothing for a value left alone", async () => {
    const p = props({ files: FILES, materials: MATERIALS });
    const el = await mount(p);
    await click(button(el, "foam"));
    expect(input(el, "Density").value).toBe("110");
    await blur(input(el, "Density"));
    expect(p.onMutate).not.toHaveBeenCalled();
    await type(input(el, "Density"), "120");
    await blur(input(el, "Density"));
    expect(p.onMutate).toHaveBeenCalledWith([{ op: "replace", path: "/materials/foam", value: { density: "120 kg/m^3", yield_strength: "2 MPa", doc: "Foam" } }], "Edit material foam");
  });

  it("refuses to clear the last density", async () => {
    const p = props({ files: FILES, materials: MATERIALS });
    const el = await mount(p);
    await click(button(el, "foam"));
    await type(input(el, "Density"), "");
    await blur(input(el, "Density"));
    expect(p.onMutate).not.toHaveBeenCalled();
    expect(el.textContent).toContain("A material needs at least one density.");
  });

  it("shows the check's diagnostics on this material", async () => {
    const p = props({ files: FILES, materials: MATERIALS, diagnostics: [{ code: "RW-E064", severity: "error", path: "/materials/foam/density", message: "must be greater than 0" }, { code: "RW-E064", severity: "error", path: "/materials/foamy", message: "another material" }] as never });
    const el = await mount(p);
    await click(button(el, "foam"));
    const list = el.querySelector("[data-testid='materials.validation']");
    expect(list?.textContent).toContain("must be greater than 0");
    expect(list?.textContent).not.toContain("another material");
  });

  it("follows the model, and lets go of a material that is gone", async () => {
    const p = props({ files: FILES, materials: MATERIALS });
    const el = await mount(p);
    await click(button(el, "foam"));
    await rerender({ ...p, materials: { foam: { density: 200 } } });
    expect(input(el, "Density").value).toBe("200");
    await rerender({ ...p, files: { "rocket.rw.toml": "" }, materials: {} });
    expect(el.querySelector("input[aria-label='Density']")).toBeNull();
  });
});

describe("the library", () => {
  it("asks for the library when it opens", async () => {
    const onOpenLibrary = vi.fn<() => void>();
    await mount(props({ onOpenLibrary }));
    expect(onOpenLibrary).toHaveBeenCalledTimes(1);
  });

  it("copies a material into the project under its library key (D15), and opens it", async () => {
    const p = props();
    const el = await mount(p);
    await click(el.querySelector<HTMLButtonElement>("[data-testid='materials.library-item']")!);
    expect(p.onMutate).toHaveBeenCalledWith([{ op: "add", path: "/materials/fiber_bulk", value: { density: "657.0 kg/m^3", doc: "Fiber, bulk" } }], "Copy material fiber bulk");
    expect(input(el, "Density").value).toBe("657");
    expect(input(el, "Name").value).toBe("fiber bulk");
  });

  it("opens the project's copy rather than copying twice", async () => {
    const p = props({ files: { "rocket.rw.toml": '[materials.fiber_bulk]\ndensity = "700 kg/m^3"\n' }, materials: { fiber_bulk: { density: 700 } } });
    const el = await mount(p);
    await click(el.querySelector<HTMLButtonElement>("[data-testid='materials.library-item']")!);
    expect(p.onMutate).not.toHaveBeenCalled();
    expect(input(el, "Density").value).toBe("700");
  });

  it("filters by what is typed", async () => {
    const el = await mount(props());
    await type(input(el, "Search the library"), "balsa");
    expect(el.querySelector("[data-testid='materials.library-item']")).toBeNull();
    expect(el.textContent).toContain("No library material matches.");
  });

  it("says when the library cannot be read", async () => {
    const el = await mount(props({ library: { state: "error", items: [], error: "no sidecar" } }));
    expect(el.textContent).toContain("no sidecar");
  });
});
