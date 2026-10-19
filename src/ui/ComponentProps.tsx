import { useState } from 'react';
import {
  axisValues,
  containingComponent,
  PROP_FIELDS,
  propHost,
  propOwner,
  propValue,
  swapCandidates,
  variantAxes,
  variantSet,
  variantsOf,
} from '../core/components';
import type { Editor } from '../core/editor';
import type { ComponentProp, ComponentPropType, SceneNode } from '../core/types';
import { IconButton, Section } from './controls';

const TYPE_LABEL: Record<ComponentPropType, string> = { text: 'Text', boolean: 'Boolean', instance: 'Instance swap' };
const TYPE_BADGE: Record<ComponentPropType, string> = { text: 'T', boolean: '◑', instance: '◇' };

/** Text input that commits on blur / Enter. */
export function TextField({ value, onCommit, label, multiline }: { value: string; onCommit: (v: string) => void; label: string; multiline?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const props = {
    className: 'text-field',
    'aria-label': label,
    title: label,
    value: draft ?? value,
    onFocus: () => setDraft(value),
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => {
      if (draft !== null && draft !== value) onCommit(draft);
      setDraft(null);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        setDraft(value);
        (e.target as HTMLElement).blur();
      }
      if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) (e.target as HTMLElement).blur();
    },
  };
  return multiline ? <textarea rows={1} {...props} /> : <input {...props} />;
}

function ValueEditor({
  editor,
  prop,
  value,
  componentId,
  onChange,
}: {
  editor: Editor;
  prop: ComponentProp;
  value: string | boolean;
  componentId: string;
  onChange: (v: string | boolean) => void;
}) {
  if (prop.type === 'boolean') {
    return (
      <label className="switch" title={prop.name}>
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        <span>{value ? 'On' : 'Off'}</span>
      </label>
    );
  }
  if (prop.type === 'instance') {
    const options = swapCandidates(editor.doc, componentId);
    return (
      <select aria-label={prop.name} value={String(value)} onChange={(e) => onChange(e.target.value)}>
        {!options.some((c) => c.id === value) && <option value={String(value)}>(missing)</option>}
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {componentLabel(editor, c)}
          </option>
        ))}
      </select>
    );
  }
  return <TextField label={prop.name} value={String(value)} onCommit={onChange} multiline />;
}

/** Main component: declare, rename, set defaults, delete properties. */
export function ComponentPropsSection({ editor, component }: { editor: Editor; component: SceneNode }) {
  return (
    <Section title="Properties">
      {component.componentProps.length === 0 && (
        <p className="hint">Add properties so each instance can change text, show or hide layers, or swap a nested instance.</p>
      )}
      {component.componentProps.map((p) => (
        <div className="prop-row" key={p.id}>
          <div className="prop-head">
            <span className="prop-badge" title={TYPE_LABEL[p.type]}>
              {TYPE_BADGE[p.type]}
            </span>
            <TextField label="Property name" value={p.name} onCommit={(name) => editor.updateComponentProp(component.id, p.id, { name })} />
            <IconButton icon="minus" title="Delete property" onClick={() => editor.deleteComponentProp(component.id, p.id)} />
          </div>
          <ValueEditor
            editor={editor}
            prop={p}
            value={p.type === 'boolean' ? p.defaultValue !== false : String(p.defaultValue)}
            componentId={component.id}
            onChange={(defaultValue) => editor.updateComponentProp(component.id, p.id, { defaultValue })}
          />
        </div>
      ))}
      <div className="button-row">
        {(['text', 'boolean', 'instance'] as ComponentPropType[]).map((t) => (
          <button key={t} type="button" className="small-button" onClick={() => editor.addComponentProp(component.id, t)}>
            + {TYPE_LABEL[t]}
          </button>
        ))}
      </div>
    </Section>
  );
}

/** Instance: set this instance's value for each property of its component. */
export function InstancePropsSection({ editor, instance }: { editor: Editor; instance: SceneNode }) {
  const main = editor.doc.nodes[instance.componentId];
  const comp = main ? propHost(editor.doc, main) : null;
  const hasVariants = !!(main && variantSet(editor.doc, main.id));
  if (!main || !comp || (!comp.componentProps.length && !hasVariants)) return null;
  return (
    <Section title="Properties">
      <InstanceVariantSelects editor={editor} instance={instance} />
      {comp.componentProps.map((p) => {
        const isSet = p.id in instance.propValues;
        return (
          <div className="prop-row" key={p.id}>
            <div className="prop-head">
              <span className="prop-badge" title={TYPE_LABEL[p.type]}>
                {TYPE_BADGE[p.type]}
              </span>
              <span className="prop-name">{p.name}</span>
              {isSet && (
                <button
                  type="button"
                  className="link-button"
                  title="Use the component's default"
                  onClick={() =>
                    editor.updateNodes([instance.id], (n) => {
                      const { [p.id]: _reset, ...rest } = n.propValues;
                      n.propValues = rest;
                    })
                  }
                >
                  Reset
                </button>
              )}
            </div>
            <ValueEditor
              editor={editor}
              prop={p}
              value={propValue(instance, p)}
              componentId={comp.id}
              onChange={(v) => editor.setInstanceProp([instance.id], p.id, v)}
            />
          </div>
        );
      })}
    </Section>
  );
}

