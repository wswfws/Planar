import { useEffect, useState } from 'react';
import type { Editor } from '../core/editor';
import type { Variable, VariableType } from '../core/types';
import { variableValue } from '../core/variables';
import { ColorField, IconButton, NumberField } from './controls';
import { useEditorState } from './EditorContext';

const TYPES: { type: VariableType; label: string; badge: string }[] = [
  { type: 'color', label: 'Color', badge: '●' },
  { type: 'number', label: 'Number', badge: '#' },
  { type: 'string', label: 'String', badge: 'T' },
  { type: 'boolean', label: 'Boolean', badge: '◑' },
];

function NameInput({ value, onCommit, className, label }: { value: string; onCommit: (v: string) => void; className?: string; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className={className}
      aria-label={label}
      value={draft ?? value}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onCommit(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function ValueCell({ editor, variable, modeId }: { editor: Editor; variable: Variable; modeId: string }) {
  const value = variableValue(editor.doc, variable, modeId);
  const set = (v: unknown) => editor.setVariableValue(variable.id, modeId, v);
  switch (variable.type) {
    case 'color':
      return <ColorField value={String(value)} onChange={set} />;
    case 'number':
      return <NumberField label="" value={Number(value)} onChange={set} />;
    case 'boolean':
      return (
        <label className="checkbox">
          <input type="checkbox" checked={value === true} onChange={(e) => set(e.target.checked)} />
          {value ? 'true' : 'false'}
        </label>
      );
    default:
      return <NameInput className="cell-input" label="Value" value={String(value)} onCommit={set} />;
  }
}

export function VariablesDialog({ onClose }: { onClose: () => void }) {
  const editor = useEditorState();
  const { doc } = editor;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const usage = (id: string) =>
    Object.values(doc.nodes).filter(
      (n) =>
        Object.values(n.bindings).includes(id) ||
        [...n.fills, ...n.strokes].some((p) => p.type === 'solid' && p.variableId === id),
    ).length;

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="Variables">
        <header className="dialog-header">
          <h2>Variables</h2>
          <IconButton icon="close" title="Close (Esc)" onClick={onClose} />
        </header>
        <div className="dialog-body">
          <table className="variables-table">
            <thead>
              <tr>
                <th>Name</th>
                {doc.modes.map((m) => (
                  <th key={m.id}>
                    <span className="mode-head">
                      <NameInput className="mode-name" label="Mode name" value={m.name} onCommit={(v) => editor.renameMode(m.id, v)} />
                      {doc.modes.length > 1 && <IconButton icon="close" title="Delete mode" onClick={() => editor.deleteMode(m.id)} />}
                    </span>
                  </th>
                ))}
                <th className="narrow">
                  <IconButton icon="plus" title="Add mode" onClick={() => editor.addMode()} />
                </th>
              </tr>
            </thead>
            <tbody>
              {doc.variables.map((v) => {
                const used = usage(v.id);
                return (
                  <tr key={v.id}>
                    <td>
                      <span className="var-name">
                        <span className={`type-badge-small ${v.type}`} title={v.type}>
                          {TYPES.find((t) => t.type === v.type)?.badge}
                        </span>
                        <NameInput className="cell-input" label="Variable name" value={v.name} onCommit={(name) => editor.renameVariable(v.id, name)} />
                      </span>
                    </td>
                    {doc.modes.map((m) => (
                      <td key={m.id}>
                        <ValueCell editor={editor} variable={v} modeId={m.id} />
                      </td>
                    ))}
                    <td className="narrow">
                      <IconButton
                        icon="trash"
                        title={used ? `Delete (used by ${used} layer${used === 1 ? '' : 's'})` : 'Delete'}
                        onClick={() => editor.deleteVariable(v.id)}
                      />
                    </td>
                  </tr>
                );
              })}
              {!doc.variables.length && (
                <tr>
                  <td colSpan={doc.modes.length + 2} className="empty-hint">
                    No variables yet. Add one below, then bind it from the properties panel with the ⬡ picker.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <footer className="dialog-footer">
          {TYPES.map((t) => (
            <button key={t.type} type="button" className="small-button" onClick={() => editor.addVariable(t.type)}>
              + {t.label}
            </button>
          ))}
        </footer>
      </div>
    </div>
  );
}
