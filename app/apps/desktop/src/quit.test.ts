import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { guardQuit, once, QUIT_DISCARD_BUTTON, QUIT_KEEP_BUTTON, QUIT_PROMPT, type QuitGuardDeps } from "./quit.ts";

function harness(over: Partial<QuitGuardDeps> = {}) {
  const app = new EventEmitter();
  const codes: number[] = [];
  const answers: ((discard: boolean) => void)[] = [];
  let dirty = false;
  const guard = guardQuit(app as never, {
    isDirty: () => dirty,
    confirmDiscard: () => new Promise<boolean>((resolve) => answers.push(resolve)),
    shutdown: once(async (code: number) => void codes.push(code)),
    log: () => undefined,
    ...over,
  });
  const event = () => {
    const e = { prevented: false, preventDefault: () => (e.prevented = true) };
    return e;
  };
  const quit = () => {
    const e = event();
    app.emit("before-quit", e);
    return e.prevented;
  };
  const close = () => {
    const e = event();
    guard.onWindowClose(e);
    return e.prevented;
  };
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));
  return { codes, answers, quit, close, settle, setDirty: (d: boolean) => (dirty = d) };
}

describe("quitting without orphans (quit.ts)", () => {
  it("app.quit() holds the quit and runs the graceful shutdown once, however often it is asked", async () => {
    const t = harness();
    expect(t.quit()).toBe(true);
    // A second Cmd+Q while the server stops: still held, no second shutdown.
    expect(t.quit()).toBe(true);
    await t.settle();
    expect(t.codes).toEqual([0]);
    expect(t.answers).toHaveLength(0);
  });

  it("asks before quitting with typed work, and Keep editing stays open and asks again", async () => {
    const t = harness();
    t.setDirty(true);
    expect(t.quit()).toBe(true);
    expect(t.answers).toHaveLength(1);
    t.answers[0]!(false);
    await t.settle();
    expect(t.codes).toEqual([]);

    expect(t.quit()).toBe(true);
    expect(t.answers).toHaveLength(2);
    t.answers[1]!(true);
    await t.settle();
    expect(t.codes).toEqual([0]);
  });

  it("asks once while its prompt is up, whichever way the quit comes", async () => {
    const t = harness();
    t.setDirty(true);
    t.quit();
    expect(t.quit()).toBe(true);
    expect(t.close()).toBe(true);
    expect(t.answers).toHaveLength(1);
  });

  it("lets a clean window close go on to window-all-closed", async () => {
    const t = harness();
    expect(t.close()).toBe(false);
    await t.settle();
    expect(t.codes).toEqual([]);
  });

  it("holds a window close with typed work, and Quit without saving ends the app", async () => {
    const t = harness();
    t.setDirty(true);
    expect(t.close()).toBe(true);
    expect(t.answers).toHaveLength(1);
    t.answers[0]!(true);
    await t.settle();
    expect(t.codes).toEqual([0]);
    expect(t.close()).toBe(false);
  });

  it("never asks once the shutdown has started", async () => {
    const t = harness();
    t.quit();
    t.setDirty(true);
    expect(t.quit()).toBe(true);
    expect(t.close()).toBe(false);
    expect(t.answers).toHaveLength(0);
  });

  it("stays open when the prompt cannot be shown", async () => {
    const lines: string[] = [];
    const t = harness({ confirmDiscard: () => Promise.reject(new Error("no window")), log: (l) => lines.push(l) });
    t.setDirty(true);
    t.quit();
    await t.settle();
    expect(t.codes).toEqual([]);
    expect(lines.join()).toContain("no window");
    t.setDirty(false);
    t.quit();
    await t.settle();
    expect(t.codes).toEqual([0]);
  });

  it("offers Keep editing as the default and as what Esc means", () => {
    expect(QUIT_PROMPT.defaultId).toBe(QUIT_KEEP_BUTTON);
    expect(QUIT_PROMPT.cancelId).toBe(QUIT_KEEP_BUTTON);
    expect(QUIT_PROMPT.buttons[QUIT_DISCARD_BUTTON]).toBe("Quit without saving");
  });

  it("once() hands every caller the first call's promise", async () => {
    let n = 0;
    const f = once(async () => void n++);
    await Promise.all([f(), f(), f()]);
    expect(n).toBe(1);
  });
});
