import { useState } from 'react';
import { containingComponent, PROP_FIELDS, propOwner, propValue, swapCandidates } from '../core/components';
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
            {c.name}
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
  const comp = editor.doc.nodes[instance.componentId];
  if (!comp || !comp.componentProps.length) return null;
  return (
    <Section title="Properties">
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
  const comp = containingComponent(editor.doc, node.id);
  if (!comp) return null;
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
