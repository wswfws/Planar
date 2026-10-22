import type { Editor } from '../core/editor';
import { screenOf, screensOf, TRANSITIONS, type Transition } from '../core/prototype';
import type { SceneNode } from '../core/types';
import { Section } from './controls';

/** "On click, go to…" for the selected layer. */
export function PrototypeSection({ editor, node }: { editor: Editor; node: SceneNode }) {
  const own = screenOf(editor.doc, node.id);
  // Other screens of the page; a screen cannot link to itself.
  const targets = screensOf(editor.doc, editor.pageId).filter((id) => id !== node.id && id !== own);
  const link = node.link && editor.doc.nodes[node.link.to] ? node.link : undefined;
  const set = (to: string, transition: Transition) => editor.updateNodes([node.id], { link: to ? { to, transition } : undefined });
  return (
    <Section title="Prototype">
      <div className="row">
        <span className="hint">On click</span>
        <select value={link?.to ?? ''} onChange={(e) => set(e.target.value, link?.transition ?? 'instant')} aria-label="Go to screen">
          <option value="">Nothing</option>
          {targets.map((id) => (
            <option key={id} value={id}>
              Go to {editor.doc.nodes[id].name}
            </option>
          ))}
        </select>
      </div>
      {link && (
        <div className="row">
          <span className="hint">Animation</span>
          <select value={link.transition ?? 'instant'} onChange={(e) => set(link.to, e.target.value as Transition)} aria-label="Transition">
            {TRANSITIONS.map((t) => (
              <option key={t} value={t}>
                {t[0].toUpperCase() + t.slice(1)}
              </option>
            ))}
          </select>
        </div>
      )}
      {!targets.length && <p className="hint">Add another top-level frame to link to it.</p>}
    </Section>
  );
}
