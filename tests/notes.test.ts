import { describe, expect, it } from 'vitest';
import { initCanvas, renderPng } from '../src/agent/raster';
import { generateCode } from '../src/codegen/codegen';
import { createDocument, createNode, insertNode, parseDocument } from '../src/core/document';
import { Editor } from '../src/core/editor';
import { exportSvg } from '../src/core/export';
import { applyOps, ChangeTracker } from '../src/core/ops';
import { createNote, markdownBlocks, mergeMessages, noteSummary } from '../src/core/notes';

function setup() {
  const editor = new Editor(createDocument(), { autosave: false });
  const frame = createNode('frame', { name: 'Login', x: 0, y: 0, width: 200, height: 100, layoutMode: 'vertical' });
  editor.change((d) => insertNode(d, frame, editor.pageId));
  return { editor, frame };
}

describe('annotation layers', () => {
  it('are created with their kind, kept in files and cleaned when invalid', () => {
    const { editor, frame } = setup();
    editor.select([frame.id]);
    const callout = editor.addNote('callout')!;
    const c = editor.doc.nodes[callout];
    // A callout points at the selected layer, to its right, on the page.
    expect(c).toMatchObject({ type: 'note', parentId: editor.pageId, characters: 'Login', layoutAbsolute: true, note: { kind: 'callout', targetId: frame.id } });
    expect(c.x).toBeGreaterThan(200);
    expect(editor.selection).toEqual([callout]);
    expect(editor.focusNoteId).toBe(callout);

    const sticky = editor.addNote('sticky', 'Ann')!;
    expect(editor.doc.nodes[sticky].note).toEqual({ kind: 'sticky', author: 'Ann' });

    const raw = JSON.parse(JSON.stringify(editor.doc));
    raw.nodes[sticky].note = { kind: 'bogus', messages: 'x' };
    raw.nodes[frame.id].note = { kind: 'chat' };
    raw.nodes[callout].note.targetId = 42;
    const doc = parseDocument(raw);
    expect(doc.nodes[sticky].note).toEqual({ kind: 'sticky' });
    expect(doc.nodes[frame.id].note).toBeUndefined();
    expect(doc.nodes[callout].note).toEqual({ kind: 'callout', targetId: '' });
  });

  it('chats keep everyone’s messages when two people post at once', () => {
    const { editor } = setup();
    const chat = editor.addNote('chat')!;
    const base = JSON.parse(JSON.stringify(editor.doc));
    const a = new Editor(parseDocument(structuredClone(base)), { autosave: false });
    const b = new Editor(parseDocument(structuredClone(base)), { autosave: false });
    const ta = new ChangeTracker();
    ta.reset(a.doc);
    const tb = new ChangeTracker();
    tb.reset(b.doc);
    a.postMessage(chat, 'Hi from A', 'Ann');
    b.postMessage(chat, 'Hi from B', 'Bob');
    const opsA = ta.collect(a.doc);
    const opsB = tb.collect(b.doc);
    // The server applies both in turn; each client gets the other's change.
    const server = parseDocument(structuredClone(base));
    applyOps(server, opsA);
    applyOps(server, opsB);
    a.applyRemote(opsB);
    b.applyRemote(opsA);
    for (const d of [server, a.doc, b.doc]) expect(d.nodes[chat].note!.messages!.map((m) => m.text).sort()).toEqual(['Hi from A', 'Hi from B']);

    // A deletion wins over an older copy of the message.
    const id = a.doc.nodes[chat].note!.messages!.find((m) => m.author === 'Ann')!.id;
    a.deleteMessage(chat, id);
    const merged = mergeMessages(a.doc.nodes[chat].note!.messages, b.doc.nodes[chat].note!.messages);
    expect(merged.find((m) => m.id === id)).toMatchObject({ deleted: true, text: '' });
    expect(noteSummary({ ...a.doc.nodes[chat], note: { kind: 'chat', messages: merged } })).toBe('1 message, last: Bob: Hi from B');
  });

  it('checklists and descriptions', () => {
    const { editor } = setup();
    const list = editor.addNote('checklist')!;
    editor.updateNote(list, { items: [{ id: '1', text: 'Empty state', done: true }, { id: '2', text: 'Error state', done: false }] });
    expect(noteSummary(editor.doc.nodes[list])).toBe('To do (1/2 done)');
    editor.undo();
    expect(editor.doc.nodes[list].note!.items).toEqual([]);
    expect(markdownBlocks('# Title\n\n- one\n- [x] done\n> said\n```\ncode\n```\n**bold** `x`').map((b) => `${b.kind}:${b.text}`)).toEqual([
      'h1:Title',
      'blank:',
      'bullet:one',
      'done:done',
      'quote:said',
      'code:code',
      'p:bold x',
    ]);
  });

  it('are left out of SVG, code and exported images but drawn on screenshots', async () => {
    const { editor, frame } = setup();
    const note = createNote('sticky', { characters: 'Remember the error state', x: 10, y: 10, width: 80, height: 60 });
    editor.change((d) => insertNode(d, note, frame.id));
    // Notes inside an auto layout frame do not take part in it.
    expect(editor.doc.nodes[note.id]).toMatchObject({ x: 10, y: 10 });
    expect(exportSvg(editor.doc, [frame.id])).not.toContain('Remember');
    expect(generateCode(editor.doc, frame.id, 'html').code).not.toContain('Remember');

    const mod = await initCanvas();
    if (!mod) return;
    const pixel = async (annotations: boolean) => {
      const img = await mod.loadImage(await renderPng(editor.doc, [frame.id], { annotations }));
      const c = mod.createCanvas(img.width, img.height).getContext('2d');
      c.drawImage(img, 0, 0);
      return [...c.getImageData(80, 60, 1, 1).data];
    };
    expect(await pixel(false)).toEqual([255, 255, 255, 255]);
    // The sticky's yellow.
    expect(await pixel(true)).toEqual([255, 229, 143, 255]);

    // Every kind draws without errors.
    for (const kind of ['doc', 'chat', 'checklist', 'callout'] as const) {
      const id = editor.addNote(kind)!;
      if (kind === 'chat') editor.postMessage(id, 'A long message that needs to wrap over several lines in the bubble', 'Ann');
      await renderPng(editor.doc, [id], { annotations: true });
    }
  });
});
