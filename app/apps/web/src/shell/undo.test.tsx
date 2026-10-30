import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Header, undoTitle } from "./Header.tsx";
import { canonicalStep, restoreTarget, stepTitle, undoKey, undoState } from "./undo.ts";

const step = (seq: number, title = `Edit ${seq}`, tool: string | null = "model_patch") => ({ seq, title, tool });
const restore = (seq: number, target: string) => step(seq, `Restore ${target}`, "history_restore");

describe("undoState (no separate stack: derived from the steps)", () => {
  it("is empty without history and has no undo at the first step", () => {
    expect(undoState([])).toEqual({ shown: null, undo: null, redo: null });
    expect(undoState([step(1)])).toEqual({ shown: 1, undo: null, redo: null });
  });

  it("undo goes back one state, redo forward, and the shown step follows", () => {
    const base = [step(1), step(2), step(3), step(4)];
    expect(undoState(base)).toEqual({ shown: 4, undo: 3, redo: null });
    // Undo = history_restore of step 3 (a new step 5 equal to step 3).
    const undone = [...base, restore(5, "step:3")];
    expect(undoState(undone)).toEqual({ shown: 3, undo: 2, redo: 4 });
    const twice = [...undone, restore(6, "step:2")];
    expect(undoState(twice)).toEqual({ shown: 2, undo: 1, redo: 3 });
    const redone = [...twice, restore(7, "step:3")];
    expect(undoState(redone)).toEqual({ shown: 3, undo: 2, redo: 4 });
  });

  it("a restore step stands for the step it restored (canonicalStep)", () => {
    const s = [step(1), step(2), step(3), restore(4, "step:2"), restore(5, "step:4")];
    expect(canonicalStep(s, [], 3)).toBe(3);
    expect(canonicalStep(s, [], 4)).toBe(2);
    expect(canonicalStep(s, [], 5)).toBe(2);
    expect(canonicalStep(s, [], 9)).toBe(9);
  });

  it("a restore of a restore step resolves to the state it restored", () => {
    const s = [step(1), step(2), step(3), restore(4, "step:2"), restore(5, "step:3"), restore(6, "step:4")];
    expect(undoState(s)).toEqual({ shown: 2, undo: 1, redo: 3 });
  });

  it("a new edit after an undo clears redo", () => {
    const s = [step(1), step(2), step(3), restore(4, "step:2"), step(5)];
    expect(undoState(s)).toEqual({ shown: 5, undo: 2, redo: null });
  });

  it("revisions resolve to their step; unparseable restores are new states", () => {
    const revs = [{ number: 7, step: 2 }];
    expect(restoreTarget(restore(4, "rev:07"), revs)).toBe(2);
    expect(undoState([step(1), step(2), step(3), restore(4, "rev:7")], revs)).toEqual({ shown: 2, undo: 1, redo: 3 });
    expect(undoState([step(1), step(2), step(3, "Put it back", "history_restore")])).toEqual({ shown: 3, undo: 2, redo: null });
    expect(restoreTarget(step(4, "Restore step:2", "model_patch"))).toBeNull();
  });

  it("restore steps read as words in the strip", () => {
    expect(stepTitle(restore(5, "step:3"))).toBe("Restored Step 03");
    expect(stepTitle(restore(5, "rev:7"))).toBe("Restored Rev 07");
    expect(stepTitle(step(2, "Fin revision"))).toBe("Fin revision");
  });
});

describe("undoKey", () => {
  const ev = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}, tagName = "BODY") => ({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
    target: { tagName } as unknown as EventTarget,
  });
  it("maps the platform shortcuts and leaves text fields alone", () => {
    expect(undoKey(ev("z", { metaKey: true }))).toBe("undo");
    expect(undoKey(ev("z", { ctrlKey: true }))).toBe("undo");
    expect(undoKey(ev("Z", { metaKey: true, shiftKey: true }))).toBe("redo");
    expect(undoKey(ev("y", { ctrlKey: true }))).toBe("redo");
    expect(undoKey(ev("z"))).toBeNull();
    expect(undoKey(ev("z", { metaKey: true }, "INPUT"))).toBeNull();
    expect(undoKey(ev("z", { metaKey: true }, "TEXTAREA"))).toBeNull();
  });
});

describe("Header undo/redo", () => {
  const s3 = { id: "step:3", number: 3, name: "Fin revision", date: "Oct 14, 2026" };
  const base = { projectName: "P", saveState: "Saved", activeTab: "design" as const, check: { status: "ok" as const, issues: 0 } };
  it("shows both controls with tooltips, disabled when there is nothing to move to", () => {
    const html = renderToStaticMarkup(<Header {...base} undo={{ undo: s3, redo: null }} />);
    expect(html).toContain('data-testid="header.undo-redo"');
    expect(html).toMatch(/data-testid="header.undo" data-target="step:3"[^>]*title="Undo: back to Step 03 · Fin revision \((⌘Z|Ctrl\+Z)\)"/);
    expect(html).toMatch(/data-testid="header.redo" data-target=""[^>]*title="Nothing to redo"[^>]*disabled=""/);
    expect(html).not.toMatch(/data-testid="header.undo"[^>]*disabled=""/);
  });
  it("hides the controls without history, and disables both while a restore runs", () => {
    expect(renderToStaticMarkup(<Header {...base} />)).not.toContain("header.undo-redo");
    const busy = renderToStaticMarkup(<Header {...base} undo={{ undo: s3, redo: s3 }} undoBusy />);
    expect(busy.match(/disabled=""/g)?.length).toBe(2);
  });
  it("names the shortcut per platform", () => {
    expect(undoTitle("redo", s3, true)).toBe("Redo: forward to Step 03 · Fin revision (⇧⌘Z)");
    expect(undoTitle("redo", s3, false)).toBe("Redo: forward to Step 03 · Fin revision (Ctrl+Y)");
  });
});
