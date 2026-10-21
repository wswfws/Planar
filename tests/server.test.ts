import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../server/server';
import { CollabClient } from '../src/collab/client';
import { createDocument, createNode, insertNode } from '../src/core/document';
import { Editor } from '../src/core/editor';
import { caller, signUp, until, type TestServer } from './helpers';

let server: TestServer;
let url = '';
const anon = () => caller(url);

beforeAll(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1', dataDir: null, staticDir: null, authLimit: 1000 });
  url = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

describe('accounts', () => {
  it('registers, signs in and out', async () => {
    const ann = await signUp(url, 'ann');
    expect((await ann.call('GET', '/api/me')).body.user.username).toBe(ann.username);
    expect((await anon()('GET', '/api/me')).body.user).toBeNull();

    const login = await anon()('POST', '/api/auth/login', { username: ann.username, password: 'correct horse' });
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect((await anon()('POST', '/api/auth/login', { username: ann.username, password: 'wrong password' })).status).toBe(401);
    expect((await anon()('POST', '/api/auth/login', { username: 'nobody-here', password: 'whatever pw' })).status).toBe(401);

    await ann.call('POST', '/api/auth/logout', {});
    expect((await ann.call('GET', '/api/me')).body.user).toBeNull();
  });

  it('validates usernames and passwords, and refuses duplicates', async () => {
    const ann = await signUp(url, 'dup');
    expect((await anon()('POST', '/api/auth/register', { username: ann.username, password: 'another pass' })).status).toBe(409);
    expect((await anon()('POST', '/api/auth/register', { username: 'x', password: 'another pass' })).status).toBe(400);
    expect((await anon()('POST', '/api/auth/register', { username: 'okname', password: 'short' })).status).toBe(400);
  });

  it('refuses cross-origin writes that use the cookie', async () => {
    const ann = await signUp(url, 'csrf');
    const res = await fetch(`${url}/api/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ann.cookie, Origin: 'https://evil.example' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('issues API keys that act as the user and can be revoked', async () => {
    const ann = await signUp(url, 'keys');
    const byKey = caller(url, { key: ann.key });
    expect((await byKey('GET', '/api/me')).body.user.username).toBe(ann.username);
    const list = (await ann.call('GET', '/api/me/keys')).body.keys;
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(ann.key);
    await ann.call('DELETE', `/api/me/keys/${list[0].id}`);
    expect((await byKey('GET', '/api/me')).body.user).toBeNull();
  });

  it('limits sign-in attempts per address', async () => {
    const limited = await startServer({ port: 0, host: '127.0.0.1', dataDir: null, staticDir: null, authLimit: 3 });
    const base = `http://127.0.0.1:${limited.port}`;
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await caller(base)('POST', '/api/auth/login', { username: 'nobody', password: 'password123' })).status);
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes[4]).toBe(429);
    await limited.close();
  });
});

