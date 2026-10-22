import { describe, expect, it } from 'vitest';
import { createDocument, createNode, insertNode, parseDocument } from '../src/core/document';
import { Editor } from '../src/core/editor';
import { linkAt, linksOnPage, nextScreen, screenOf, screensOf, stepScreen } from '../src/core/prototype';
import { applyProps } from '../src/agent/props';

function build() {
  const doc = createDocument('Proto');
  const page = doc.pageIds[0];
  const home = createNode('frame', { name: 'Home', x: 0, y: 0, width: 400, height: 800 });
  const detail = createNode('frame', { name: 'Detail', x: 500, y: 0, width: 400, height: 800 });
  const done = createNode('frame', { name: 'Done', x: 1000, y: 0, width: 400, height: 800 });
  const button = createNode('rectangle', { name: 'Button', x: 20, y: 20, width: 100, height: 40 });
  const label = createNode('text', { name: 'Label', x: 10, y: 10, width: 40, height: 10 });
  for (const n of [home, detail, done]) insertNode(doc, n, page);
  insertNode(doc, button, home.id);
  insertNode(doc, label, button.id);
  button.link = { to: detail.id, transition: 'slide' };
  return { doc, page, home, detail, done, button, label };
}

describe('prototype links', () => {
  it('lists screens and finds the screen of a layer', () => {
    const { doc, page, home, detail, done, label } = build();
    expect(screensOf(doc, page)).toEqual([home.id, detail.id, done.id]);
    expect(screenOf(doc, label.id)).toBe(home.id);
    expect(screenOf(doc, home.id)).toBe(home.id);
    expect(stepScreen(doc, page, home.id, 1)).toBe(detail.id);
    expect(stepScreen(doc, page, home.id, -1)).toBeNull();
  });

  it('follows the link of the layer under the click, or of an ancestor', () => {
    const { doc, home, detail, button } = build();
    // Click on the button, and on its child text (which has no link itself).
    expect(nextScreen(doc, home.id, { x: 30, y: 30 })).toEqual({ to: detail.id, transition: 'slide' });
    expect(nextScreen(doc, home.id, { x: 25, y: 25 })).toEqual({ to: detail.id, transition: 'slide' });
    expect(linkAt(doc, home.id, { x: 30, y: 30 })?.from).toBe(button.id);
    // Empty space does nothing.
    expect(nextScreen(doc, home.id, { x: 300, y: 600 })).toBeNull();
  });

  it('ignores links to layers that no longer exist and lists links for the editor', () => {
    const { doc, page, home, button } = build();
    expect(linksOnPage(doc, page)).toEqual([{ from: button.id, to: expect.any(String) }]);
    button.link = { to: 'gone' };
    expect(nextScreen(doc, home.id, { x: 30, y: 30 })).toBeNull();
    expect(linksOnPage(doc, page)).toEqual([]);
  });

  it('survives saving and loading', () => {
    const { doc, button } = build();
    const loaded = parseDocument(JSON.parse(JSON.stringify(doc)));
    expect(loaded.nodes[button.id].link).toEqual(button.link);
  });

  it('can be set by an agent by frame name, and cleared', () => {
    const { doc, button, detail } = build();
    const editor = new Editor(doc, { autosave: false });
    delete button.link;
    applyProps(editor, button.id, { link: 'Detail', transition: 'dissolve' });
    expect(editor.doc.nodes[button.id].link).toEqual({ to: detail.id, transition: 'dissolve' });
    expect(() => applyProps(editor, button.id, { link: 'Nowhere' })).toThrow(/no top-level frame/);
    applyProps(editor, button.id, { link: null });
    expect(editor.doc.nodes[button.id].link).toBeUndefined();
  });
});
