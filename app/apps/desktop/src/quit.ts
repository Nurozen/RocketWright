/**
 * Quitting without orphans (CPW1R5A). `app.quit()` (Cmd+Q, Playwright's
 * `ElectronApplication.close()`) closes the windows but never emits
 * `window-all-closed`, so main's graceful shutdown (SIGTERM to the app
 * server, which stops its rocketwright sidecars and the Lecturn sidecar)
 * never ran: the process `exit` hook SIGKILLed the server and its children
 * lived on. After the electron b4a spec those orphans (a Lecturn server
 * over a deleted temp dir, its sidecars) starved the next spec's Chromium
 * ("Create page" hung for the whole 90 s test timeout). `before-quit` now
 * holds the quit and runs the shutdown once; the shutdown ends with
 * `app.exit`, which emits no second `before-quit`.
 */

/** Runs `fn` once; later calls get the first call's promise. */
export function once<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  let running: Promise<void> | null = null;
  return (...args: A) => (running ??= fn(...args));
}

/**
 * Asking before typed work is lost (R3.7). The page reports whether it holds
 * typed work, but that report trails the keystroke by a timer and a busy
 * renderer can hold it back, so main's copy saying clean is not enough to end
 * the app: main asks the page once more, briefly (`checkPage`). Main's copy
 * saying dirty needs no second opinion. A page that cannot answer in time does
 * not hold the quit open. The prompt runs before `shutdown`, because `once`
 * latches: Keep editing could not undo a shutdown that had started. SIGINT and
 * SIGTERM stay prompt-free.
 *
 * Two doors: `before-quit` (Cmd+Q, the dock, Playwright's close) and the
 * window's `close` (the red button, Cmd-Shift-W), which never passes through
 * `before-quit`. Clean, a close is issued again and goes on to
 * `window-all-closed`.
 */
export interface QuitEvents {
  on(event: "before-quit", listener: (e: PreventableEvent) => void): unknown;
}

export interface PreventableEvent {
  preventDefault(): void;
}

/** Keep editing comes first, so it is the default on every platform; the destructive choice sits furthest from it. */
export const QUIT_KEEP_BUTTON = 0;
export const QUIT_SAVE_BUTTON = 1;
export const QUIT_DISCARD_BUTTON = 2;

export const QUIT_PROMPT = {
  type: "warning",
  title: "RocketWright",
  message: "Save your edit before quitting?",
  detail: "A field you were editing has not been saved to the project. If you quit without saving, that edit is lost.",
  buttons: ["Keep editing", "Save and quit", "Quit without saving"],
  defaultId: QUIT_KEEP_BUTTON,
  cancelId: QUIT_KEEP_BUTTON,
  noLink: true,
} as const;

export type QuitChoice = "keep" | "save" | "discard";

/** An answer that is none of the buttons (or an aborted box) keeps the edit. */
export function quitChoice(response: number | undefined): QuitChoice {
  if (response === QUIT_SAVE_BUTTON) return "save";
  return response === QUIT_DISCARD_BUTTON ? "discard" : "keep";
}

export const SAVE_FAILED_KEEP_BUTTON = 0;
export const SAVE_FAILED_DISCARD_BUTTON = 1;

const MAX_PROBLEMS_SHOWN = 5;
const MAX_PROBLEM_CHARS = 300;

/** What Save and quit could not save. A native box promises no scrolling, so the list is capped. */
export function quitSaveFailedPrompt(problems: readonly string[]) {
  const shown = problems.slice(0, MAX_PROBLEMS_SHOWN).map((p) => (p.length > MAX_PROBLEM_CHARS ? `${p.slice(0, MAX_PROBLEM_CHARS)}…` : p));
  const more = problems.length - shown.length;
  return {
    type: "warning" as const,
    title: "RocketWright",
    message: "Your edit could not be saved",
    detail: `${shown.join("\n")}${more > 0 ? `\nand ${more} more` : ""}\n\nIf you quit now, that edit is lost.`,
    buttons: ["Keep editing", "Quit without saving"],
    defaultId: SAVE_FAILED_KEEP_BUTTON,
    cancelId: SAVE_FAILED_KEEP_BUTTON,
    noLink: true,
  };
}

export interface QuitGuardDeps {
  isDirty: () => boolean;
  /** Whether the page holds typed work right now: main's copy can be behind the keystroke. */
  checkPage: () => Promise<boolean>;
  /** Closes the window again once a held close has been cleared. */
  closeWindow: () => void;
  /** Asks the person what to do with the edit. */
  ask: () => Promise<QuitChoice>;
  /** The same save Close runs; resolves to what could not be saved, empty when all of it was. */
  flush: () => Promise<string[]>;
  /** Says what could not be saved. True when the person chooses to lose it. */
  confirmSaveFailed: (problems: string[]) => Promise<boolean>;
  /** Ends the app; never resolves into a running one. */
  shutdown: (code: number) => Promise<void>;
  log: (line: string) => void;
}

