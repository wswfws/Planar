import type { Editor } from '../core/editor';
import { defaultEffect, EFFECT_LABELS, EFFECT_TYPES, isShadow } from '../core/effects';
import type { Effect, EffectType, SceneNode } from '../core/types';
import { ColorField, IconButton, NumberField, Section } from './controls';

/** Shadows and blurs of the selected layers. */
export function EffectsSection({ editor, nodes }: { editor: Editor; nodes: SceneNode[] }) {
  const ids = nodes.map((n) => n.id);
  const effects = nodes[0].effects;
  const mixed = nodes.some((n) => JSON.stringify(n.effects) !== JSON.stringify(effects));
  const setEffects = (next: Effect[]) => editor.updateNodes(ids, (n) => (n.effects = structuredClone(next)));
  const update = (i: number, patch: Partial<Effect>) => setEffects(effects.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  return (
    <Section
      title="Effects"
      actions={<IconButton icon="plus" title="Add drop shadow" onClick={() => setEffects([...(mixed ? [] : effects), defaultEffect('drop-shadow')])} />}
    >
      {mixed ? (
        <p className="hint">Mixed — click + to replace for all selected layers.</p>
      ) : (
        effects.map((e, i) => (
          <div className="effect" key={i}>
            <div className="paint-row">
              <select
                value={e.type}
                aria-label="Effect type"
                onChange={(ev) => {
                  const type = ev.target.value as EffectType;
                  // Keep the numbers when switching between the two shadows.
                  update(i, isShadow(e) && isShadow({ ...e, type }) ? { type } : { ...defaultEffect(type), visible: e.visible });
                }}
              >
                {EFFECT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {EFFECT_LABELS[t]}
                  </option>
                ))}
              </select>
              <IconButton icon={e.visible ? 'eye' : 'eyeOff'} title={e.visible ? 'Hide' : 'Show'} onClick={() => update(i, { visible: !e.visible })} />
              <IconButton icon="minus" title="Remove" onClick={() => setEffects(effects.filter((_, j) => j !== i))} />
            </div>
            {isShadow(e) ? (
              <>
                <div className="row">
                  <NumberField label="X" title="Offset X" value={e.x} onChange={(x) => update(i, { x })} />
                  <NumberField label="Y" title="Offset Y" value={e.y} onChange={(y) => update(i, { y })} />
                </div>
                <div className="row">
                  <NumberField label="B" title="Blur" value={e.radius} min={0} onChange={(radius) => update(i, { radius })} />
                  <NumberField label="S" title="Spread" value={e.spread} onChange={(spread) => update(i, { spread })} />
                </div>
                <div className="paint-row">
                  <ColorField value={e.color} onChange={(color) => update(i, { color })} />
                  <NumberField
                    label=""
                    value={Math.round(e.opacity * 100)}
                    min={0}
                    max={100}
                    precision={0}
                    suffix="%"
                    title="Opacity"
                    onChange={(v) => update(i, { opacity: v / 100 })}
                  />
                </div>
              </>
            ) : (
              <div className="row">
                <NumberField label="B" title="Blur" value={e.radius} min={0} onChange={(radius) => update(i, { radius })} />
              </div>
            )}
          </div>
        ))
      )}
    </Section>
  );
}
