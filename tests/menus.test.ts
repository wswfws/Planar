import { describe, expect, it } from 'vitest';
import { createDocument, createNode, insertNode } from '../src/core/document';
import { Editor } from '../src/core/editor';
import { worldBounds } from '../src/core/geometry';
import { tidy, type MenuEntry, type MenuItem } from '../src/ui/ContextMenu';
import { canvasMenu, selectionMenu } from '../src/ui/menus';

const labels = (entries: MenuEntry[]) => entries.filter((e): e is MenuItem => e !== '-').map((e) => e.label);
const item = (entries: MenuEntry[], label: string) => entries.find((e): e is MenuItem => e !== '-' && e.label === label);

function setup() {
  const editor = new Editor(createDocument(), { autosave: false });
  const a = createNode('rectangle', { name: 'A', x: 0, y: 0, width: 100, height: 100 });
  const b = createNode('ellipse', { name: 'B', x: 50, y: 50, width: 100, height: 100 });
  editor.change((doc) => {
    insertNode(doc, a, editor.pageId);
    insertNode(doc, b, editor.pageId);
  });
  return { editor, a: a.id, b: b.id };
}

describe('context menus', () => {
  it('tidies separators', () => {
    expect(tidy(['-', false, { label: 'x' }, '-', '-', null, { label: 'y' }, '-'])).toEqual([{ label: 'x' }, '-', { label: 'y' }]);
  });

  it('offers canvas actions on empty canvas', () => {
    const { editor } = setup();
    expect(labels(canvasMenu(editor, { x: 0, y: 0 }, () => {}))).toEqual(
      expect.arrayContaining(['Paste here', 'Select all', 'Zoom to fit', 'Variables…']),
    );
  });

  it('lists layers under the pointer and selection actions', () => {
    const { editor, a, b } = setup();
    editor.select([b]);
    const menu = selectionMenu(editor, { x: 75, y: 75 });
    expect(labels(menu)).toEqual(expect.arrayContaining(['Copy', 'Duplicate', 'Delete', 'Order', 'Create component', 'Hide', 'Rename']));
    const under = item(menu, 'Select layer')!.submenu!;
    expect(labels(under)).toEqual(['B', 'A']);
    item(under, 'A')!.action!();
    expect(editor.selection).toEqual([a]);
  });

  it('switches to instance actions for instances', () => {
    const { editor, a } = setup();
    editor.select([a]);
    editor.createComponent();
    const inst = editor.createInstance(editor.selection[0], { x: 500, y: 500 })!;
    editor.select([inst]);
    const menu = selectionMenu(editor);
    expect(labels(menu)).toEqual(expect.arrayContaining(['Go to main component', 'Detach instance']));
    expect(labels(menu)).not.toContain('Create component');
    // Layers inside an instance cannot be deleted.
    editor.select([editor.doc.nodes[inst].children[0]]);
    expect(item(selectionMenu(editor), 'Delete')!.disabled).toBe(true);
  });

  it('pastes at the pointer', () => {
    const { editor, a } = setup();
    editor.select([a]);
    editor.copySelection();
    editor.paste(undefined, { x: 400, y: 300 });
    const b = worldBounds(editor.doc, editor.selection[0]);
    expect(b.x + b.width / 2).toBe(400);
    expect(b.y + b.height / 2).toBe(300);
  });
});
