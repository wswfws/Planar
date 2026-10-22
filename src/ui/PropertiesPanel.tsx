import { useState } from 'react';
import { solid } from '../core/document';
import type { AlignKind, Editor } from '../core/editor';
import { hasOverrides, isInInstance, owningInstance, propHost } from '../core/components';
import { POPULAR_FONTS } from '../core/fonts';
import { scaleContents } from '../core/geometry';
import { effectiveSizing, isAutoLayout, isLaidOut } from '../core/layout';
import { isFrameLike, type CounterAlign, type Paint, type PrimaryAlign, type SceneNode, type Sizing, type TextAlign, type TextAlignVertical } from '../core/types';
import { BINDABLE } from '../core/variables';
import { CodeSection } from './CodeSection';
import { PrototypeSection } from './PrototypeSection';
import { ComponentPropsSection, InstancePropsSection, LayerPropBindings, VariantSetSection, VariantValuesSection } from './ComponentProps';
import { ColorField, IconButton, NumberField, Section, type BindProps } from './controls';
import { useEditorState } from './EditorContext';
import type { IconName } from './icons';

const SYSTEM_FONTS = [
  { label: 'System UI', value: 'system-ui, sans-serif' },
  { label: 'Arial / Helvetica', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Georgia', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Monospace', value: 'ui-monospace, "Cascadia Code", Consolas, monospace' },
];

