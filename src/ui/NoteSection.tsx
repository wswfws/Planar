import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { solid } from '../core/document';
import type { Editor } from '../core/editor';
import { MAX_ITEMS, NOTE_LABELS, STICKY_COLORS, newItem } from '../core/notes';
import { isFrameLike, type SceneNode } from '../core/types';
import { IconButton, Section } from './controls';
import { useServer } from './router';

const CALLOUT_COLORS = ['#5B5BD6', '#E5484D', '#F76B15', '#30A46C', '#0090FF', '#1F1F24'];

/** Name shown on messages and sticky notes written here. */
export function useAuthorName(): string {
  return useServer()?.me?.displayName ?? 'Guest';
}

/** Text saved as one undo step when the field loses focus. */
function DraftText({
  value,
  onSave,
  label,
  placeholder,
  rows,
  focus,
  readOnly,
  single,
}: {
  value: string;
  onSave: (v: string) => void;
  label: string;
  placeholder?: string;
  rows?: number;
  focus?: boolean;
  readOnly: boolean;
  single?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  useEffect(() => {
    // A new or double-clicked note: typing replaces the placeholder text.
    if (focus) ref.current?.select();
  }, [focus]);
  const props = {
    ref,
    className: `text-field${single ? '' : ' context-field'}`,
    'aria-label': label,
    placeholder,
    readOnly,
    value: draft ?? value,
    onFocus: () => setDraft(value),
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => {
      if (draft !== null && draft !== value) onSave(draft);
      setDraft(null);
    },
    onKeyDown: (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        setDraft(null);
        (e.target as HTMLElement).blur();
      }
      if (e.key === 'Enter' && (single || e.ctrlKey || e.metaKey)) (e.target as HTMLElement).blur();
    },
  };
  return single ? <input {...props} /> : <textarea rows={rows ?? Math.min(14, Math.max(4, (draft ?? value).split('\n').length + 1))} {...props} />;
}

function Swatches({ colors, value, onPick, disabled }: { colors: string[]; value: string; onPick: (c: string) => void; disabled: boolean }) {
  return (
    <div className="note-swatches">
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          className={`note-swatch${c.toUpperCase() === value.toUpperCase() ? ' active' : ''}`}
          style={{ background: c }}
          title={c}
          aria-label={`Colour ${c}`}
          disabled={disabled}
          onClick={() => onPick(c)}
        />
      ))}
    </div>
  );
}

/** Layers a callout can point at: the page's layers, a few levels deep. */
function targets(editor: Editor, pageId: string): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  const walk = (id: string, depth: number) => {
    for (const c of editor.doc.nodes[id]?.children ?? []) {
      const n = editor.doc.nodes[c];
      if (!n || n.type === 'note' || out.length >= 300) continue;
      out.push({ id: c, label: `${'  '.repeat(depth)}${n.name}` });
      if (depth < 3 && (isFrameLike(n) || n.type === 'group') && n.type !== 'instance') walk(c, depth + 1);
    }
  };
  walk(pageId, 0);
  return out;
}

function timeOf(at: number): string {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function ChatBody({ editor, node, focus }: { editor: Editor; node: SceneNode; focus: boolean }) {
  const author = useAuthorName();
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const messages = (node.note?.messages ?? []).filter((m) => !m.deleted);
  useEffect(() => {
    if (focus) input.current?.focus();
  }, [focus]);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages.length]);
  const send = () => {
    if (!text.trim()) return;
    editor.postMessage(node.id, text, author);
    setText('');
  };
  return (
    <>
      <div className="chat-list" ref={list}>
        {!messages.length && <p className="hint">No messages yet. Mention @ai to ask an AI agent connected to this file.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`chat-message${m.agent ? ' agent' : ''}`}>
            <div className="chat-meta">
              <b>{m.author}</b>
              {m.agent && <span className="type-badge">AI</span>}
              <span>{timeOf(m.at)}</span>
              {!editor.readOnly && <IconButton icon="trash" title="Delete for everyone" onClick={() => editor.deleteMessage(node.id, m.id)} />}
            </div>
            <p>{m.text}</p>
          </div>
        ))}
      </div>
      {!editor.readOnly && (
        <div className="chat-composer">
          <textarea
            ref={input}
            className="text-field context-field"
            aria-label="Message"
            rows={2}
            placeholder="Write a message… (Enter sends, Shift+Enter new line)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button type="button" className="small-button" disabled={!text.trim()} onClick={send}>
            Send
          </button>
        </div>
      )}
    </>
  );
}

