import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inbox, relatedNotes } from '../src/agent/notes';
import { AgentSession } from '../src/agent/session';
import { INSTRUCTIONS, registerTools } from '../src/agent/tools';
import { createDocument, createNode, insertNode } from '../src/core/document';
import { Editor } from '../src/core/editor';
import { createNote, newMessage } from '../src/core/notes';

describe('notes for agents', () => {
  it('finds the requests mentioning @ai that have no agent answer', () => {
    const editor = new Editor(createDocument(), { autosave: false });
    const screen = createNode('frame', { name: 'Login', width: 300, height: 400 });
    const chat = createNote('chat', { x: 320, y: 0 });
    chat.note!.messages = [newMessage('Ann', 'Hi all', false), newMessage('Ann', '@ai make the button bigger', false)];
    const sticky = createNote('sticky', { x: 2000, y: 0, characters: 'Ask @AI about copy' });
    const plain = createNote('sticky', { x: 2400, y: 0, characters: 'email me at ann@ai.com' });
    const callout = createNote('callout', { x: 3000, y: 0 });
    editor.change((d) => {
      insertNode(d, screen, editor.pageId);
      for (const n of [chat, sticky, plain, callout]) insertNode(d, n, editor.pageId);
      d.nodes[callout.id].note!.targetId = screen.id;
    });
    expect(inbox(editor.doc).map((e) => [e.note.id, e.message?.text])).toEqual([
      [chat.id, '@ai make the button bigger'],
      [sticky.id, undefined],
    ]);
    editor.postMessage(chat.id, 'Done, 48px now', 'Agent', true);
    expect(inbox(editor.doc).map((e) => e.note.id)).toEqual([sticky.id]);

    // Notes near the screen and callouts pointing into it, not the far sticky.
    expect(relatedNotes(editor.doc, screen.id).map((n) => n.id).sort()).toEqual([chat.id, callout.id].sort());
  });
});

describe('notes MCP tool', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'planar-notes-'));
  const file = path.join(dir, 'n.planar.json');
  let client: Client;
  let session: AgentSession;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: r.isError };
  };
  const idIn = (s: string) => /#(\S+)/.exec(s)![1];

  beforeAll(async () => {
    session = new AgentSession({ allowFiles: true, name: 'Claude' });
    const server = new McpServer({ name: 'planar', version: 'test' }, { instructions: INSTRUCTIONS });
    registerTools(server, session);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
    await call('open', { file });
  });

  afterAll(() => {
    session.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds, reads, lists and changes notes', async () => {
    const screen = idIn((await call('create', { layers: [{ type: 'frame', name: 'Checkout', width: 375, height: 600 }] })).text);
    expect((await call('notes', { action: 'list' })).text).toMatch(/No notes yet/);

    const list = idIn((await call('notes', { action: 'add', kind: 'checklist', title: 'Before release', items: ['Empty cart', { text: 'Error state', done: true }], target: screen })).text);
    const callout = idIn((await call('notes', { action: 'add', kind: 'callout', text: 'Total updates live', target: screen, color: '#E5484D' })).text);
    const sticky = (await call('notes', { action: 'add', text: 'Check tax rules' })).text;
    expect(sticky).toMatch(/note:sticky "Sticky note" #\S+ +200×200/);

    const listed = (await call('notes', { action: 'list' })).text;
    expect(listed).toMatch(/note:checklist "Checklist" #\S+ .* "Before release \(1\/2 done\)"/);
    expect(listed).toMatch(/note:callout .*"Total updates live"/);

    await call('notes', { action: 'set', id: list, check: [{ item: 1, done: true }, { item: 'error state', done: false }] });
    const read = (await call('notes', { action: 'read', id: list })).text;
    expect(read).toMatch(/1\. \[x\] Empty cart/);
    expect(read).toMatch(/2\. \[ \] Error state/);
    expect((await call('notes', { action: 'read', id: callout })).text).toMatch(/points at frame "Checkout" #/);

    // context get shows the notes around the screen.
    const ctx = (await call('context', { action: 'get', id: screen })).text;
    expect(ctx).toMatch(/# Annotations on and around this screen/);
    expect(ctx).toMatch(/Total updates live/);
    expect(ctx).toMatch(/\[x\] Empty cart/);

    // Placed beside the screen, not on top of it or of each other.
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const [a, b] = [doc.nodes[list], doc.nodes[callout]];
    expect(a.x).toBeGreaterThanOrEqual(375);
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
    expect(b.fills[0].color).toBe('#E5484D');

    expect((await call('notes', { action: 'set', id: callout, items: ['x'] })).isError).toBe(true);
    expect((await call('create', { layers: [{ type: 'note' }] })).text).toMatch(/notes tool/);
    expect((await call('inspect', { ids: [list] })).text).toMatch(/"kind": "checklist"/);
  });

  it('answers requests from the inbox in chats', async () => {
    const chat = idIn((await call('notes', { action: 'add', kind: 'chat', title: 'Review', text: 'I will look at this.' })).text);
    expect((await call('notes', { action: 'inbox' })).text).toMatch(/No open requests/);

    // A person asks in the chat (as the editor in the app would).
    const editor = await session.ready();
    editor.postMessage(chat, '@ai can you check the contrast?', 'Ann');
    await session.committed([chat]);
    const box = (await call('notes', { action: 'inbox' })).text;
    expect(box).toMatch(/1 open request/);
    expect(box).toMatch(/Ann \[.*\]: @ai can you check the contrast\?/);
    expect((await call('overview')).text).toMatch(/1 open request mentioning @ai: notes inbox/);

    await call('notes', { action: 'post', id: chat, text: 'Contrast is 7.2:1, fine.' });
    expect((await call('notes', { action: 'inbox' })).text).toMatch(/No open requests/);
    const read = (await call('notes', { action: 'read', id: chat })).text;
    expect(read).toMatch(/Claude \(AI\) \[.*\]: Contrast is 7\.2:1, fine\./);
    expect((await call('notes', { action: 'post', id: chat })).isError).toBe(true);
  });
});
