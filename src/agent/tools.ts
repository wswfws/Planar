// MCP tools for Planar. See docs/MCP.md for the user-facing description.

import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { generateCode, generateTokens } from '../codegen/codegen';
import { getPageOf } from '../core/document';
import type { Editor } from '../core/editor';
import { exportSvg } from '../core/export';
import type { VariableType } from '../core/types';
import { variableValue } from '../core/variables';
import { find, outline, overview, summary } from './outline';
import { applyProps, createLayers, describe, PropError, type Friendly } from './props';
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
3. tree / find to locate layers; inspect for details. inspect returns the same vocabulary that create and update accept, so read → tweak → write back.
4. Design: create builds whole nested layouts in one call (frames with layout/gap/padding, text, shapes, component instances). update restyles or moves many layers in one call. Prefer auto layout ("layout": "column"/"row") over absolute x/y.
5. Check visually with screenshot.
6. Prototypes: update a layer with "link": "<top-level frame name>" (optional "transition": "slide" | "dissolve") to make it go to that screen on click in Present mode; "link": null removes it.
7. Developers: code gives React (components with typed props/variants) or HTML/CSS; tokens exports variables.
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
      description: 'Find layers by name and/or text content (substring, or /regex/) and type, on the current page, inside a layer, or everywhere.',
      inputSchema: {
        name: z.string().optional(),
        text: z.string().optional().describe('Match text layer content'),
        type: z.string().optional().describe('frame, text, rectangle, ellipse, vector, group, component, componentSet, instance'),
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
      const png = await renderPng(doc, ids, { scale, maxSize, background: page && bg?.type === 'solid' ? bg.color : undefined });
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
        'Create layers from nested descriptions in one undoable step. Each layer: {type, name, ...props, children:[...]}. Types: frame, text, rectangle, ellipse, line, vector, group, component, instance (with component:"Name", props:{…}, variant:{…}). Props: width/height (number|"hug"|"fill"), layout ("row"|"column"), gap, padding, align, crossAlign, fill/stroke ("#hex", "#hex 50%", "$var"), radius, shadow ("0 4 12 #000000 25%", "inset …"), blur, backgroundBlur, text, size, weight, font, lineHeight, textAlign, x/y (outside auto layout), opacity, mode.',
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
        if (doc.pageIds.length <= 1) throw new PropError('Cannot delete the only page');
        await edit(session, (e) => e.deletePage(pid));
        touched = true;
      } else if (action === 'open') {
        editor.setPage(need());
      }
      if (touched) await session.committed([]);
      const lines = editor.doc.pageIds.map((pid) => {
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
      description: 'Export variables for code: css (custom properties, one block per mode via [data-mode]), json, or ts.',
      inputSchema: { format: z.enum(['css', 'json', 'ts']).optional().describe('Default css') },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ format }) => {
      const editor = await session.ready();
      if (!editor.doc.variables.length) return text('This document has no variables.');
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
