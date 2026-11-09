/** B2-a's fixture facts (U40), free of Playwright so `__tests__` can load them. */
export const PROJECT_NEW_FIXTURE = "project-new";
/** Run ordinals in `fixtures/scripted/project-new.json`. */
export const WITH_REQUEST = "1";
export const BARE = "2";

/** Lecturn `scriptedScript.ts` FENCE: the last block in the text wins, and a newline must follow the opening fence. */
const FENCE = /```scripted[^\S\n]*\r?\n([\s\S]*?)```/gu;

/** The script a fenced `request` carries, parsed; throws without a block. */
export function fencedScript(text: string): unknown {
  const blocks = [...text.matchAll(FENCE)];
  const last = blocks.at(-1);
  if (last === undefined) throw new Error("no fenced scripted block in the text");
  return JSON.parse(last[1]!) as unknown;
}
