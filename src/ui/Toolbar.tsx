import { openLibraries } from './LibrariesDialog';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Tool } from '../core/editor';
import { files } from '../collab/session';
import { useEditorState } from './EditorContext';
import { Icon, type IconName } from './icons';
import { navigate, useServer } from './router';
import { screenOf, screensOf } from '../core/prototype';
import { NOTE_KINDS, NOTE_LABELS } from '../core/notes';
import { useAuthorName } from './NoteSection';
import { togglePanel, toggleAllPanels, usePanels } from './Panels';

interface ToolInfo {
  tool: Tool;
  icon: IconName;
  label: string;
  key: string;
}

const T = (tool: Tool, icon: IconName, label: string, key: string): ToolInfo => ({ tool, icon, label, key });

/** The tool bar at the bottom of the canvas: single tools and groups sharing a button. */
const TOOL_GROUPS: ToolInfo[][] = [
  [T('select', 'select', 'Move', 'V'), T('hand', 'hand', 'Hand', 'H')],
  [T('frame', 'frame', 'Frame', 'F')],
  [T('rectangle', 'rectangle', 'Rectangle', 'R'), T('ellipse', 'ellipse', 'Ellipse', 'O'), T('line', 'line', 'Line', 'L')],
  [T('pen', 'pen', 'Pen', 'P')],
  [T('text', 'text', 'Text', 'T')],
  [T('comment', 'comment', 'Comment', 'C')],
];

export const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

interface MenuItem {
  label: string;
  shortcut?: string;
  action: () => void;
  disabled?: boolean;
}

function Dropdown({ button, items, className, up, title }: { button: ReactNode; items: (MenuItem | '-')[]; className?: string; up?: boolean; title?: string }) {
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
      <button type="button" className={`toolbar-button${open ? ' active' : ''}`} title={title} aria-label={title} onClick={() => setOpen(!open)}>
        {button}
      </button>
      {open && (
        <div className={`menu${up ? ' up' : ''}`} role="menu">
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
  const panels = usePanels();
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
            { label: editor.showAnnotations ? 'Hide annotations' : 'Show annotations', action: () => editor.setShowAnnotations(!editor.showAnnotations) },
            ...(server ? [{ label: 'Share…', action: onShare }] : []),
            ...(server && fileId ? [{ label: 'Present', action: present }] : []),
            ...(server && fileId && !editor.readOnly ? [{ label: 'Version history…', action: onHistory }] : []),
            ...(server?.me && fileId ? [{ label: 'Team libraries…', action: openLibraries }] : []),
            { label: 'Create component', shortcut: `${MOD}Alt+K`, action: () => editor.createComponent(), disabled: !editor.selection.length || editor.readOnly },
            '-',
            { label: panels.left.open && panels.right.open ? 'Hide panels' : 'Show panels', shortcut: `${MOD}\\`, action: toggleAllPanels },
            { label: panels.left.open ? 'Hide layers panel' : 'Show layers panel', action: () => togglePanel('left') },
            { label: panels.right.open ? 'Hide properties panel' : 'Show properties panel', action: () => togglePanel('right') },
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
        {server && fileId && (
          <button type="button" className="toolbar-button" title="Present: play this page as a clickable prototype" aria-label="Present" onClick={present}>
            <Icon name="play" />
          </button>
        )}
        {server && (
          <button type="button" className="share-button" title="Invite people and set link access" onClick={onShare}>
            Share
          </button>
        )}
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

/** One button for a group of tools: shows the active (or last used) one; the arrow lists the rest. */
function ToolButton({ group }: { group: ToolInfo[] }) {
  const editor = useEditorState();
  const [last, setLast] = useState(group[0]);
  const active = group.find((t) => t.tool === editor.tool);
  useEffect(() => {
    if (active) setLast(active);
  }, [active]);
  const shown = active ?? last;
  return (
    <div className="tool-group">
      <button
        type="button"
        className={`toolbar-button${active ? ' active' : ''}`}
        title={`${shown.label} (${shown.key})`}
        aria-label={shown.label}
        onClick={() => editor.setTool(shown.tool)}
      >
        <Icon name={shown.icon} />
      </button>
      {group.length > 1 && (
        <Dropdown
          className="tool-more"
          up
          title={`More tools like ${shown.label}`}
          button={<Icon name="caretDown" size={12} />}
          items={group.map((t) => ({ label: t.label, shortcut: t.key, action: () => editor.setTool(t.tool) }))}
        />
      )}
    </div>
  );
}

/** Tools, floating at the bottom of the canvas. */
export function ToolDock() {
  const editor = useEditorState();
  const author = useAuthorName();
  const groups = TOOL_GROUPS.filter((g) => g[0].tool !== 'comment' || editor.collab);
  return (
    <div className="tool-dock" role="toolbar" aria-label="Tools">
      {groups.map((g) => (
        <ToolButton key={g[0].tool} group={g} />
      ))}
      <span className="tool-dock-sep" />
      <Dropdown
        className="notes-menu"
        up
        title="Notes, chats and checklists"
        button={<Icon name="note" />}
        items={[
          ...NOTE_KINDS.map((kind) => ({
            label: kind === 'callout' ? 'Callout (points at the selection)' : NOTE_LABELS[kind],
            action: () => void editor.addNote(kind, author),
            disabled: editor.readOnly,
          })),
          '-' as const,
          { label: editor.showAnnotations ? 'Hide annotations' : 'Show annotations', action: () => editor.setShowAnnotations(!editor.showAnnotations) },
        ]}
      />
    </div>
  );
}
