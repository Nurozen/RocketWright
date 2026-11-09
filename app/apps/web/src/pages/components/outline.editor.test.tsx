// @vitest-environment jsdom
/** The fin outline editor's fields and keys. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { anyDirtyField, flushDirtyFields, resetDirtyFields } from "../../state/dirtyFields.ts";
import { FinOutlineEditor, type FinOutlineEditorProps } from "./FinOutlineEditor.tsx";
import { blurFromWindow } from "../../testing/windowFocus.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const comp = { id: "fin", name: "Fin", shape: { type: "freeform_fin_set", points: [[0, 0], [0.03, 0.03], [0.05, 0.03], [0.08, 0]] } } as unknown as FinOutlineEditorProps["comp"];

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  resetDirtyFields();
});

async function outline() {
  const onEdit = vi.fn<FinOutlineEditorProps["onEdit"]>();
  const onCommit = vi.fn<FinOutlineEditorProps["onCommit"]>();
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<FinOutlineEditor comp={comp} units="mm" diagnostics={[]} onEdit={onEdit} onCommit={onCommit} onDiscard={() => undefined} />));
  return { el, onEdit, onCommit };
}

const type = async (input: HTMLInputElement, value: string) =>
  act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

const press = (target: Element, key: string) =>
  act(() => {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  });

describe("outline point fields and the dirty registry", () => {
  it("a typed point is dirty and a flush writes it", async () => {
    const { el, onEdit, onCommit } = await outline();
    const x = el.querySelector<HTMLInputElement>('[data-testid="outline.x"]')!;
    expect(anyDirtyField()).toBe(false);
    await type(x, "12");
    expect(anyDirtyField()).toBe(true);
    await act(async () => void (await flushDirtyFields()));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledOnce();
    expect(anyDirtyField()).toBe(false);
  });

  it("text that is not a number is reported, not sent", async () => {
    const { el, onEdit } = await outline();
    await type(el.querySelector<HTMLInputElement>('[data-testid="outline.x"]')!, "wide");
    await expect(flushDirtyFields()).resolves.toEqual(["Point 1 X needs a number."]);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("the window losing focus keeps invalid text, keeps it dirty, and writes nothing", async () => {
    const { el, onEdit } = await outline();
    const x = el.querySelector<HTMLInputElement>('[data-testid="outline.x"]')!;
    await act(async () => x.focus());
    await type(x, "wide");
    await blurFromWindow(x);
    expect(x.value).toBe("wide");
    expect(anyDirtyField()).toBe(true);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("the window losing focus keeps a valid value uncommitted until focus really moves", async () => {
    const { el, onEdit, onCommit } = await outline();
    const x = el.querySelector<HTMLInputElement>('[data-testid="outline.x"]')!;
    await act(async () => x.focus());
    await type(x, "12");
    await blurFromWindow(x);
    expect(x.value).toBe("12");
    expect(anyDirtyField()).toBe(true);
    expect(onEdit).not.toHaveBeenCalled();
    await act(async () => x.focus());
    await act(async () => x.blur());
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledOnce();
  });
});

describe("Delete on the outline", () => {
  it("is taken by the outline even with no point selected, so the shell does not ask to delete the fin set", async () => {
    const { el, onEdit } = await outline();
    const canvas = el.querySelector('[data-testid="outline.canvas"]')!;
    let event: KeyboardEvent | undefined;
    await act(async () => {
      const e = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
      canvas.dispatchEvent(e);
      event = e;
    });
    expect(event?.defaultPrevented).toBe(true);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("a press on a selected point removes it and stays with the outline", async () => {
    const { el, onEdit } = await outline();
    await act(async () => el.querySelector<HTMLElement>('[data-testid="outline.row"][data-index="1"]')!.click());
    const canvas = el.querySelector('[data-testid="outline.canvas"]')!;
    const e = await press(canvas, "Delete");
    expect((e as KeyboardEvent).defaultPrevented).toBe(true);
    expect(onEdit).toHaveBeenCalledOnce();
  });
});
