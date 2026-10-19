import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Tool } from '../core/editor';
import { useEditorState } from './EditorContext';
import { Icon, type IconName } from './icons';

const TOOLS: { tool: Tool; icon: IconName; label: string; key: string }[] = [
  { tool: 'select', icon: 'select', label: 'Move', key: 'V' },
  { tool: 'hand', icon: 'hand', label: 'Hand', key: 'H' },
  { tool: 'frame', icon: 'frame', label: 'Frame', key: 'F' },
  { tool: 'rectangle', icon: 'rectangle', label: 'Rectangle', key: 'R' },
  { tool: 'ellipse', icon: 'ellipse', label: 'Ellipse', key: 'O' },
  { tool: 'line', icon: 'line', label: 'Line', key: 'L' },
  { tool: 'pen', icon: 'pen', label: 'Pen', key: 'P' },
  { tool: 'text', icon: 'text', label: 'Text', key: 'T' },
];

export const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

interface MenuItem {
  label: string;
  shortcut?: string;
  action: () => void;
  disabled?: boolean;
}

function Dropdown({ button, items, className }: { button: ReactNode; items: (MenuItem | '-')[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div className={`dropdown ${className ?? ''}`} ref={ref}>
      <button type="button" className={`toolbar-button${open ? ' active' : ''}`} onClick={() => setOpen(!open)}>
        {button}
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map((item, i) =>
            item === '-' ? (
              <div key={i} className="menu-separator" />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.action();
                }}
              >
                <span>{item.label}</span>
                {item.shortcut && <kbd>{item.shortcut}</kbd>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function Toolbar({ onOpen, onVariables }: { onOpen: () => void; onVariables: () => void }) {
  const editor = useEditorState();
  const [name, setName] = useState(editor.doc.name);
  useEffect(() => setName(editor.doc.name), [editor.doc.name]);

  return (
    <header className="toolbar">
      <div className="toolbar-left">
        <Dropdown
          button={<Icon name="menu" />}
          items={[
            {
              label: 'New file',
              action: () => {
                if (confirm('Discard the current document and start a new one?')) editor.newDocument();
              },
            },
            { label: 'Open…', shortcut: `${MOD}O`, action: onOpen },
            { label: 'Save as .planar.json', shortcut: `${MOD}S`, action: () => editor.saveFile() },
            '-',
            { label: 'Export PNG', shortcut: `${MOD}Shift+E`, action: () => editor.exportAs('png', 2) },
            { label: 'Export SVG', action: () => editor.exportAs('svg') },
            '-',
            { label: 'Variables…', action: onVariables },
            { label: 'Create component', shortcut: `${MOD}Alt+K`, action: () => editor.createComponent(), disabled: !editor.selection.length },
            '-',
            { label: 'Undo', shortcut: `${MOD}Z`, action: () => editor.undo(), disabled: !editor.canUndo },
            { label: 'Redo', shortcut: `${MOD}Shift+Z`, action: () => editor.redo(), disabled: !editor.canRedo },
            '-',
            {
              label: 'About Planar',
              action: () => window.open('https://github.com/wswfws/Planar', '_blank', 'noopener'),
            },
          ]}
        />
        <div className="tools" role="toolbar" aria-label="Tools">
          {TOOLS.map((t) => (
            <button
              key={t.tool}
              type="button"
              className={`toolbar-button${editor.tool === t.tool ? ' active' : ''}`}
              title={`${t.label} (${t.key})`}
              aria-label={t.label}
              onClick={() => editor.setTool(t.tool)}
            >
              <Icon name={t.icon} />
            </button>
          ))}
        </div>
      </div>
      <div className="toolbar-center">
        <input
          className="doc-name"
          value={name}
          aria-label="Document name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            editor.renameDocument(name);
            setName(editor.doc.name);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <div className="toolbar-right">
        <button type="button" className="toolbar-button" title="Variables" onClick={onVariables}>
          <Icon name="variable" />
          <span className="toolbar-label">Variables</span>
        </button>
        <button type="button" className="toolbar-button" title={`Undo (${MOD}Z)`} disabled={!editor.canUndo} onClick={() => editor.undo()}>
          <Icon name="undo" />
        </button>
        <button type="button" className="toolbar-button" title={`Redo (${MOD}Shift+Z)`} disabled={!editor.canRedo} onClick={() => editor.redo()}>
          <Icon name="redo" />
        </button>
        <Dropdown
          className="zoom-menu"
          button={<span className="zoom-label">{Math.round(editor.viewport.zoom * 100)}%</span>}
          items={[
            { label: 'Zoom in', shortcut: `${MOD}+`, action: () => editor.zoomBy(2) },
            { label: 'Zoom out', shortcut: `${MOD}-`, action: () => editor.zoomBy(0.5) },
            { label: 'Zoom to 100%', shortcut: 'Shift+0', action: () => editor.zoomTo(1) },
            { label: 'Zoom to fit', shortcut: 'Shift+1', action: () => editor.zoomToFit() },
            { label: 'Zoom to selection', shortcut: 'Shift+2', action: () => editor.zoomToSelection(), disabled: !editor.selection.length },
          ]}
        />
      </div>
    </header>
  );
}
