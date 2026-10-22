import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../server/server';
import { AUTO_KEEP_COUNT, VersionStore } from '../server/versions';
import { CollabClient } from '../src/collab/client';
import { createDocument, createNode, insertNode } from '../src/core/document';
import { Editor } from '../src/core/editor';
import { restoreSummary } from '../src/ui/VersionsDialog';
import { signUp, until, type TestServer } from './helpers';

let server: TestServer;
let url = '';
let dir = '';

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'planar-versions-'));
  server = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, staticDir: null, authLimit: 1000 });
  url = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function open(fileId: string, opts: { key?: string; name?: string }) {
  const editor = new Editor(createDocument(), { autosave: false });
  const client = new CollabClient(editor, { serverUrl: url, fileId, key: opts.key, guestName: opts.name, shareUrl: '' });
  client.start();
  await until(() => client.status === 'connected' || client.status === 'error');
  return { editor, client };
}

function addBox(editor: Editor, name: string) {
  editor.change((doc) => insertNode(doc, createNode('rectangle', { name, x: 0, y: 0, width: 10, height: 10 }), editor.pageId));
}

const names = (editor: Editor) => Object.values(editor.doc.nodes).filter((n) => n.type === 'rectangle').map((n) => n.name).sort();

describe('version history', () => {
  it('saves a restore point before an agent starts editing, and restores it for everyone', async () => {
    const ann = await signUp(url, 'ann');
    const doc = createDocument('Work');
    insertNode(doc, createNode('rectangle', { name: 'Original', x: 0, y: 0, width: 10, height: 10 }), doc.pageIds[0]);
    const file = (await ann.call('POST', '/api/files', { doc })).body.file;

    const agent = await open(file.id, { key: ann.key, name: 'Claude' });
    const watcher = await open(file.id, { key: ann.key, name: 'Watcher' });

    expect((await ann.call('GET', `/api/files/${file.id}/versions`)).body.versions).toHaveLength(0);
    addBox(agent.editor, 'Agent made this');
    await agent.client.settled();
    await until(() => names(watcher.editor).includes('Agent made this'));

    const list = (await ann.call('GET', `/api/files/${file.id}/versions`)).body.versions;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'agent', label: 'Before Claude' });

    // More agent edits shortly after do not pile up restore points.
    addBox(agent.editor, 'And this');
    await agent.client.settled();
    expect((await ann.call('GET', `/api/files/${file.id}/versions`)).body.versions).toHaveLength(1);

    // The snapshot is the file before the agent.
    const old = await ann.call('GET', `/api/files/${file.id}/versions/${list[0].id}`);
    expect(Object.values(old.body.doc.nodes as Record<string, { name: string }>).map((n) => n.name)).toContain('Original');
    expect(Object.values(old.body.doc.nodes as Record<string, { name: string }>).map((n) => n.name)).not.toContain('Agent made this');

    const restored = await ann.call('POST', `/api/files/${file.id}/versions/${list[0].id}/restore`, {});
    expect(restored.status).toBe(200);
    await until(() => !names(watcher.editor).includes('Agent made this'));
    await until(() => !names(agent.editor).includes('And this'));
    expect(names(watcher.editor)).toEqual(['Original']);

    // The state before the restore is kept, so a restore can be undone.
    const after = (await ann.call('GET', `/api/files/${file.id}/versions`)).body.versions;
    expect(after.map((v: { kind: string }) => v.kind)).toContain('restore');
    const undo = after.find((v: { kind: string }) => v.kind === 'restore');
    await ann.call('POST', `/api/files/${file.id}/versions/${undo.id}/restore`, {});
    await until(() => names(watcher.editor).includes('And this'));

    // Edits after a restore still sync both ways.
    addBox(watcher.editor, 'After restore');
    await watcher.client.settled();
    await until(() => names(agent.editor).includes('After restore'));

    agent.client.stop();
    watcher.client.stop();
  });

  it('keeps named versions, and is only for people who can edit', async () => {
    const ann = await signUp(url, 'ann');
    const ben = await signUp(url, 'ben');
    const file = (await ann.call('POST', '/api/files', { name: 'Named' })).body.file;
    await ann.call('PUT', `/api/files/${file.id}/members`, { username: ben.username, role: 'viewer' });

    const saved = await ann.call('POST', `/api/files/${file.id}/versions`, { label: 'Before the big change' });
    expect(saved.status).toBe(200);
    expect(saved.body.version).toMatchObject({ kind: 'named', label: 'Before the big change' });
    const renamed = await ann.call('PATCH', `/api/files/${file.id}/versions/${saved.body.version.id}`, { label: 'Approved by the client' });
    expect(renamed.body.version.label).toBe('Approved by the client');

    // Viewers cannot read history or restore (old content may have been removed on purpose).
    expect((await ben.call('GET', `/api/files/${file.id}/versions`)).status).toBe(403);
    expect((await ben.call('POST', `/api/files/${file.id}/versions/${saved.body.version.id}/restore`, {})).status).toBe(403);
    expect((await ann.call('POST', `/api/files/${file.id}/versions/nope/restore`, {})).status).toBe(404);

    await ann.call('PUT', `/api/files/${file.id}/members`, { username: ben.username, role: 'editor' });
    expect((await ben.call('GET', `/api/files/${file.id}/versions`)).body.versions).toHaveLength(1);
  });

  it('summarises what a restore would change', () => {
    const now = createDocument('Doc');
    const then = structuredClone(now);
    const page = now.pageIds[0];
    insertNode(then, createNode('rectangle', { name: 'Deleted since' }), page);
    insertNode(now, createNode('rectangle', { name: 'Added since' }), page);
    const s = restoreSummary(now, then);
    expect(s.brought).toEqual(['Deleted since']);
    expect(s.removed).toEqual(['Added since']);
    expect(s.reverted).toEqual([]);
  });
});

describe('VersionStore', () => {
  it('skips identical snapshots, forgets old automatic ones and keeps named ones', async () => {
    const store = new VersionStore(null);
    const doc = createDocument('Store');
    const auto = { kind: 'auto' as const, label: '', authorId: null, authorName: '' };
    expect(await store.save('file-aaaaaa', doc, auto)).not.toBeNull();
    expect(await store.save('file-aaaaaa', doc, auto)).toBeNull();
    const named = await store.save('file-aaaaaa', doc, { kind: 'named', label: 'Keep', authorId: null, authorName: 'x' }, true);
    expect(named).not.toBeNull();

    await store.pruneAt('file-aaaaaa', Date.now() + 31 * 86_400_000);
    const left = await store.list('file-aaaaaa');
    expect(left.map((v) => v.kind)).toEqual(['named']);
    expect(await store.load('file-aaaaaa', named!.id)).not.toBeNull();
  });

  it('keeps at most 100 automatic snapshots per file', async () => {
    const store = new VersionStore(null);
    for (let i = 0; i < AUTO_KEEP_COUNT + 5; i++) {
      await store.save('file-bbbbbb', createDocument(`v${i}`), { kind: 'auto', label: '', authorId: null, authorName: '' });
    }
    expect(await store.list('file-bbbbbb')).toHaveLength(AUTO_KEEP_COUNT);
  });
});