describe('files and permissions', () => {
  it('creates, lists, renames, duplicates and trashes files', async () => {
    const ann = await signUp(url, 'ann');
    const created = (await ann.call('POST', '/api/files', { name: 'Landing' })).body.file;
    expect(created.role).toBe('owner');
    expect((await ann.call('GET', '/api/files?scope=mine')).body.files.map((f: { id: string }) => f.id)).toEqual([created.id]);

    expect((await ann.call('PATCH', `/api/files/${created.id}`, { name: 'Home page' })).body.file.name).toBe('Home page');

    const copy = (await ann.call('POST', `/api/files/${created.id}/duplicate`, {})).body.file;
    expect(copy.id).not.toBe(created.id);
    expect(copy.name).toBe('Home page (copy)');

    await ann.call('DELETE', `/api/files/${created.id}`);
    expect((await ann.call('GET', '/api/files?scope=mine')).body.files.map((f: { id: string }) => f.id)).toEqual([copy.id]);
    expect((await ann.call('GET', '/api/files?scope=trash')).body.files.map((f: { id: string }) => f.id)).toEqual([created.id]);
    await ann.call('POST', `/api/files/${created.id}/restore`, {});
    expect((await ann.call('GET', '/api/files?scope=trash')).body.files).toHaveLength(0);
    await ann.call('DELETE', `/api/files/${created.id}?forever=1`);
    expect((await ann.call('GET', `/api/files/${created.id}`)).status).toBe(404);
  });

  it('hides files from people with no access', async () => {
    const ann = await signUp(url, 'ann');
    const ben = await signUp(url, 'ben');
    const file = (await ann.call('POST', '/api/files', { name: 'Secret' })).body.file;
    expect((await ben.call('GET', `/api/files/${file.id}`)).status).toBe(404);
    expect((await anon()('GET', `/api/files/${file.id}`)).status).toBe(401);
    expect((await ben.call('POST', `/api/files/${file.id}/duplicate`, {})).status).toBe(404);
  });

  it('invites by username with roles that limit what each person can do', async () => {
    const ann = await signUp(url, 'ann');
    const ben = await signUp(url, 'ben');
    const cy = await signUp(url, 'cy');
    const file = (await ann.call('POST', '/api/files', { name: 'Team' })).body.file;

    expect((await ann.call('PUT', `/api/files/${file.id}/members`, { username: 'no-such-user', role: 'viewer' })).status).toBe(404);
    await ann.call('PUT', `/api/files/${file.id}/members`, { username: ben.username, role: 'viewer' });
    expect((await ben.call('GET', '/api/files?scope=shared')).body.files[0].role).toBe('viewer');

    // A viewer can look and copy, but not rename or share.
    expect((await ben.call('PATCH', `/api/files/${file.id}`, { name: 'Mine now' })).status).toBe(403);
    expect((await ben.call('PUT', `/api/files/${file.id}/members`, { username: cy.username, role: 'viewer' })).status).toBe(403);
    expect((await ben.call('POST', `/api/files/${file.id}/duplicate`, {})).status).toBe(200);
    expect((await ben.call('DELETE', `/api/files/${file.id}`)).status).toBe(403);

    // An editor can rename and invite, but not delete or take over.
    await ann.call('PUT', `/api/files/${file.id}/members`, { username: ben.username, role: 'editor' });
    expect((await ben.call('PATCH', `/api/files/${file.id}`, { name: 'Renamed by Ben' })).status).toBe(200);
    expect((await ben.call('PUT', `/api/files/${file.id}/members`, { username: cy.username, role: 'viewer' })).status).toBe(200);
    expect((await ben.call('PUT', `/api/files/${file.id}/members`, { username: ann.username, role: 'viewer' })).status).toBe(400);
    expect((await ben.call('DELETE', `/api/files/${file.id}`)).status).toBe(403);
    expect((await ben.call('POST', `/api/files/${file.id}/transfer`, { username: ben.username })).status).toBe(403);

    // Removing access closes the door.
    await ann.call('PUT', `/api/files/${file.id}/members`, { username: cy.username, role: null });
    expect((await cy.call('GET', `/api/files/${file.id}`)).status).toBe(404);
  });

  it('lets the owner hand a file over', async () => {
    const ann = await signUp(url, 'ann');
    const ben = await signUp(url, 'ben');
    const file = (await ann.call('POST', '/api/files', { name: 'Gift' })).body.file;
    await ann.call('POST', `/api/files/${file.id}/transfer`, { username: ben.username });
    expect((await ben.call('GET', `/api/files/${file.id}`)).body.file.role).toBe('owner');
    expect((await ann.call('GET', `/api/files/${file.id}`)).body.file.role).toBe('editor');
  });

  it('shares by link, including with people who are not signed in', async () => {
    const ann = await signUp(url, 'ann');
    const file = (await ann.call('POST', '/api/files', { name: 'Public' })).body.file;
    expect((await anon()('GET', `/api/files/${file.id}`)).status).toBe(401);

    await ann.call('PATCH', `/api/files/${file.id}`, { linkAccess: 'view' });
    const seen = await anon()('GET', `/api/files/${file.id}`);
    expect(seen.body.file.role).toBe('viewer');
    expect((await anon()('PATCH', `/api/files/${file.id}`, { name: 'Hacked' })).status).toBe(403);

    // A guest cannot copy to their files (they have none).
    expect((await anon()('POST', `/api/files/${file.id}/duplicate`, {})).status).toBe(401);
    const ben = await signUp(url, 'ben');
    expect((await ben.call('POST', `/api/files/${file.id}/duplicate`, {})).status).toBe(200);
  });

  it('only suggests usernames to signed-in people, a few at a time', async () => {
    const ann = await signUp(url, 'suggest');
    for (let i = 0; i < 10; i++) await signUp(url, 'suggest');
    const found = (await ann.call('GET', '/api/users?q=suggest')).body.users;
    expect(found.length).toBeLessThanOrEqual(8);
    expect(found.every((u: { username: string }) => u.username !== ann.username)).toBe(true);
    expect(found[0]).not.toHaveProperty('id');
    expect((await anon()('GET', '/api/users?q=suggest')).status).toBe(401);
  });
});