const FIELD_LABEL: Record<string, string> = { characters: 'Content', visible: 'Visibility', componentId: 'Swap' };

/** A layer inside a main component: bind its content / visibility / swap to properties. */
export function LayerPropBindings({ editor, node }: { editor: Editor; node: SceneNode }) {
  const main = containingComponent(editor.doc, node.id);
  if (!main) return null;
  const comp = propHost(editor.doc, main);
  const fields = Object.keys(PROP_FIELDS).filter(
    (f) => f === 'visible' || (f === 'characters' && node.type === 'text') || (f === 'componentId' && node.type === 'instance'),
  );
  return (
    <Section title={`Property of ${comp.name}`}>
      {fields.map((field) => {
        const type = PROP_FIELDS[field];
        const options = comp.componentProps.filter((p) => p.type === type);
        const bound = node.propBindings[field];
        const valid = bound && propOwner(editor.doc, node.id, bound);
        return (
          <label className="labeled-select" key={field}>
            {FIELD_LABEL[field]}
            <select
              value={valid ? bound : ''}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '__new') editor.addComponentProp(comp.id, type, { nodeId: node.id, field });
                else editor.bindComponentProp(node.id, field, v || null);
              }}
            >
              <option value="">Not bound</option>
              {options.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="__new">+ Create property</option>
            </select>
          </label>
        );
      })}
    </Section>
  );
}

/** Component set: variant properties (axes) and adding variants. */
export function VariantSetSection({ editor, set }: { editor: Editor; set: SceneNode }) {
  const axes = variantAxes(editor.doc, set.id);
  const variants = variantsOf(editor.doc, set.id);
  return (
    <Section title="Variants">
      <p className="hint">
        {variants.length} variant{variants.length === 1 ? '' : 's'}. Instances pick a variant with one selector per property.
      </p>
      {axes.map((axis) => (
        <div className="prop-head" key={axis}>
          <span className="prop-badge" title="Variant property">
            ▤
          </span>
          <TextField label="Variant property name" value={axis} onCommit={(name) => editor.renameVariantAxis(set.id, axis, name)} />
          <span className="axis-values" title={axisValues(editor.doc, set.id, axis).join(', ')}>
            {axisValues(editor.doc, set.id, axis).length} values
          </span>
          <IconButton icon="minus" title="Remove variant property" onClick={() => editor.removeVariantAxis(set.id, axis)} />
        </div>
      ))}
      <div className="button-row">
        <button type="button" className="small-button" onClick={() => editor.addVariant(set.id)}>
          + Variant
        </button>
        <button type="button" className="small-button" onClick={() => editor.addVariantAxis(set.id)}>
          + Variant property
        </button>
      </div>
    </Section>
  );
}

/** A variant: its value for each variant property of the set. */
export function VariantValuesSection({ editor, variant }: { editor: Editor; variant: SceneNode }) {
  const set = variantSet(editor.doc, variant.id);
  if (!set) return null;
  return (
    <Section title={`Variant of ${set.name}`}>
      <div className="grid-2">
        {variantAxes(editor.doc, set.id).map((axis) => (
          <label className="stacked-field" key={axis}>
            <span>{axis}</span>
            <TextField label={axis} value={variant.variantProps[axis] ?? ''} onCommit={(v) => editor.setVariantValue(variant.id, axis, v)} />
          </label>
        ))}
      </div>
      <button type="button" className="small-button" onClick={() => editor.addVariant(variant.id)}>
        + Variant like this
      </button>
    </Section>
  );
}

/** Instance of a variant: one selector per variant property. */
function InstanceVariantSelects({ editor, instance }: { editor: Editor; instance: SceneNode }) {
  const comp = editor.doc.nodes[instance.componentId];
  const set = comp ? variantSet(editor.doc, comp.id) : null;
  if (!comp || !set) return null;
  return (
    <>
      {variantAxes(editor.doc, set.id).map((axis) => (
        <label className="labeled-select" key={axis}>
          {axis}
          <select value={comp.variantProps[axis] ?? ''} onChange={(e) => editor.setInstanceVariant([instance.id], axis, e.target.value)}>
            {axisValues(editor.doc, set.id, axis).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      ))}
    </>
  );
}

/** Label for a component in pickers: "Set / Variant" for variants. */
export function componentLabel(editor: Editor, c: SceneNode): string {
  const set = variantSet(editor.doc, c.id);
  return set ? `${set.name} / ${c.name}` : c.name;
}
