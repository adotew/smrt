import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent } from "react";
import Icon, { type IconName } from "./Icon.tsx";

export type MenuItem = { id: string; label: string; icon?: IconName } | { type: "separator" };

let menu: { items: MenuItem[]; x: number; y: number; resolve: (id: string | null) => void } | null = null;
const listeners = new Set<() => void>();
const setMenu = (next: typeof menu) => {
  menu = next;
  for (const listener of listeners) listener();
};
let pointer = { x: 0, y: 0 };
window.addEventListener("pointerdown", (event) => (pointer = { x: event.clientX, y: event.clientY }), true);

/** Shows a menu at the last pointer position; resolves with the chosen item's id, or null if dismissed. */
export function contextMenu(items: MenuItem[]) {
  menu?.resolve(null);
  return new Promise<string | null>((resolve) => setMenu({ items, ...pointer, resolve }));
}

export default function ContextMenu() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => menu,
  );
  const element = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  function close(id: string | null) {
    menu?.resolve(id);
    setMenu(null);
    restoreFocus.current?.focus();
  }

  useEffect(() => {
    if (!current) return;
    const dismiss = () => close(null);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, [current]);

  // Keeps the menu inside the window, flipping it to the pointer's other side like native menus.
  useLayoutEffect(() => {
    const node = element.current;
    if (!current || !node) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    const { width, height } = node.getBoundingClientRect();
    const { x, y } = current;
    node.style.left = `${Math.max(4, x + width > innerWidth ? x - width : x)}px`;
    node.style.top = `${Math.max(4, y + height > innerHeight ? y - height : y)}px`;
    node.focus();
  }, [current]);

  function onKeyDown(event: KeyboardEvent) {
    const buttons = [...element.current!.querySelectorAll("button")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") close(null);
    else if (event.key === "ArrowDown") buttons[(index + 1) % buttons.length].focus();
    else if (event.key === "ArrowUp") buttons.at(Math.max(index, 0) - 1)?.focus();
    else return;
    event.preventDefault();
  }

  if (!current) return null;
  return (
    <>
      <div
        className="context-menu-backdrop"
        role="presentation"
        onPointerDown={() => close(null)}
        onContextMenu={(event) => event.preventDefault()}
      ></div>
      <div className="context-menu" role="menu" tabIndex={-1} ref={element} onKeyDown={onKeyDown}>
        {current.items.map((item, index) =>
          "type" in item ? (
            <hr key={index} />
          ) : (
            <button
              key={index}
              role="menuitem"
              tabIndex={-1}
              onClick={() => close(item.id)}
              onPointerEnter={(e) => e.currentTarget.focus()}
            >
              {item.icon && <Icon name={item.icon} size={14} />}
              {item.label}
            </button>
          ),
        )}
      </div>
    </>
  );
}
