// @vitest-environment jsdom
/** U47: the Parts library tab: paged search, real filters, windowed rows, add and replace. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EvaluatedModel, schema } from "@rw/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddPartPalette, type AddPartPaletteProps } from "./AddPartPopover.tsx";
import { PAGE_SIZE, ROW_HEIGHT, SEARCH_DEBOUNCE_MS, type PresetQuery } from "./PartsLibrary.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const parts = (JSON.parse(readFileSync(resolve(process.cwd(), "../../../fixtures/contracts/evaluated-model.json"), "utf8")) as { payload: EvaluatedModel }).payload.components;

const TOTAL = 3449;
const facets: schema.LibraryFacets = {
  manufacturers: [
    { value: "Apogee", count: 300 },
    { value: "Estes", count: 800 },
  ],
  component_types: [
    { value: "body_tube", count: 1089 },
    { value: "parachute", count: 151 },
  ],
};

const preset = (i: number, over: Record<string, unknown> = {}): schema.LibItem => ({
  id: `preset:estes/part_${i}`,
  kind: "preset",
  name: `Part ${i}`,
  source: "openrocket-database (Apache-2.0) orc/estes.orc",
  data: { type: "body_tube", length: "100 mm", od: "24 mm", id: "23 mm", preset: { manufacturer: "Estes", part_number: `PN${i}`, description: `Tube ${i}`, materials: {}, needs: [] }, ...over },
});

const catalog = (q: PresetQuery): schema.LibrarySearchOut => ({
  items: Array.from({ length: Math.min(PAGE_SIZE, TOTAL - q.offset) }, (_, k) => preset(q.offset + k)),
  total: TOTAL,
  facets,
});

let root: Root | null = null;
let host: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

const settle = () => act(async () => {
  await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 1);
});

interface Opened {
  search: ReturnType<typeof vi.fn<AddPartPaletteProps["library"]["search"]>>;
  add: ReturnType<typeof vi.fn<AddPartPaletteProps["library"]["onAdd"]>>;
  replace: ReturnType<typeof vi.fn<AddPartPaletteProps["library"]["onReplace"]>>;
  done: ReturnType<typeof vi.fn<() => void>>;
}

async function open(props: Partial<AddPartPaletteProps> & { result?: (q: PresetQuery) => Promise<schema.LibrarySearchOut> } = {}): Promise<Opened> {
  const { result, ...rest } = props;
  const search = vi.fn<AddPartPaletteProps["library"]["search"]>(result ?? (async (q) => catalog(q)));
  const add = vi.fn<AddPartPaletteProps["library"]["onAdd"]>(async () => {});
  const replace = vi.fn<AddPartPaletteProps["library"]["onReplace"]>(async () => {});
  const done = vi.fn<() => void>();
  act(() => {
    root ??= createRoot(host);
    root.render(<AddPartPalette components={parts} selected={[]} onAdd={async () => {}} onDone={done} library={{ search, onAdd: add, onReplace: replace }} {...rest} />);
  });
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === "Parts library")!;
  act(() => tab.click());
  await settle();
  return { search, add, replace, done };
}

const rows = () => [...document.querySelectorAll<HTMLElement>('[role="listitem"]')];
const listEl = () => document.querySelector<HTMLElement>('[data-testid="add-part.library-list"]')!;
const statusText = () => document.querySelector('[data-testid="add-part.library-count"]')!.textContent;
const group = (name: string) => document.querySelector<HTMLElement>(`[role="group"][aria-label="${name}"]`)!;
const button = (scope: HTMLElement, name: string) => [...scope.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement | undefined;

function choose(label: string, value: string): void {
  const forLabel = [...document.querySelectorAll("label")].find((l) => l.textContent === label)!;
  const select = document.getElementById(forLabel.htmlFor) as HTMLSelectElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function scrollTo(top: number): void {
  const list = listEl();
  act(() => {
    list.scrollTop = top;
    list.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

describe("PartsLibrary", () => {
  it("reports the whole catalog but renders only the rows in view", async () => {
    await open();
    expect(statusText()).toBe("3,449 parts");
    expect(rows().length).toBeGreaterThan(5);
    expect(rows().length).toBeLessThan(25);
    expect(rows()[0]!.getAttribute("aria-setsize")).toBe("3449");
    expect(host.textContent).toContain("Part 0");
    expect(host.textContent).not.toContain("Part 40");
  });

  it("asks for the next page only when the list reaches it, and can reach the last part", async () => {
    const { search } = await open();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![0]).toEqual({ kind: "preset", limit: PAGE_SIZE, offset: 0 });
    scrollTo(20 * ROW_HEIGHT);
    await settle();
    expect(search).toHaveBeenCalledTimes(1);
    scrollTo((TOTAL - 3) * ROW_HEIGHT);
    await settle();
    expect(search.mock.calls.at(-1)![0].offset).toBe(3400);
    expect(host.textContent).toContain("Part 3448");
  });

  it("sends the manufacturer and type to the sidecar and starts again at the top", async () => {
    const { search } = await open();
    scrollTo(500 * ROW_HEIGHT);
    await settle();
    choose("Manufacturer", "Estes");
    await settle();
    expect(search.mock.calls.at(-1)![0]).toEqual({ kind: "preset", limit: PAGE_SIZE, offset: 0, manufacturer: "Estes" });
    choose("Type", "parachute");
    await settle();
    expect(search.mock.calls.at(-1)![0]).toEqual({ kind: "preset", limit: PAGE_SIZE, offset: 0, manufacturer: "Estes", component_type: "parachute" });
    expect(listEl().scrollTop).toBe(0);
  });

  it("lists facets with counts and part types in words", async () => {
    await open();
    const options = [...document.querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(["All manufacturers", "Estes (800)", "All types", "Body tube (1,089)", "Parachute (151)"]));
  });

  it("waits for typing to settle before searching", async () => {
    const { search } = await open();
    const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "bt-55");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(search).toHaveBeenCalledTimes(1);
    await settle();
    expect(search.mock.calls.at(-1)![0]).toEqual({ kind: "preset", limit: PAGE_SIZE, offset: 0, query: "bt-55" });
  });

  it("ignores an answer to a search that has been replaced", async () => {
    let answer: (out: schema.LibrarySearchOut) => void = () => {};
    let calls = 0;
    await open({
      result: (q) => {
        calls++;
        if (calls > 2) return Promise.resolve({ items: [preset(7777)], total: 1, facets });
        if (calls === 2) return new Promise((r) => { answer = r; });
        return Promise.resolve(catalog(q));
      },
    });
    choose("Manufacturer", "Estes");
    await settle();
    choose("Manufacturer", "Apogee");
    await settle();
    await act(async () => {
      answer(catalog({ kind: "preset", limit: PAGE_SIZE, offset: 0 }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(statusText()).toBe("1 part");
    expect(host.textContent).toContain("Part 7777");
  });

  it("says when nothing matches", async () => {
    await open({ result: async () => ({ items: [], total: 0, facets }) });
    expect(statusText()).toBe("0 parts");
    expect(host.textContent).toContain("No parts match");
  });

  it("shows a failed search and can try again", async () => {
    let fail = true;
    await open({ result: async (q) => { if (fail) throw new Error("sidecar is gone"); return catalog(q); } });
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("sidecar is gone");
    fail = false;
    act(() => button(document.querySelector('[role="alert"]')!, "Try again")!.click());
    await settle();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(statusText()).toBe("3,449 parts");
  });

  it("adds a catalog part on the chosen parent and closes", async () => {
    const { add, done } = await open();
    act(() => button(group("Part 0"), "Add")!.click());
    await settle();
    expect(add.mock.calls[0]![0].id).toBe("preset:estes/part_0");
    expect(add.mock.calls[0]![1]).not.toBeNull();
    expect(done).toHaveBeenCalledOnce();
  });

  it("adds the first part as the root on an empty project, and refuses a kind that cannot start the rocket", async () => {
    const chute = preset(1, { type: "parachute" });
    const { add } = await open({ components: [], result: async () => ({ items: [preset(0), chute], total: 2, facets }) });
    expect(button(group("Part 1"), "Add")!.disabled).toBe(true);
    expect(button(group("Part 1"), "Add")!.title).toMatch(/Start the rocket/);
    act(() => button(group("Part 0"), "Add")!.click());
    await settle();
    expect(add.mock.calls[0]![1]).toBeNull();
  });

  it("offers Replace geometry only for the one selected part of the same kind", async () => {
    const tube = parts.find((p) => p.shape.type === "body_tube")!;
    const { replace, done } = await open({ selected: [tube.id], result: async () => ({ items: [preset(0), preset(1, { type: "parachute" })], total: 2, facets }) });
    expect(button(group("Part 1"), "Replace geometry")).toBeUndefined();
    act(() => button(group("Part 0"), "Replace geometry")!.click());
    await settle();
    expect(replace.mock.calls[0]![1]).toMatchObject({ id: tube.id });
    expect(done).toHaveBeenCalledOnce();
  });

  it("offers no Replace geometry with no part or several parts selected", async () => {
    const [a, b] = parts;
    await open({ selected: [a!.id, b!.id] });
    expect(button(group("Part 0"), "Replace geometry")).toBeUndefined();
  });

  it("says which fields a catalog part leaves to defaults", async () => {
    const chute = preset(0, { type: "parachute", preset: { manufacturer: "Estes", part_number: "P", description: "Chute", materials: {}, needs: ["cd", "packed_length", "packed_diameter"] } });
    await open({ result: async () => ({ items: [chute], total: 1, facets }) });
    expect(host.textContent).toContain("Adds default Cd, packed length, packed diameter");
  });

  it("keeps the popover open and shows the failure when a commit fails", async () => {
    const add = vi.fn<AddPartPaletteProps["library"]["onAdd"]>(async () => Promise.reject(new Error("rejected")));
    const done = vi.fn<() => void>();
    act(() => {
      root ??= createRoot(host);
      root.render(<AddPartPalette components={parts} selected={[]} onAdd={async () => {}} onDone={done} library={{ search: async (q) => catalog(q), onAdd: add, onReplace: async () => {} }} />);
    });
    act(() => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === "Parts library")!.click());
    await settle();
    act(() => button(group("Part 0"), "Add")!.click());
    await settle();
    expect(done).not.toHaveBeenCalled();
    expect(host.textContent).toContain("rejected");
  });
});
