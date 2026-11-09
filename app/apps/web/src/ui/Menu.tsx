/**
 * Menus anchored to a trigger or a pointer position, with submenus, danger
 * items, dividers and headings. Every list is `role="menu"`, so the desktop app
 * takes the agent pane out of the way when one overlaps it.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../shell/Icon.tsx";
import { OVERLAY_EVENTS, useAnchoredPosition, type Anchor, type PlacementAlign } from "./Popover.tsx";
import { useDismiss, useFocusScope } from "./useDismiss.tsx";
import "./ui.css";

export interface MenuItem {
  kind?: "item";
  id: string;
  label: string;
  disabled?: boolean | undefined;
  /** Present (true or false) makes this a checkable item. */
  checked?: boolean | undefined;
  /** False keeps this row out of the check column of a list that has one (actions under a list of choices). */
  gutter?: false | undefined;
  /** Destructive action, drawn in the danger colour. */
  danger?: boolean | undefined;
  icon?: ReactNode;
  /** Right-aligned hint, such as a shortcut. */
  hint?: string | undefined;
  onSelect?: (() => void) | undefined;
  /** Entries of a nested menu; the item then opens it instead of selecting. */
  submenu?: readonly MenuEntry[] | undefined;
}

export interface MenuDivider {
  kind: "divider";
  id: string;
}

export interface MenuHeading {
  kind: "heading";
  id: string;
  label: string;
}

export type MenuEntry = MenuItem | MenuDivider | MenuHeading;

const isItem = (e: MenuEntry): e is MenuItem => e.kind === undefined || e.kind === "item";

const enabledItems = (list: HTMLElement): HTMLElement[] => [...list.querySelectorAll<HTMLElement>(":scope > li > button:not(:disabled)")];

function moveFocus(list: HTMLElement, to: "next" | "prev" | "first" | "last"): void {
  const items = enabledItems(list);
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const index = to === "first" ? 0 : to === "last" ? items.length - 1 : to === "next" ? (at + 1) % items.length : at <= 0 ? items.length - 1 : at - 1;
  items[index]?.focus();
}

interface MenuListProps {
  entries: readonly MenuEntry[];
  label: string;
  testId?: string | undefined;
  listRef: RefObject<HTMLUListElement | null>;
  /** Closes the whole menu. */
  close: () => void;
  /** Closes just this submenu; absent on the root list. */
  back?: (() => void) | undefined;
}

