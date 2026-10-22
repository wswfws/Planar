import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInstanceNode } from '../src/core/components';
import { createDocument, createNode, insertNode } from '../src/core/document';
import { Editor } from '../src/core/editor';
import { buildLibrarySnapshot, libraryOf, visiblePageIds } from '../src/core/library';
import type { PlanarDocument } from '../src/core/types';
import { startServer } from '../server/server';
import { signUp, type TestServer } from './helpers';

/** A design system: a Button component bound to a colour variable, with a text style. */
function designSystem(label = 'Click me', color = '#5B5BD6'): PlanarDocument {
  const editor = new Editor(createDocument('Design system'), { autosave: false });
  const id = editor.addVariable('color');
  editor.renameVariable(id, 'brand');
  editor.setVariableValue(id, editor.doc.modes[0].id, color);
  const button = createNode('component', { name: 'Button', width: 120, height: 40 });
  const text = createNode('text', { name: 'Label', characters: label, fontSize: 14 });
  editor.change((d) => {
    insertNode(d, button, editor.pageId);
    insertNode(d, text, button.id);
    d.nodes[button.id].fills = [{ type: 'solid', color, opacity: 1, visible: true, variableId: id }];
  });
  editor.select([text.id]);
  editor.createTextStyle('Body/Small', text.id);
  return editor.doc;
}

describe('library documents', () => {
  it('imports components, variables and styles onto a hidden page', () => {
    const snap = buildLibrarySnapshot(designSystem(), 'lib1', 'Design system', 1);
    expect(snap.roots).toHaveLength(1);
    const editor = new Editor(createDocument('App'), { autosave: false });
    editor.useLibrary(snap);
    const doc = editor.doc;
    expect(doc.libraries).toEqual([expect.objectContaining({ fileId: 'lib1', name: 'Design system', version: 1 })]);
    expect(visiblePageIds(doc)).toHaveLength(1);
    expect(doc.pageIds).toHaveLength(2);
    const button = Object.values(doc.nodes).find((n) => n.type === 'component')!;
    expect(libraryOf(doc, button.id)?.name).toBe('Design system');
    // References inside point at the imported copies.
    const brand = doc.variables.find((v) => v.name === 'brand')!;
    expect(brand.library).toEqual({ fileId: 'lib1', key: expect.any(String) });
    expect(button.fills[0]).toMatchObject({ variableId: brand.id });
    const label = doc.nodes[button.children[0]];
    expect(doc.styles.find((s) => s.id === label.textStyleId)?.name).toBe('Body/Small');
  });

  it('updates in place: instances stay connected and keep their overrides', () => {
    const lib = new Editor(designSystem(), { autosave: false });
    const editor = new Editor(createDocument('App'), { autosave: false });
    editor.useLibrary(buildLibrarySnapshot(lib.doc, 'lib1', 'Design system', 1));
    const button = Object.values(editor.doc.nodes).find((n) => n.type === 'component')!;
    let inst = '';
    editor.change((d) => {
      const node = createInstanceNode(d, button.id);
      inst = node.id;
      insertNode(d, node, editor.pageId);
    });
    const label = () => editor.doc.nodes[editor.doc.nodes[inst].children[0]];
    editor.updateNodes([inst], { x: 300 });
    editor.updateNodes([label().id], { characters: 'Buy now' });

    // The library changes its colour, its button size and adds a component.
    const brand = lib.doc.variables[0];
    lib.setVariableValue(brand.id, lib.doc.modes[0].id, '#FF0000');
    const libButton = Object.values(lib.doc.nodes).find((n) => n.type === 'component')!;
    lib.updateNodes([libButton.id], { width: 160 });
    lib.change((d) => void insertNode(d, createNode('component', { name: 'Badge' }), lib.pageId));
    editor.useLibrary(buildLibrarySnapshot(lib.doc, 'lib1', 'Design system', 2));

    expect(editor.doc.libraries[0].version).toBe(2);
    expect(editor.doc.nodes[inst]).toMatchObject({ componentId: button.id, x: 300, width: 160 });
    expect(editor.doc.nodes[inst].fills[0]).toMatchObject({ color: '#FF0000' });
    expect(label().characters).toBe('Buy now');
    expect(editor.doc.variables.filter((v) => v.name === 'brand')).toHaveLength(1);
    expect(Object.values(editor.doc.nodes).filter((n) => n.type === 'component').map((n) => n.name).sort()).toEqual(['Badge', 'Button']);
  });

  it('removing a library keeps instances as ordinary layers', () => {
    const editor = new Editor(createDocument('App'), { autosave: false });
    editor.useLibrary(buildLibrarySnapshot(designSystem(), 'lib1', 'Design system', 1));
    const button = Object.values(editor.doc.nodes).find((n) => n.type === 'component')!;
    let inst = '';
    editor.change((d) => {
      const node = createInstanceNode(d, button.id);
      inst = node.id;
      insertNode(d, node, editor.pageId);
    });
    editor.removeLibrary('lib1');
    expect(editor.doc.libraries).toEqual([]);
    expect(editor.doc.pageIds).toHaveLength(1);
    expect(editor.doc.nodes[inst]).toMatchObject({ type: 'frame', fills: [expect.objectContaining({ color: '#5B5BD6' })] });
    expect(editor.doc.variables).toEqual([]);
    expect(editor.doc.styles).toEqual([]);
    expect(editor.doc.nodes[editor.doc.nodes[inst].children[0]].characters).toBe('Click me');
  });
});

