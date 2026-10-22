import { describe, expect, it } from 'vitest';
import { applyProps, applyStyleSpec, describe as describeLayer } from '../src/agent/props';
import { generateCode, generateTokens } from '../src/codegen/codegen';
import { createDocument, createNode, insertNode, parseDocument } from '../src/core/document';
import { parseShadows } from '../src/core/effects';
import { Editor } from '../src/core/editor';
import { ChangeTracker, applyOps } from '../src/core/ops';

function setup() {
  const editor = new Editor(createDocument(), { autosave: false });
  const a = createNode('text', { name: 'A', characters: 'Hello', fontSize: 32, fontWeight: 700 });
  const b = createNode('text', { name: 'B', characters: 'World', fontSize: 12 });
  editor.change((d) => {
    insertNode(d, a, editor.pageId);
    insertNode(d, b, editor.pageId);
  });
  return { editor, a, b };
}

describe('styles', () => {
  it('a text style made from a layer is followed by every layer using it', () => {
    const { editor, a, b } = setup();
    editor.select([a.id]);
    const id = editor.createTextStyle('Heading/H1', a.id)!;
    editor.applyStyle([b.id], 'text', id);
    expect(editor.doc.nodes[b.id]).toMatchObject({ fontSize: 32, fontWeight: 700, textStyleId: id });
    editor.updateStyle(id, { fontSize: 40 });
    expect(editor.doc.nodes[a.id].fontSize).toBe(40);
    expect(editor.doc.nodes[b.id].fontSize).toBe(40);
    // The text box grows with the font.
    expect(editor.doc.nodes[b.id].height).toBeGreaterThan(30);
  });

  it('editing a styled field by hand detaches; deleting a style keeps the look', () => {
    const { editor, a, b } = setup();
    const id = editor.createTextStyle('Body', a.id)!;
    editor.applyStyle([b.id], 'text', id);
    editor.updateNodes([a.id], { fontSize: 20 });
    expect(editor.doc.nodes[a.id].textStyleId).toBe('');
    editor.updateNodes([b.id], { characters: 'Still styled' });
    expect(editor.doc.nodes[b.id].textStyleId).toBe(id);
    editor.deleteStyle(id);
    expect(editor.doc.nodes[b.id]).toMatchObject({ textStyleId: '', fontSize: 32 });
    editor.undo();
    expect(editor.doc.nodes[b.id].textStyleId).toBe(id);
  });

  it('effect styles drive effects', () => {
    const editor = new Editor(createDocument(), { autosave: false });
    const card = createNode('rectangle', { name: 'Card', effects: parseShadows('0 2 4 #000000 20%') });
    const other = createNode('rectangle', { name: 'Other' });
    editor.change((d) => {
      insertNode(d, card, editor.pageId);
      insertNode(d, other, editor.pageId);
    });
    const id = editor.createEffectStyle('Shadow/Card', card.id)!;
    editor.applyStyle([other.id], 'effect', id);
    editor.updateStyle(id, { effects: parseShadows('0 8 24 #000000 30%') });
    expect(editor.doc.nodes[other.id].effects[0]).toMatchObject({ y: 8, radius: 24 });
    expect(generateCode(editor.doc, other.id, 'css').code).toContain('box-shadow: var(--shadow-shadow-card)');
    expect(generateTokens(editor.doc, 'css')).toContain('--shadow-shadow-card: 0 8px 24px rgba(0, 0, 0, 0.3);');
    editor.updateNodes([other.id], (n) => (n.effects = []));
    expect(editor.doc.nodes[other.id].effectStyleId).toBe('');
  });

  it('syncs through ops, survives save/load and drops broken entries', () => {
    const { editor, a } = setup();
    const tracker = new ChangeTracker();
    tracker.reset(editor.doc);
    editor.createTextStyle('Body', a.id);
    const ops = tracker.collect(editor.doc);
    expect(ops.some((op) => op.o === 'meta' && op.key === 'styles')).toBe(true);
    const copy = structuredClone(editor.doc);
    copy.styles = [];
    applyOps(copy, ops);
    expect(copy.styles.map((s) => s.name)).toEqual(['Body']);

    const raw = JSON.parse(JSON.stringify(editor.doc));
    raw.styles.push({ id: 'x', name: 'Bad', type: 'paint' }, { id: 'y', name: 'Fx', type: 'effect', effects: [{ type: 'drop-shadow', radius: 3 }] });
    const parsed = parseDocument(raw);
    expect(parsed.styles.map((s) => s.name)).toEqual(['Body', 'Fx']);
    delete raw.styles;
    expect(parseDocument(raw).styles).toEqual([]);
  });

  it('agents create styles and apply them by name', () => {
    const { editor, a, b } = setup();
    applyStyleSpec(editor, { name: 'Caption', type: 'text', size: 11, weight: 'medium' });
    applyStyleSpec(editor, { name: 'Lifted', type: 'effect', shadow: '0 4 12 #000000 25%' });
    applyProps(editor, b.id, { textStyle: 'caption', effectStyle: 'Lifted' });
    expect(editor.doc.nodes[b.id]).toMatchObject({ fontSize: 11, fontWeight: 500 });
    expect(describeLayer(editor.doc, editor.doc.nodes[b.id])).toMatchObject({ textStyle: 'Caption', effectStyle: 'Lifted', size: 11 });
    applyStyleSpec(editor, { name: 'Caption', from: a.id });
    expect(editor.doc.nodes[b.id].fontSize).toBe(32);
    expect(() => applyProps(editor, b.id, { textStyle: 'Nope' })).toThrow(/Unknown text style "Nope"/);
    expect(() => applyStyleSpec(editor, { name: 'Untyped' })).toThrow(/needs a type/);
  });
});