export interface QuitGuard {
  onWindowClose(e: PreventableEvent): void;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Holds every quit, then shuts down, asking first when the page has typed work. */
export function guardQuit(app: QuitEvents, deps: QuitGuardDeps): QuitGuard {
  let asking = false;
  let checking = false;
  let leaving = false;
  /** Lets through the one close main issues itself after the page said it was clean. */
  let closeCleared = false;

  const leave = (): void => {
    leaving = true;
    void deps.shutdown(0);
  };
  const decide = async (): Promise<void> => {
    const choice = await deps.ask();
    if (choice === "discard") return leave();
    if (choice === "keep") return;
    // A failed save must never read as a saved one: the edit stays unless the person gives it up.
    const problems = await deps.flush().catch((e: unknown) => [errorText(e)]);
    if (problems.length === 0 || (await deps.confirmSaveFailed(problems))) leave();
  };
  const ask = (): void => {
    asking = true;
    decide()
      // Could not ask, so the edit stays: a quit that loses it unasked is the thing being prevented.
      .catch((e: unknown) => deps.log(`quit: cannot show the unsaved edit prompt: ${errorText(e)}`))
      .finally(() => {
        asking = false;
      });
  };

  /** Asks about typed work if there is any, by main's copy or the page's own word; otherwise goes on. */
  const askIfUnsaved = (clean: () => void): void => {
    if (deps.isDirty()) return ask();
    checking = true;
    void deps
      .checkPage()
      .catch(() => false)
      .then((dirty) => {
        checking = false;
        // Main's copy is read again: the page's report may have landed during the wait.
        if (dirty || deps.isDirty()) ask();
        else clean();
      });
  };

  app.on("before-quit", (e) => {
    // Held in every case: only `shutdown` may end the app, and it ends with `app.exit`.
    e.preventDefault();
    if (leaving || asking || checking) return;
    askIfUnsaved(leave);
  });

  return {
    onWindowClose: (e) => {
      if (leaving) return;
      if (closeCleared) {
        closeCleared = false;
        return;
      }
      e.preventDefault();
      if (asking || checking) return;
      askIfUnsaved(() => {
        closeCleared = true;
        deps.closeWindow();
      });
    },
  };
}

/** Long enough for a model write on a busy sidecar; a page that never answers must not hold a quit open. */
export const PAGE_FLUSH_TIMEOUT_MS = 15_000;

export interface PageFlushDeps {
  /** Asks the page to save; false when there is no page to ask. */
  send(id: number): boolean;
}

export interface PageFlush {
  flush(): Promise<string[]>;
  /** The page's answer (`rw-desktop:flush-done`). */
  done(result: { id: number; problems: string[] }): void;
  /** The page crashed or navigated: nothing will answer. */
  pageGone(): void;
}

interface PageRequests<T> {
  request(): Promise<T>;
  done(id: number, answer: T): void;
  pageGone(): void;
}

/** One question to the page at a time per id: asks, then waits for the answer or for `timedOut`. */
function createPageRequests<T>(send: (id: number) => boolean, timeoutMs: number, answers: { timedOut: T; noPage: T; gone: T }): PageRequests<T> {
  let nextId = 1;
  const pending = new Map<number, (answer: T) => void>();
  return {
    request: () =>
      new Promise((resolve) => {
        const id = nextId++;
        const timer = setTimeout(() => finish(answers.timedOut), timeoutMs);
        const finish = (answer: T): void => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(answer);
        };
        pending.set(id, finish);
        if (!send(id)) finish(answers.noPage);
      }),
    done: (id, answer) => pending.get(id)?.(answer),
    pageGone: () => {
      for (const finish of [...pending.values()]) finish(answers.gone);
    },
  };
}

/** Main's half of the page's save: ask, then wait for the answer, its absence reading as a failure. */
export function createPageFlush({ send }: PageFlushDeps): PageFlush {
  const requests = createPageRequests<string[]>(send, PAGE_FLUSH_TIMEOUT_MS, {
    timedOut: ["The save did not finish in time. It may still complete."],
    noPage: ["The window that held the edit is gone."],
    gone: ["The window that held the edit went away."],
  });
  return {
    flush: () => requests.request(),
    done: ({ id, problems }) => requests.done(id, problems),
    pageGone: () => requests.pageGone(),
  };
}

/** Plenty for a page that is merely busy; a wedged one must still let the person quit. */
export const PAGE_DIRTY_CHECK_TIMEOUT_MS = 3_000;

export interface PageDirtyCheck {
  check(): Promise<boolean>;
  /** The page's answer (`rw-desktop:dirty-answer`). */
  done(result: { id: number; dirty: boolean }): void;
  /** The page crashed or navigated: nothing will answer. */
  pageGone(): void;
}

/** Asks the page whether it holds typed work. No answer reads as clean, so a page that cannot reply does not hold a quit open. */
export function createPageDirtyCheck({ send }: PageFlushDeps): PageDirtyCheck {
  const requests = createPageRequests<boolean>(send, PAGE_DIRTY_CHECK_TIMEOUT_MS, { timedOut: false, noPage: false, gone: false });
  return {
    check: () => requests.request(),
    done: ({ id, dirty }) => requests.done(id, dirty),
    pageGone: () => requests.pageGone(),
  };
}
