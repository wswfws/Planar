import type { Editor } from '../core/editor';
import { cssEffects } from '../core/effects';
import { cssFontFamily } from '../core/fonts';
import { createNode } from '../core/document';
import { textStyleValues } from '../core/styles';
import type { SceneNode, Style } from '../core/types';
import { IconButton } from './controls';
import { useEditorState } from './EditorContext';

const CREATE = '__create__';

/** Picks the style the selected layers follow, or makes a new one from them. */
export function StylePicker({ editor, nodes, kind }: { editor: Editor; nodes: SceneNode[]; kind: 'text' | 'effect' }) {
  const field = kind === 'text' ? 'textStyleId' : 'effectStyleId';
  const styles = editor.doc.styles.filter((s) => s.type === kind);
  const current = nodes.every((n) => n[field] === nodes[0][field]) ? nodes[0][field] : null;
  return (
    <select
      className={`style-picker${current ? ' bound' : ''}`}
      value={current ?? ''}
      title={kind === 'text' ? 'Text style' : 'Effect style'}
      aria-label={kind === 'text' ? 'Text style' : 'Effect style'}
      onChange={(e) => {
        const value = e.target.value;
        if (value === CREATE) {
          const name = prompt(kind === 'text' ? 'Text style name (e.g. Heading/H1)' : 'Effect style name (e.g. Shadow/Card)');
          if (!name?.trim()) return;
          if (kind === 'text') editor.createTextStyle(name, nodes[0].id);
          else editor.createEffectStyle(name, nodes[0].id);
          return;
        }
        editor.applyStyle(
          nodes.map((n) => n.id),
          kind,
          value,
        );
      }}
    >
      {current === null && <option value="">Mixed</option>}
      <option value="">{current ? 'Detach style' : 'No style'}</option>
      {styles.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
      <option value={CREATE}>Create style…</option>
    </select>
  );
}

function Preview({ style }: { style: Style }) {
  if (style.type === 'text') {
    return (
      <span
        className="style-preview"
        style={{ fontFamily: cssFontFamily(style.fontFamily), fontWeight: style.fontWeight, fontSize: Math.min(18, Math.max(10, style.fontSize * 0.6)) }}
      >
        Ag
      </span>
    );
  }
  const css = cssEffects({ ...createNode('rectangle'), effects: style.effects });
  return <span className="style-preview effect" style={{ boxShadow: css['box-shadow'], backdropFilter: css['backdrop-filter'] }} />;
}

/** Text and effect styles in the Assets tab: apply, rename, update from the selection, delete. */
export function StylesAssets() {
  const editor = useEditorState();
  const selected = editor.selection.map((id) => editor.doc.nodes[id]).filter(Boolean);
  const groups = [
    { kind: 'text' as const, title: 'Text styles' },
    { kind: 'effect' as const, title: 'Effect styles' },
  ];
  if (!editor.doc.styles.length) {
    return <p className="empty-hint">No styles yet. Pick “Create style…” in the Text or Effects section of a selected layer.</p>;
  }
  return (
    <>
      {groups.map(({ kind, title }) => {
        const styles = editor.doc.styles.filter((s) => s.type === kind).sort((a, b) => a.name.localeCompare(b.name));
        if (!styles.length) return null;
        const targets = selected.filter((n) => kind === 'effect' || n.type === 'text');
        const used = (id: string) => Object.values(editor.doc.nodes).filter((n) => n.textStyleId === id || n.effectStyleId === id).length;
        return (
          <section key={kind} className="style-group">
            <h4>{title}</h4>
            <ul className="asset-list">
              {styles.map((s) => (
                <li
                  key={s.id}
                  className="asset style-asset"
                  title={targets.length ? 'Apply to the selection' : 'Select layers to apply this style'}
                  onClick={() => targets.length && editor.applyStyle(targets.map((n) => n.id), kind, s.id)}
                  onDoubleClick={() => {
                    const name = prompt('Rename style', s.name);
                    if (name?.trim()) editor.updateStyle(s.id, { name });
                  }}
                >
                  <Preview style={s} />
                  <span className="asset-text">
                    <span className="component-name">{s.name}</span>
                    <span className="asset-page">
                      {s.type === 'text' ? `${s.fontSize}px · ${s.fontWeight}` : `${s.effects.length} effect${s.effects.length === 1 ? '' : 's'}`} · {used(s.id)} used
                    </span>
                  </span>
                  <span className="asset-actions" onClick={(e) => e.stopPropagation()}>
                    {targets.length === 1 && (
                      <IconButton
                        icon="refresh"
                        title="Update style from the selected layer"
                        onClick={() => editor.updateStyle(s.id, s.type === 'text' ? textStyleValues(targets[0]) : { effects: structuredClone(targets[0].effects) })}
                      />
                    )}
                    <IconButton icon="trash" title="Delete style (layers keep their look)" onClick={() => editor.deleteStyle(s.id)} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
