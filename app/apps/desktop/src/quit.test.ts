import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPageFlush, guardQuit, once, PAGE_FLUSH_TIMEOUT_MS, QUIT_DISCARD_BUTTON, QUIT_KEEP_BUTTON, QUIT_PROMPT, QUIT_SAVE_BUTTON, quitChoice, quitSaveFailedPrompt, SAVE_FAILED_DISCARD_BUTTON, SAVE_FAILED_KEEP_BUTTON, type QuitChoice, type QuitGuardDeps } from "./quit.ts";

function harness(over: Partial<QuitGuardDeps> = {}) {
  const app = new EventEmitter();
  const codes: number[] = [];
  const answers: ((choice: QuitChoice) => void)[] = [];
  const flushes: ((problems: string[]) => void)[] = [];
  const failed: { problems: string[]; answer: (discard: boolean) => void }[] = [];
  let dirty = false;
  const guard = guardQuit(app as never, {
    isDirty: () => dirty,
    ask: () => new Promise<QuitChoice>((resolve) => answers.push(resolve)),
    flush: () => new Promise<string[]>((resolve) => flushes.push(resolve)),
    confirmSaveFailed: (problems) => new Promise<boolean>((answer) => failed.push({ problems, answer })),
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
  return { codes, answers, flushes, failed, quit, close, settle, setDirty: (d: boolean) => (dirty = d) };
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
    t.answers[0]!("keep");
    await t.settle();
    expect(t.codes).toEqual([]);

    expect(t.quit()).toBe(true);
    expect(t.answers).toHaveLength(2);
    t.answers[1]!("discard");
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
    t.answers[0]!("discard");
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
    const t = harness({ ask: () => Promise.reject(new Error("no window")), log: (l) => lines.push(l) });
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
    expect(QUIT_PROMPT.buttons[QUIT_SAVE_BUTTON]).toBe("Save and quit");
    expect(QUIT_PROMPT.buttons[QUIT_DISCARD_BUTTON]).toBe("Quit without saving");
  });

  it("maps every button to its choice, and anything else to Keep editing", () => {
    expect(quitChoice(QUIT_KEEP_BUTTON)).toBe("keep");
    expect(quitChoice(QUIT_SAVE_BUTTON)).toBe("save");
    expect(quitChoice(QUIT_DISCARD_BUTTON)).toBe("discard");
    expect(quitChoice(9)).toBe("keep");
  });

  describe("Save and quit", () => {
    it("quits once the save has landed, and not before", async () => {
      const t = harness();
      t.setDirty(true);
      t.quit();
      t.answers[0]!("save");
      await t.settle();
      expect(t.flushes).toHaveLength(1);
      expect(t.codes).toEqual([]);
      t.flushes[0]!([]);
      await t.settle();
      expect(t.codes).toEqual([0]);
      expect(t.failed).toEqual([]);
    });

    it("also works from the window's close", async () => {
      const t = harness();
      t.setDirty(true);
      expect(t.close()).toBe(true);
      t.answers[0]!("save");
      await t.settle();
      t.flushes[0]!([]);
      await t.settle();
      expect(t.codes).toEqual([0]);
    });

    it("holds every other quit while the save is running", async () => {
      const t = harness();
      t.setDirty(true);
      t.quit();
      t.answers[0]!("save");
      await t.settle();
      expect(t.quit()).toBe(true);
      expect(t.close()).toBe(true);
      expect(t.answers).toHaveLength(1);
      expect(t.flushes).toHaveLength(1);
    });

    it("says what could not be saved, and Keep editing stays open and can ask again", async () => {
      const t = harness();
      t.setDirty(true);
      t.quit();
      t.answers[0]!("save");
      await t.settle();
      t.flushes[0]!(["Delay: needs a number"]);
      await t.settle();
      expect(t.codes).toEqual([]);
      expect(t.failed.map((f) => f.problems)).toEqual([["Delay: needs a number"]]);
      t.failed[0]!.answer(false);
      await t.settle();
      expect(t.codes).toEqual([]);

      t.quit();
      expect(t.answers).toHaveLength(2);
    });

    it("quits without the edit only when the person says so after the failure", async () => {
      const t = harness();
      t.setDirty(true);
      t.quit();
      t.answers[0]!("save");
      await t.settle();
      t.flushes[0]!(["no"]);
      await t.settle();
      t.failed[0]!.answer(true);
      await t.settle();
      expect(t.codes).toEqual([0]);
    });

    it("treats a flush that could not run as a failed save, not a saved one", async () => {
      const failed: string[][] = [];
      const t = harness({
        flush: () => Promise.reject(new Error("the window went away")),
        confirmSaveFailed: async (problems) => {
          failed.push(problems);
          return false;
        },
      });
      t.setDirty(true);
      t.quit();
      t.answers[0]!("save");
      await t.settle();
      expect(failed).toEqual([["the window went away"]]);
      expect(t.codes).toEqual([]);
    });

    it("stays open when the failure cannot be shown", async () => {
      const lines: string[] = [];
      const t = harness({ confirmSaveFailed: () => Promise.reject(new Error("no window")), log: (l) => lines.push(l) });
      t.setDirty(true);
      t.quit();
      t.answers[0]!("save");
      await t.settle();
      t.flushes[0]!(["no"]);
      await t.settle();
      expect(t.codes).toEqual([]);
      expect(lines.join()).toContain("no window");
    });
  });

  describe("the failed-save prompt", () => {
    it("names what failed, keeps editing by default, and offers only the two honest ways on", () => {
      const prompt = quitSaveFailedPrompt(["Delay: needs a number", "Altitude: too low"]);
      expect(prompt.detail).toContain("Delay: needs a number");
      expect(prompt.detail).toContain("Altitude: too low");
      expect(prompt.buttons[SAVE_FAILED_KEEP_BUTTON]).toBe("Keep editing");
      expect(prompt.buttons[SAVE_FAILED_DISCARD_BUTTON]).toBe("Quit without saving");
      expect(prompt.buttons).toHaveLength(2);
      expect(prompt.defaultId).toBe(SAVE_FAILED_KEEP_BUTTON);
      expect(prompt.cancelId).toBe(SAVE_FAILED_KEEP_BUTTON);
    });

    it("stays readable when the page reports a great deal", () => {
      const prompt = quitSaveFailedPrompt(Array.from({ length: 50 }, (_, i) => `problem ${i} ${"x".repeat(2000)}`));
      expect(prompt.detail.length).toBeLessThan(2500);
      expect(prompt.detail).toContain("and 45 more");
    });
  });

  describe("asking the page to save (createPageFlush)", () => {
    beforeEach(() => void vi.useFakeTimers());
    afterEach(() => void vi.useRealTimers());

    function flusher(send: (id: number) => boolean = () => true) {
      const sent: number[] = [];
      const flush = createPageFlush({
        send: (id) => {
          sent.push(id);
          return send(id);
        },
      });
      return { flush, sent };
    }

    it("answers with what the page reports, by id", async () => {
      const { flush, sent } = flusher();
      const a = flush.flush();
      const b = flush.flush();
      flush.done({ id: sent[1]!, problems: ["no"] });
      flush.done({ id: sent[0]!, problems: [] });
      await expect(a).resolves.toEqual([]);
      await expect(b).resolves.toEqual(["no"]);
    });

    it("ignores an answer nobody is waiting for", () => {
      expect(() => flusher().flush.done({ id: 41, problems: [] })).not.toThrow();
    });

    it("does not call a save that took too long a success", async () => {
      const { flush } = flusher();
      const result = flush.flush();
      await vi.advanceTimersByTimeAsync(PAGE_FLUSH_TIMEOUT_MS - 1);
      let settled = false;
      void result.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toEqual([expect.stringMatching(/did not finish/)]);
    });

    it("reports a page that is not there, at once", async () => {
      const { flush } = flusher(() => false);
      await expect(flush.flush()).resolves.toEqual([expect.stringMatching(/window/)]);
    });

    it("reports a page that goes away mid-save, at once", async () => {
      const { flush } = flusher();
      const result = flush.flush();
      flush.pageGone();
      await expect(result).resolves.toEqual([expect.stringMatching(/went away/)]);
    });
  });

  it("once() hands every caller the first call's promise", async () => {
    let n = 0;
    const f = once(async () => void n++);
    await Promise.all([f(), f(), f()]);
    expect(n).toBe(1);
  });
});
