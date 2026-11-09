// @vitest-environment jsdom
/** D22: what a focused editor field does when the project is left. Valid text is already in the draft; text that failed its check is not. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EvaluatedModel } from "@rw/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { anyDirtyField, flushDirtyFields, resetDirtyFields } from "../../state/dirtyFields.ts";
import { ComponentEditor, type ComponentEditorProps } from "./ComponentEditor.tsx";
import { blurFromWindow } from "../../testing/windowFocus.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom's `import.meta.url` is not a file URL; vitest runs from the package.
const evaluated = (JSON.parse(readFileSync(resolve(process.cwd(), "../../../fixtures/contracts/evaluated-model.json"), "utf8")) as { payload: EvaluatedModel }).payload;
const fins = evaluated.components.find((c) => c.id === "fins")!;

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  resetDirtyFields();
});

async function editor(field = "span", previewNote?: string) {
  const onEdit = vi.fn<ComponentEditorProps["onEdit"]>();
  const onCommit = vi.fn<ComponentEditorProps["onCommit"]>();
  const noop = () => undefined;
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () =>
    root!.render(
      <ComponentEditor
        comps={[fins]}
        files={{ "rocket.rw.toml": "[c.fins]\n" }}
        units="mm"
        materials={{ balsa: { density: 120 } }}
        diagnostics={[]}
        status={{ kind: "clean", detail: "" }}
        tab="Geometry"
        onTab={noop}
        collapsed={false}
        onCollapse={noop}
        canRevert={false}
        onEdit={onEdit}
        onCommit={onCommit}
        onDiscard={noop}
        onRevert={noop}
        library={{ state: "idle", items: [] }}
        onOpenLibrary={noop}
        onApplyPreset={noop}
        previewNote={previewNote}
      />,
    ),
  );
  return { input: el.querySelector<HTMLInputElement>(`[data-field="${field}"] input`)!, onEdit, onCommit };
}

const type = async (input: HTMLInputElement, value: string) =>
  act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("a draft whose check is left to the sidecar", () => {
  it("says so under the fields", async () => {
    await editor("span", "This rocket flies a library motor, so the check shown here is the last saved one.");
    expect(document.body.querySelector('[data-testid="editor.preview-note"]')?.textContent).toContain("library motor");
  });
});

describe("an expression typed in a numeric field", () => {
  it("is accepted where the schema allows one, unchanged", async () => {
    const { input, onEdit } = await editor();
    await type(input, "= params.fin_span * 2");
    expect(document.body.querySelector('[data-field="span"]')?.getAttribute("data-invalid")).toBeNull();
    expect(onEdit.mock.calls.at(-1)?.[0]).toEqual([{ op: "add", path: "/c/fins/span", value: "= params.fin_span * 2" }]);
    expect(document.body.textContent).not.toContain("needs a number");
  });

  it("says a formula is needed for a bare =", async () => {
    const { input, onEdit } = await editor();
    await type(input, "=");
    expect(onEdit).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Span needs a formula after =.");
  });

  it("a numeric field the schema does not allow it in still needs a number", async () => {
    const { input, onEdit } = await editor("thickness");
    await type(input, "= 2 * 3");
    expect(onEdit).toHaveBeenCalled();
    onEdit.mockClear();
    const count = document.body.querySelector<HTMLInputElement>('[data-field="count"] input')!;
    await type(count, "= 2 * 3");
    expect(onEdit).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("needs a number");
  });
});

describe("an editor field still focused when the project is left", () => {
  it("has handed valid text to the draft already, so nothing is left to flush", async () => {
    const { input, onEdit, onCommit } = await editor();
    await type(input, "100");
    expect(onEdit).toHaveBeenCalled();
    expect(document.body.querySelector('[data-field="span"]')?.getAttribute("data-invalid")).toBeNull();
    expect(anyDirtyField()).toBe(false);
    await expect(flushDirtyFields()).resolves.toEqual([]);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("reports text that failed its check", async () => {
    const { input } = await editor();
    await type(input, "tall");
    expect(anyDirtyField()).toBe(true);
    await expect(flushDirtyFields()).resolves.toEqual(["Span needs a number."]);
  });

  it("still reports it after a blur has put the model's value back", async () => {
    const { input } = await editor();
    await type(input, "tall");
    await act(async () => input.blur());
    expect(input.value).not.toBe("tall");
    await expect(flushDirtyFields()).resolves.toEqual(["Span needs a number."]);
  });
});

describe("the window losing focus (a native dialog) with a part field being edited", () => {
  it("leaves invalid typed text and its dirty state alone", async () => {
    const { input, onCommit } = await editor();
    await type(input, "tall");
    await blurFromWindow(input);
    expect(input.value).toBe("tall");
    expect(document.body.querySelector('[data-field="span"]')?.getAttribute("data-invalid")).toBe("true");
    expect(anyDirtyField()).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();
    await expect(flushDirtyFields()).resolves.toEqual(["Span needs a number."]);
  });

  it("does not commit valid typed text", async () => {
    const { input, onCommit } = await editor();
    await type(input, "100");
    await blurFromWindow(input);
    expect(input.value).toBe("100");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits when focus then really moves on", async () => {
    const { input, onCommit } = await editor();
    await type(input, "100");
    await blurFromWindow(input);
    await act(async () => input.focus());
    await act(async () => input.blur());
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("leaves a typed name alone too", async () => {
    const { input, onCommit } = await editor("name");
    await type(input, "New name");
    await blurFromWindow(input);
    expect(input.value).toBe("New name");
    expect(onCommit).not.toHaveBeenCalled();
  });
});
