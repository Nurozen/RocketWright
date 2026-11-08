/**
 * Stubs Electron's native dialogs for B1 and B2: a per-method queue of
 * answers, and a log of every call. The queue is mirrored here so it survives
 * a relaunch: main's copy dies with the process, so `install` must run again
 * on each launch, and pending answers follow. Call `sync` before quitting so
 * answers already used are not replayed.
 *
 * The only file allowed to use `app.evaluate` (D27).
 */
import type { ElectronApplication } from "@playwright/test";

/** The native message box's button order: index 0 accepts, index 1 cancels. */
export const MESSAGE_BOX_BUTTONS = { accept: 0, cancel: 1 } as const;

export const DIALOG_METHODS = ["showOpenDialog", "showSaveDialog", "showMessageBox", "showOpenDialogSync", "showSaveDialogSync", "showMessageBoxSync"] as const;
export type DialogMethod = (typeof DIALOG_METHODS)[number];

export interface DialogCall {
  method: DialogMethod;
  options: unknown;
  answer: unknown;
}

/** The one method used: the real application, or a stand-in in unit tests. */
export type EvaluatingApp = Pick<ElectronApplication, "evaluate">;

interface MainStub {
  queues: Record<string, unknown[]>;
  log: DialogCall[];
}

export class DialogQueues {
  private app: EvaluatingApp | undefined;
  private readonly pending = new Map<DialogMethod, unknown[]>(DIALOG_METHODS.map((m) => [m, []]));
  private readonly callLog: DialogCall[] = [];

  /** Installs the stubs on a freshly launched app and hands it the answers still unused. */
  async install(app: EvaluatingApp): Promise<void> {
    this.app = app;
    const queues = Object.fromEntries(this.pending);
    // Runs in the main process: it can reach nothing outside its arguments.
    await app.evaluate(
      ({ dialog }, arg: { methods: readonly string[]; queues: Record<string, unknown[]> }) => {
        const methods = dialog as unknown as Record<string, unknown>;
        const stub: MainStub = { queues: arg.queues, log: [] };
        (globalThis as { __rwDialogStub?: MainStub }).__rwDialogStub = stub;
        for (const method of arg.methods) {
          const answer = (...args: unknown[]): unknown => {
            // Electron takes (window, options) or (options); a window does not cross into the log.
            const options = JSON.parse(JSON.stringify(args.length > 1 ? args[1] : (args[0] ?? null))) as unknown;
            const queue = stub.queues[method] ?? [];
            if (queue.length === 0) {
              stub.log.push({ method: method as DialogMethod, options, answer: null });
              throw new Error(`no stubbed answer queued for dialog.${method}`);
            }
            const next = queue.shift();
            stub.log.push({ method: method as DialogMethod, options, answer: next });
            return next;
          };
          methods[method] = method.endsWith("Sync") ? answer : async (...args: unknown[]) => answer(...args);
        }
      },
      { methods: [...DIALOG_METHODS], queues },
    );
  }

  /** Queues answers, in order, for the next calls of `method`. */
  async enqueue(method: DialogMethod, ...answers: readonly unknown[]): Promise<void> {
    this.pending.get(method)!.push(...answers);
    if (this.app === undefined) return;
    await this.app.evaluate(
      (_electron, arg: { method: string; answers: readonly unknown[] }) => {
        (globalThis as { __rwDialogStub?: MainStub }).__rwDialogStub!.queues[arg.method]!.push(...arg.answers);
      },
      { method, answers: [...answers] },
    );
  }

  /** Collects main's new calls into the log and drops the answers they used. */
  async sync(): Promise<void> {
    if (this.app === undefined) return;
    const calls = await this.app.evaluate((_electron, _arg: null) => (globalThis as { __rwDialogStub?: MainStub }).__rwDialogStub!.log.splice(0), null);
    for (const call of calls) {
      this.callLog.push(call);
      if (call.answer !== null) this.pending.get(call.method)!.shift();
    }
  }

  /** Every call seen so far, across relaunches; one method's when given. */
  calls(method?: DialogMethod): DialogCall[] {
    return method === undefined ? [...this.callLog] : this.callLog.filter((c) => c.method === method);
  }

  /** Answers still queued for `method`. */
  remaining(method: DialogMethod): number {
    return this.pending.get(method)!.length;
  }
}
