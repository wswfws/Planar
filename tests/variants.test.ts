import { describe, expect, it } from 'vitest';
import { axisValues, variantAxes, variantsOf } from '../src/core/components';
import { createDocument, createNode, insertNode } from '../src/core/document';
import { Editor } from '../src/core/editor';

function makeSet() {
  const editor = new Editor(createDocument(), { autosave: false });
  const ids: string[] = [];
  for (const [i, name] of ['Primary', 'Secondary'].entries()) {
    const frame = createNode('frame', { name, x: i * 200, width: 120, height: 40 });
    const label = createNode('text', { name: 'Label', characters: name });
    editor.change((doc) => {
      insertNode(doc, frame, editor.pageId);
      insertNode(doc, label, frame.id);
    });
    editor.select([frame.id]);
    editor.createComponent();
    ids.push(frame.id);
  }
  editor.select(ids);
  editor.combineAsVariants();
  return { editor, setId: editor.selection[0], primary: ids[0], secondary: ids[1] };
}

describe('variants', () => {
  it('combines components into a set with a variant property', () => {
    const { editor, setId, primary } = makeSet();
    const set = editor.doc.nodes[setId];
    expect(set.type).toBe('componentSet');
    expect(variantsOf(editor.doc, setId)).toHaveLength(2);
    expect(variantAxes(editor.doc, setId)).toEqual(['Property 1']);
    expect(editor.doc.nodes[primary].name).toBe('Property 1=Primary');
    // The set wraps its variants with padding.
    expect(set.width).toBeGreaterThan(320);
  });

  it('adds variants and axes and renames axes', () => {
    const { editor, setId } = makeSet();
    editor.addVariant(setId);
    expect(variantsOf(editor.doc, setId)).toHaveLength(3);
    expect(axisValues(editor.doc, setId, 'Property 1')).toContain('Variant 3');
    editor.addVariantAxis(setId);
    editor.renameVariantAxis(setId, 'Property 1', 'Type');
    editor.renameVariantAxis(setId, 'Property 2', 'Size');
    expect(variantAxes(editor.doc, setId)).toEqual(['Type', 'Size']);
    expect(variantsOf(editor.doc, setId)[0].name).toBe('Type=Primary, Size=Default');
  });

  it('switches instance variants and keeps overrides on matching layers', () => {
    const { editor, setId, secondary } = makeSet();
    const inst = editor.createInstance(setId, { x: 0, y: 500 })!;
    const label = () => editor.doc.nodes[editor.doc.nodes[inst].children[0]];
    editor.updateNodes([label().id], { fills: [{ type: 'solid', color: '#FF0000', opacity: 1, visible: true }] });
    editor.setInstanceVariant([inst], 'Property 1', 'Secondary');
    expect(editor.doc.nodes[inst].componentId).toBe(secondary);
    expect(label().characters).toBe('Secondary');
    expect(label().fills[0]).toMatchObject({ color: '#FF0000' });
  });

  it('shares component properties across variants', () => {
    const { editor, setId, primary } = makeSet();
    const text = editor.doc.nodes[primary].children[0];
    const prop = editor.addComponentProp(primary, 'text', { nodeId: text, field: 'characters' })!;
    expect(editor.doc.nodes[setId].componentProps.map((p) => p.id)).toEqual([prop]);
    const inst = editor.createInstance(setId, { x: 0, y: 500 })!;
    editor.setInstanceProp([inst], prop, 'Hello');
    expect(editor.doc.nodes[editor.doc.nodes[inst].children[0]].characters).toBe('Hello');
  });
});

describe('variant naming', () => {
  it('gives same-named components distinct values', () => {
    const editor = new Editor(createDocument(), { autosave: false });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const f = createNode('frame', { name: 'Card', x: i * 200 });
      editor.change((doc) => insertNode(doc, f, editor.pageId));
      editor.select([f.id]);
      editor.createComponent();
      ids.push(f.id);
    }
    editor.select(ids);
    editor.combineAsVariants();
    expect(ids.map((id) => editor.doc.nodes[id].name)).toEqual(['Property 1=Card', 'Property 1=Card 2']);
  });
});

describe('ungrouping a set', () => {
  it('releases variants as components that keep the shared properties', () => {
    const { editor, setId, primary } = makeSet();
    const text = editor.doc.nodes[primary].children[0];
    const prop = editor.addComponentProp(primary, 'text', { nodeId: text, field: 'characters' })!;
    editor.select([setId]);
    editor.ungroup();
    expect(editor.doc.nodes[setId]).toBeUndefined();
    expect(editor.doc.nodes[primary].type).toBe('component');
    expect(editor.doc.nodes[primary].componentProps.map((p) => p.id)).toEqual([prop]);
  });
});
