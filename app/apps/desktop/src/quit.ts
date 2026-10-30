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

export interface QuitEvents {
  on(event: "before-quit", listener: (e: { preventDefault(): void }) => void): unknown;
}

/** Holds the first quit and runs `shutdown(0)` instead (it exits the app); a quit during the shutdown is held too. */
export function shutdownOnQuit(app: QuitEvents, shutdown: (code: number) => Promise<void>): void {
  app.on("before-quit", (e) => {
    e.preventDefault();
    void shutdown(0);
  });
}
