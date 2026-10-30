import { describe, expect, it } from "vitest";
import { freshCapture, nextRenderFrame } from "./renderFrame.ts";

/** A fake browser: queued animation-frame callbacks and tasks, run by hand. */
function fakeLoop() {
  let frame = 0;
  let rafs: (() => void)[] = [];
  const tasks: (() => void)[] = [];
  return {
    frameId: () => frame,
    raf: (cb: () => void) => rafs.push(cb),
    later: (cb: () => void) => tasks.push(cb),
    /** One display frame: the render loop's callback (bumping the id when `loop`) runs before the probe's. */
    tick(loop = true) {
      if (loop) frame++;
      const now = rafs;
      rafs = [];
      for (const cb of now) cb();
    },
    runTasks() {
      while (tasks.length > 0) tasks.shift()!();
    },
    get pendingRafs() {
      return rafs.length;
    },
  };
}

describe("nextRenderFrame (B7e: probe renders each get their own render-loop frame)", () => {
  it("resolves in a task after the frame id moves, never in the same frame", async () => {
    const l = fakeLoop();
    let done = false;
    void nextRenderFrame(l.frameId, l.raf, l.later).then(() => (done = true));
    l.runTasks();
    await Promise.resolve();
    expect(done).toBe(false);
    l.tick();
    // The id moved, but the resolve waits for a task of its own.
    await Promise.resolve();
    expect(done).toBe(false);
    l.runTasks();
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it("keeps waiting while frames pass without a render-loop frame (the id unchanged)", async () => {
    const l = fakeLoop();
    let done = false;
    void nextRenderFrame(l.frameId, l.raf, l.later).then(() => (done = true));
    for (let i = 0; i < 5; i++) l.tick(false);
    l.runTasks();
    await Promise.resolve();
    expect(done).toBe(false);
    expect(l.pendingRafs).toBe(1);
    l.tick();
    l.runTasks();
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it("two probe renders in a row land in two different frames", async () => {
    const l = fakeLoop();
    const seen: number[] = [];
    const run = (async () => {
      await nextRenderFrame(l.frameId, l.raf, l.later);
      seen.push(l.frameId());
      await nextRenderFrame(l.frameId, l.raf, l.later);
      seen.push(l.frameId());
    })();
    for (let i = 0; i < 4; i++) {
      l.tick();
      l.runTasks();
      await new Promise((r) => setTimeout(r, 0));
    }
    await run;
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThan(seen[0]!);
  });

  it("fails loudly when no render loop runs", async () => {
    const l = fakeLoop();
    const p = nextRenderFrame(l.frameId, l.raf, l.later, 3);
    for (let i = 0; i < 5; i++) l.tick(false);
    await expect(p).rejects.toThrow(/started no frame in 3 animation frames/);
  });
});

/**
 * three's pass reuse in miniature: the first render in a frame draws the
 * passes with the camera of that moment; later renders in the same frame
 * reuse them. The render loop draws when the camera moved.
 */
function fakeRenderer(l: ReturnType<typeof fakeLoop>) {
  const r = {
    camera: "A",
    passFrame: -1,
    passCamera: "",
    render() {
      if (r.passFrame !== l.frameId()) {
        r.passFrame = l.frameId();
        r.passCamera = r.camera;
      }
      return r.passCamera;
    },
  };
  return r;
}

describe("freshCapture (CPW1R5A: viewport_render right after viewport_set_camera)", () => {
  it("a capture in the frame the camera moved in returns the old camera; freshCapture waits for a frame drawn with the new one", async () => {
    const l = fakeLoop();
    const r = fakeRenderer(l);
    l.tick();
    r.render(); // the loop's frame, camera A
    r.camera = "B"; // viewport_set_camera, same frame
    expect(r.render()).toBe("A"); // the old synchronous capture
    let shot: string | null = null;
    void freshCapture(l.frameId, () => r.render(), { raf: l.raf, later: l.later, timer: () => undefined }).then((s) => (shot = s));
    l.runTasks();
    await Promise.resolve();
    expect(shot).toBeNull();
    l.tick();
    r.render(); // the loop redraws the moved camera
    l.runTasks();
    await new Promise((res) => setTimeout(res, 0));
    expect(shot).toBe("B");
  });

  it("the first render of the new frame may be the capture's own: still the current camera", async () => {
    const l = fakeLoop();
    const r = fakeRenderer(l);
    l.tick();
    r.render();
    r.camera = "C";
    const p = freshCapture(l.frameId, () => r.render(), { raf: l.raf, later: l.later, timer: () => undefined });
    l.tick(); // no loop render this frame
    l.runTasks();
    expect(await p).toBe("C");
  });

  it("captures after the timeout when no render loop runs, instead of hanging", async () => {
    const l = fakeLoop();
    let fire: (() => void) | null = null;
    const p = freshCapture(l.frameId, () => "shot", { raf: l.raf, later: l.later, timer: (cb) => (fire = cb), timeoutMs: 50 });
    for (let i = 0; i < 3; i++) l.tick(false);
    expect(fire).not.toBeNull();
    fire!();
    expect(await p).toBe("shot");
  });
});
