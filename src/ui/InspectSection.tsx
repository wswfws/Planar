import { useState } from 'react';
import type { Editor } from '../core/editor';
import type { Paint, SceneNode } from '../core/types';
import { Section } from './controls';

function Copy({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="inspect-value"
      title="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1000);
        }, () => undefined);
      }}
    >
      {done ? 'Copied' : (label ?? value)}
    </button>
  );
}

function paintLabel(editor: Editor, p: Paint): string | null {
  if (!p.visible) return null;
  if (p.type === 'image') return 'image';
  const v = p.variableId ? editor.doc.variables.find((x) => x.id === p.variableId) : null;
  return `${p.color.toUpperCase()}${p.opacity < 1 ? ` ${Math.round(p.opacity * 100)}%` : ''}${v ? ` · ${v.name}` : ''}`;
}

/** Developer view of one layer: measurements and colours that copy on click, plus distance lines on hover. */
export function InspectSection({ editor, node }: { editor: Editor; node: SceneNode }) {
  const on = editor.inspect || editor.readOnly;
  const round = (n: number) => String(Math.round(n * 100) / 100);
  const fills = node.fills.map((p) => paintLabel(editor, p)).filter((x): x is string => !!x);
  const strokes = node.strokes.map((p) => paintLabel(editor, p)).filter((x): x is string => !!x);
  return (
    <Section
      title="Inspect"
      actions={
        <label className="hint check-row" title="Show distances to the layer under the pointer">
          <input type="checkbox" checked={on} disabled={editor.readOnly} onChange={(e) => ((editor.inspect = e.target.checked), editor.emit())} /> Distances
        </label>
      }
    >
      <div className="inspect-grid">
        <span className="hint">Size</span>
        <Copy value={`${round(node.width)} × ${round(node.height)}`} />
        <span className="hint">Position</span>
        <Copy value={`${round(node.x)}, ${round(node.y)}`} />
        {node.cornerRadius > 0 && (
          <>
            <span className="hint">Radius</span>
            <Copy value={round(node.cornerRadius)} />
          </>
        )}
        {node.layoutMode !== 'none' && (
          <>
            <span className="hint">Gap</span>
            <Copy value={round(node.itemSpacing)} />
            <span className="hint">Padding</span>
            <Copy value={[node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map(round).join(' ')} />
          </>
        )}
        {node.type === 'text' && (
          <>
            <span className="hint">Font</span>
            <Copy value={`${node.fontFamily} ${node.fontWeight} ${round(node.fontSize)}px`} />
          </>
        )}
        {fills.length > 0 && <span className="hint">Fill</span>}
        {fills.length > 0 && (
          <span className="inspect-list">
            {fills.map((f, i) => (
              <Copy key={i} value={f.split(' ')[0]} label={f} />
            ))}
          </span>
        )}
        {strokes.length > 0 && <span className="hint">Stroke</span>}
        {strokes.length > 0 && (
          <span className="inspect-list">
            {strokes.map((f, i) => (
              <Copy key={i} value={f.split(' ')[0]} label={`${f}${node.strokeWidth ? ` · ${round(node.strokeWidth)}px` : ''}`} />
            ))}
          </span>
        )}
      </div>
    </Section>
  );
}
