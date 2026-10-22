import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { commentsApi, onCommentsChanged, type CommentInfo } from '../collab/session';
import { hitTest, worldMatrix } from '../core/geometry';
import { apply, invert } from '../core/math';
import { useEditor, useEditorState } from './EditorContext';
import { IconButton } from './controls';
import { useServer } from './router';

interface CommentsState {
  comments: CommentInfo[];
  /** Thread (id of its first comment) open on the canvas. */
  openThread: string | null;
  setOpenThread: (id: string | null) => void;
  reload: () => void;
}

const CommentsContext = createContext<CommentsState | null>(null);

export function useComments(): CommentsState {
  const ctx = useContext(CommentsContext);
  if (!ctx) throw new Error('CommentsProvider is missing');
  return ctx;
}

/** Keeps the file's comments loaded and fresh while it is open. */
export function CommentsProvider({ fileId, children }: { fileId: string; children: ReactNode }) {
  const [comments, setComments] = useState<CommentInfo[]>([]);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const reload = useCallback(() => {
    commentsApi.list(fileId).then(setComments, () => undefined);
  }, [fileId]);
  useEffect(() => {
    reload();
    return onCommentsChanged(reload);
  }, [reload]);
  const value = useMemo(() => ({ comments, openThread, setOpenThread, reload }), [comments, openThread, reload]);
  return <CommentsContext.Provider value={value}>{children}</CommentsContext.Provider>;
}

function when(t: number): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