describe('live access control', () => {
  async function open(fileId: string, opts: { key?: string; name?: string }) {
    const editor = new Editor(createDocument(), { autosave: false });
    const client = new CollabClient(editor, { serverUrl: url, fileId, key: opts.key, guestName: opts.name, shareUrl: '' });
    client.start();
    await until(() => client.status === 'connected' || client.status === 'error');
    return { editor, client };
  }

  it('lets viewers watch but not change the document', async () => {
    const ann = await signUp(url, 'ann');
    const ben = await signUp(url, 'ben');
    const doc = createDocument('Live');
    const rect = createNode('rectangle', { name: 'Box', x: 0 });
    insertNode(doc, rect, doc.pageIds[0]);
    const file = (await ann.call('POST', '/api/files', { doc })).body.file;
    await ann.call('PUT', `/api/files/${file.id}/members`, { username: ben.username, role: 'viewer' });

    const a = await open(file.id, { key: ann.key });
    const b = await open(file.id, { key: ben.key });
    expect(a.editor.collab?.role).toBe('owner');
    expect(b.editor.collab?.role).toBe('viewer');
    expect(b.editor.readOnly).toBe(true);

    // Ben's editor refuses edits; even a raw message is refused by the server.
    b.editor.updateNodes([rect.id], { x: 99 });
    expect(b.editor.doc.nodes[rect.id].x).toBe(0);
    (b.client as unknown as { ws: WebSocket }).ws.send(JSON.stringify({ t: 'ops', seq: 1, ops: [{ o: 'node', id: rect.id, node: { ...rect, x: 99 } }] }));

    // Ann's edits still reach Ben.
    a.editor.updateNodes([rect.id], { x: 5 });
    await until(() => b.editor.doc.nodes[rect.id].x === 5);
    expect(server.db.files.get(file.id)).toBeDefined();

    // Promoting Ben makes the open editor writable without reconnecting.
    await ann.call('PUT', `/api/files/${file.id}/members`, { username: ben.username, role: 'editor' });
    await until(() => b.editor.collab?.role === 'editor' && !b.editor.readOnly);
    b.editor.updateNodes([rect.id], { x: 7 });
    await until(() => a.editor.doc.nodes[rect.id].x === 7);

    a.client.stop();
    b.client.stop();
  });

  it('closes sockets when access is removed', async () => {
    const ann = await signUp(url, 'ann');
    const ben = await signUp(url, 'ben');
    const file = (await ann.call('POST', '/api/files', { name: 'Closing' })).body.file;
    await ann.call('PUT', `/api/files/${file.id}/members`, { username: ben.username, role: 'editor' });
    const b = await open(file.id, { key: ben.key });
    expect(b.client.status).toBe('connected');
    await ann.call('PUT', `/api/files/${file.id}/members`, { username: ben.username, role: null });
    await until(() => b.client.status === 'error');
    expect(b.editor.collab?.error).toMatch(/closed/i);
  });

  it('admits guests only through a link, and shows their name', async () => {
    const ann = await signUp(url, 'ann');
    const file = (await ann.call('POST', '/api/files', { name: 'Guests' })).body.file;
    const denied = await open(file.id, { name: 'Gus' });
    expect(denied.client.status).toBe('error');
    expect(denied.editor.collab?.error).toMatch(/sign in/i);

    await ann.call('PATCH', `/api/files/${file.id}`, { linkAccess: 'edit' });
    const a = await open(file.id, { key: ann.key });
    const g = await open(file.id, { name: 'Gus' });
    expect(g.editor.collab?.role).toBe('editor');
    await until(() => a.editor.collab?.peers.some((p) => p.name === 'Gus') ?? false);

    // Dropping the link to view-only demotes the guest on the spot.
    await ann.call('PATCH', `/api/files/${file.id}`, { linkAccess: 'view' });
    await until(() => g.editor.readOnly);
    await ann.call('PATCH', `/api/files/${file.id}`, { linkAccess: 'none' });
    await until(() => g.client.status === 'error');
    a.client.stop();
  });

  it('renames through the API for everyone who has the file open', async () => {
    const ann = await signUp(url, 'ann');
    const file = (await ann.call('POST', '/api/files', { name: 'Old name' })).body.file;
    const a = await open(file.id, { key: ann.key });
    await ann.call('PATCH', `/api/files/${file.id}`, { name: 'New name' });
    await until(() => a.editor.doc.name === 'New name');
    a.client.stop();
  });

  it('keeps a trashed file closed to everyone but its owner', async () => {
    const ann = await signUp(url, 'ann');
    const file = (await ann.call('POST', '/api/files', { name: 'Gone' })).body.file;
    await ann.call('PATCH', `/api/files/${file.id}`, { linkAccess: 'edit' });
    await ann.call('DELETE', `/api/files/${file.id}`);
    expect((await open(file.id, { name: 'Gus' })).client.status).toBe('error');
  });
});

