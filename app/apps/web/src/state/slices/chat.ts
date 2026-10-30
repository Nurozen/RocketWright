/** `chat`: the agent pane's app-side state, the project's Lecturn threads and the one the embed shows (B12). */
import { mappedThread, type EmbedThread, type LecturnStatus } from "@rw/contracts";
import { activeRailKey } from "../../embed/threads.ts";
import type { ChatSlice, LecturnThreads, SliceCtx } from "../types.ts";

/** No Lecturn list yet, nothing shown. */
export const EMPTY_LECTURN: LecturnThreads = { embedded: false, threads: null, activeThreadId: null, activeKey: null };

export function createChatSlice(ctx: SliceCtx): ChatSlice {
  return {
    lecturn: EMPTY_LECTURN,

    setEmbedded(on: boolean): void {
      if (ctx.get().chat.lecturn.embedded !== on) ctx.patch("chat", (c) => ({ lecturn: { ...c.lecturn, embedded: on } }));
    },

    setLecturnThread(threadId: string | null): void {
      ctx.patch("chat", (c) => {
        const l = c.lecturn;
        if (l.activeThreadId === threadId && (threadId === null || l.activeKey !== null)) return {};
        return { lecturn: { ...l, activeThreadId: threadId, activeKey: activeRailKey(l.threads, threadId, l.activeThreadId === threadId ? l.activeKey : null) } };
      });
    },
  };
}

/** An `embed.threads` push for the connected project: the whole list, and the active thread's key once it is in it. */
export function onEmbedThreads(ctx: SliceCtx, threads: readonly EmbedThread[]): void {
  ctx.patch("chat", (c) => {
    const list = threads.map((t) => ({ ...t }));
    return { lecturn: { ...c.lecturn, threads: list, activeKey: activeRailKey(list, c.lecturn.activeThreadId, c.lecturn.activeKey) } };
  });
}

/**
 * A live switch (D25, `lecturn.status` with `switched`): the shown thread
 * takes its id on the new server; its rail key stays until the new list
 * names it (a copy keys to its source, so it is the same entry).
 */
export function onLecturnSwitch(ctx: SliceCtx, status: LecturnStatus): void {
  const sw = status.switched;
  if (sw === undefined) return;
  ctx.patch("chat", (c) => {
    const l = c.lecturn;
    const mapped = mappedThread(l.activeThreadId, sw.threadIdMap);
    if (mapped === undefined || mapped === l.activeThreadId) return {};
    return { lecturn: { ...l, activeThreadId: mapped, activeKey: activeRailKey(l.threads, mapped, l.activeKey) } };
  });
}
