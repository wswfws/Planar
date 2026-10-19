import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  shortcut?: string;
  action?: () => void;
  disabled?: boolean;
  danger?: boolean;
  submenu?: MenuEntry[];
  /** Extra line shown under the label. */
  hint?: string;
}

export type MenuEntry = MenuItem | '-';

interface OpenMenu {
  x: number;
  y: number;
  items: MenuEntry[];
}

const MenuContext = createContext<(x: number, y: number, items: MenuEntry[]) => void>(() => {});

export function useContextMenu() {
  return useContext(MenuContext);
}

/** Removes leading/trailing/double separators left by conditional items. */
export function tidy(entries: (MenuEntry | false | null | undefined)[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (e === '-' && (!out.length || out[out.length - 1] === '-')) continue;
    out.push(e);
  }
  while (out[out.length - 1] === '-') out.pop();
  return out;
}

function MenuList({
  items,
  x,
  y,
  onClose,
  autoFocus,
  onExitLeft,
}: {
  items: MenuEntry[];
  x: number;
  y: number;
  onClose: () => void;
  autoFocus: boolean;
  onExitLeft?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [active, setActive] = useState(-1);
  const [openSub, setOpenSub] = useState<{ index: number; x: number; y: number; focus: boolean } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = x + r.width > window.innerWidth - 4 ? Math.max(4, window.innerWidth - r.width - 4) : x;
    const ny = y + r.height > window.innerHeight - 4 ? Math.max(4, window.innerHeight - r.height - 4) : y;
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const enabled = items.map((it, i) => (it !== '-' && !it.disabled ? i : -1)).filter((i) => i >= 0);

  const openSubmenu = (index: number, focus: boolean) => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const right = r.right + 2;
    setOpenSub({ index, x: right + 200 > window.innerWidth ? r.left - 202 : right, y: r.top - 4, focus });
  };

  const activate = (i: number) => {
    const it = items[i];
    if (it === '-' || it.disabled) return;
    if (it.submenu) {
      openSubmenu(i, true);
      return;
    }
    onClose();
    it.action?.();
  };

  return (
    <>
      <div
        ref={ref}
        className="context-menu"
        role="menu"
        tabIndex={-1}
        style={{ left: pos.x, top: pos.y }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (openSub?.focus) return;
          e.stopPropagation();
          const at = enabled.indexOf(active);
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive(enabled[(at + 1) % enabled.length] ?? -1);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive(enabled[(at - 1 + enabled.length) % enabled.length] ?? -1);
          } else if (e.key === 'ArrowRight' && active >= 0) {
            const it = items[active];
            if (it !== '-' && it.submenu) openSubmenu(active, true);
          } else if (e.key === 'ArrowLeft' && onExitLeft) {
            onExitLeft();
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (active >= 0) activate(active);
          } else if (e.key === 'Escape') {
            if (onExitLeft) onExitLeft();
            else onClose();
          }
        }}
      >
        {items.map((it, i) =>
          it === '-' ? (
            <div key={`sep-${i}`} className="menu-separator" role="separator" />
          ) : (
            <button
              key={`${it.label}-${i}`}
              type="button"
              role="menuitem"
              data-index={i}
              aria-haspopup={it.submenu ? 'menu' : undefined}
              aria-expanded={it.submenu ? openSub?.index === i : undefined}
              className={`${i === active ? 'active' : ''}${it.danger ? ' danger' : ''}`}
              disabled={it.disabled}
              onPointerEnter={() => {
                setActive(i);
                if (hoverTimer.current) clearTimeout(hoverTimer.current);
                hoverTimer.current = setTimeout(() => {
                  if (it.submenu && !it.disabled) openSubmenu(i, false);
                  else setOpenSub(null);
                }, it.submenu ? 80 : 160);
              }}
              onClick={() => activate(i)}
            >
              <span className="menu-label">
                {it.label}
                {it.hint && <small>{it.hint}</small>}
              </span>
              {it.shortcut && <kbd>{it.shortcut}</kbd>}
              {it.submenu && <span className="menu-arrow">›</span>}
            </button>
          ),
        )}
      </div>
      {openSub && (() => {
        const parent = items[openSub.index];
        if (parent === '-' || !parent.submenu) return null;
        return (
          <MenuList
            key={openSub.index}
            items={parent.submenu}
            x={openSub.x}
            y={openSub.y}
            onClose={onClose}
            autoFocus={openSub.focus}
            onExitLeft={() => {
              setOpenSub(null);
              ref.current?.focus();
            }}
          />
        );
      })()}
    </>
  );
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<OpenMenu | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof PointerEvent && (e.target as HTMLElement)?.closest?.('.context-menu')) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('wheel', close, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('wheel', close, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  return (
    <MenuContext.Provider value={(x, y, items) => setMenu(items.length ? { x, y, items } : null)}>
      {children}
      {menu && (
        <div className="context-menu-layer">
          <MenuList key={`${menu.x},${menu.y}`} items={menu.items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} autoFocus />
        </div>
      )}
    </MenuContext.Provider>
  );
}
