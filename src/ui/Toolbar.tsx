import { openLibraries } from './LibrariesDialog';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Tool } from '../core/editor';
import { files } from '../collab/session';
import { useEditorState } from './EditorContext';
import { Icon, type IconName } from './icons';
import { navigate, useServer } from './router';
import { screenOf, screensOf } from '../core/prototype';

const TOOLS: { tool: Tool; icon: IconName; label: string; key: string }[] = [
  { tool: 'select', icon: 'select', label: 'Move', key: 'V' },
  { tool: 'hand', icon: 'hand', label: 'Hand', key: 'H' },
  { tool: 'frame', icon: 'frame', label: 'Frame', key: 'F' },
  { tool: 'rectangle', icon: 'rectangle', label: 'Rectangle', key: 'R' },
  { tool: 'ellipse', icon: 'ellipse', label: 'Ellipse', key: 'O' },
  { tool: 'line', icon: 'line', label: 'Line', key: 'L' },
  { tool: 'pen', icon: 'pen', label: 'Pen', key: 'P' },
  { tool: 'text', icon: 'text', label: 'Text', key: 'T' },
  { tool: 'comment', icon: 'comment', label: 'Comment', key: 'C' },
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


/** Everyone in the shared document; clicking someone jumps to them. */
function Collaborators({ onShare }: { onShare: () => void }) {
  const editor = useEditorState();
  const collab = editor.collab;
  if (!collab) return null;
  const follow = (id: string) => {
    const p = collab.peers.find((x) => x.id === id)?.presence;
    if (!p) return;
    if (p.pageId && p.pageId !== editor.pageId && editor.doc.nodes[p.pageId]) editor.setPage(p.pageId);
    if (p.cursor) {
      const { width, height } = editor.canvasSize;
      const z = editor.viewport.zoom;
      editor.viewport = { zoom: z, x: width / 2 - p.cursor.x * z, y: height / 2 - p.cursor.y * z };
      editor.emit();
    }
  };
  return (
    <div className="collaborators">
      <span className={`status-dot ${collab.status}`} title={collab.error ?? collab.status} />
      {collab.peers.slice(0, 6).map((p) => (
        <button
          key={p.id}
          type="button"
          className="avatar"
          style={{ background: p.color }}
          title={`${p.name} — click to go to their view`}
          onClick={() => follow(p.id)}
        >
          {p.name.slice(0, 1).toUpperCase()}
        </button>
      ))}
      {collab.peers.length > 6 && <span className="avatar more">+{collab.peers.length - 6}</span>}
      <button type="button" className="avatar-button" title="Sharing" onClick={onShare}>
        {collab.peers.length + 1}
      </button>
    </div>
  );
}

export function Toolbar({ onOpen, onVariables, onShare, onHistory, onAccount }: { onOpen: () => void; onVariables: () => void; onShare: () => void; onHistory: () => void; onAccount: () => void }) {
  const editor = useEditorState();
  const server = useServer();
  const [name, setName] = useState(editor.doc.name);
  useEffect(() => setName(editor.doc.name), [editor.doc.name]);
  const fileId = editor.collab?.fileId;
  const duplicate = () =>
    fileId && server?.me
      ? files.duplicate(fileId).then((f) => navigate(`/file/${f.id}`), (e: Error) => editor.notify(e.message))
      : editor.notify('Sign in to copy this file to your files');
  const present = () => {
    if (!fileId) return;
    const start = (editor.selection[0] && screenOf(editor.doc, editor.selection[0])) || screensOf(editor.doc, editor.pageId)[0];
    if (!start) return editor.notify('Draw a frame to present it');
    navigate(`/file/${fileId}/present?frame=${start}`);
  };
  const newServerFile = () => files.create({}).then((f) => navigate(`/file/${f.id}`), (e: Error) => editor.notify(e.message));

  const fileItems: (MenuItem | '-')[] = server
    ? [
        { label: 'Back to files', action: () => navigate('/') },
        { label: 'New file', action: () => void newServerFile(), disabled: !server.me },
        { label: server.me ? 'Duplicate (copy to my files)' : 'Sign in to copy…', action: () => void duplicate() },
        { label: 'Download .planar.json', shortcut: `${MOD}S`, action: () => fileId && (location.href = files.downloadUrl(fileId)) },
      ]
    : [
        {
          label: 'New file',
          action: () => {
            if (confirm('Discard the current document and start a new one?')) editor.newDocument();
          },
        },
        { label: 'Open…', shortcut: `${MOD}O`, action: onOpen },
        { label: 'Save as .planar.json', shortcut: `${MOD}S`, action: () => editor.saveFile() },
      ];

  return (
    <header className="toolbar">
      <div className="toolbar-left">
        <Dropdown
          button={<Icon name="menu" />}
          items={[
            ...fileItems,
            '-',
            { label: 'Export PNG', shortcut: `${MOD}Shift+E`, action: () => editor.exportAs('png', 2) },
            { label: 'Export SVG', action: () => editor.exportAs('svg') },
            '-',
            { label: 'Variables…', action: onVariables },
            ...(server ? [{ label: 'Share…', action: onShare }] : []),
            ...(server && fileId ? [{ label: 'Present', action: present }] : []),
            ...(server && fileId && !editor.readOnly ? [{ label: 'Version history…', action: onHistory }] : []),
            ...(server?.me && fileId ? [{ label: 'Team libraries…', action: openLibraries }] : []),
            { label: 'Create component', shortcut: `${MOD}Alt+K`, action: () => editor.createComponent(), disabled: !editor.selection.length || editor.readOnly },
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
          {TOOLS.filter((t) => t.tool !== 'comment' || editor.collab).map((t) => (
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
          readOnly={editor.readOnly}
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
        {editor.readOnly && <span className="badge" title="You can look at this file but not change it">View only</span>}
        <Collaborators onShare={onShare} />
        {server && fileId && (
          <button type="button" className="small-button" title="Play this page as a clickable prototype" onClick={present}>
            Present
          </button>
        )}
        {server && fileId && !editor.readOnly && (
          <button type="button" className="small-button" title="Earlier versions of this file" onClick={onHistory}>
            History
          </button>
        )}
        {server && (
          <button type="button" className="share-button" title="Invite people and set link access" onClick={onShare}>
            Share
          </button>
        )}
        {server &&
          (server.me ? (
            <button type="button" className="avatar toolbar-avatar" style={{ background: server.me.color }} title={`@${server.me.username} — account and API keys`} onClick={onAccount}>
              {server.me.displayName.slice(0, 1).toUpperCase()}
            </button>
          ) : (
            <button type="button" className="small-button" onClick={() => navigate(`/login?next=${encodeURIComponent(location.pathname)}`)}>
              Sign in
            </button>
          ))}
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
