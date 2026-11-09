/**
 * The page's side of the app command table (`APP_COMMANDS`, seam 6). Each
 * entry's behaviour lives with whoever owns the state it acts on, and
 * registers through `CommandHandlers`.
 */
import type { DesktopCommand, DesktopCommandId } from "@rw/contracts";

export { APP_COMMANDS, commandLabel, type AppCommand } from "@rw/contracts";

export type CommandHandlers = { [Id in DesktopCommandId]?: (command: Extract<DesktopCommand, { id: Id }>) => void };

/** Runs `command`'s handler. False when nothing handles it yet, so a caller can leave it to a later owner. */
export function dispatchCommand(command: DesktopCommand, handlers: CommandHandlers): boolean {
  const handler = handlers[command.id] as ((c: DesktopCommand) => void) | undefined;
  if (handler === undefined) return false;
  handler(command);
  return true;
}