function MenuList({ entries, label, testId, listRef, close, back }: MenuListProps) {
  const [sub, setSub] = useState<{ id: string; focus: boolean } | null>(null);
  const checkable = entries.some((e) => isItem(e) && e.checked !== undefined);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLUListElement>): void => {
    if (e.defaultPrevented) return; // a submenu inside this list already handled it
    const list = e.currentTarget;
    const move = ({ ArrowDown: "next", ArrowUp: "prev", Home: "first", End: "last" } as const)[e.key as "ArrowDown"];
    if (move !== undefined) {
      e.preventDefault();
      moveFocus(list, move);
    } else if (e.key === "ArrowRight") {
      const id = (e.target as HTMLElement).closest("[data-item]")?.getAttribute("data-item");
      if (entries.some((en) => isItem(en) && en.id === id && en.submenu !== undefined)) {
        e.preventDefault();
        setSub({ id: id as string, focus: true });
      }
    } else if ((e.key === "ArrowLeft" || e.key === "Escape") && back !== undefined) {
      e.preventDefault();
      back();
    } else if (e.key === "Tab") {
      e.preventDefault();
      close();
    }
  };
  return (
    <ul ref={listRef} className="rw-ui-menu rw-list" role="menu" aria-label={label} tabIndex={-1} data-testid={testId === undefined ? undefined : `${testId}.list`} onKeyDown={onKeyDown}>
      {entries.map((entry) => {
        if (entry.kind === "divider") return <li key={entry.id} role="separator" className="rw-ui-menu__divider" />;
        if (entry.kind === "heading") {
          return (
            <li key={entry.id} role="none" className="rw-ui-menu__heading">
              {entry.label}
            </li>
          );
        }
        const open = sub?.id === entry.id;
        const nested = entry.submenu !== undefined && entry.disabled !== true;
        return (
          <li key={entry.id} role="none" onMouseEnter={() => setSub(nested ? { id: entry.id, focus: false } : null)}>
            <button
              type="button"
              role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={entry.checked}
              aria-haspopup={entry.submenu === undefined ? undefined : "menu"}
              aria-expanded={entry.submenu === undefined ? undefined : open}
              disabled={entry.disabled}
              data-danger={entry.danger === true ? "true" : undefined}
              data-testid={testId === undefined ? undefined : `${testId}.item`}
              data-item={entry.id}
              onClick={() => {
                if (entry.submenu !== undefined) {
                  setSub(open ? null : { id: entry.id, focus: false });
                  return;
                }
                close();
                entry.onSelect?.();
              }}
            >
              {checkable && entry.gutter !== false && (
                <span className="rw-ui-menu__check" aria-hidden>
                  {entry.checked === true ? <Icon name="check" size={16} /> : null}
                </span>
              )}
              {entry.icon !== undefined && (
                <span className="rw-ui-menu__icon" aria-hidden>
                  {entry.icon}
                </span>
              )}
              <span className="rw-ui-menu__label">{entry.label}</span>
              {entry.hint !== undefined && <span className="rw-ui-menu__hint">{entry.hint}</span>}
              {entry.submenu !== undefined && <Icon name="chevron-right" size={16} className="rw-ui-menu__more" />}
            </button>
            {open && nested && (
              <Submenu
                entries={entry.submenu as readonly MenuEntry[]}
                label={entry.label}
                testId={testId === undefined ? undefined : `${testId}.${entry.id}`}
                focus={sub.focus}
                close={close}
                back={(trigger) => {
                  setSub(null);
                  trigger?.focus();
                }}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Submenu({ entries, label, testId, focus, close, back }: { entries: readonly MenuEntry[]; label: string; testId: string | undefined; focus: boolean; close: () => void; back: (trigger: HTMLElement | null) => void }) {
  const listRef = useRef<HTMLUListElement>(null);
  const trigger = (): HTMLElement | null => listRef.current?.previousElementSibling as HTMLElement | null;
  useAnchoredPosition(listRef, trigger, { side: "right", gap: 2, margin: 8 });
  useEffect(() => {
    if (focus && listRef.current !== null) moveFocus(listRef.current, "first");
  }, [focus]);
  return <MenuList entries={entries} label={label} testId={testId} listRef={listRef} close={close} back={() => back(trigger())} />;
}

export interface MenuProps {
  open: boolean;
  /** The trigger element, or a pointer position for a context menu. */
  anchor: Anchor | null;
  onClose: () => void;
  items: readonly MenuEntry[];
  /** Accessible name of the menu. */
  label: string;
  align?: PlacementAlign | undefined;
  testId?: string | undefined;
}

function MenuSurface({ anchor, onClose, items, label, align, testId }: Omit<MenuProps, "open">) {
  const listRef = useRef<HTMLUListElement>(null);
  useDismiss({ open: true, surfaceRef: listRef, onDismiss: onClose, ignore: () => (anchor instanceof HTMLElement ? [anchor] : []) });
  useFocusScope(true, listRef);
  useAnchoredPosition(listRef, () => anchor, { side: "bottom", align });
  return createPortal(
    <div className="rw-ui-menu-root" {...OVERLAY_EVENTS}>
      <MenuList entries={items} label={label} testId={testId} listRef={listRef} close={onClose} />
    </div>,
    document.body,
  );
}

export function Menu({ open, ...rest }: MenuProps) {
  return open ? <MenuSurface {...rest} /> : null;
}

/** A button that opens a menu below it; closes on a pick, Escape, or an outside press. */
export function MenuButton({
  testId,
  label,
  className = "rw-button",
  items,
  children,
  align = "left",
}: {
  testId: string;
  label: string;
  className?: string;
  items: readonly MenuEntry[];
  children: ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <div className="rw-menu-button">
      <button ref={button} type="button" className={className} data-testid={testId} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {children}
      </button>
      <Menu open={open} anchor={button.current} onClose={() => setOpen(false)} items={items} label={label} align={align === "right" ? "end" : "start"} testId={testId} />
    </div>
  );
}
