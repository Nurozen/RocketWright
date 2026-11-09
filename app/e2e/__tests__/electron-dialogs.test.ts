/** The dialog stub, run as main would: the injected function is re-parsed, so it can close over nothing. */
import { afterEach, describe, expect, it } from "vitest";
import { DialogQueues, MESSAGE_BOX_BUTTONS, type EvaluatingApp } from "../electron-dialogs.ts";

type Dialog = Record<string, (...args: unknown[]) => unknown>;

function fakeApp(): { app: EvaluatingApp; dialog: Dialog } {
  const dialog: Dialog = {};
  const app = {
    evaluate: async <R, A>(fn: (e: { dialog: Dialog }, arg: A) => R | Promise<R>, arg: A): Promise<R> => {
      const rebuilt = new Function(`return (${fn.toString()})`)() as typeof fn;
      return rebuilt({ dialog }, JSON.parse(JSON.stringify(arg)) as A);
    },
  } as unknown as EvaluatingApp;
  return { app, dialog };
}

const relaunch = () => {
  delete (globalThis as { __rwDialogStub?: unknown }).__rwDialogStub;
  return fakeApp();
};

afterEach(() => {
  delete (globalThis as { __rwDialogStub?: unknown }).__rwDialogStub;
});

describe("DialogQueues", () => {
  it("holds a dialog open until it is released, with its options already logged", async () => {
    const { app, dialog } = fakeApp();
    const q = new DialogQueues();
    await q.install(app);
    await q.enqueueHeld("showMessageBox", "consent", { response: 1 });
    let answered: unknown = "pending";
    const box = Promise.resolve(dialog["showMessageBox"]!({ message: "m" })).then((a) => (answered = a));
    const calls = await q.waitForCalls("showMessageBox", 1, 1000);
    expect(calls[0]).toMatchObject({ options: { message: "m" }, answer: { response: 1 } });
    expect(answered).toBe("pending");
    await q.release("consent");
    await box;
    expect(answered).toEqual({ response: 1 });
    await expect(q.release("consent")).rejects.toThrow(/no held dialog/);
  });

  it("answers per method, in order, and logs the options", async () => {
    const { app, dialog } = fakeApp();
    const q = new DialogQueues();
    await q.install(app);
    await q.enqueue("showOpenDialog", { canceled: false, filePaths: ["/tmp/a"] }, { canceled: true, filePaths: [] });
    await q.enqueue("showMessageBox", { response: MESSAGE_BOX_BUTTONS.cancel });
    await expect(dialog["showOpenDialog"]!({ title: "Choose" })).resolves.toEqual({ canceled: false, filePaths: ["/tmp/a"] });
    await expect(dialog["showMessageBox"]!({ message: "m" })).resolves.toEqual({ response: 1 });
    await expect(dialog["showOpenDialog"]!({ title: "Again" })).resolves.toEqual({ canceled: true, filePaths: [] });
    await q.sync();
    expect(q.calls("showOpenDialog").map((c) => c.options)).toEqual([{ title: "Choose" }, { title: "Again" }]);
    expect(q.calls()).toHaveLength(3);
    expect(q.remaining("showOpenDialog")).toBe(0);
  });

  it("logs the options, not the window, for a (window, options) call", async () => {
    const { app, dialog } = fakeApp();
    const q = new DialogQueues();
    await q.install(app);
    await q.enqueue("showSaveDialog", { canceled: true });
    await dialog["showSaveDialog"]!({ webContents: {} }, { title: "Save" });
    await q.sync();
    expect(q.calls("showSaveDialog")[0]?.options).toEqual({ title: "Save" });
  });

  it("answers sync methods directly", async () => {
    const { app, dialog } = fakeApp();
    const q = new DialogQueues();
    await q.install(app);
    await q.enqueue("showMessageBoxSync", 0);
    expect(dialog["showMessageBoxSync"]!({ message: "m" })).toBe(0);
  });

  it("fails an unscripted dialog loudly and logs it", async () => {
    const { app, dialog } = fakeApp();
    const q = new DialogQueues();
    await q.install(app);
    await expect(dialog["showOpenDialog"]!({ title: "x" })).rejects.toThrow(/no stubbed answer queued for dialog.showOpenDialog/);
    await q.sync();
    expect(q.calls("showOpenDialog")).toHaveLength(1);
  });

  it("is reinstalled after a relaunch with the answers still unused, and keeps the call log", async () => {
    const first = fakeApp();
    const q = new DialogQueues();
    await q.install(first.app);
    await q.enqueue("showOpenDialog", { first: true }, { second: true });
    await first.dialog["showOpenDialog"]!({ n: 1 });
    await q.sync();
    expect(q.remaining("showOpenDialog")).toBe(1);

    const second = relaunch();
    await q.install(second.app);
    await expect(second.dialog["showOpenDialog"]!({ n: 2 })).resolves.toEqual({ second: true });
    await q.enqueue("showMessageBox", { response: MESSAGE_BOX_BUTTONS.accept });
    await expect(second.dialog["showMessageBox"]!({})).resolves.toEqual({ response: 0 });
    await q.sync();
    expect(q.calls("showOpenDialog").map((c) => c.options)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(q.remaining("showOpenDialog")).toBe(0);
  });

  it("queues before install reach the app when installed", async () => {
    const { app, dialog } = fakeApp();
    const q = new DialogQueues();
    await q.enqueue("showMessageBox", { response: 0 });
    await q.install(app);
    await expect(dialog["showMessageBox"]!({})).resolves.toEqual({ response: 0 });
  });
});
