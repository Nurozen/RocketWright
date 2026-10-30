/**
 * The window event that puts a part into the agent's composer: the
 * viewport's `@` (and other "ask about this" actions) dispatch it on
 * `window` with a `Mention` (`{ref, label}`) as its detail, and the pane
 * wiring (`wiring.ts`) sends it to the embed as `lecturn/composer.insertMention`
 * (a removable chip in the strip above Lecturn's composer input).
 */
export const MENTION_EVENT = "rw:mention";
