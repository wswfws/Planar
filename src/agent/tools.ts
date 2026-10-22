// MCP tools for Planar. See docs/MCP.md for the user-facing description.

import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { generateCode, generateTokens } from '../codegen/codegen';
import { descendants, getPageOf, insertNode, solid } from '../core/document';
import type { Editor } from '../core/editor';
import { exportSvg } from '../core/export';
import type { VariableType } from '../core/types';
import { variableValue } from '../core/variables';
import { find, outline, overview, summary } from './outline';
import { contextChain, formatContext, sanitizeContext } from '../core/context';
import { createNote, MAX_ITEMS, newItem } from '../core/notes';
import { formatInbox, formatNote, freeSpot, inbox, relatedNotes } from './notes';
import { shadowToString } from '../core/effects';
import { visiblePageIds } from '../core/library';
import { applyProps, applyStyleSpec, createLayers, describe, PropError, type Friendly } from './props';
import { renderPng } from './raster';
import { parseLink, type AgentSession } from './session';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

const text = (t: string): Result => ({ content: [{ type: 'text', text: t }] });

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

export const INSTRUCTIONS = `Planar is an open-source design editor. These tools read and edit a Planar document (a file or a live shared room).

Workflow:
1. If nothing is open, call files to see your Planar files (or create one), then open it by id; or open a file link / local path.
2. overview first: pages, top-level frames, components (with props/variants), variables, the current selection and, in a live room, what people are looking at.
   Read the file brief there; context get <id> tells what a screen or component is for before you change it.
3. tree / find to locate layers; inspect for details. inspect returns the same vocabulary that create and update accept, so read → tweak → write back.
4. Design: create builds whole nested layouts in one call (frames with layout/gap/padding, text, shapes, component instances). update restyles or moves many layers in one call. Prefer auto layout ("layout": "column"/"row") over absolute x/y.
5. Check visually with screenshot.
6. Prototypes: update a layer with "link": "<top-level frame name>" (optional "transition": "slide" | "dissolve") to make it go to that screen on click in Present mode; "link": null removes it.
7. Notes: notes inbox lists chat messages and notes that mention @ai — requests people left for you on the canvas; answer in the chat with notes post. Leave findings and to-dos as notes (sticky, doc, checklist, or a callout pointing at a layer).
   Context: write decisions, intent and open questions with context set (the file brief, or notes on a layer) so people and later agents know them.
8. Developers: code gives React (components with typed props/variants) or HTML/CSS; tokens exports variables.
Colours: "#RRGGBB", "#RRGGBB 50%", or "$variableName". Sizes: number, "hug" or "fill". Every change is undoable with undo.`;

function guard<A>(fn: (args: A) => Promise<Result> | Result): (args: A) => Promise<Result> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      const message = e instanceof PropError ? e.message : (e as Error).message ?? String(e);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  };
}

/** Runs edits as one undo step; on failure everything is rolled back. */
async function edit<T>(session: AgentSession, fn: (editor: Editor) => T): Promise<T> {
  const editor = await session.ready();
  if (editor.readOnly) throw new PropError('This file is view-only for you, so it cannot be changed. Ask the owner for edit access, or duplicate it with files.');
  editor.begin();
  try {
    const result = fn(editor);
    editor.commit();
    return result;
  } catch (e) {
    editor.cancel();
    throw e;
  }
}

