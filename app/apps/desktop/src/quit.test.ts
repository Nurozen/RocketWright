import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { once, shutdownOnQuit } from "./quit.ts";

describe("quitting without orphans (quit.ts)", () => {
  it("app.quit() holds the quit and runs the graceful shutdown once, however often it is asked", async () => {
    const app = new EventEmitter();
    const codes: number[] = [];
    let release!: () => void;
    const shutdown = once(async (code: number) => {
      codes.push(code);
      await new Promise<void>((r) => (release = r));
    });
    shutdownOnQuit(app as never, shutdown);
    const quit = () => {
      let prevented = false;
      app.emit("before-quit", { preventDefault: () => (prevented = true) });
      return prevented;
    };
    expect(quit()).toBe(true);
    // A second Cmd+Q while the server stops: still held, no second shutdown.
    expect(quit()).toBe(true);
    expect(codes).toEqual([0]);
    release();
    // window-all-closed after the quit shares the same shutdown.
    await shutdown(0);
    expect(codes).toEqual([0]);
  });

  it("once() hands every caller the first call's promise", async () => {
    let n = 0;
    const f = once(async () => void n++);
    await Promise.all([f(), f(), f()]);
    expect(n).toBe(1);
  });
});
