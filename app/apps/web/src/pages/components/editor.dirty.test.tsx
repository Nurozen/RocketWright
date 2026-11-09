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

async function editor() {
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
        materials={["balsa"]}
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
      />,
    ),
  );
  return { input: el.querySelector<HTMLInputElement>('[data-field="span"] input')!, onEdit, onCommit };
}

const type = async (input: HTMLInputElement, value: string) =>
  act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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