describe('storage', () => {
  it('keeps accounts and files across restarts and adopts pre-account documents', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'planar-data-'));
    try {
      // A room saved by the previous version: no owner, loose in the data directory.
      mkdirSync(dir, { recursive: true });
      const old = createDocument('Old room');
      writeFileSync(path.join(dir, 'oldroom123.planar.json'), JSON.stringify(old));

      let s = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, staticDir: null, legacyOwner: 'boss', authLimit: 1000 });
      let base = `http://127.0.0.1:${s.port}`;
      // Until the owner exists, the old link still works and nobody else can claim it.
      const legacy = await caller(base)('GET', '/api/files/oldroom123');
      expect(legacy.body.file.linkAccess).toBe('edit');
      expect(existsSync(path.join(dir, 'files', 'oldroom123.planar.json'))).toBe(true);

      const mallory = await signUp(base, 'mallory');
      expect((await mallory.call('GET', '/api/files?scope=mine')).body.files).toHaveLength(0);

      const boss = await caller(base)('POST', '/api/auth/register', { username: 'boss', password: 'correct horse' });
      expect(boss.status).toBe(200);
      const cookie = boss.headers.get('set-cookie')!.split(';')[0];
      const mine = (await caller(base, { cookie })('GET', '/api/files?scope=mine')).body.files;
      expect(mine.map((f: { id: string }) => f.id)).toEqual(['oldroom123']);
      const made = (await caller(base, { cookie })('POST', '/api/files', { name: 'New one' })).body.file;
      await s.close();

      s = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, staticDir: null, authLimit: 1000 });
      base = `http://127.0.0.1:${s.port}`;
      const again = await caller(base)('POST', '/api/auth/login', { username: 'boss', password: 'correct horse' });
      expect(again.status).toBe(200);
      const list = (await caller(base, { cookie: again.headers.get('set-cookie')!.split(';')[0] })('GET', '/api/files?scope=mine')).body.files;
      expect(list.map((f: { id: string }) => f.id).sort()).toEqual(['oldroom123', made.id].sort());
      await s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
