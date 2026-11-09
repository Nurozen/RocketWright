/**
 * The header's project menu as data (R0.6, mockup 03): the open projects with
 * the shown one checked, Recent, then the project commands, every label from
 * the one command table.
 */
import { createElement } from "react";
import type { DesktopCommand, RecentProject } from "@rw/contracts";
import type { MenuEntry } from "../ui/Menu.tsx";
import { commandLabel } from "./commands.ts";
import { Icon } from "./Icon.tsx";
import type { ProjectMenuModel, ShellProject } from "./model.ts";
import { RECENT_STATUS_TEXT } from "./projectActions.ts";

/** A long Recent belongs on Welcome; the menu has to fit under the header. */
const MAX_MENU_RECENTS = 8;

const ACTIONS = ["project.new", "project.open", "project.openSample", "file.import", "file.export", "project.rename", "project.close"] as const;

function recentEntries(recent: RecentProject, onCommand: (c: DesktopCommand) => void, onRemove: (dir: string) => void): MenuEntry[] {
  const missing = recent.status === "missing";
  const row: MenuEntry = {
    id: `recent:${recent.dir}`,
    label: recent.name,
    hint: RECENT_STATUS_TEXT[recent.status],
    disabled: missing,
    onSelect: () => onCommand({ id: "project.openRecent", dir: recent.dir }),
  };
  if (!missing) return [row];
  // Short and quiet, so it reads as an action on the row above rather than a project of its own; the name says which.
  const remove: MenuEntry = {
    id: `remove:${recent.dir}`,
    label: "Remove",
    accessibleName: `Remove ${recent.name} from Recent`,
    quiet: true,
    gutter: false,
    icon: createElement(Icon, { name: "close", size: 14 }),
    onSelect: () => onRemove(recent.dir),
  };
  return [row, remove];
}

export interface ProjectMenuInput {
  projects: readonly ShellProject[];
  projectId: string | null;
  projectName: string;
  menu: ProjectMenuModel | undefined;
  onSwitch: (projectId: string) => void;
}

export function projectMenuEntries({ projects, projectId, projectName, menu, onSwitch }: ProjectMenuInput): MenuEntry[] {
  // The shown project comes first and carries the live name: the list is only as new as the last time the menu opened.
  const others = projects.filter((p) => p.id !== projectId);
  const open = projectId === null ? others : [{ id: projectId, name: projectName }, ...others];
  const entries: MenuEntry[] = open.map((p) => ({
    id: `project:${p.id}`,
    label: p.name,
    checked: p.id === projectId,
    onSelect: () => {
      if (p.id !== projectId) onSwitch(p.id);
    },
  }));
  if (open.length === 0) entries.push({ kind: "heading", id: "none", label: "No other projects open" });
  if (menu === undefined) return entries;

  const errors: MenuEntry[] = menu.errors.map((text, i) => ({ kind: "heading", id: `error:${i}`, label: text }));
  // Open projects are the list above; Recent is for reaching the others.
  const recents = menu.recents.filter((r) => r.open !== true).slice(0, MAX_MENU_RECENTS).flatMap((r) => recentEntries(r, menu.onCommand, menu.onRemoveRecent));
  const middle = recents.length > 0 ? [{ kind: "heading", id: "recent", label: commandLabel("project.openRecent") } as const, ...recents] : [];
  const section = [...errors, ...middle];
  return [
    ...entries,
    { kind: "divider", id: "divider-open" },
    ...(section.length > 0 ? [...section, { kind: "divider", id: "divider-recent" } as const] : []),
    ...ACTIONS.map((id): MenuEntry => ({ id, label: commandLabel(id), gutter: false, onSelect: () => menu.onCommand({ id }) })),
  ];
}