/** Font family: free text with suggestions (any Google Fonts family loads automatically). */
function FontField({ value, onChange }: { value: string | null; onChange: (family: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const label = (v: string) => SYSTEM_FONTS.find((f) => f.value === v)?.label ?? v;
  const commit = () => {
    if (draft === null) return;
    const typed = draft.trim();
    const system = SYSTEM_FONTS.find((f) => f.label.toLowerCase() === typed.toLowerCase());
    const next = system ? system.value : typed;
    if (next && next !== value) onChange(next);
    setDraft(null);
  };
  return (
    <>
      <input
        className="text-field font-field"
        aria-label="Font family"
        list="planar-fonts"
        placeholder={value === null ? 'Mixed' : 'Font family'}
        value={draft ?? (value === null ? '' : label(value))}
        onFocus={(e) => {
          setDraft(e.target.value);
          e.target.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <datalist id="planar-fonts">
        {SYSTEM_FONTS.map((f) => (
          <option key={f.value} value={f.label} />
        ))}
        {POPULAR_FONTS.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
    </>
  );
}

const WEIGHTS = [
  [100, 'Thin'],
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'Semibold'],
  [700, 'Bold'],
  [900, 'Black'],
] as const;

const ALIGN_BUTTONS: { kind: AlignKind; icon: IconName; title: string }[] = [
  { kind: 'left', icon: 'alignLeft', title: 'Align left' },
  { kind: 'hcenter', icon: 'alignHCenter', title: 'Align horizontal centers' },
  { kind: 'right', icon: 'alignRight', title: 'Align right' },
  { kind: 'top', icon: 'alignTop', title: 'Align top' },
  { kind: 'vcenter', icon: 'alignVCenter', title: 'Align vertical centers' },
  { kind: 'bottom', icon: 'alignBottom', title: 'Align bottom' },
];

function common<T>(nodes: SceneNode[], get: (n: SceneNode) => T): T | null {
  if (!nodes.length) return null;
  const first = get(nodes[0]);
  return nodes.every((n) => get(n) === first) ? first : null;
}

function PaintList({
  title,
  nodes,
  field,
  editor,
}: {
  title: string;
  nodes: SceneNode[];
  field: 'fills' | 'strokes';
  editor: Editor;
}) {
  const ids = nodes.map((n) => n.id);
  const paints = nodes[0][field];
  const mixed = nodes.some((n) => JSON.stringify(n[field]) !== JSON.stringify(paints));
  const setPaints = (next: Paint[]) => editor.updateNodes(ids, (n) => (n[field] = structuredClone(next)));
  const update = (i: number, patch: Partial<Paint>) => setPaints(paints.map((p, j) => (j === i ? ({ ...p, ...patch } as Paint) : p)));
  const defaultColor = field === 'strokes' || nodes[0].type === 'text' ? '#000000' : '#D9D9D9';

  return (
    <Section
      title={title}
      actions={<IconButton icon="plus" title={`Add ${field === 'fills' ? 'fill' : 'stroke'}`} onClick={() => setPaints([...(mixed ? [] : paints), solid(defaultColor)])} />}
    >
      {mixed ? (
        <p className="hint">Mixed — click + to replace for all selected layers.</p>
      ) : (
        [...paints.keys()].reverse().map((i) => {
          const p = paints[i];
          return (
            <div className="paint-row" key={i}>
              {p.type === 'solid' ? (
                <ColorField
                  value={p.color}
                  onChange={(color) => update(i, { color, variableId: undefined })}
                  bind={{
                    type: 'color',
                    boundId: nodes.every((n) => {
                      const q = n[field][i];
                      return q?.type === 'solid' && q.variableId === p.variableId;
                    })
                      ? p.variableId
                      : undefined,
                    onBind: (vid) => editor.bindPaint(ids, field, i, vid),
                  }}
                />
              ) : (
                <span className="image-paint">
                  <img src={p.src} alt="" />
                  <select value={p.scaleMode} onChange={(e) => update(i, { scaleMode: e.target.value as 'fill' | 'fit' })}>
                    <option value="fill">Fill</option>
                    <option value="fit">Fit</option>
                  </select>
                </span>
              )}
              <NumberField
                label=""
                value={Math.round(p.opacity * 100)}
                min={0}
                max={100}
                precision={0}
                suffix="%"
                title="Opacity"
                onChange={(v) => update(i, { opacity: v / 100 })}
              />
              <IconButton icon={p.visible ? 'eye' : 'eyeOff'} title={p.visible ? 'Hide' : 'Show'} onClick={() => update(i, { visible: !p.visible })} />
              <IconButton icon="minus" title="Remove" onClick={() => setPaints(paints.filter((_, j) => j !== i))} />
            </div>
          );
        })
      )}
      {field === 'strokes' && !mixed && paints.length > 0 && (
        <div className="row">
          <NumberField
            label="W"
            title="Stroke width"
            value={common(nodes, (n) => n.strokeWidth)}
            min={0}
            onChange={(v) => editor.updateNodes(ids, { strokeWidth: v })}
            bind={bindFor(editor, nodes, 'strokeWidth')}
          />
        </div>
      )}
    </Section>
  );
}

/** Binding props for a node property shared by all selected nodes. */
function bindFor(editor: Editor, nodes: SceneNode[], field: string): BindProps {
  return {
    type: BINDABLE[field],
    boundId: common(nodes, (n) => n.bindings[field]) ?? undefined,
    onBind: (vid) => editor.bindField(nodes.map((n) => n.id), field, vid),
  };
}

const ALIGN_STEPS = ['start', 'center', 'end'] as const;

function AlignGrid({ frame, editor }: { frame: SceneNode; editor: Editor }) {
  const horizontal = frame.layoutMode === 'horizontal';
  const between = frame.primaryAlign === 'space-between';
  return (
    <div className="align-grid" role="group" aria-label="Alignment">
      {[0, 1, 2].flatMap((row) =>
        [0, 1, 2].map((col) => {
          const primary = ALIGN_STEPS[horizontal ? col : row];
          const counter = ALIGN_STEPS[horizontal ? row : col];
          const active = frame.counterAlign === counter && (between || frame.primaryAlign === primary);
          return (
            <button
              key={row * 3 + col}
              type="button"
              className={active ? 'active' : ''}
              title={primary + ' / ' + counter}
              onClick={() =>
                editor.updateNodes([frame.id], {
                  counterAlign: counter as CounterAlign,
                  primaryAlign: (between ? 'space-between' : primary) as PrimaryAlign,
                })
              }
            />
          );
        }),
      )}
    </div>
  );
}

function AutoLayoutSection({ editor, nodes }: { editor: Editor; nodes: SceneNode[] }) {
  const frame = nodes.length === 1 && isAutoLayout(nodes[0]) ? nodes[0] : null;
  const anyOn = nodes.some((n) => isAutoLayout(n));
  const set = (patch: Partial<SceneNode>) => {
    if (frame) editor.updateNodes([frame.id], patch);
  };
  return (
    <Section
      title="Auto layout"
      actions={
        anyOn ? (
          <IconButton icon="minus" title="Remove auto layout (Alt+Shift+A)" onClick={() => editor.removeAutoLayout()} />
        ) : (
          <IconButton icon="plus" title="Add auto layout (Shift+A)" onClick={() => editor.addAutoLayout()} />
        )
      }
    >
      {frame && (
        <>
          <div className="auto-layout">
            <AlignGrid frame={frame} editor={editor} />
            <div className="stack">
              <div className="row">
                <IconButton icon="layoutH" title="Horizontal" active={frame.layoutMode === 'horizontal'} onClick={() => set({ layoutMode: 'horizontal' })} />
                <IconButton icon="layoutV" title="Vertical" active={frame.layoutMode === 'vertical'} onClick={() => set({ layoutMode: 'vertical' })} />
              </div>
              <NumberField
                label={frame.layoutMode === 'horizontal' ? '↔' : '↕'}
                title="Spacing between items"
                value={frame.itemSpacing}
                min={0}
                onChange={(v) => set({ itemSpacing: v })}
                bind={bindFor(editor, [frame], 'itemSpacing')}
              />
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={frame.primaryAlign === 'space-between'}
                  onChange={(e) => set({ primaryAlign: e.target.checked ? 'space-between' : 'start' })}
                />
                Space between
              </label>
            </div>
          </div>
          <div className="grid-2">
            <NumberField label="L" title="Padding left" value={frame.paddingLeft} min={0} onChange={(v) => set({ paddingLeft: v })} bind={bindFor(editor, [frame], 'paddingLeft')} />
            <NumberField label="T" title="Padding top" value={frame.paddingTop} min={0} onChange={(v) => set({ paddingTop: v })} bind={bindFor(editor, [frame], 'paddingTop')} />
            <NumberField label="R" title="Padding right" value={frame.paddingRight} min={0} onChange={(v) => set({ paddingRight: v })} bind={bindFor(editor, [frame], 'paddingRight')} />
            <NumberField label="B" title="Padding bottom" value={frame.paddingBottom} min={0} onChange={(v) => set({ paddingBottom: v })} bind={bindFor(editor, [frame], 'paddingBottom')} />
          </div>
        </>
      )}
    </Section>
  );
}

function BindRow({ label, bind }: { label: string; bind: BindProps }) {
  const editor = useEditorState();
  const options = editor.doc.variables.filter((v) => v.type === bind.type);
  if (!options.length && !bind.boundId) return null;
  return (
    <label className="labeled-select">
      {label}
      <select value={bind.boundId ?? ''} onChange={(e) => bind.onBind(e.target.value || null)}>
        <option value="">No variable</option>
        {options.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function BindVisible({ editor, nodes }: { editor: Editor; nodes: SceneNode[] }) {
  return <BindRow label="Visible" bind={bindFor(editor, nodes, 'visible')} />;
}

type TextSizing = 'width' | 'height' | 'fixed';

function textSizing(n: SceneNode): TextSizing {
  return n.autoWidth ? 'width' : n.autoHeight ? 'height' : 'fixed';
}

const TEXT_SIZING: { mode: TextSizing; label: string; title: string; patch: Partial<SceneNode> }[] = [
  { mode: 'width', label: 'Auto W', title: 'Auto width: grows with the text', patch: { autoWidth: true, autoHeight: true } },
  { mode: 'height', label: 'Auto H', title: 'Auto height: fixed width, wraps', patch: { autoWidth: false, autoHeight: true } },
  { mode: 'fixed', label: 'Fixed', title: 'Fixed size', patch: { autoWidth: false, autoHeight: false } },
];

const SIZING_LABEL: Record<Sizing, string> = { fixed: 'Fixed', hug: 'Hug', fill: 'Fill' };

function SizingRow({ editor, node }: { editor: Editor; node: SceneNode }) {
  const { doc } = editor;
  const laidOut = isLaidOut(doc, node);
  const options = (): Sizing[] => {
    const out: Sizing[] = ['fixed'];
    if (isAutoLayout(node) || node.type === 'text') out.push('hug');
    if (laidOut) out.push('fill');
    return out;
  };
  const apply = (axis: 'h' | 'v', v: Sizing) => {
    if (node.type === 'text' && axis === 'h') {
      editor.updateNodes(
        [node.id],
        v === 'fill'
          ? { sizingH: 'fill' }
          : v === 'hug'
            ? { sizingH: 'fixed', autoWidth: true }
            : { sizingH: 'fixed', autoWidth: false, autoHeight: node.autoWidth || node.autoHeight },
      );
    } else if (node.type === 'text') {
      editor.updateNodes(
        [node.id],
        v === 'fill'
          ? { sizingV: 'fill' }
          : v === 'hug'
            ? { sizingV: 'fixed', autoHeight: true }
            : { sizingV: 'fixed', autoWidth: false, autoHeight: false },
      );
    } else {
      editor.updateNodes([node.id], axis === 'h' ? { sizingH: v } : { sizingV: v });
    }
  };
  const h = options();
  const v = options();
  if (h.length < 2 && v.length < 2) return null;
  const select = (axis: 'h' | 'v', opts: Sizing[], label: string) =>
    opts.length > 1 ? (
      <label className="labeled-select">
        {label}
        <select value={effectiveSizing(doc, node, axis)} onChange={(e) => apply(axis, e.target.value as Sizing)}>
          {opts.map((o) => (
            <option key={o} value={o}>
              {SIZING_LABEL[o]}
            </option>
          ))}
        </select>
      </label>
    ) : (
      <span />
    );
  return (
    <div className="grid-2">
      {select('h', h, 'W')}
      {select('v', v, 'H')}
    </div>
  );
}

function ComponentSection({ editor, node }: { editor: Editor; node: SceneNode }) {
  const { doc } = editor;
  if (node.type === 'component') {
    const count = Object.values(doc.nodes).filter((n) => n.type === 'instance' && n.componentId === node.id).length;
    return (
      <Section title="Main component">
        <p className="hint">
          {count} instance{count === 1 ? '' : 's'}. Changes here update every instance.
        </p>
        <button type="button" className="wide-button" onClick={() => editor.instanceBeside(node.id)}>
          Create instance
        </button>
      </Section>
    );
  }
  const inst = owningInstance(doc, node.id);
  if (!inst) return null;
  const comp = doc.nodes[inst.componentId];
  const isRoot = inst.id === node.id;
  return (
    <Section title={isRoot ? 'Instance' : 'Inside instance'}>
      <p className="hint">
        {comp ? (
          <>
            Of <strong className="component-name">{comp.name}</strong>
          </>
        ) : (
          'Main component was deleted'
        )}
        {!isRoot && ' · position and size follow the component'}
      </p>
      <div className="button-row">
        {comp && (
          <button type="button" className="small-button" onClick={() => editor.goToMainComponent(inst.id)}>
            Go to main
          </button>
        )}
        {hasOverrides(doc, inst.id) && (
          <button type="button" className="small-button" onClick={() => editor.resetInstanceOverrides()}>
            Reset changes
          </button>
        )}
        {isRoot && (
          <button type="button" className="small-button" onClick={() => editor.detachInstances()}>
            Detach
          </button>
        )}
      </div>
    </Section>
  );
}

function ModeSelect({ editor, ids, value }: { editor: Editor; ids: string[]; value: string | null }) {
  if (editor.doc.modes.length < 2) return null;
  return (
    <label className="labeled-select">
      Mode
      <select value={value ?? ''} onChange={(e) => editor.setVariableMode(ids, e.target.value)}>
        <option value="">Auto (inherit)</option>
        {editor.doc.modes.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function ExportSection({ editor, count }: { editor: Editor; count: number }) {
  const [scale, setScale] = useState(2);
  const [format, setFormat] = useState<'png' | 'svg'>('png');
  return (
    <Section title="Export">
      <div className="row">
        <select value={scale} onChange={(e) => setScale(Number(e.target.value))} disabled={format === 'svg'} aria-label="Scale">
          <option value={1}>1×</option>
          <option value={2}>2×</option>
          <option value={3}>3×</option>
        </select>
        <select value={format} onChange={(e) => setFormat(e.target.value as 'png' | 'svg')} aria-label="Format">
          <option value="png">PNG</option>
          <option value="svg">SVG</option>
        </select>
      </div>
      <button type="button" className="wide-button" onClick={() => editor.exportAs(format, scale)}>
        {count ? `Export ${count === 1 ? 'layer' : `${count} layers`}` : 'Export page'}
      </button>
    </Section>
  );
}

export function PropertiesPanel() {
  const editor = useEditorState();
  const nodes = editor.selectedNodes;
  const ids = nodes.map((n) => n.id);

  if (!nodes.length) {
    const bg = editor.page.fills[0];
    return (
      <aside className="sidebar right">
        <Section title="Page">
          <div className="row">
            <ColorField
              value={bg && bg.type === 'solid' ? bg.color : '#1E1E24'}
              onChange={(color) => editor.updateNodes([editor.pageId], (n) => (n.fills = [solid(color)]))}
            />
          </div>
          <ModeSelect editor={editor} ids={[editor.pageId]} value={editor.page.variableMode} />
        </Section>
        <ExportSection editor={editor} count={0} />
        <div className="shortcuts-hint">
          <p>
            <kbd>V</kbd> move · <kbd>F</kbd> frame · <kbd>R</kbd> rectangle · <kbd>O</kbd> ellipse · <kbd>L</kbd> line · <kbd>P</kbd> pen · <kbd>T</kbd> text
          </p>
          <p>
            <kbd>Space</kbd> + drag to pan · <kbd>Ctrl</kbd> + wheel to zoom
          </p>
        </div>
      </aside>
    );
  }

  const single = nodes.length === 1 ? nodes[0] : null;
  const parent = single?.parentId ? editor.doc.nodes[single.parentId] : null;
  const canAlign = nodes.length > 1 || (parent && parent.type !== 'page');
  const texts = nodes.filter((n) => n.type === 'text');
  const textIds = texts.map((n) => n.id);
  const hasCorners = nodes.every((n) => n.type === 'rectangle' || isFrameLike(n));
  const frames = nodes.filter((n) => isFrameLike(n));
  const locked = nodes.some((n) => isInInstance(editor.doc, n.id));
  const paintable = nodes.filter((n) => n.type !== 'group');

  const allLaidOut = nodes.every((n) => isLaidOut(editor.doc, n));
  const setSize = (key: 'width' | 'height', v: number) =>
    editor.updateNodes(ids, (n) => {
      const old = n[key];
      n[key] = Math.max(0, v);
      if (key === 'width') n.sizingH = 'fixed';
      else n.sizingV = 'fixed';
      if (n.type === 'text' && key === 'width') {
        n.autoHeight = n.autoWidth || n.autoHeight;
        n.autoWidth = false;
      }
      if (n.type === 'text' && key === 'height') {
        n.autoWidth = false;
        n.autoHeight = false;
      }
      if (old > 0) scaleContents(editor.doc, n, key === 'width' ? v / old : 1, key === 'height' ? v / old : 1);
    });

  return (
    <aside className="sidebar right">
      <div className="selection-title">
        {single ? single.name : `${nodes.length} layers`}
        <span className="type-badge">{single ? single.type : 'mixed'}</span>
      </div>

      {single && <ComponentSection editor={editor} node={single} />}
      {single?.type === 'componentSet' && <VariantSetSection editor={editor} set={single} />}
      {single?.type === 'component' && <VariantValuesSection editor={editor} variant={single} />}
      {(single?.type === 'component' || single?.type === 'componentSet') && (
        <ComponentPropsSection editor={editor} component={single.type === 'component' ? propHost(editor.doc, single) : single} />
      )}
      {single?.type === 'instance' && <InstancePropsSection editor={editor} instance={single} />}
      {single && <LayerPropBindings editor={editor} node={single} />}

      <Section title="Align">
        <div className="align-row">
          {ALIGN_BUTTONS.map((b) => (
            <IconButton key={b.kind} icon={b.icon} title={b.title} disabled={!canAlign} onClick={() => editor.align(b.kind)} />
          ))}
        </div>
      </Section>

      <Section title="Layout">
        <div className="grid-2">
          <NumberField label="X" disabled={allLaidOut || locked} value={common(nodes, (n) => n.x)} onChange={(v) => editor.updateNodes(ids, { x: v })} />
          <NumberField label="Y" disabled={allLaidOut || locked} value={common(nodes, (n) => n.y)} onChange={(v) => editor.updateNodes(ids, { y: v })} />
          <NumberField label="W" disabled={locked} value={common(nodes, (n) => n.width)} min={0} onChange={(v) => setSize('width', v)} bind={bindFor(editor, nodes, 'width')} />
          <NumberField label="H" disabled={locked} value={common(nodes, (n) => n.height)} min={0} onChange={(v) => setSize('height', v)} bind={bindFor(editor, nodes, 'height')} />
          <NumberField
            label="↻"
            title="Rotation"
            suffix="°"
            disabled={locked}
            value={common(nodes, (n) => n.rotation)}
            onChange={(v) => editor.updateNodes(ids, { rotation: ((((v + 180) % 360) + 360) % 360) - 180 })}
          />
          {hasCorners && (
            <NumberField
              label="◜"
              title="Corner radius"
              value={common(nodes, (n) => n.cornerRadius)}
              min={0}
              onChange={(v) => editor.updateNodes(ids, { cornerRadius: v })}
              bind={bindFor(editor, nodes, 'cornerRadius')}
            />
          )}
        </div>
        {single && !locked && <SizingRow editor={editor} node={single} />}
        {frames.length > 0 && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={frames.every((f) => f.clipContent)}
              onChange={(e) => editor.updateNodes(frames.map((f) => f.id), { clipContent: e.target.checked })}
            />
            Clip content
          </label>
        )}
      </Section>

      <AutoLayoutSection editor={editor} nodes={nodes} />

      <Section title="Layer">
        {parent && isAutoLayout(parent) && single && (
          <label className="checkbox">
            <input type="checkbox" checked={single.layoutAbsolute} onChange={(e) => editor.updateNodes([single.id], { layoutAbsolute: e.target.checked })} />
            Ignore auto layout
          </label>
        )}
        <div className="grid-2">
          <NumberField
            label="◐"
            title="Opacity"
            suffix="%"
            precision={0}
            min={0}
            max={100}
            value={common(nodes, (n) => Math.round(n.opacity * 100))}
            onChange={(v) => editor.updateNodes(ids, { opacity: v / 100 })}
          />
          <BindVisible editor={editor} nodes={nodes} />
        </div>
        {nodes.every((n) => isFrameLike(n)) && <ModeSelect editor={editor} ids={ids} value={common(nodes, (n) => n.variableMode)} />}
      </Section>

      {texts.length > 0 && (
        <Section title="Text">
          <div className="row">
            <FontField
              value={common(texts, (n) => n.fontFamily)}
              onChange={(fontFamily) => editor.updateNodes(textIds, { fontFamily })}
            />
          </div>
          <div className="grid-2">
            <select
              aria-label="Font weight"
              value={common(texts, (n) => n.fontWeight) ?? ''}
              onChange={(e) => editor.updateNodes(textIds, { fontWeight: Number(e.target.value) })}
            >
              {common(texts, (n) => n.fontWeight) === null && <option value="">Mixed</option>}
              {WEIGHTS.map(([w, label]) => (
                <option key={w} value={w}>
                  {label}
                </option>
              ))}
            </select>
            <NumberField
              label="Aa"
              title="Font size"
              value={common(texts, (n) => n.fontSize)}
              min={1}
              onChange={(v) => editor.updateNodes(textIds, { fontSize: v })}
              bind={bindFor(editor, texts, 'fontSize')}
            />
            <NumberField
              label="↕"
              title="Line height (× font size, 0 = auto)"
              step={0.1}
              value={common(texts, (n) => n.lineHeight || null)}
              placeholder={texts.every((n) => !n.lineHeight) ? 'Auto' : 'Mixed'}
              min={0}
              onChange={(v) => editor.updateNodes(textIds, { lineHeight: v })}
              bind={bindFor(editor, texts, 'lineHeight')}
            />
            <div className="align-row">
              {(['left', 'center', 'right'] as TextAlign[]).map((a) => (
                <IconButton
                  key={a}
                  icon={a === 'left' ? 'textLeft' : a === 'center' ? 'textCenter' : 'textRight'}
                  title={`Align text ${a}`}
                  active={common(texts, (n) => n.textAlign) === a}
                  onClick={() => editor.updateNodes(textIds, { textAlign: a })}
                />
              ))}
            </div>
          </div>
          <div className="segmented" role="group" aria-label="Text sizing">
            {TEXT_SIZING.map((m) => (
              <button
                key={m.mode}
                type="button"
                className={common(texts, textSizing) === m.mode ? 'active' : ''}
                title={m.title}
                onClick={() => editor.updateNodes(textIds, m.patch)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="align-row">
            {(['top', 'middle', 'bottom'] as TextAlignVertical[]).map((a) => (
              <IconButton
                key={a}
                icon={a === 'top' ? 'alignTop' : a === 'middle' ? 'alignVCenter' : 'alignBottom'}
                title={`Align text ${a}${common(texts, textSizing) === 'fixed' ? '' : ' (fixed size only)'}`}
                active={common(texts, (n) => n.textAlignVertical) === a}
                onClick={() => editor.updateNodes(textIds, { textAlignVertical: a })}
              />
            ))}
          </div>
          <BindRow label="Content" bind={bindFor(editor, texts, 'characters')} />
        </Section>
      )}

      {paintable.length > 0 && (
        <>
          <PaintList title="Fill" nodes={paintable} field="fills" editor={editor} />
          <PaintList title="Stroke" nodes={paintable} field="strokes" editor={editor} />
        </>
      )}

      {single && single.type !== 'page' && <PrototypeSection editor={editor} node={single} />}
      <ExportSection editor={editor} count={ids.length} />
      {single && <CodeSection editor={editor} id={single.id} />}
    </aside>
  );
}