function ChecklistBody({ editor, node, focus }: { editor: Editor; node: SceneNode; focus: boolean }) {
  const items = node.note?.items ?? [];
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) input.current?.focus();
  }, [focus]);
  const setItems = (next: typeof items) => editor.updateNote(node.id, { items: next });
  const add = () => {
    if (!text.trim() || items.length >= MAX_ITEMS) return;
    setItems([...items, newItem(text.trim())]);
    setText('');
  };
  return (
    <>
      <ul className="checklist">
        {items.map((item) => (
          <li key={item.id}>
            <input
              type="checkbox"
              checked={item.done}
              disabled={editor.readOnly}
              aria-label={item.done ? 'Mark as not done' : 'Mark as done'}
              onChange={() => setItems(items.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)))}
            />
            <DraftText
              single
              label="Item"
              readOnly={editor.readOnly}
              value={item.text}
              onSave={(v) => setItems(items.map((i) => (i.id === item.id ? { ...i, text: v } : i)))}
            />
            {!editor.readOnly && <IconButton icon="trash" title="Remove item" onClick={() => setItems(items.filter((i) => i.id !== item.id))} />}
          </li>
        ))}
      </ul>
      {!editor.readOnly && (
        <input
          ref={input}
          className="text-field"
          aria-label="New item"
          placeholder="Add an item and press Enter"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') add();
          }}
        />
      )}
    </>
  );
}

/** Properties of an annotation layer. */
export function NoteSection({ editor, node }: { editor: Editor; node: SceneNode }) {
  const kind = node.note?.kind ?? 'sticky';
  const ro = editor.readOnly;
  const fill = node.fills.find((p) => p.type === 'solid');
  const color = fill?.type === 'solid' ? fill.color : '#FFFFFF';
  const setText = (v: string) => editor.updateNodes([node.id], (n) => (n.characters = v));
  const setColor = (c: string) => editor.updateNodes([node.id], (n) => (n.fills = [solid(c)]));
  const pageId = editor.pageId;
  // Asked for by a double-click or a new note; children focus in their effects, which run first.
  const focus = editor.focusNoteId === node.id;
  useEffect(() => {
    if (focus) editor.focusNoteId = null;
  });

  return (
    <Section title={NOTE_LABELS[kind]}>
      {kind === 'sticky' && (
        <>
          <DraftText label="Note" readOnly={ro} focus={focus} value={node.characters} onSave={setText} placeholder="Write a note…" />
          <Swatches colors={STICKY_COLORS} value={color} onPick={setColor} disabled={ro} />
          {node.note?.author && <p className="hint">By {node.note.author}</p>}
        </>
      )}
      {kind === 'doc' && (
        <>
          <DraftText label="Description" readOnly={ro} focus={focus} value={node.characters} onSave={setText} rows={12} />
          <p className="hint">Markdown: # heading, - list, - [ ] task, &gt; quote, ``` code.</p>
        </>
      )}
      {kind === 'callout' && (
        <>
          <DraftText label="Callout text" readOnly={ro} focus={focus} value={node.characters} onSave={setText} rows={2} />
          <Swatches colors={CALLOUT_COLORS} value={color} onPick={setColor} disabled={ro} />
          <label className="prop-row">
            <span>Points at</span>
            <select
              value={node.note?.targetId ?? ''}
              disabled={ro}
              onChange={(e) => editor.updateNote(node.id, { targetId: e.target.value })}
            >
              <option value="">Nothing</option>
              {targets(editor, pageId).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {(kind === 'chat' || kind === 'checklist') && (
        <DraftText single label="Title" readOnly={ro} value={node.characters} onSave={setText} placeholder="Title" />
      )}
      {kind === 'chat' && <ChatBody editor={editor} node={node} focus={focus} />}
      {kind === 'checklist' && <ChecklistBody editor={editor} node={node} focus={focus} />}
    </Section>
  );
}
