import { describe, expect, it } from 'vitest';
import { hasOverrides } from '../src/core/components';
import { createDocument, createNode, insertNode, parseDocument } from '../src/core/document';
import { Editor } from '../src/core/editor';
import type { SceneNode } from '../src/core/types';

function setup() {
  const editor = new Editor(createDocument(), { autosave: false });
  const rect = createNode('rectangle', { name: 'Box', x: 0, y: 0, width: 40, height: 40 });
  const label = createNode('text', { name: 'Label', characters: 'Hi', x: 50, y: 0 });
  editor.change((doc) => {
    insertNode(doc, rect, editor.pageId);
    insertNode(doc, label, editor.pageId);
  });
  editor.select([rect.id, label.id]);
  editor.createComponent();
  const compId = editor.selection[0];
  const instId = editor.createInstance(compId, { x: 500, y: 500 })!;
  return { editor, compId, instId, rect, label };
}

const kids = (editor: Editor, id: string): SceneNode[] => editor.doc.nodes[id].children.map((c) => editor.doc.nodes[c]);

describe('components and instances', () => {
  it('creates a component and an instance that mirrors it', () => {
    const { editor, compId, instId } = setup();
    const comp = editor.doc.nodes[compId];
    expect(comp.type).toBe('component');
    const inst = editor.doc.nodes[instId];
    expect(inst).toMatchObject({ type: 'instance', componentId: compId, width: comp.width, height: comp.height });
    expect(kids(editor, instId).map((n) => n.name)).toEqual(['Box', 'Label']);
    expect(kids(editor, instId).every((n) => n.sourceId)).toBe(true);
  });

  it('propagates component edits, additions and removals', () => {
    const { editor, compId, instId, rect } = setup();
    editor.updateNodes([rect.id], { fills: [{ type: 'solid', color: '#FF0000', opacity: 1, visible: true }], cornerRadius: 8 });
    const box = kids(editor, instId)[0];
    expect(box.fills[0]).toMatchObject({ color: '#FF0000' });
    expect(box.cornerRadius).toBe(8);

    const extra = createNode('ellipse', { name: 'Dot', x: 0, y: 0, width: 5, height: 5 });
    editor.change((doc) => insertNode(doc, extra, compId));
    expect(kids(editor, instId).map((n) => n.name)).toEqual(['Box', 'Label', 'Dot']);

    editor.select([extra.id]);
    editor.deleteSelection();
    expect(kids(editor, instId).map((n) => n.name)).toEqual(['Box', 'Label']);
  });

  it('keeps overrides and resets them', () => {
    const { editor, instId, rect } = setup();
    const box = kids(editor, instId)[0];
    editor.updateNodes([box.id], { cornerRadius: 20 });
    editor.updateNodes([rect.id], { cornerRadius: 3, opacity: 0.5 });
    const after = editor.doc.nodes[box.id];
    expect(after.cornerRadius).toBe(20); // overridden
    expect(after.opacity).toBe(0.5); // still follows the component
    expect(hasOverrides(editor.doc, instId)).toBe(true);

    editor.select([box.id]);
    editor.resetInstanceOverrides();
    expect(editor.doc.nodes[box.id].cornerRadius).toBe(3);
    expect(hasOverrides(editor.doc, instId)).toBe(false);
  });

  it('protects instance layers from structural edits', () => {
    const { editor, instId } = setup();
    const box = kids(editor, instId)[0];
    editor.select([box.id]);
    editor.deleteSelection();
    editor.nudge(10, 0);
    expect(editor.doc.nodes[box.id]).toBeDefined();
    expect(editor.doc.nodes[box.id].x).toBe(0);
  });

  it('detaches an instance into a frame', () => {
    const { editor, instId, rect } = setup();
    editor.select([instId]);
    editor.detachInstances();
    expect(editor.doc.nodes[instId].type).toBe('frame');
    editor.updateNodes([rect.id], { cornerRadius: 9 });
    expect(kids(editor, instId)[0].cornerRadius).toBe(0);
  });

  it('duplicates instances and refuses self-nesting', () => {
    const { editor, compId, instId } = setup();
    editor.select([instId]);
    const [dup] = editor.duplicateSelection();
    expect(editor.doc.nodes[dup]).toMatchObject({ type: 'instance', componentId: compId });
    expect(kids(editor, dup)).toHaveLength(2);
    editor.moveLayers([dup], compId, 0);
    expect(editor.doc.nodes[dup].parentId).toBe(editor.pageId);
  });

  it('round-trips through the file format', () => {
    const { editor, instId } = setup();
    const doc = parseDocument(JSON.parse(JSON.stringify(editor.doc)));
    expect(doc.nodes[instId].type).toBe('instance');
  });
});

