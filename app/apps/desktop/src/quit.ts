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
 * Asking before typed work is lost (R3.7). Main keeps the page's last answer
 * rather than asking at quit, so a quit does not wait on the page. The prompt
 * runs before `shutdown`, because `once` latches: Keep editing could not
 * undo a shutdown that had started. SIGINT and SIGTERM stay prompt-free.
 *
 * Two doors: `before-quit` (Cmd+Q, the dock, Playwright's close) and the
 * window's `close` (the red button, Cmd-Shift-W), which never passes through
 * `before-quit`. Clean, a close just goes on to `window-all-closed`.
 */
export interface QuitEvents {
  on(event: "before-quit", listener: (e: PreventableEvent) => void): unknown;
}

export interface PreventableEvent {
  preventDefault(): void;
}

/** Keep editing comes first, so it is the default on every platform. */
export const QUIT_KEEP_BUTTON = 0;
export const QUIT_DISCARD_BUTTON = 1;

export const QUIT_PROMPT = {
  type: "warning",
  title: "RocketWright",
  message: "Quit without saving your edit?",
  detail: "A field you were editing has not been saved to the project. If you quit now, that edit is lost.",
  buttons: ["Keep editing", "Quit without saving"],
  defaultId: QUIT_KEEP_BUTTON,
  cancelId: QUIT_KEEP_BUTTON,
  noLink: true,
} as const;

export interface QuitGuardDeps {
  isDirty: () => boolean;
  /** Asks the person. True when they choose to lose the edit. */
  confirmDiscard: () => Promise<boolean>;
  /** Ends the app; never resolves into a running one. */
  shutdown: (code: number) => Promise<void>;
  log: (line: string) => void;
}

export interface QuitGuard {
  onWindowClose(e: PreventableEvent): void;
}

/** Holds every quit, then shuts down, asking first when the page has typed work. */
export function guardQuit(app: QuitEvents, deps: QuitGuardDeps): QuitGuard {
  let asking = false;
  let leaving = false;

  const leave = (): void => {
    leaving = true;
    void deps.shutdown(0);
  };
  const ask = (): void => {
    asking = true;
    deps.confirmDiscard().then(
      (discard) => {
        asking = false;
        if (discard) leave();
      },
      (e: unknown) => {
        // Could not ask, so the edit stays: a quit that loses it unasked is the thing being prevented.
        asking = false;
        deps.log(`quit: cannot show the unsaved edit prompt: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  };

  app.on("before-quit", (e) => {
    // Held in every case: only `shutdown` may end the app, and it ends with `app.exit`.
    e.preventDefault();
    if (leaving || asking) return;
    if (deps.isDirty()) ask();
    else leave();
  });

  return {
    onWindowClose: (e) => {
      if (leaving) return;
      if (asking) {
        e.preventDefault();
        return;
      }
      if (!deps.isDirty()) return;
      e.preventDefault();
      ask();
    },
  };
}
