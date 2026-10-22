import type { Editor } from '../core/editor';
import type { ConstraintH, ConstraintV, SceneNode } from '../core/types';
import { Section } from './controls';

const H_LABELS: Record<ConstraintH, string> = { left: 'Left', right: 'Right', 'left-right': 'Left & right', center: 'Center', scale: 'Scale' };
const V_LABELS: Record<ConstraintV, string> = { top: 'Top', bottom: 'Bottom', 'top-bottom': 'Top & bottom', center: 'Center', scale: 'Scale' };

/** A click pins one side; Shift-click adds or removes it next to the opposite side. */
function pick<T extends string>(shift: boolean, current: T, side: T, other: T, both: T): T {
  if (!shift) return side;
  if (current === other) return both;
  if (current === both) return other;
  return side;
}

/** How the selected layers follow their parent frame when it is resized. */
export function ConstraintsSection({ editor, nodes }: { editor: Editor; nodes: SceneNode[] }) {
  const ids = nodes.map((n) => n.id);
  const h = nodes.every((n) => n.constraintH === nodes[0].constraintH) ? nodes[0].constraintH : null;
  const v = nodes.every((n) => n.constraintV === nodes[0].constraintV) ? nodes[0].constraintV : null;
  const setH = (constraintH: ConstraintH) => editor.updateNodes(ids, { constraintH });
  const setV = (constraintV: ConstraintV) => editor.updateNodes(ids, { constraintV });
  const on = (active: boolean) => `constraint-bar${active ? ' active' : ''}`;
  return (
    <Section title="Constraints">
      <div className="constraints">
        <svg viewBox="0 0 64 64" width="64" height="64" role="group" aria-label="Constraints">
          <rect x="1" y="1" width="62" height="62" rx="3" className="constraint-frame" />
          <rect x="22" y="22" width="20" height="20" rx="2" className="constraint-box" />
          <g className={on(h === 'left' || h === 'left-right')} onClick={(e) => setH(pick(e.shiftKey, h ?? 'left', 'left', 'right', 'left-right'))}>
            <title>Left (Shift-click: left and right)</title>
            <rect x="2" y="26" width="20" height="12" className="hit" />
            <line x1="6" y1="32" x2="18" y2="32" />
          </g>
          <g className={on(h === 'right' || h === 'left-right')} onClick={(e) => setH(pick(e.shiftKey, h ?? 'left', 'right', 'left', 'left-right'))}>
            <title>Right (Shift-click: left and right)</title>
            <rect x="42" y="26" width="20" height="12" className="hit" />
            <line x1="46" y1="32" x2="58" y2="32" />
          </g>
          <g className={on(v === 'top' || v === 'top-bottom')} onClick={(e) => setV(pick(e.shiftKey, v ?? 'top', 'top', 'bottom', 'top-bottom'))}>
            <title>Top (Shift-click: top and bottom)</title>
            <rect x="26" y="2" width="12" height="20" className="hit" />
            <line x1="32" y1="6" x2="32" y2="18" />
          </g>
          <g className={on(v === 'bottom' || v === 'top-bottom')} onClick={(e) => setV(pick(e.shiftKey, v ?? 'top', 'bottom', 'top', 'top-bottom'))}>
            <title>Bottom (Shift-click: top and bottom)</title>
            <rect x="26" y="42" width="12" height="20" className="hit" />
            <line x1="32" y1="46" x2="32" y2="58" />
          </g>
          <g className={on(h === 'center')} onClick={() => setH('center')}>
            <title>Center horizontally</title>
            <rect x="29" y="23" width="6" height="18" className="hit" />
            <line x1="32" y1="27" x2="32" y2="37" />
          </g>
          <g className={on(v === 'center')} onClick={() => setV('center')}>
            <title>Center vertically</title>
            <rect x="23" y="29" width="18" height="6" className="hit" />
            <line x1="27" y1="32" x2="37" y2="32" />
          </g>
        </svg>
        <div className="stack">
          <select value={h ?? ''} aria-label="Horizontal constraint" onChange={(e) => setH(e.target.value as ConstraintH)}>
            {!h && <option value="">Mixed</option>}
            {Object.entries(H_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <select value={v ?? ''} aria-label="Vertical constraint" onChange={(e) => setV(e.target.value as ConstraintV)}>
            {!v && <option value="">Mixed</option>}
            {Object.entries(V_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Section>
  );
}