describe('variables', () => {
  it('binds properties, switches modes and unbinds on manual edit', () => {
    const editor = new Editor(createDocument(), { autosave: false });
    const frame = createNode('frame', { width: 200, height: 200 });
    const rect = createNode('rectangle', { width: 10, height: 10 });
    editor.change((doc) => {
      insertNode(doc, frame, editor.pageId);
      insertNode(doc, rect, frame.id);
    });
    const light = editor.doc.modes[0].id;
    editor.addMode();
    const dark = editor.doc.modes[1].id;
    const colour = editor.addVariable('color');
    editor.setVariableValue(colour, light, '#ffffff');
    editor.setVariableValue(colour, dark, '#111111');
    const radius = editor.addVariable('number');
    editor.setVariableValue(radius, light, 4);
    editor.setVariableValue(radius, dark, 12);

    editor.bindPaint([rect.id], 'fills', 0, colour);
    editor.bindField([rect.id], 'cornerRadius', radius);
    const r = () => editor.doc.nodes[rect.id];
    expect(r().fills[0]).toMatchObject({ color: '#FFFFFF' });
    expect(r().cornerRadius).toBe(4);

    editor.setVariableMode([frame.id], dark);
    expect(r().fills[0]).toMatchObject({ color: '#111111' });
    expect(r().cornerRadius).toBe(12);

    editor.updateNodes([rect.id], { cornerRadius: 1 });
    expect(r().bindings.cornerRadius).toBeUndefined();
    expect(r().cornerRadius).toBe(1);

    editor.deleteVariable(colour);
    expect(r().fills[0]).not.toHaveProperty('variableId');
    expect(r().fills[0]).toMatchObject({ color: '#111111' });
  });

  it('binds text content and visibility', () => {
    const editor = new Editor(createDocument(), { autosave: false });
    const text = createNode('text', { characters: 'a' });
    editor.change((doc) => insertNode(doc, text, editor.pageId));
    const s = editor.addVariable('string');
    const b = editor.addVariable('boolean');
    const mode = editor.doc.modes[0].id;
    editor.setVariableValue(s, mode, 'Hello variables');
    editor.setVariableValue(b, mode, false);
    editor.bindField([text.id], 'characters', s);
    editor.bindField([text.id], 'visible', b);
    expect(editor.doc.nodes[text.id]).toMatchObject({ characters: 'Hello variables', visible: false });
    expect(editor.doc.nodes[text.id].width).toBeGreaterThan(50);
  });
});

