import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../server/server';
import { CollabClient } from '../src/collab/client';
import { createDocument, createNode, insertNode } from '../src/core/document';
import { Editor } from '../src/core/editor';
import { applyOps, repairTree } from '../src/core/ops';

let server: Awaited<ReturnType<typeof startServer>>;
let url = '';

beforeAll(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1', dataDir: null, staticDir: null, token: 'secret' });
  url = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await wait(10);
  }
}

let roomCounter = 0;

async function pair() {
  const roomId = `test-room-${++roomCounter}-${Date.now()}`;
  const a = new Editor(createDocument('Shared'), { autosave: false });
  const rect = createNode('rectangle', { name: 'Box', x: 0, y: 0 });
  a.change((doc) => insertNode(doc, rect, a.pageId));
  const ca = new CollabClient(a, { serverUrl: url, roomId, name: 'Ann', color: '#ff0000', token: 'secret', createWith: a.doc, shareUrl: '' });
  ca.start();
  await until(() => ca.status === 'connected');
  const b = new Editor(createDocument(), { autosave: false });
  const cb = new CollabClient(b, { serverUrl: url, roomId, name: 'Ben', color: '#0000ff', token: 'secret', shareUrl: '' });
  cb.start();
  await until(() => cb.status === 'connected');
  return { a, b, ca, cb, rect: rect.id };
}

describe('tree repair', () => {
  it('rebuilds children from parent links and drops orphans', () => {
    const doc = createDocument();
    const page = doc.pageIds[0];
    const frame = insertNode(doc, createNode('frame'), page);
    const kid = insertNode(doc, createNode('rectangle'), frame.id);
    const lost = createNode('ellipse', { parentId: frame.id });
    doc.nodes[lost.id] = lost; // parent does not list it
    const orphan = createNode('ellipse', { parentId: 'gone' });
    doc.nodes[orphan.id] = orphan;
    repairTree(doc);
    expect(doc.nodes[frame.id].children).toEqual([kid.id, lost.id]);
    expect(doc.nodes[orphan.id]).toBeUndefined();
    applyOps(doc, [{ o: 'node', id: frame.id, node: null }]);
    expect(doc.nodes[kid.id]).toBeUndefined();
  });
});

describe('collaboration', () => {
  it('rejects a wrong token', async () => {
    const e = new Editor(createDocument(), { autosave: false });
    const c = new CollabClient(e, { serverUrl: url, roomId: 'nope-room-1', name: 'X', color: '#000000', token: 'bad', shareUrl: '' });
    c.start();
    await until(() => c.status === 'error');
    expect(e.collab?.error).toMatch(/token/i);
    c.stop();
  });

  it('joins with the shared document and sees peers', async () => {
    const { a, b, ca, cb, rect } = await pair();
    expect(b.doc.name).toBe('Shared');
    expect(b.doc.nodes[rect]).toBeDefined();
    await until(() => (a.collab?.peers.length ?? 0) === 1 && (b.collab?.peers.length ?? 0) === 1);
    expect(a.collab!.peers[0].name).toBe('Ben');
    ca.stop();
    cb.stop();
  });

  it('syncs edits both ways', async () => {
    const { a, b, ca, cb, rect } = await pair();
    a.updateNodes([rect], { x: 123 });
    await until(() => b.doc.nodes[rect]?.x === 123);
    const circle = createNode('ellipse', { name: 'Dot' });
    b.change((doc) => insertNode(doc, circle, b.pageId));
    await until(() => !!a.doc.nodes[circle.id]);
    expect(a.page.children).toContain(circle.id);
    b.select([rect]);
    b.deleteSelection();
    await until(() => !a.doc.nodes[rect]);
    ca.stop();
    cb.stop();
  });

  it('converges when both edit the same layer at once', async () => {
    const { a, b, ca, cb, rect } = await pair();
    a.updateNodes([rect], { x: 1 });
    b.updateNodes([rect], { x: 2 });
    ca.flush();
    cb.flush();
    await ca.settled();
    await cb.settled();
    await wait(50);
    expect(a.doc.nodes[rect].x).toBe(b.doc.nodes[rect].x);
    ca.stop();
    cb.stop();
  });

  it('keeps both concurrent inserts into one frame', async () => {
    const { a, b, ca, cb } = await pair();
    const frame = createNode('frame', { name: 'F' });
    a.change((doc) => insertNode(doc, frame, a.pageId));
    await until(() => !!b.doc.nodes[frame.id]);
    const x = createNode('rectangle', { name: 'X' });
    const y = createNode('rectangle', { name: 'Y' });
    a.change((doc) => insertNode(doc, x, frame.id));
    b.change((doc) => insertNode(doc, y, frame.id));
    await ca.settled();
    await cb.settled();
    await until(() => a.doc.nodes[frame.id].children.length === 2 && b.doc.nodes[frame.id].children.length === 2);
    expect([...a.doc.nodes[frame.id].children].sort()).toEqual([...b.doc.nodes[frame.id].children].sort());
    ca.stop();
    cb.stop();
  });

  it('undo only reverts local changes', async () => {
    const { a, b, ca, cb, rect } = await pair();
    const other = createNode('ellipse', { name: 'Other', x: 5 });
    b.change((doc) => insertNode(doc, other, b.pageId));
    await until(() => !!a.doc.nodes[other.id]);
    a.updateNodes([rect], { x: 50 });
    b.updateNodes([other.id], { x: 77 });
    await cb.settled();
    await until(() => a.doc.nodes[other.id]?.x === 77);
    a.undo();
    expect(a.doc.nodes[rect].x).toBe(0);
    expect(a.doc.nodes[other.id].x).toBe(77);
    await until(() => b.doc.nodes[rect].x === 0);
    ca.stop();
    cb.stop();
  });

  it('re-applies offline edits after reconnecting', async () => {
    const { a, b, ca, cb, rect } = await pair();
    // Drop B's connection; it edits while offline, A edits something else.
    (cb as unknown as { ws: WebSocket }).ws.close();
    await until(() => cb.status === 'reconnecting');
    b.updateNodes([rect], { name: 'Renamed offline' });
    const dot = createNode('ellipse', { name: 'From A' });
    a.change((doc) => insertNode(doc, dot, a.pageId));
    await ca.settled();
    await until(() => cb.status === 'connected', 5000);
    await cb.settled();
    await until(() => a.doc.nodes[rect].name === 'Renamed offline');
    expect(b.doc.nodes[dot.id]).toBeDefined();
    ca.stop();
    cb.stop();
  });

  it('relays presence', async () => {
    const { a, b, ca, cb, rect } = await pair();
    a.select([rect]);
    a.setPointer({ x: 10, y: 20 });
    await until(() => !!b.collab?.peers[0]?.presence?.cursor);
    expect(b.collab!.peers[0].presence!.selection).toEqual([rect]);
    ca.stop();
    cb.stop();
  });
});
