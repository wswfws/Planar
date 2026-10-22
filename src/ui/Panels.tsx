// Side panels: width (dragged at their inner edge) and visibility, remembered
// per browser.

import { useRef, useSyncExternalStore, type ReactNode } from 'react';

export type Side = 'left' | 'right';

interface PanelState {
  width: number;
  open: boolean;
}

export const PANEL_DEFAULT = 248;
const MIN = 180;
const MAX = 560;
const KEY = 'planar.panels';

function load(): Record<Side, PanelState> {
  const fallback = { left: { width: PANEL_DEFAULT, open: true }, right: { width: PANEL_DEFAULT, open: true } };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!saved) return fallback;
    const clean = (p: Partial<PanelState> | undefined): PanelState => ({
      width: Math.max(MIN, Math.min(MAX, Number(p?.width) || PANEL_DEFAULT)),
      open: p?.open !== false,
    });
    return { left: clean(saved.left), right: clean(saved.right) };
  } catch {
    return fallback;
  }
}

let state = load();
const listeners = new Set<() => void>();

function set(next: Record<Side, PanelState>): void {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Only a convenience.
  }
  listeners.forEach((fn) => fn());
}

export function setPanel(side: Side, patch: Partial<PanelState>): void {
  set({ ...state, [side]: { ...state[side], ...patch } });
}

export function togglePanel(side: Side): void {
  setPanel(side, { open: !state[side].open });
}

/** Hides both panels, or shows both when either is hidden. */
export function toggleAllPanels(): void {
  const open = !(state.left.open && state.right.open);
  set({ left: { ...state.left, open }, right: { ...state.right, open } });
}

export function usePanels(): Record<Side, PanelState> {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}

/** A side panel with a drag handle on its inner edge; nothing when hidden. */
export function Dock({ side, children }: { side: Side; children: ReactNode }) {
  const panel = usePanels()[side];
  const drag = useRef<{ x: number; width: number } | null>(null);
  if (!panel.open) return null;
  return (
    <div className={`dock ${side}`} style={{ width: panel.width }}>
      {children}
      <div
        className="dock-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${side} panel`}
        title="Drag to resize · double-click for the default width"
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, width: panel.width };
          document.body.classList.add('resizing-panel');
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const dx = (e.clientX - drag.current.x) * (side === 'left' ? 1 : -1);
          setPanel(side, { width: Math.round(Math.max(MIN, Math.min(MAX, drag.current.width + dx))) });
        }}
        onPointerUp={() => {
          drag.current = null;
          document.body.classList.remove('resizing-panel');
        }}
        onDoubleClick={() => setPanel(side, { width: PANEL_DEFAULT })}
      />
    </div>
  );
}
