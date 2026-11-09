/**
 * The one table of app commands (seam 6): the native menu, the header menus
 * and the shortcuts all read it, so a command cannot exist in one and be
 * missing from another. Each entry's behaviour lives with whoever owns the
 * state it acts on, and registers through `CommandHandlers`.
 */
import type { DesktopCommand, DesktopCommandId } from "@rw/contracts";

export interface AppCommand {
  id: DesktopCommandId;
  label: string;
  menu: "File" | "Edit" | "View" | "Help" | "App";
}

export const APP_COMMANDS: readonly AppCommand[] = [
  { id: "project.new", label: "New project…", menu: "File" },
  { id: "project.open", label: "Open folder…", menu: "File" },
  { id: "project.openSample", label: "Open sample rocket", menu: "File" },
  { id: "project.openRecent", label: "Recent", menu: "File" },
  { id: "project.close", label: "Close project", menu: "File" },
  { id: "project.rename", label: "Rename project…", menu: "File" },
  { id: "file.import", label: "Import…", menu: "File" },
  { id: "file.export", label: "Export…", menu: "File" },
  { id: "edit.undo", label: "Undo", menu: "Edit" },
  { id: "edit.redo", label: "Redo", menu: "Edit" },
  { id: "view.tab", label: "Tab", menu: "View" },
  { id: "help.quickStart", label: "Quick start", menu: "Help" },
  { id: "app.settings", label: "Settings…", menu: "App" },
];

export type CommandHandlers = { [Id in DesktopCommandId]?: (command: Extract<DesktopCommand, { id: Id }>) => void };

/** Runs `command`'s handler. False when nothing handles it yet, so a caller can leave it to a later owner. */
export function dispatchCommand(command: DesktopCommand, handlers: CommandHandlers): boolean {
  const handler = handlers[command.id] as ((c: DesktopCommand) => void) | undefined;
  if (handler === undefined) return false;
  handler(command);
  return true;
}
