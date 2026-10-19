import { useEffect, useState, type DragEvent, type MouseEvent } from 'react';
import { getAncestors } from '../core/document';
import { isAutoLayout } from '../core/layout';
import { isContainer } from '../core/types';
import { AssetsPanel } from './AssetsPanel';
import { useContextMenu } from './ContextMenu';
import { selectionMenu } from './menus';
import { useEditorState } from './EditorContext';
import { IconButton } from './controls';
import { Icon, NODE_ICONS } from './icons';

function InlineRename({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const [text, setText] = useState(value);
  return (
    <input
      className="inline-rename"
      autoFocus
      value={text}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onDone(text)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onDone(text);
        if (e.key === 'Escape') onDone(null);
      }}
    />
  );
}

function PagesList() {
  const editor = useEditorState();
  const [renaming, setRenaming] = useState<string | null>(null);
  return (
    <div className="pages">
      <header className="sidebar-header">
        <h3>Pages</h3>
        <IconButton icon="plus" title="Add page" onClick={() => editor.addPage()} />
      </header>
      <ul>
        {editor.doc.pageIds.map((id) => {
          const page = editor.doc.nodes[id];
          return (
            <li
              key={id}
              className={`page-row${id === editor.pageId ? ' active' : ''}`}
              onClick={() => editor.setPage(id)}
              onDoubleClick={() => setRenaming(id)}
            >
              {renaming === id ? (
                <InlineRename
                  value={page.name}
                  onDone={(v) => {
                    if (v !== null) editor.renamePage(id, v);
                    setRenaming(null);
                  }}
                />
              ) : (
                <span className="row-name">{page.name}</span>
              )}
              {editor.doc.pageIds.length > 1 && (
                <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                  <IconButton
                    icon="trash"
                    title="Delete page"
                    onClick={() => {
                      if (confirm(`Delete "${page.name}"?`)) editor.deletePage(id);
                    }}
                  />
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type DropPos = 'before' | 'after' | 'inside';

export function LayersPanel() {
  const editor = useEditorState();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragIds, setDragIds] = useState<string[]>([]);
  const [drop, setDrop] = useState<{ id: string; pos: DropPos } | null>(null);
  const [tab, setTab] = useState<'layers' | 'assets'>('layers');
  const openMenu = useContextMenu();

  // Rename requests come from the canvas context menu and Ctrl/Cmd+R.
  useEffect(() => {
    const id = editor.renameRequest;
    if (!id) return;
    editor.renameRequest = null;
    setTab('layers');
    // Wait a frame so a closing menu cannot steal focus from the input.
    setTimeout(() => setRenaming(id), 0);
  }, [editor, editor.version]);
  const { doc } = editor;

  // Ancestors of the selection are always expanded.
  const forcedOpen = new Set(editor.selection.flatMap((id) => (doc.nodes[id] ? getAncestors(doc, id).map((a) => a.id) : [])));

  const onRowClick = (id: string, e: MouseEvent) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) editor.toggleSelect(id);
    else editor.select([id]);
  };

  const dropPosition = (e: DragEvent, id: string): DropPos => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = (e.clientY - rect.top) / rect.height;
    if (isContainer(doc.nodes[id]) && f > 0.25 && f < 0.75) return 'inside';
    return f < 0.5 ? 'before' : 'after';
  };

  const applyDrop = () => {
    if (!drop || !dragIds.length) return;
    const target = doc.nodes[drop.id];
    if (drop.pos === 'inside') {
      editor.moveLayers(dragIds, target.id, target.children.length);
    } else if (target.parentId) {
      const siblings = doc.nodes[target.parentId].children;
      const i = siblings.indexOf(target.id);
      // The panel lists top-most first, so "before" in the list means above in z-order.
      editor.moveLayers(dragIds, target.parentId, drop.pos === 'before' ? i + 1 : i);
    }
  };

  const renderRows = (parentId: string, depth: number): JSX.Element[] => {
    const parent = doc.nodes[parentId];
    return [...parent.children].reverse().flatMap((id) => {
      const node = doc.nodes[id];
      if (!node) return [];
      const selected = editor.selection.includes(id);
      const hasKids = node.children.length > 0;
      const open = hasKids && (forcedOpen.has(id) || !collapsed.has(id));
      const dropClass = drop?.id === id ? ` drop-${drop.pos}` : '';
      const row = (
        <li
          key={id}
          className={`layer-row${node.type === 'component' || node.type === 'instance' || node.sourceId ? ' linked' : ''}${selected ? ' selected' : ''}${editor.hoverId === id ? ' hover' : ''}${!node.visible ? ' hidden' : ''}${dropClass}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable={renaming !== id}
          onClick={(e) => onRowClick(id, e)}
          onDoubleClick={() => setRenaming(id)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (!editor.selection.includes(id)) editor.select([id]);
            openMenu(e.clientX, e.clientY, selectionMenu(editor));
          }}
          onMouseEnter={() => {
            editor.hoverId = id;
            editor.emit();
          }}
          onMouseLeave={() => {
            editor.hoverId = null;
            editor.emit();
          }}
          onDragStart={(e) => {
            const ids = selected ? editor.selection : [id];
            if (!selected) editor.select([id]);
            setDragIds(ids);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', id);
          }}
          onDragOver={(e) => {
            if (!dragIds.length) return;
            e.preventDefault();
            const pos = dropPosition(e, id);
            if (drop?.id !== id || drop.pos !== pos) setDrop({ id, pos });
          }}
          onDrop={(e) => {
            e.preventDefault();
            applyDrop();
            setDrop(null);
            setDragIds([]);
          }}
          onDragEnd={() => {
            setDrop(null);
            setDragIds([]);
          }}
        >
          <span
            className={`disclosure${open ? ' open' : ''}${hasKids ? '' : ' empty'}`}
            onClick={(e) => {
              e.stopPropagation();
              const next = new Set(collapsed);
              if (open) next.add(id);
              else next.delete(id);
              setCollapsed(next);
              if (open && forcedOpen.has(id)) editor.select([id]);
            }}
          >
            {hasKids && <Icon name="chevron" size={12} />}
          </span>
          <span className="layer-icon">
            <Icon name={node.type !== 'component' && node.type !== 'instance' && isAutoLayout(node) ? (node.layoutMode === 'horizontal' ? 'layoutH' : 'layoutV') : NODE_ICONS[node.type]} size={14} />
          </span>
          {renaming === id ? (
            <InlineRename
              value={node.name}
              onDone={(v) => {
                if (v !== null) editor.rename(id, v);
                setRenaming(null);
              }}
            />
          ) : (
            <span className="row-name">{node.name}</span>
          )}
          <span className={`row-actions${node.locked || !node.visible ? ' pinned' : ''}`} onClick={(e) => e.stopPropagation()}>
            <IconButton icon={node.locked ? 'lock' : 'unlock'} title={node.locked ? 'Unlock' : 'Lock'} onClick={() => editor.toggleLocked([id])} />
            <IconButton icon={node.visible ? 'eye' : 'eyeOff'} title={node.visible ? 'Hide' : 'Show'} onClick={() => editor.toggleVisible([id])} />
          </span>
        </li>
      );
      return open ? [row, ...renderRows(id, depth + 1)] : [row];
    });
  };

  return (
    <aside className="sidebar left">
      <PagesList />
      <div className="layers">
        <header className="sidebar-header tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'layers'} className={tab === 'layers' ? 'active' : ''} onClick={() => setTab('layers')}>
            Layers
          </button>
          <button type="button" role="tab" aria-selected={tab === 'assets'} className={tab === 'assets' ? 'active' : ''} onClick={() => setTab('assets')}>
            Assets
          </button>
        </header>
        {tab === 'layers' ? (
          <ul onClick={(e) => e.target === e.currentTarget && editor.select([])}>
            {renderRows(editor.pageId, 0)}
            {!editor.page.children.length && <li className="empty-hint">Pick a tool in the toolbar and draw on the canvas.</li>}
          </ul>
        ) : (
          <AssetsPanel />
        )}
      </div>
    </aside>
  );
}