describe('library API', () => {
  let server: TestServer;
  let url = '';
  beforeAll(async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', dataDir: null, staticDir: null, authLimit: 1000 });
    url = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => {
    await server.close();
  });

  it('publishes for editors and lists for people who work with the file', async () => {
    const ann = await signUp(url, 'ann');
    const ben = await signUp(url, 'ben');
    const eve = await signUp(url, 'eve');
    const file = (await ann.call('POST', '/api/files', { doc: designSystem() })).body.file;
    const empty = (await ann.call('POST', '/api/files', { name: 'Empty' })).body.file;
    expect((await ann.call('POST', `/api/files/${empty.id}/library`, {})).status).toBe(400);

    await ann.call('PUT', `/api/files/${file.id}/members`, { username: ben.username, role: 'viewer' });
    expect((await ben.call('POST', `/api/files/${file.id}/library`, {})).status).toBe(403);
    const pub = await ann.call('POST', `/api/files/${file.id}/library`, {});
    expect(pub.body.library).toMatchObject({ version: 1, components: 1, variables: 1, styles: 1 });
    expect((await ann.call('POST', `/api/files/${file.id}/library`, {})).body.library.version).toBe(2);

    const listed = (await ben.call('GET', '/api/libraries')).body.libraries;
    expect(listed).toEqual([expect.objectContaining({ fileId: file.id, name: 'Design system', version: 2, publishedBy: expect.any(String) })]);
    const snap = (await ben.call('GET', `/api/libraries/${file.id}`)).body.library;
    expect(snap.roots).toHaveLength(1);

    // A public link lets people open it by id, but it is not listed for strangers.
    await ann.call('PATCH', `/api/files/${file.id}`, { linkAccess: 'view' });
    expect((await eve.call('GET', '/api/libraries')).body.libraries).toEqual([]);
    expect((await eve.call('GET', `/api/libraries/${file.id}`)).status).toBe(200);
    await ann.call('PATCH', `/api/files/${file.id}`, { linkAccess: 'none' });
    expect((await eve.call('GET', `/api/libraries/${file.id}`)).status).toBe(404);

    expect((await ann.call('GET', `/api/files/${file.id}`)).body.file.library).toMatchObject({ version: 2 });
    expect((await ann.call('DELETE', `/api/files/${file.id}/library`)).status).toBe(200);
    expect((await ben.call('GET', '/api/libraries')).body.libraries).toEqual([]);
    expect((await ben.call('GET', `/api/libraries/${file.id}`)).status).toBe(404);
  });

  it('deleting the file removes its library', async () => {
    const ann = await signUp(url, 'ann');
    const file = (await ann.call('POST', '/api/files', { doc: designSystem() })).body.file;
    await ann.call('POST', `/api/files/${file.id}/library`, {});
    await ann.call('DELETE', `/api/files/${file.id}`);
    expect((await ann.call('GET', '/api/libraries')).body.libraries).toEqual([]);
    await ann.call('DELETE', `/api/files/${file.id}?forever=1`);
    expect((await ann.call('GET', `/api/libraries/${file.id}`)).status).toBe(404);
  });
});