describe('component properties', () => {
  function withProps() {
    const editor = new Editor(createDocument(), { autosave: false });
    const label = createNode('text', { name: 'Label', characters: 'Buy' });
    const icon = createNode('ellipse', { name: 'Icon', x: 60, width: 10, height: 10 });
    editor.change((doc) => {
      insertNode(doc, label, editor.pageId);
      insertNode(doc, icon, editor.pageId);
    });
    editor.select([label.id, icon.id]);
    editor.createComponent();
    const compId = editor.selection[0];
    const textProp = editor.addComponentProp(compId, 'text', { nodeId: label.id, field: 'characters' })!;
    const showProp = editor.addComponentProp(compId, 'boolean', { nodeId: icon.id, field: 'visible' })!;
    const instId = editor.createInstance(compId, { x: 400, y: 400 })!;
    const child = (name: string) => kids(editor, instId).find((n) => n.name === name)!;
    return { editor, compId, instId, textProp, showProp, label, icon, child };
  }

  it('creates properties from bound layers with their current values', () => {
    const { editor, compId } = withProps();
    const props = editor.doc.nodes[compId].componentProps;
    expect(props.map((p) => [p.type, p.defaultValue])).toEqual([
      ['text', 'Buy'],
      ['boolean', true],
    ]);
  });

  it('lets each instance set values and follows defaults otherwise', () => {
    const { editor, compId, instId, textProp, showProp, child } = withProps();
    editor.setInstanceProp([instId], textProp, 'Sell');
    editor.setInstanceProp([instId], showProp, false);
    expect(child('Label').characters).toBe('Sell');
    expect(child('Icon').visible).toBe(false);

    const other = editor.createInstance(compId, { x: 800, y: 400 })!;
    const otherLabel = kids(editor, other).find((n) => n.name === 'Label')!;
    expect(otherLabel.characters).toBe('Buy');
    editor.updateComponentProp(compId, textProp, { defaultValue: 'Order' });
    expect(editor.doc.nodes[otherLabel.id].characters).toBe('Order');
    expect(child('Label').characters).toBe('Sell');
  });

  it('routes text edits to the property instead of overriding', () => {
    const { editor, instId, textProp, label, compId, child } = withProps();
    const lbl = child('Label');
    editor.startTextEditing(lbl.id);
    editor.setText(lbl.id, 'Typed');
    editor.finishTextEditing();
    expect(editor.doc.nodes[instId].propValues[textProp]).toBe('Typed');
    expect(editor.doc.nodes[lbl.id].overrides).not.toContain('characters');
    // Editing the main component's text changes the default.
    editor.updateNodes([label.id], { characters: 'Main' });
    expect(editor.doc.nodes[compId].componentProps.find((p) => p.id === textProp)!.defaultValue).toBe('Main');
  });

  it('swaps nested instances', () => {
    const editor = new Editor(createDocument(), { autosave: false });
    const a = createNode('rectangle', { name: 'Square', width: 10, height: 10 });
    const b = createNode('ellipse', { name: 'Round', width: 20, height: 20 });
    editor.change((doc) => {
      insertNode(doc, a, editor.pageId);
      insertNode(doc, b, editor.pageId);
    });
    editor.select([a.id]);
    editor.createComponent();
    const squareComp = editor.selection[0];
    editor.select([b.id]);
    editor.createComponent();
    const roundComp = editor.selection[0];
    const nested = editor.createInstance(squareComp, { x: 500, y: 500 })!;
    editor.select([nested]);
    editor.createComponent();
    const card = editor.selection[0];
    const swap = editor.addComponentProp(card, 'instance', { nodeId: nested, field: 'componentId' })!;
    const inst = editor.createInstance(card, { x: 900, y: 900 })!;
    const nestedCopy = () => editor.doc.nodes[editor.doc.nodes[inst].children[0]];
    expect(kids(editor, nestedCopy().id)[0].name).toBe('Square');
    editor.setInstanceProp([inst], swap, roundComp);
    expect(nestedCopy().componentId).toBe(roundComp);
    expect(kids(editor, nestedCopy().id)[0].name).toBe('Round');
    // The main component keeps its default.
    expect(editor.doc.nodes[nested].componentId).toBe(squareComp);
  });

  it('unbinds layers when a property is deleted', () => {
    const { editor, compId, textProp, label } = withProps();
    editor.deleteComponentProp(compId, textProp);
    expect(editor.doc.nodes[label.id].propBindings.characters).toBeUndefined();
    expect(editor.doc.nodes[label.id].characters).toBe('Buy');
  });
});
