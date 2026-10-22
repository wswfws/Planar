import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { getAncestors } from '../core/document';
import { isAutoLayout } from '../core/layout';
import { isContainer } from '../core/types';
import { AssetsPanel } from './AssetsPanel';
import { visiblePageIds } from '../core/library';
import { CommentsPanel, useComments } from './Comments';
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

function OpenCount() {
  const { comments } = useComments();
  const n = comments.filter((c) => !c.threadId && !c.resolvedAt).length;
  return n ? <span className="tab-count">{n}</span> : null;
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
        {visiblePageIds(editor.doc).map((id) => {
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
              {visiblePageIds(editor.doc).length > 1 && (
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

/** Height of a layer row in px (matches .layer-row in the CSS). */
const ROW_HEIGHT = 28;

export function LayersPanel() {
  const editor = useEditorState();
  // Layers with children start collapsed (big files would otherwise list thousands of rows).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [view, setView] = useState({ top: 0, height: 800 });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragIds, setDragIds] = useState<string[]>([]);
  const [drop, setDrop] = useState<{ id: string; pos: DropPos } | null>(null);
  const [tab, setTab] = useState<'layers' | 'assets' | 'comments'>('layers');
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

  // Track the visible part of the list (for rendering only the rows in view).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => setView({ top: el.scrollTop, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const isOpen = (id: string) => (doc.nodes[id]?.children.length ?? 0) > 0 && (forcedOpen.has(id) || expanded.has(id));

  /** Rows in panel order (top-most first), descending into open layers. */
  const rows: { id: string; depth: number }[] = [];
  const collect = (parentId: string, depth: number) => {
    const parent = doc.nodes[parentId];
    for (let i = parent.children.length - 1; i >= 0; i--) {
      const id = parent.children[i];
      if (!doc.nodes[id]) continue;
      rows.push({ id, depth });
      if (isOpen(id)) collect(id, depth + 1);
    }
  };
  collect(editor.pageId, 0);

  // Only the rows in view are rendered; the rest is empty space of the same height.
  const offset = list.current?.offsetTop ?? 0;
  const first = Math.max(0, Math.floor((view.top - offset) / ROW_HEIGHT) - 10);
  const last = Math.min(rows.length, Math.ceil((view.top - offset + view.height) / ROW_HEIGHT) + 10);

  const renderRow = ({ id, depth }: { id: string; depth: number }): JSX.Element => {
    const node = doc.nodes[id];
    const selected = editor.selection.includes(id);
    const hasKids = node.children.length > 0;
    const open = isOpen(id);
    const dropClass = drop?.id === id ? ` drop-${drop.pos}` : '';
    const row = (
      <li
        key={id}
        className={`layer-row${node.type === 'component' || node.type === 'componentSet' || node.type === 'instance' || node.sourceId ? ' linked' : ''}${selected ? ' selected' : ''}${editor.hoverId === id ? ' hover' : ''}${!node.visible ? ' hidden' : ''}${dropClass}`}
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
            const next = new Set(expanded);
            if (open) next.delete(id);
            else next.add(id);
            setExpanded(next);
            if (open && forcedOpen.has(id)) editor.select([id]);
          }}
        >
          {hasKids && <Icon name="chevron" size={12} />}
        </span>
        <span className="layer-icon">
          <Icon name={node.type !== 'component' && node.type !== 'componentSet' && node.type !== 'instance' && isAutoLayout(node) ? (node.layoutMode === 'horizontal' ? 'layoutH' : node.layoutMode === 'grid' ? 'layoutGrid' : 'layoutV') : NODE_ICONS[node.type]} size={14} />
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
        {node.context.trim() && (
          <span className="row-context" title={node.context.length > 200 ? node.context.slice(0, 200) + '…' : node.context}>
            <Icon name="note" size={12} />
          </span>
        )}
        <span className={`row-actions${node.locked || !node.visible ? ' pinned' : ''}`} onClick={(e) => e.stopPropagation()}>
          <IconButton icon={node.locked ? 'lock' : 'unlock'} title={node.locked ? 'Unlock' : 'Lock'} onClick={() => editor.toggleLocked([id])} />
          <IconButton icon={node.visible ? 'eye' : 'eyeOff'} title={node.visible ? 'Hide' : 'Show'} onClick={() => editor.toggleVisible([id])} />
        </span>
      </li>
    );
    return row;
  };

  return (
    <aside className="sidebar left">
      <PagesList />
      <div className="layers" ref={scroller} onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
        <header className="sidebar-header tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'layers'} className={tab === 'layers' ? 'active' : ''} onClick={() => setTab('layers')}>
            Layers
          </button>
          <button type="button" role="tab" aria-selected={tab === 'assets'} className={tab === 'assets' ? 'active' : ''} onClick={() => setTab('assets')}>
            Assets
          </button>
          {editor.collab && (
            <button type="button" role="tab" aria-selected={tab === 'comments'} className={tab === 'comments' ? 'active' : ''} onClick={() => setTab('comments')}>
              Comments
              <OpenCount />
            </button>
          )}
        </header>
        {tab === 'comments' && editor.collab ? (
          <CommentsPanel />
        ) : tab === 'layers' ? (
          <ul ref={list} onClick={(e) => e.target === e.currentTarget && editor.select([])}>
            {first > 0 && <li className="rows-spacer" style={{ height: first * ROW_HEIGHT }} />}
            {rows.slice(first, last).map(renderRow)}
            {last < rows.length && <li className="rows-spacer" style={{ height: (rows.length - last) * ROW_HEIGHT }} />}
            {!editor.page.children.length && <li className="empty-hint">Pick a tool in the toolbar and draw on the canvas.</li>}
          </ul>
        ) : (
          <AssetsPanel />
        )}
      </div>
    </aside>
  );
}
