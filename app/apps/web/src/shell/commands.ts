/**
 * The page's side of the app command table (`APP_COMMANDS`, seam 6). Each
 * entry's behaviour lives with whoever owns the state it acts on, and
 * registers through `CommandHandlers`.
 */
import type { DesktopCommand, DesktopCommandId } from "@rw/contracts";

import { APP_COMMANDS } from "@rw/contracts";

export { APP_COMMANDS, commandLabel, type AppCommand } from "@rw/contracts";

export type CommandHandlers = { [Id in DesktopCommandId]?: (command: Extract<DesktopCommand, { id: Id }>) => void };

/** Runs `command`'s handler. False when nothing handles it yet, so a caller can leave it to a later owner. */
export function dispatchCommand(command: DesktopCommand, handlers: CommandHandlers): boolean {
  const handler = handlers[command.id] as ((c: DesktopCommand) => void) | undefined;
  if (handler === undefined) return false;
  handler(command);
  return true;
}

const BROWSER_SHORTCUTS: readonly { key: string; command: DesktopCommand }[] = APP_COMMANDS.flatMap((c) =>
  c.browser === true && c.accelerator !== undefined ? [{ key: c.accelerator.split("+").at(-1)!.toLowerCase(), command: { id: c.id } as DesktopCommand }] : [],
);

/**
 * What a key means in a plain browser tab, which has no native menu (R0.12).
 * Only keys flagged `browser` in the table: Cmd-N, Cmd-W and the like are the
 * browser's, a page cannot take them, so they are dropped here rather than
 * half-working. Text fields are not excluded: none of these keys edit text.
 */
export function browserShortcut(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): DesktopCommand | null {
  if (e.altKey || e.shiftKey || !(e.metaKey || e.ctrlKey)) return null;
  const key = e.key.toLowerCase();
  return BROWSER_SHORTCUTS.find((s) => s.key === key)?.command ?? null;
}
