import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../server/server';
import { CollabClient } from '../src/collab/client';
import { createDocument } from '../src/core/document';
import { Editor } from '../src/core/editor';
import { caller, signUp, until, type TestServer } from './helpers';

let server: TestServer;
let url = '';

beforeAll(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1', dataDir: null, staticDir: null, authLimit: 1000 });
  url = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

describe('comments', () => {
  it('lets people with access discuss a spot, with replies, resolve and delete rules', async () => {
    const ann = await signUp(url, 'ann');
    const ben = await signUp(url, 'ben');
    const cy = await signUp(url, 'cy');
    const file = (await ann.call('POST', '/api/files', { name: 'Review' })).body.file;
    await ann.call('PUT', `/api/files/${file.id}/members`, { username: ben.username, role: 'viewer' });
    await ann.call('PUT', `/api/files/${file.id}/members`, { username: cy.username, role: 'editor' });
    const base = `/api/files/${file.id}/comments`;

    // A viewer may comment; strangers and signed-out visitors may not.
    const root = await ben.call('POST', base, { text: `Is this right, @${ann.username}?`, pageId: 'p1', nodeId: 'n1', x: 4, y: 5 });
    expect(root.status).toBe(200);
    expect(root.body.comment).toMatchObject({ nodeId: 'n1', x: 4, y: 5, threadId: null, agent: false });
    expect((await caller(url)('POST', base, { text: 'hi' })).status).toBe(401);
    const stranger = await signUp(url, 'eve');
    expect((await stranger.call('POST', base, { text: 'hi' })).status).toBe(404);
    expect((await ben.call('POST', base, { text: '   ' })).status).toBe(400);

    // Replies stay in the thread and keep its position.
    const reply = await ann.call('POST', base, { text: 'Yes, fixed', threadId: root.body.comment.id, x: 99 });
    expect(reply.body.comment).toMatchObject({ threadId: root.body.comment.id, x: 4, nodeId: 'n1' });
    expect((await ann.call('GET', base)).body.comments).toHaveLength(2);

    // Unread counts: Ann has Ben's comment waiting, Ben has Ann's reply.
    const unread = async (who: typeof ann) => (await who.call('GET', '/api/files?scope=' + (who === ann ? 'mine' : 'shared'))).body.files.find((f: { id: string }) => f.id === file.id).unreadComments;
    expect(await unread(ben)).toBe(1);
    await ben.call('POST', `${base}/read`, {});
    expect(await unread(ben)).toBe(0);

    // Only the author edits; the author or an editor resolves; viewers cannot resolve others' threads.
    expect((await cy.call('PATCH', `${base}/${root.body.comment.id}`, { text: 'hijack' })).status).toBe(403);
    expect((await ben.call('PATCH', `${base}/${root.body.comment.id}`, { text: 'Is this right now?' })).body.comment.editedAt).toBeGreaterThan(0);
    expect((await cy.call('PATCH', `${base}/${root.body.comment.id}`, { resolved: true })).status).toBe(200);
    const resolved = (await ann.call('GET', base)).body.comments.find((c: { id: string }) => c.id === root.body.comment.id);
    expect(resolved.resolvedAt).toBeGreaterThan(0);
    // A new reply reopens the thread.
    await ann.call('POST', base, { text: 'One more thing', threadId: root.body.comment.id });
    expect((await ann.call('GET', base)).body.comments.find((c: { id: string }) => c.id === root.body.comment.id).resolvedAt).toBeNull();
    expect((await ben.call('PATCH', `${base}/${reply.body.comment.id}`, { resolved: true })).status).toBe(200); // Ben started the thread

    // Authors delete their own; the owner may delete any; deleting a thread removes its replies.
    expect((await cy.call('DELETE', `${base}/${reply.body.comment.id}`)).status).toBe(403);
    expect((await ann.call('DELETE', `${base}/${root.body.comment.id}`)).status).toBe(200);
    expect((await ann.call('GET', base)).body.comments).toHaveLength(0);
  });

  it('tells open editors when comments change, and agents can comment with a key', async () => {
    const ann = await signUp(url, 'ann');
    const file = (await ann.call('POST', '/api/files', { name: 'Live' })).body.file;
    const editor = new Editor(createDocument(), { autosave: false });
    let pings = 0;
    const client = new CollabClient(editor, { serverUrl: url, fileId: file.id, key: ann.key, shareUrl: '', onComments: () => pings++ });
    client.start();
    await until(() => client.status === 'connected');
    const byKey = caller(url, { key: ann.key });
    const made = await byKey('POST', `/api/files/${file.id}/comments`, { text: 'From the agent', pageId: 'p', x: 1, y: 2 });
    expect(made.body.comment.agent).toBe(true);
    await until(() => pings > 0);
    client.stop();
  });
});