/** Text with @mentions highlighted. */
function Text({ text }: { text: string }) {
  return (
    <>
      {text.split(/(@[a-z0-9_.-]{3,32})/gi).map((part, i) =>
        part.startsWith('@') && part.length > 3 ? (
          <span key={i} className="mention">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

function Message({ c, onDelete }: { c: CommentInfo; onDelete?: () => void }) {
  const server = useServer();
  return (
    <div className="comment-message">
      <span className="peer-dot" style={{ background: c.author.color }} />
      <div className="comment-body">
        <div className="comment-meta">
          <b>{c.author.name}</b>
          {c.agent && <span className="badge">Agent</span>}
          <span className="hint">{when(c.createdAt)}</span>
          {onDelete && server?.me?.id === c.author.id && (
            <button type="button" className="link-button" onClick={onDelete}>
              Delete
            </button>
          )}
        </div>
        <p>
          <Text text={c.text} />
        </p>
      </div>
    </div>
  );
}

function Composer({ placeholder, onPost, onCancel, autoFocus }: { placeholder: string; onPost: (text: string) => Promise<void>; onCancel?: () => void; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const post = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onPost(text.trim());
      setText('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="comment-composer">
      <textarea
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void post();
          }
          if (e.key === 'Escape') onCancel?.();
        }}
      />
      <div className="comment-actions">
        {onCancel && (
          <button type="button" className="link-button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className="primary-button" disabled={!text.trim() || busy} onClick={post}>
          Post
        </button>
      </div>
    </div>
  );
}

function Thread({ root, onClose }: { root: CommentInfo; onClose: () => void }) {
  const editor = useEditor();
  const server = useServer();
  const { comments, reload } = useComments();
  const fileId = editor.collab!.fileId;
  const replies = comments.filter((c) => c.threadId === root.id);
  const canResolve = editor.collab?.role === 'owner' || editor.collab?.role === 'editor' || server?.me?.id === root.author.id;
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      reload();
    } catch (e) {
      editor.notify((e as Error).message);
    }
  };
  return (
    <div className="comment-thread" onPointerDown={(e) => e.stopPropagation()}>
      <div className="comment-thread-head">
        {canResolve && (
          <button type="button" className="small-button" onClick={() => act(() => commentsApi.resolve(fileId, root.id, !root.resolvedAt))}>
            {root.resolvedAt ? 'Reopen' : 'Resolve'}
          </button>
        )}
        <IconButton icon="close" title="Close (Esc)" onClick={onClose} />
      </div>
      <div className="comment-messages">
        {[root, ...replies].map((c) => (
          <Message
            key={c.id}
            c={c}
            onDelete={() =>
              act(async () => {
                await commentsApi.remove(fileId, c.id);
                if (c.id === root.id) onClose();
              })
            }
          />
        ))}
      </div>
      {server?.me ? (
        <Composer placeholder="Reply…" onPost={(text) => act(() => commentsApi.add(fileId, { text, threadId: root.id }))} />
      ) : (
        <p className="hint">Sign in to reply.</p>
      )}
    </div>
  );
}

/** Where a comment sits in the world (it follows the layer it is attached to). */
function pinPosition(editor: ReturnType<typeof useEditor>, c: CommentInfo): { x: number; y: number } | null {
  if (c.nodeId) {
    if (!editor.doc.nodes[c.nodeId]) return { x: c.x, y: c.y };
    return apply(worldMatrix(editor.doc, c.nodeId), { x: c.x, y: c.y });
  }
  return { x: c.x, y: c.y };
}

interface Draft {
  pageId: string;
  nodeId: string | null;
  x: number;
  y: number;
  world: { x: number; y: number };
}

/** Pins on the canvas, the comment tool and the open thread. Place inside the stage. */
export function CommentsLayer() {
  const editor = useEditorState();
  const server = useServer();
  const { comments, openThread, setOpenThread, reload } = useComments();
  const [draft, setDraft] = useState<Draft | null>(null);
  const fileId = editor.collab?.fileId;
  const tool = editor.tool === 'comment';

  useEffect(() => {
    if (!tool) setDraft(null);
  }, [tool]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setDraft(null);
      setOpenThread(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpenThread]);

  if (!fileId) return null;

  const place = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!server?.me) {
      editor.notify('Sign in to comment');
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const world = editor.screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    const hit = hitTest(editor.doc, editor.pageId, world, 4 / editor.viewport.zoom);
    setOpenThread(null);
    if (hit) {
      const local = apply(invert(worldMatrix(editor.doc, hit)), world);
      setDraft({ pageId: editor.pageId, nodeId: hit, x: local.x, y: local.y, world });
    } else {
      setDraft({ pageId: editor.pageId, nodeId: null, x: world.x, y: world.y, world });
    }
  };

  const roots = comments.filter((c) => !c.threadId && c.pageId === editor.pageId && !c.resolvedAt);
  /** Popover corner next to a pin, kept inside the canvas. */
  const near = (p: { x: number; y: number }) => {
    const s = editor.worldToScreen(p);
    const { width, height } = editor.canvasSize;
    return { left: Math.max(8, Math.min(s.x + 18, width - 296)), top: Math.max(8, Math.min(s.y - 8, height - 240)) };
  };
  const stage = (p: { x: number; y: number }) => editor.worldToScreen(p);
  const open = comments.find((c) => c.id === openThread && !c.threadId) ?? null;
  const openPos = open && open.pageId === editor.pageId ? pinPosition(editor, open) : null;

  return (
    <div className="comments-layer">
      {tool && <div className="comment-catcher" onPointerDown={place} onMouseDown={(e) => e.preventDefault()} />}
      {roots.map((c, i) => {
        const world = pinPosition(editor, c);
        if (!world) return null;
        const p = stage(world);
        return (
          <button
            key={c.id}
            type="button"
            className={`comment-pin${c.id === openThread ? ' active' : ''}`}
            style={{ left: p.x, top: p.y, background: c.author.color }}
            title={`${c.author.name}: ${c.text}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              setDraft(null);
              setOpenThread(c.id === openThread ? null : c.id);
            }}
          >
            {i + 1}
          </button>
        );
      })}
      {draft && (
        <>
          <span className="comment-pin draft" style={{ left: stage(draft.world).x, top: stage(draft.world).y }} />
          <div className="comment-popover" style={near(draft.world)} onPointerDown={(e) => e.stopPropagation()}>
            <Composer
              autoFocus
              placeholder="Add a comment… use @username to mention"
              onCancel={() => setDraft(null)}
              onPost={async (text) => {
                try {
                  const c = await commentsApi.add(fileId, { text, pageId: draft.pageId, nodeId: draft.nodeId ?? undefined, x: draft.x, y: draft.y });
                  setDraft(null);
                  reload();
                  setOpenThread(c.id);
                  editor.setTool('select');
                } catch (e) {
                  editor.notify((e as Error).message);
                }
              }}
            />
          </div>
        </>
      )}
      {open && openPos && (
        <div className="comment-popover" style={near(openPos)}>
          <Thread root={open} onClose={() => setOpenThread(null)} />
        </div>
      )}
    </div>
  );
}

/** The "Comments" tab of the left panel. */
export function CommentsPanel() {
  const editor = useEditorState();
  const { comments, openThread, setOpenThread } = useComments();
  const [showResolved, setShowResolved] = useState(false);
  const fileId = editor.collab?.fileId;
  useEffect(() => {
    if (fileId) void commentsApi.markRead(fileId).catch(() => undefined);
  }, [fileId, comments.length]);
  const roots = comments.filter((c) => !c.threadId && (showResolved || !c.resolvedAt));
  const go = (c: CommentInfo) => {
    if (c.pageId !== editor.pageId && editor.doc.nodes[c.pageId]) editor.setPage(c.pageId);
    const at = pinPosition(editor, c);
    if (at) {
      const { width, height } = editor.canvasSize;
      const z = editor.viewport.zoom;
      editor.viewport = { zoom: z, x: width / 2 - at.x * z, y: height / 2 - at.y * z };
      editor.emit();
    }
    setOpenThread(c.id);
  };
  return (
    <div className="comments-panel">
      <label className="hint comments-filter">
        <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
      </label>
      {!roots.length && <p className="hint comments-empty">{showResolved ? 'No comments yet.' : 'No open comments. Press C and click on the canvas to leave one.'}</p>}
      {roots.map((c, i) => {
        const replies = comments.filter((r) => r.threadId === c.id).length;
        return (
          <button type="button" key={c.id} className={`comment-row${c.id === openThread ? ' active' : ''}${c.resolvedAt ? ' resolved' : ''}`} onClick={() => go(c)}>
            <span className="comment-pin small" style={{ background: c.author.color }}>
              {i + 1}
            </span>
            <span className="comment-row-body">
              <span className="comment-meta">
                <b>{c.author.name}</b>
                <span className="hint">{when(c.createdAt)}</span>
              </span>
              <span className="comment-row-text">{c.text}</span>
              {(replies > 0 || c.resolvedAt) && (
                <span className="hint">
                  {c.resolvedAt ? 'Resolved' : ''}
                  {c.resolvedAt && replies ? ' · ' : ''}
                  {replies ? `${replies} repl${replies === 1 ? 'y' : 'ies'}` : ''}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
