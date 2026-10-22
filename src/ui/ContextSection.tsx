import { useState } from 'react';
import { CONTEXT_MAX, contextChain } from '../core/context';
import type { Editor } from '../core/editor';
import type { SceneNode } from '../core/types';
import { Section } from './controls';

/** Notes editor: saved as one undo step when the field loses focus. */
function ContextField({ value, placeholder, label, readOnly, onSave }: { value: string; placeholder: string; label: string; readOnly: boolean; onSave: (text: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    if (draft !== null && draft !== value) onSave(draft);
    setDraft(null);
  };
  return (
    <textarea
      className="text-field context-field"
      aria-label={label}
      placeholder={placeholder}
      maxLength={CONTEXT_MAX}
      readOnly={readOnly}
      rows={Math.min(12, Math.max(3, (draft ?? value).split('\n').length + 1))}
      value={draft ?? value}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          setDraft(null);
          (e.target as HTMLTextAreaElement).blur();
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.target as HTMLTextAreaElement).blur();
      }}
    />
  );
}

/** Context of one layer (or page), with what its main component says about it. */
export function ContextSection({ editor, node }: { editor: Editor; node: SceneNode }) {
  const inherited = contextChain(editor.doc, node.id).filter((e) => e.source === 'component');
  return (
    <Section title="Context">
      {inherited.map((e) => (
        <details key={e.id} className="context-inherited">
          <summary>From component “{e.name}”</summary>
          <p>{e.text}</p>
        </details>
      ))}
      <ContextField
        label="Context"
        readOnly={editor.readOnly}
        value={node.context}
        placeholder={node.type === 'page' ? 'What this page is for…' : 'What this layer is for, decisions, open questions… (markdown; people and AI agents read this)'}
        onSave={(text) => editor.updateNodes([node.id], (n) => (n.context = text))}
      />
    </Section>
  );
}

/** The brief for the whole file. */
export function FileContextSection({ editor }: { editor: Editor }) {
  return (
    <Section title="File brief">
      <ContextField
        label="File brief"
        readOnly={editor.readOnly}
        value={editor.doc.context}
        placeholder="Goal, audience, brand rules, what is done and what is not… AI agents read this first."
        onSave={(text) => editor.setDocumentContext(text)}
      />
    </Section>
  );
}