export function registerTools(server: McpServer, session: AgentSession): void {
  const allowFiles = session.opts.allowFiles;

  const loadImage = (ref: string): string => {
    if (ref.startsWith('data:')) return ref;
    if (/^https?:\/\//.test(ref)) throw new PropError('Image URLs are not fetched; pass a local file path or a data: URL');
    if (!allowFiles) throw new PropError('Local image files are not available on this server; pass a data: URL');
    // Read synchronously: props are applied inside a synchronous edit.
    const buf = readFileSync(path.resolve(ref));
    return `data:${MIME[path.extname(ref).toLowerCase()] ?? 'image/png'};base64,${buf.toString('base64')}`;
  };

  server.registerTool(
    'open',
    {
      title: 'Open document',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'Open a Planar file by id or by its link (https://host/file/<id>), or a local .planar.json path (created if missing). Edits to a Planar file are live: people in it see them immediately. Access follows the signed-in user\'s rights.',
      inputSchema: {
        fileId: z.string().optional().describe('Planar file id'),
        link: z.string().optional().describe('Planar file link'),
        file: z.string().optional().describe('Path to a local .planar.json file'),
      },
    },
    guard(async ({ fileId, link, file }) => {
      let msg: string;
      if (fileId) msg = await session.openFileId(fileId);
      else if (link) msg = await session.openRoom(parseLink(link));
      else if (file) msg = await session.openFile(file);
      else return text(`Currently: ${session.describe()}. Pass fileId, link or file to open something.`);
      return text(`${msg}\n\n${overview(await session.ready())}`);
    }),
  );

  server.registerTool(
    'files',
    {
      title: 'Planar files',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      description:
        'Files on the Planar server for the signed-in user. list: files you own (scope mine), that others shared with you (scope shared) or both (scope all), optionally in one project or matching a name search, with your role. projects: projects you belong to. create: a new empty file, optionally inside a project. duplicate: copy any file you can view into your own files.',
      inputSchema: {
        action: z.enum(['list', 'projects', 'create', 'duplicate']),
        scope: z.enum(['mine', 'shared', 'all']).optional().describe('list: which files (default mine)'),
        project: z.string().optional().describe('list / create: project name or id'),
        q: z.string().optional().describe('list: only files whose name contains this text'),
        name: z.string().optional().describe('create: file name'),
        fileId: z.string().optional().describe('duplicate: the file to copy'),
      },
    },
    guard(async ({ action, scope, name, fileId, project, q }) => {
      if (action === 'projects') {
        const list = await session.listProjects();
        return text(list.length ? list.map((p) => `${p.id}  "${p.name}"  ${p.role ?? ''}  ${p.files} files`).join(String.fromCharCode(10)) : 'No projects yet.');
      }
      if (action === 'list') {
        const list = await session.listFiles(project || q ? (scope ?? 'all') : (scope ?? 'mine'), { q, project });
        if (!list.length) return text(scope === 'shared' ? 'Nothing is shared with you yet.' : 'No files yet. Use files create.');
        return text(list.map((f) => `${f.id}  "${f.name}"  ${f.role ?? ''}${f.owner ? ` (owner ${f.owner.username})` : ''}  ${f.link}`).join('\n'));
      }
      if (action === 'create') {
        const f = await session.createFile(name, project);
        return text(`Created "${f.name}" — id ${f.id}. Open it with open fileId=${f.id}.\n${f.link}`);
      }
      if (!fileId) throw new PropError('duplicate needs fileId');
      const f = await session.duplicateFile(fileId);
      return text(`Copied to "${f.name}" — id ${f.id}. Open it with open fileId=${f.id}.\n${f.link}`);
    }),
  );

  server.registerTool(
    'versions',
    {
      title: 'Version history',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      description:
        'Restore points of the open Planar file. list: saved versions, newest first (a version is saved automatically before an agent starts editing). save: store the file as it is now under a label. restore: put the file back to a version; the current state is saved first, so a restore can be undone the same way.',
      inputSchema: {
        action: z.enum(['list', 'save', 'restore']),
        label: z.string().optional().describe('save: what to call this version'),
        versionId: z.string().optional().describe('restore: id from list'),
      },
    },
    guard(async ({ action, label, versionId }) => {
      await session.ready();
      if (action === 'list') {
        const list = await session.listVersions();
        if (!list.length) return text('No saved versions yet.');
        return text(list.map((v) => `${v.id}  ${new Date(v.createdAt).toISOString().slice(0, 16).replace('T', ' ')}  ${v.kind}  "${v.label}"${v.authorName ? `  by ${v.authorName}` : ''}  ${v.nodes} layers`).join(String.fromCharCode(10)));
      }
      if (action === 'save') {
        const v = await session.saveVersion(label?.trim() || 'Saved by agent');
        return text(`Saved version ${v.id} "${v.label}".`);
      }
      if (!versionId) throw new PropError('restore needs versionId (see list)');
      await session.restoreVersion(versionId);
      return text(`Restored version ${versionId}. The previous state was saved as a version too.`);
    }),
  );

  server.registerTool(
    'comments',
    {
      title: 'Comments',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      description:
        'Comment threads pinned on the canvas of the open Planar file. list: open threads with their layer, page and replies (resolved: true to include resolved ones). add: start a thread on a layer (nodeId) or at a point of the current page. reply: answer in a thread. resolve: mark a thread resolved or open again.',
      inputSchema: {
        action: z.enum(['list', 'add', 'reply', 'resolve']),
        text: z.string().optional().describe('add / reply: the comment; @username mentions a person'),
        nodeId: z.string().optional().describe('add: layer the pin is attached to'),
        x: z.number().optional().describe('add: x on the page (default 0)'),
        y: z.number().optional().describe('add: y on the page (default 0)'),
        commentId: z.string().optional().describe('reply / resolve: id of the thread'),
        resolved: z.boolean().optional().describe('list: include resolved threads. resolve: false reopens (default true)'),
      },
    },
    guard(async ({ action, text: body, nodeId, x, y, commentId, resolved }) => {
      const editor = await session.ready();
      if (action === 'list') {
        const all = await session.listComments();
        const roots = all.filter((c) => !c.threadId && (resolved || !c.resolvedAt));
        if (!roots.length) return text(resolved ? 'No comments.' : 'No open comments.');
        const nl = String.fromCharCode(10);
        return text(
          roots
            .map((r) => {
              const where = r.nodeId && editor.doc.nodes[r.nodeId] ? `on "${editor.doc.nodes[r.nodeId].name}" (${r.nodeId})` : `at ${Math.round(r.x)},${Math.round(r.y)}`;
              const page = editor.doc.nodes[r.pageId]?.name ?? r.pageId;
              const replies = all.filter((c) => c.threadId === r.id);
              const line = (c: typeof r) => `${c.author.name}${c.agent ? ' (agent)' : ''}: ${c.text}`;
              return [`${r.id}  ${r.resolvedAt ? '[resolved] ' : ''}page "${page}" ${where}`, `  ${line(r)}`, ...replies.map((c) => `  ↳ ${line(c)}`)].join(nl);
            })
            .join(nl + nl),
        );
      }
      if (action === 'resolve') {
        if (!commentId) throw new PropError('resolve needs commentId (see list)');
        await session.resolveComment(commentId, resolved !== false);
        return text(resolved === false ? 'Thread reopened.' : 'Thread resolved.');
      }
      if (!body?.trim()) throw new PropError(`${action} needs text`);
      if (action === 'reply') {
        if (!commentId) throw new PropError('reply needs commentId (see list)');
        await session.addComment({ text: body, threadId: commentId });
        return text('Replied.');
      }
      const c = await session.addComment({ text: body, pageId: editor.pageId, nodeId, x, y });
      return text(`Added comment ${c.id}.`);
    }),
  );

  server.registerTool(
    'overview',
    {
      title: 'Document overview',
      description: 'Pages with their top-level layers, components (props, variants), variables and modes, the selection, and people in a live file.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async () => text(overview(await session.ready()))),
  );

  server.registerTool(
    'tree',
    {
      title: 'Layer tree',
      description: 'Indented outline of a page or layer: type, name, id, size, layout and key styles per line. Children are in document order: first = first in auto layout (and bottom-most when layers overlap).',
      inputSchema: {
        id: z.string().optional().describe('Page or layer id (default: current page)'),
        depth: z.number().int().min(0).max(30).optional().describe('Levels to show (default 3)'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ id, depth }) => {
      const editor = await session.ready();
      const root = id ?? editor.pageId;
      if (!editor.doc.nodes[root]) throw new PropError(`No layer with id ${root}`);
      return text(outline(editor.doc, root, depth ?? 3));
    }),
  );

  server.registerTool(
    'find',
    {
      title: 'Find layers',
      description: 'Find layers by name, text content and/or context notes (substring, or /regex/) and type, on the current page, inside a layer, or everywhere.',
      inputSchema: {
        name: z.string().optional(),
        text: z.string().optional().describe('Match text layer content'),
        context: z.string().optional().describe('Match the context notes written on layers'),
        type: z.string().optional().describe('frame, text, rectangle, ellipse, vector, group, component, componentSet, instance, note'),
        within: z.string().optional().describe('Layer or page id, or "all" for every page (default: current page)'),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (q) => {
      const editor = await session.ready();
      const found = find(editor.doc, q, editor.pageId);
      if (!found.length) return text('No matching layers.');
      return text(found.map((n) => `- ${summary(editor.doc, n)}`).join('\n'));
    }),
  );

  server.registerTool(
    'inspect',
    {
      title: 'Inspect layers',
      description: 'All properties of layers, in the same property vocabulary used for editing (layout, gap, padding, fill, text, size, props, variant…). Set children=true to include nested layers.',
      inputSchema: {
        ids: z.array(z.string()).min(1).describe('Layer ids'),
        children: z.boolean().optional().describe('Include descendants as nested "layers"'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ ids, children }) => {
      const editor = await session.ready();
      const { doc } = editor;
      const deep = (id: string): Friendly => {
        const n = doc.nodes[id];
        if (!n) throw new PropError(`No layer with id ${id}`);
        const d = describe(doc, n);
        if (children && n.children.length && n.type !== 'instance') {
          delete d.children;
          d.layers = n.children.map(deep);
        }
        return d;
      };
      return text(JSON.stringify(ids.length === 1 ? deep(ids[0]) : ids.map(deep), null, 2));
    }),
  );

  server.registerTool(
    'context',
    {
      title: 'Context notes',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      description:
        'Notes (markdown) that explain what the file and its layers are for: the file brief (goal, audience, rules), and notes on pages, frames, components and any layer. get: everything written about a layer, from the file brief through its page, parents and main component down to the layer itself (no id: the file brief). set: replace the notes of a layer, or the file brief when id is omitted; append: true adds a paragraph instead. Read context before changing a screen, and write down decisions and open questions so the next person or agent knows them.',
      inputSchema: {
        action: z.enum(['get', 'set']),
        id: z.string().optional().describe('Layer or page id (omit for the file brief)'),
        text: z.string().optional().describe('set: the notes (markdown); empty clears them'),
        append: z.boolean().optional().describe('set: add text as a new paragraph instead of replacing'),
      },
    },
    guard(async ({ action, id, text: body, append }) => {
      const editor = await session.ready();
      if (id && !editor.doc.nodes[id]) throw new PropError(`No layer with id ${id}`);
      if (action === 'get') {
        const chain = id ? contextChain(editor.doc, id) : contextChain(editor.doc, '').filter((e) => e.source === 'file');
        const notes = id ? relatedNotes(editor.doc, id) : [];
        const parts = [chain.length ? formatContext(chain) : id ? 'Nothing is written about this layer, its parents or the file yet.' : 'The file has no brief yet.'];
        if (notes.length) parts.push(`# Annotations on and around this screen\n\n${notes.map((n) => formatNote(editor.doc, n, 10)).join('\n\n')}`);
        return text(parts.join('\n\n'));
      }
      if (body === undefined) throw new PropError('set needs text');
      const join = (old: string) => sanitizeContext(append && old.trim() ? `${old.trimEnd()}\n\n${body.trim()}` : body.trim());
      await edit(session, (ed) => {
        if (id) ed.updateNodes([id], (n) => (n.context = join(n.context)));
        else ed.setDocumentContext(join(ed.doc.context));
      });
      await session.committed(id ? [id] : []);
      return text(id ? `Context of "${editor.doc.nodes[id].name}" saved.` : 'File brief saved.');
    }),
  );

  const noteKinds = ['sticky', 'doc', 'chat', 'checklist', 'callout'] as const;
  const itemSpec = z.union([z.string(), z.object({ text: z.string(), done: z.boolean().optional() })]);

  server.registerTool(
    'notes',
    {
      title: 'Notes, chats and checklists',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      description:
        'Annotation layers people and agents leave on the canvas: sticky notes, text descriptions (markdown), chats, checklists and callouts (a label with an arrow to a layer). They are not part of the design (not exported or turned into code). ' +
        'inbox: requests for you — chat messages and notes that mention @ai and have no agent reply yet; check it when you start and after you finish a task. ' +
        'list: every note on the current page (within: "all" for every page) with its text. read: full contents of notes (ids), a chat with its messages. ' +
        'add: a new note (kind, text; title and items for chats/checklists; target: a layer id to point a callout at or to place the note beside; x/y on the page; color "#RRGGBB"). ' +
        'post: write a message in a chat (id, text) — your answer to a request there. set: change a note (text, title, items to replace a checklist, check: [{item, done}] to tick items by id, number or text, target, color). Delete notes with delete.',
      inputSchema: {
        action: z.enum(['inbox', 'list', 'read', 'add', 'post', 'set']),
        id: z.string().optional().describe('read / post / set: the note'),
        ids: z.array(z.string()).optional().describe('read: several notes'),
        kind: z.enum(noteKinds).optional().describe('add: what to add (default sticky)'),
        text: z.string().optional().describe('add / set: the note text (markdown for doc); post: the message'),
        title: z.string().optional().describe('chat / checklist title'),
        items: z.array(itemSpec).optional().describe('checklist items (add / set replaces them)'),
        check: z.array(z.object({ item: z.union([z.string(), z.number()]), done: z.boolean() })).optional().describe('set: tick or untick checklist items by id, 1-based number or text'),
        target: z.string().optional().describe('add / set: layer id a callout points at (add: other notes are placed beside it)'),
        color: z.string().optional().describe('add / set: background colour #RRGGBB'),
        x: z.number().optional(),
        y: z.number().optional(),
        within: z.string().optional().describe('list: "all" for every page (default: current page)'),
      },
    },
    guard(async (a) => {
      const editor = await session.ready();
      const { doc } = editor;
      const noteOf = (id: string | undefined) => {
        if (!id) throw new PropError(`${a.action} needs id (see notes list)`);
        const n = doc.nodes[id];
        if (n?.type !== 'note') throw new PropError(`No note with id ${id}`);
        return n;
      };
      if (a.action === 'inbox') return text(formatInbox(doc, inbox(doc)));
      if (a.action === 'list') {
        const pages = a.within === 'all' ? visiblePageIds(doc) : [editor.pageId];
        const lines: string[] = [];
        for (const pid of pages) {
          const notes = descendants(doc, pid).map((id) => doc.nodes[id]).filter((n) => n?.type === 'note');
          if (!notes.length) continue;
          lines.push(`page ${JSON.stringify(doc.nodes[pid].name)} #${pid}:`, ...notes.map((n) => `- ${summary(doc, n)}`));
        }
        return text(lines.length ? lines.join('\n') : 'No notes yet. Add one with notes add.');
      }
      if (a.action === 'read') {
        const ids = a.ids ?? (a.id ? [a.id] : []);
        if (!ids.length) throw new PropError('read needs id or ids');
        return text(ids.map((id) => formatNote(doc, noteOf(id), 200)).join('\n\n'));
      }
      const checkHex = (c: string | undefined) => {
        if (c !== undefined && !/^#[0-9a-f]{6}$/i.test(c)) throw new PropError('color must be "#RRGGBB"');
        return c?.toUpperCase();
      };
      const toItems = (list: z.infer<typeof itemSpec>[]) => list.slice(0, MAX_ITEMS).map((i) => (typeof i === 'string' ? newItem(i) : newItem(i.text, i.done === true)));
      if (a.target && !doc.nodes[a.target]) throw new PropError(`No layer with id ${a.target}`);
      if (a.action === 'post') {
        const n = noteOf(a.id);
        if (n.note?.kind !== 'chat') throw new PropError('post writes in a chat; use set to change other notes');
        if (!a.text?.trim()) throw new PropError('post needs text');
        await edit(session, (ed) => ed.postMessage(n.id, a.text!, session.agentName, true));
        await session.committed([n.id]);
        return text(`Posted in ${JSON.stringify(n.characters || 'Chat')}.`);
      }
      if (a.action === 'add') {
        const kind = a.kind ?? 'sticky';
        const color = checkHex(a.color);
        const id = await edit(session, (ed) => {
          const note = createNote(kind);
          if (a.text !== undefined && kind !== 'chat' && kind !== 'checklist') note.characters = a.text;
          if (a.title !== undefined && (kind === 'chat' || kind === 'checklist')) note.characters = a.title;
          if (kind === 'checklist' && a.items) note.note = { ...note.note!, items: toItems(a.items) };
          if (kind === 'callout' && a.target) note.note = { ...note.note!, targetId: a.target };
          if (kind === 'sticky') note.note = { ...note.note!, author: session.agentName };
          if (color) note.fills = [solid(color)];
          const pageId = a.target ? getPageOf(ed.doc, a.target)?.id ?? ed.pageId : ed.pageId;
          const at = a.x !== undefined && a.y !== undefined ? { x: a.x, y: a.y } : freeSpot(ed.doc, pageId, note, a.target);
          note.x = at.x;
          note.y = at.y;
          ed.change((d) => insertNode(d, note, pageId));
          if (kind === 'chat' && a.text?.trim()) ed.postMessage(note.id, a.text, session.agentName, true);
          return note.id;
        });
        await session.committed([id]);
        const ed = await session.ready();
        return text(`Added ${summary(ed.doc, ed.doc.nodes[id])}`);
      }
      // set
      const n = noteOf(a.id);
      const color = checkHex(a.color);
      await edit(session, (ed) => {
        const kind = n.note?.kind ?? 'sticky';
        ed.updateNodes([n.id], (node) => {
          if (a.text !== undefined && kind !== 'chat' && kind !== 'checklist') node.characters = a.text;
          if (a.title !== undefined && (kind === 'chat' || kind === 'checklist')) node.characters = a.title;
          if (color) node.fills = [solid(color)];
          const data = { ...node.note! };
          if (a.target !== undefined && kind === 'callout') data.targetId = a.target;
          if (kind === 'checklist') {
            let items = a.items ? toItems(a.items) : [...(data.items ?? [])];
            for (const c of a.check ?? []) {
              const ref = String(c.item);
              const i =
                items.findIndex((x) => x.id === ref) >= 0
                  ? items.findIndex((x) => x.id === ref)
                  : /^\d+$/.test(ref) && Number(ref) >= 1 && Number(ref) <= items.length
                    ? Number(ref) - 1
                    : items.findIndex((x) => x.text.toLowerCase() === ref.toLowerCase());
              if (i < 0) throw new PropError(`No checklist item "${ref}"`);
              items = items.map((x, k) => (k === i ? { ...x, done: c.done } : x));
            }
            data.items = items;
          } else if (a.items || a.check) throw new PropError('items and check apply to checklists');
          node.note = data;
        });
      });
      await session.committed([n.id]);
      const ed = await session.ready();
      return text(`Updated ${summary(ed.doc, ed.doc.nodes[n.id])}`);
    }),
  );

  server.registerTool(
    'screenshot',
    {
      title: 'Screenshot',
      description: 'Render a layer (or the whole current page) to a PNG image to check how it looks.',
      inputSchema: {
        id: z.string().optional().describe('Layer or page id (default: whole current page)'),
        scale: z.number().min(0.05).max(4).optional().describe('Pixel ratio (default 1)'),
        maxSize: z.number().int().min(64).max(4096).optional().describe('Longest side in px (default 1600)'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ id, scale, maxSize }) => {
      const editor = await session.ready();
      const { doc } = editor;
      if (id && !doc.nodes[id]) throw new PropError(`No layer with id ${id}`);
      await session.ensureFonts();
      // A page id (or no id) renders the whole page on its background.
      const page = !id ? doc.nodes[editor.pageId] : doc.nodes[id].type === 'page' ? doc.nodes[id] : null;
      const ids = page ? page.children.filter((c) => doc.nodes[c].visible) : [id!];
      if (!ids.length) throw new PropError('Nothing to render on this page');
      const bg = page?.fills[0];
      // Screenshots show annotations (notes, chats) too: they are part of what the agent should see.
      const png = await renderPng(doc, ids, { scale, maxSize, background: page && bg?.type === 'solid' ? bg.color : undefined, annotations: true });
      return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: page ? `Page ${page.name}` : summary(doc, doc.nodes[id!]) }] };
    }),
  );

  const layerSpec = z.record(z.string(), z.unknown());

  server.registerTool(
    'create',
    {
      title: 'Create layers',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      description:
        'Create layers from nested descriptions in one undoable step. Each layer: {type, name, ...props, children:[...]}. Types: frame, text, rectangle, ellipse, line, vector, group, component, instance (with component:"Name", props:{…}, variant:{…}). Props: width/height (number|"hug"|"fill"), layout ("row"|"column"), gap, padding, align, crossAlign, fill/stroke ("#hex", "#hex 50%", "$var"), radius, shadow ("0 4 12 #000000 25%", "inset …"), blur, backgroundBlur, wrap/rowGap (row layouts), constraints ("left-right top", outside auto layout), text, size, weight, font, lineHeight, textAlign, x/y (outside auto layout), opacity, mode, context (notes on what the layer is for, markdown).',
      inputSchema: {
        parent: z.string().optional().describe('Parent frame/page id (default: current page)'),
        index: z.number().int().min(0).optional().describe('Position among siblings (default: on top)'),
        layers: z.array(layerSpec).min(1),
      },
    },
    guard(async ({ parent, index, layers }) => {
      const result = await edit(session, (editor) => createLayers(editor, parent ?? editor.pageId, layers as Friendly[], index, loadImage));
      await session.committed(result.ids);
      const editor = await session.ready();
      const lines = [`Created ${result.ids.length} layer${result.ids.length === 1 ? '' : 's'}:`, ...result.ids.map((id) => outline(editor.doc, id, 3))];
      if (result.warnings.length) lines.push('', 'Warnings:', ...result.warnings.map((w) => `- ${w}`));
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'update',
    {
      title: 'Update layers',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      description:
        'Change properties of one or many layers in one undoable step: [{id, ...props}]. Same props as when creating layers, plus parent/index to move, component to swap an instance, props/variant for instances. Use null fill to remove fills.',
      inputSchema: {
        changes: z.array(z.object({ id: z.string() }).catchall(z.unknown())).min(1),
      },
    },
    guard(async ({ changes }) => {
      const warnings = await edit(session, (editor) =>
        changes.flatMap((c) => {
          const { id, ...props } = c as Friendly & { id: string };
          return applyProps(editor, id, props, loadImage).map((w) => `${id}: ${w}`);
        }),
      );
      await session.committed(changes.map((c) => c.id));
      const editor = await session.ready();
      const lines = changes.map((c) => (editor.doc.nodes[c.id] ? `- ${summary(editor.doc, editor.doc.nodes[c.id])}` : `- ${c.id} (gone)`));
      if (warnings.length) lines.push('', 'Warnings:', ...warnings.map((w) => `- ${w}`));
      return text(`Updated:\n${lines.join('\n')}`);
    }),
  );

  server.registerTool(
    'delete',
    {
      title: 'Delete layers',
      description: 'Delete layers (and everything inside them). Layers inside instances cannot be deleted.',
      inputSchema: { ids: z.array(z.string()).min(1) },
      annotations: { destructiveHint: true },
    },
    guard(async ({ ids }) => {
      const before = await session.ready();
      const missing = ids.filter((id) => !before.doc.nodes[id]);
      await edit(session, (editor) => {
        editor.select(ids.filter((id) => editor.doc.nodes[id]));
        editor.deleteSelection();
      });
      await session.committed([]);
      const editor = await session.ready();
      const kept = ids.filter((id) => editor.doc.nodes[id]);
      const deleted = ids.length - kept.length - missing.length;
      return text(
        `Deleted ${deleted} layer${deleted === 1 ? '' : 's'}.` +
          (kept.length ? ` Not deleted (inside instances): ${kept.join(', ')}.` : '') +
          (missing.length ? ` Unknown ids: ${missing.join(', ')}.` : ''),
      );
    }),
  );

  server.registerTool(
    'components',
    {
      title: 'Component operations',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      description:
        'create: turn layers into a component (a frame becomes one; other selections are wrapped). combine_variants: make a component set from components. add_variant: duplicate a variant. variant_value: set a variant property value (id, axis, value). add_property: add a text/boolean/instance property to a component or set, optionally binding a layer (layer, field: characters|visible|componentId). detach: turn instances into frames.',
      inputSchema: {
        action: z.enum(['create', 'combine_variants', 'add_variant', 'variant_value', 'add_property', 'detach']),
        ids: z.array(z.string()).min(1),
        axis: z.string().optional(),
        value: z.string().optional(),
        name: z.string().optional().describe('Property name (add_property)'),
        type: z.enum(['text', 'boolean', 'instance']).optional(),
        layer: z.string().optional().describe('Layer to bind (add_property)'),
        field: z.enum(['characters', 'visible', 'componentId']).optional(),
      },
    },
    guard(async (a) => {
      const touched = await edit(session, (editor) => {
        const { doc } = editor;
        for (const id of a.ids) if (!doc.nodes[id]) throw new PropError(`No layer with id ${id}`);
        switch (a.action) {
          case 'create':
            editor.select(a.ids);
            editor.createComponent();
            return editor.selection;
          case 'combine_variants':
            editor.select(a.ids);
            editor.combineAsVariants();
            return editor.selection;
          case 'add_variant':
            editor.addVariant(a.ids[0]);
            return editor.selection;
          case 'variant_value':
            if (!a.axis || a.value === undefined) throw new PropError('variant_value needs axis and value');
            editor.setVariantValue(a.ids[0], a.axis, a.value);
            return a.ids;
          case 'add_property': {
            if (!a.type) throw new PropError('add_property needs type');
            const bind = a.layer ? { nodeId: a.layer, field: a.field ?? (a.type === 'text' ? 'characters' : a.type === 'boolean' ? 'visible' : 'componentId') } : undefined;
            const propId = editor.addComponentProp(a.ids[0], a.type, bind);
            if (!propId) throw new PropError('Properties can only be added to components or component sets');
            if (a.name) {
              const host = Object.values(doc.nodes).find((n) => n.componentProps.some((p) => p.id === propId))!;
              editor.updateComponentProp(host.id, propId, { name: a.name });
            }
            return a.ids;
          }
          case 'detach':
            editor.select(a.ids);
            editor.detachInstances();
            return a.ids;
        }
      });
      await session.committed(touched);
      const editor = await session.ready();
      return text(touched.filter((id) => editor.doc.nodes[id]).map((id) => outline(editor.doc, id, 1)).join('\n') || 'Done.');
    }),
  );

  server.registerTool(
    'variables',
    {
      title: 'Variables',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      description:
        'Create or update variables and modes in one step. set: [{name, type (color|number|string|boolean; needed for new ones), value (all modes) or values: {ModeName: value}}]. modes: mode names to make sure exist (e.g. ["Light","Dark"]). remove: variable names to delete. Reference variables in props as "$name".',
      inputSchema: {
        set: z
          .array(
            z.object({
              name: z.string(),
              type: z.enum(['color', 'number', 'string', 'boolean']).optional(),
              value: z.union([z.string(), z.number(), z.boolean()]).optional(),
              values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
            }),
          )
          .optional(),
        modes: z.array(z.string()).optional(),
        remove: z.array(z.string()).optional(),
      },
    },
    guard(async ({ set, modes, remove }) => {
      await edit(session, (editor) => {
        const { doc } = editor;
        for (const name of modes ?? []) {
          if (doc.modes.some((m) => m.name.toLowerCase() === name.toLowerCase())) continue;
          // A single default mode is renamed instead of keeping "Mode 1".
          if (doc.modes.length === 1 && /^Mode \d+$/.test(doc.modes[0].name) && !doc.variables.length) editor.renameMode(doc.modes[0].id, name);
          else {
            editor.addMode();
            editor.renameMode(doc.modes[doc.modes.length - 1].id, name);
          }
        }
        for (const v of set ?? []) {
          let variable = doc.variables.find((x) => x.name === v.name);
          if (!variable) {
            if (!v.type) throw new PropError(`New variable "${v.name}" needs a type`);
            const id = editor.addVariable(v.type as VariableType);
            editor.renameVariable(id, v.name);
            variable = doc.variables.find((x) => x.id === id)!;
          }
          if (v.value !== undefined) for (const m of doc.modes) editor.setVariableValue(variable.id, m.id, v.value);
          for (const [modeName, value] of Object.entries(v.values ?? {})) {
            const mode = doc.modes.find((m) => m.name.toLowerCase() === modeName.toLowerCase());
            if (!mode) throw new PropError(`Unknown mode "${modeName}" — add it with modes: ["${modeName}"]`);
            editor.setVariableValue(variable.id, mode.id, value);
          }
        }
        for (const name of remove ?? []) {
          const variable = doc.variables.find((x) => x.name === name);
          if (variable) editor.deleteVariable(variable.id);
        }
      });
      await session.committed([]);
      const { doc } = await session.ready();
      const lines = [`Modes: ${doc.modes.map((m) => m.name).join(', ')}`, 'Variables:'];
      for (const v of doc.variables) lines.push(`- $${v.name} (${v.type}) ${doc.modes.map((m) => `${m.name}=${JSON.stringify(variableValue(doc, v, m.id))}`).join(' ')}`);
      if (!doc.variables.length) lines.push('- none');
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'styles',
    {
      title: 'Text and effect styles',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      description:
        'Create or update named styles in one step; layers using a style follow its changes. set: [{name, type (text|effect; needed for new ones), font, size, weight, lineHeight (text) or shadow, blur, backgroundBlur (effect; same forms as layer props), or from: a layer id to copy them from}]. remove: style names to delete (layers keep their look). With nothing given, lists the styles. Apply with the layer props textStyle / effectStyle: "Name".',
      inputSchema: {
        set: z
          .array(
            z.object({
              name: z.string(),
              type: z.enum(['text', 'effect']).optional(),
              from: z.string().optional(),
              font: z.string().optional(),
              size: z.number().optional(),
              weight: z.union([z.number(), z.string()]).optional(),
              lineHeight: z.union([z.number(), z.literal('auto')]).optional(),
              shadow: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
              blur: z.number().optional(),
              backgroundBlur: z.number().optional(),
            }),
          )
          .optional(),
        remove: z.array(z.string()).optional(),
      },
    },
    guard(async ({ set, remove }) => {
      if (set?.length || remove?.length) {
        await edit(session, (editor) => {
          for (const s of set ?? []) applyStyleSpec(editor, s);
          for (const name of remove ?? []) {
            const style = editor.doc.styles.find((x) => x.name === name);
            if (style) editor.deleteStyle(style.id);
          }
        });
        await session.committed([]);
      }
      const { doc } = await session.ready();
      const used = (id: string) => Object.values(doc.nodes).filter((n) => n.textStyleId === id || n.effectStyleId === id).length;
      const lines = doc.styles.map((s) =>
        s.type === 'text'
          ? `- text "${s.name}": ${s.fontFamily} ${s.fontWeight} ${s.fontSize}px, line height ${s.lineHeight || 'auto'} (${used(s.id)} layers)`
          : `- effect "${s.name}": ${s.effects.map((e) => (e.type === 'drop-shadow' || e.type === 'inner-shadow' ? shadowToString(e) : `${e.type} ${e.radius}`)).join(', ') || 'none'} (${used(s.id)} layers)`,
      );
      return text(lines.length ? `Styles:\n${lines.join('\n')}` : 'This document has no styles.');
    }),
  );

  server.registerTool(
    'libraries',
    {
      title: 'Team libraries',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      description:
        'Share components, variables and styles between files. list: libraries used in the open file and ones available to add (with versions). add / update: copy a library (name or file id) into the open file, or bring it to the latest version — its components then work like local ones (instances via create with component: "Name"). remove: stop using a library (its instances become ordinary layers). publish: publish the open file as a library (again to share changes).',
      inputSchema: {
        action: z.enum(['list', 'add', 'update', 'remove', 'publish']),
        library: z.string().optional().describe('Library name or file id (add, update, remove)'),
      },
    },
    guard(async ({ action, library }) => {
      const editor = await session.ready();
      if (action === 'publish') {
        const info = await session.publishLibrary();
        return text(`Published "${editor.doc.name}" as version ${info.version}: ${info.components} components, ${info.variables} variables, ${info.styles} styles.`);
      }
      const available = await session.listLibraries();
      const used = editor.doc.libraries ?? [];
      const pick = (list: { fileId: string; name: string }[]) => {
        if (!library) throw new PropError(`${action} needs library (a name or file id)`);
        const lower = library.toLowerCase();
        return list.find((l) => l.fileId === library) ?? list.find((l) => l.name.toLowerCase() === lower) ?? null;
      };
      if (action === 'add' || action === 'update') {
        const target = pick(available);
        if (!target) throw new PropError(`No published library "${library}". Available: ${available.map((l) => `"${l.name}"`).join(', ') || 'none'}`);
        const snapshot = await session.getLibrary(target.fileId);
        await edit(session, (ed) => ed.useLibrary(snapshot));
        await session.committed([]);
      } else if (action === 'remove') {
        const target = pick(used);
        if (!target) throw new PropError(`This file does not use a library "${library}"`);
        await edit(session, (ed) => ed.removeLibrary(target.fileId));
        await session.committed([]);
      }
      const now = (await session.ready()).doc.libraries ?? [];
      const lines = ['Used in this file:'];
      for (const l of now) {
        const latest = available.find((a) => a.fileId === l.fileId);
        lines.push(`- "${l.name}" (${l.fileId}) version ${l.version}${latest && latest.version > l.version ? ` — update to ${latest.version} available` : ''}`);
      }
      if (!now.length) lines.push('- none');
      lines.push('Available:');
      const rest = available.filter((a) => !now.some((l) => l.fileId === a.fileId) && a.fileId !== editor.collab?.fileId);
      for (const a of rest) lines.push(`- "${a.name}" (${a.fileId}) version ${a.version}: ${a.components} components, ${a.variables} variables, ${a.styles} styles`);
      if (!rest.length) lines.push('- none');
      return text(lines.join('\n'));
    }),
  );

  server.registerTool(
    'pages',
    {
      title: 'Pages',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      description:
        'list: all pages. create: add a page (name) and make it current. rename: id + name. delete: id (not the last page). open: id — make it the current page (the default target for new layers and searches).',
      inputSchema: {
        action: z.enum(['list', 'create', 'rename', 'delete', 'open']),
        id: z.string().optional(),
        name: z.string().optional(),
      },
    },
    guard(async ({ action, id, name }) => {
      const editor = await session.ready();
      const { doc } = editor;
      const need = () => {
        if (!id || doc.nodes[id]?.type !== 'page') throw new PropError(`No page with id ${id}`);
        return id;
      };
      let touched = false;
      if (action === 'create') {
        await edit(session, (e) => e.addPage(name));
        touched = true;
      } else if (action === 'rename') {
        if (!name) throw new PropError('rename needs name');
        const pid = need();
        await edit(session, (e) => e.renamePage(pid, name));
        touched = true;
      } else if (action === 'delete') {
        const pid = need();
        if (visiblePageIds(doc).length <= 1) throw new PropError('Cannot delete the only page');
        await edit(session, (e) => e.deletePage(pid));
        touched = true;
      } else if (action === 'open') {
        editor.setPage(need());
      }
      if (touched) await session.committed([]);
      const lines = visiblePageIds(editor.doc).map((pid) => {
        const p = editor.doc.nodes[pid];
        return `- page ${JSON.stringify(p.name)} #${pid}  ${p.children.length} top-level layer${p.children.length === 1 ? '' : 's'}${pid === editor.pageId ? '  (current)' : ''}`;
      });
      return text(`Pages:\n${lines.join('\n')}`);
    }),
  );

  server.registerTool(
    'select',
    {
      title: 'Select layers',
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: 'Select layers (switching page if needed). In a live file, other people see this selection.',
      inputSchema: { ids: z.array(z.string()) },
    },
    guard(async ({ ids }) => {
      const editor = await session.ready();
      const valid = ids.filter((id) => editor.doc.nodes[id]);
      const page = valid[0] ? getPageOf(editor.doc, valid[0]) : null;
      if (page && page.id !== editor.pageId) editor.setPage(page.id);
      await session.committed(valid);
      return text(valid.length ? `Selected:\n${valid.map((id) => `- ${summary(editor.doc, editor.doc.nodes[id])}`).join('\n')}` : 'Selection cleared.');
    }),
  );

  server.registerTool(
    'undo',
    {
      title: 'Undo',
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      description: 'Undo the agent\'s own last changes (never other people\'s).',
      inputSchema: { steps: z.number().int().min(1).max(50).optional() },
    },
    guard(async ({ steps }) => {
      const editor = await session.ready();
      let done = 0;
      for (let i = 0; i < (steps ?? 1) && editor.canUndo; i++, done++) editor.undo();
      await session.committed([]);
      return text(done ? `Undid ${done} step${done === 1 ? '' : 's'}.` : 'Nothing to undo.');
    }),
  );

  server.registerTool(
    'code',
    {
      title: 'Generate code',
      description:
        'Code for a layer. react: a React component (TSX + CSS); main components and component sets become components with typed props and variants, instances become <Component …/> elements. html: HTML + CSS. css: stylesheet only. Auto layout becomes flexbox; variables become var(--token) custom properties.',
      inputSchema: {
        id: z.string(),
        format: z.enum(['react', 'html', 'css']).optional().describe('Default react'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ id, format }) => {
      const editor = await session.ready();
      const result = generateCode(editor.doc, id, format ?? 'react');
      const lang = (format ?? 'react') === 'react' ? 'tsx' : format === 'css' ? 'css' : 'html';
      let out = '```' + lang + '\n' + result.code + '\n```';
      if (result.uses.length) out += `\n\nUses components: ${result.uses.map((u) => `${u.name} (code id=${u.id})`).join(', ')}`;
      if (editor.doc.variables.length) out += '\nVariables are referenced as CSS custom properties — get them with tokens.';
      return text(out);
    }),
  );

  server.registerTool(
    'tokens',
    {
      title: 'Design tokens',
      description: 'Export variables and styles for code: css (custom properties, one block per mode via [data-mode]; text styles as --font-* for font:, shadow styles as --shadow-*), json, or ts (variables only).',
      inputSchema: { format: z.enum(['css', 'json', 'ts']).optional().describe('Default css') },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ format }) => {
      const editor = await session.ready();
      if (!editor.doc.variables.length && !editor.doc.styles.length) return text('This document has no variables or styles.');
      const f = format ?? 'css';
      return text('```' + (f === 'ts' ? 'ts' : f) + '\n' + generateTokens(editor.doc, f) + '\n```');
    }),
  );

  server.registerTool(
    'export',
    {
      title: 'Export',
      annotations: { readOnlyHint: !allowFiles, destructiveHint: allowFiles, openWorldHint: false },
      description: allowFiles
        ? 'Export layers as SVG (markup) or PNG (image). With path, writes files instead (a directory gets one file per layer, named after it).'
        : 'Export layers as SVG markup or a PNG image.',
      inputSchema: {
        ids: z.array(z.string()).min(1),
        format: z.enum(['svg', 'png']),
        scale: z.number().min(0.1).max(4).optional().describe('PNG pixel ratio (default 2)'),
        path: z.string().optional().describe(allowFiles ? 'File or directory to write to' : 'Not available on this server'),
      },
    },
    guard(async ({ ids, format, scale, path: target }) => {
      const editor = await session.ready();
      const { doc } = editor;
      for (const id of ids) if (!doc.nodes[id]) throw new PropError(`No layer with id ${id}`);
      await session.ensureFonts();
      if (target) {
        if (!allowFiles) throw new PropError('This server cannot write files; omit path to get the result inline.');
        const full = path.resolve(target);
        const isDir = ids.length > 1 || (await fs.stat(full).then((s) => s.isDirectory()).catch(() => !path.extname(full)));
        if (isDir) await fs.mkdir(full, { recursive: true });
        const written: string[] = [];
        for (const id of ids) {
          const file = isDir ? path.join(full, `${doc.nodes[id].name.replace(/[\\/:*?"<>|]+/g, '_') || id}.${format}`) : full;
          if (format === 'svg') await fs.writeFile(file, exportSvg(doc, [id]) ?? '');
          else await fs.writeFile(file, await renderPng(doc, [id], { scale: scale ?? 2, maxSize: 8192 }));
          written.push(file);
        }
        return text(`Wrote:\n${written.map((f) => `- ${f}`).join('\n')}`);
      }
      if (format === 'svg') return text('```svg\n' + (exportSvg(doc, ids) ?? '') + '\n```');
      const png = await renderPng(doc, ids, { scale: scale ?? 2, maxSize: 4096 });
      return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] };
    }),
  );

}
