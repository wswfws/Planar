// Compact, readable text views of a document for agents.

import { listComponents, propHost, variantAxes, variantSet, variantsOf } from '../core/components';
import { getPageOf } from '../core/document';
import type { Editor } from '../core/editor';
import { variableValue } from '../core/variables';
import { libraryOf, visiblePageIds } from '../core/library';
import type { PlanarDocument, SceneNode } from '../core/types';
import { describe } from './props';

function fmt(v: unknown): string {
  if (Array.isArray(v)) return v.map(fmt).join(',');
  return typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v);
}

function quote(s: string, max = 48): string {
  const one = s.replace(/\s+/g, ' ');
  return JSON.stringify(one.length > max ? one.slice(0, max - 1) + '…' : one);
}

/** One line summarising a layer: type, name, id, size, layout, style. */
export function summary(doc: PlanarDocument, n: SceneNode): string {
  const d = describe(doc, n);
  const parts = [`${d.type} ${quote(n.name)} #${n.id}`];
  if (n.type === 'page') return `${parts[0]} (${n.children.length} layers)${n.context ? `  context ${quote(n.context, 60)}` : ''}`;
  parts.push(`${fmt(d.width)}×${fmt(d.height)}`);
  if (!d.absolute && n.parentId && doc.nodes[n.parentId]?.layoutMode === 'none') parts.push(`at ${fmt(d.x)},${fmt(d.y)}`);
  else if (d.absolute) parts.push(`absolute at ${fmt(d.x)},${fmt(d.y)}`);
  if (d.layout) {
    let l = `${d.layout} gap ${fmt(d.gap)}`;
    if (d.padding !== undefined) l += ` pad ${fmt(d.padding)}`;
    if (d.align) l += ` align ${d.align}`;
    if (d.crossAlign) l += ` cross ${d.crossAlign}`;
    parts.push(l);
  }
  if (d.fill !== undefined && n.type !== 'text') parts.push(`fill ${d.fill === null ? 'none' : fmt(d.fill)}`);
  if (d.stroke) parts.push(`stroke ${fmt(d.stroke)} ${fmt(d.strokeWidth)}px`);
  if (d.radius) parts.push(`r ${fmt(d.radius)}`);
  if (n.type === 'text') parts.push(`${quote(n.characters, 60)} ${fmt(d.size)}px${d.weight ? '/' + d.weight : ''} ${fmt(d.fill)}`);
  if (n.type === 'instance') {
    let s = `of ${d.component}`;
    if (d.variant) s += ` [${Object.entries(d.variant as object).map(([k, v]) => `${k}=${v}`).join(', ')}]`;
    if (d.props) s += ` {${Object.entries(d.props as object).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')}}`;
    parts.push(s);
  }
  if (n.type === 'component' && d.variant) parts.push(`variant ${Object.entries(d.variant as object).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (d.mode) parts.push(`mode ${d.mode}`);
  if (!n.visible) parts.push('hidden');
  if (n.locked) parts.push('locked');
  if (n.context) parts.push(`context ${quote(n.context, 60)}`);
  return parts.join('  ');
}

/** Indented outline of a layer and its descendants down to `depth`. */
export function outline(doc: PlanarDocument, rootId: string, depth: number): string {
  const lines: string[] = [];
  const walk = (id: string, level: number) => {
    const n = doc.nodes[id];
    if (!n) return;
    lines.push(`${'  '.repeat(level)}- ${summary(doc, n)}`);
    if (!n.children.length) return;
    // Instance contents mirror their component; show them only on request.
    if (level >= depth || (n.type === 'instance' && level > 0)) {
      lines.push(`${'  '.repeat(level + 1)}… ${n.children.length} child layer${n.children.length === 1 ? '' : 's'} (tree id=${n.id} to expand)`);
      return;
    }
    // Document order: first child = first in auto layout / bottom-most.
    for (const c of n.children) walk(c, level + 1);
  };
  walk(rootId, 0);
  return lines.join('\n');
}

export interface FindQuery {
  name?: string;
  text?: string;
  /** Match the layer's context notes. */
  context?: string;
  type?: string;
  within?: string;
  limit?: number;
}

function matcher(q: string): (s: string) => boolean {
  const re = /^\/(.+)\/([a-z]*)$/.exec(q);
  if (re) {
    const r = new RegExp(re[1], re[2].includes('i') ? re[2] : re[2] + 'i');
    return (s) => r.test(s);
  }
  const lower = q.toLowerCase();
  return (s) => s.toLowerCase().includes(lower);
}

export function find(doc: PlanarDocument, q: FindQuery, pageId: string): SceneNode[] {
  const nameOk = q.name ? matcher(q.name) : () => true;
  const textOk = q.text ? matcher(q.text) : () => true;
  const contextOk = q.context ? matcher(q.context) : () => true;
  const roots = q.within === 'all' ? doc.pageIds : [q.within ?? pageId];
  const out: SceneNode[] = [];
  const walk = (id: string) => {
    const n = doc.nodes[id];
    if (!n) return;
    if (
      n.type !== 'page' &&
      nameOk(n.name) &&
      (!q.text || (n.type === 'text' && textOk(n.characters))) &&
      (!q.context || (!!n.context && contextOk(n.context))) &&
      (!q.type || n.type === q.type || (q.type === 'line' && n.type === 'vector'))
    ) {
      out.push(n);
    }
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return out.slice(0, q.limit ?? 50);
}

/** Everything an agent needs to orient itself in one answer. */
export function overview(editor: Editor): string {
  const { doc } = editor;
  const out: string[] = [];
  const pages = visiblePageIds(doc);
  out.push(`Document ${quote(doc.name, 80)} — ${pages.length} page${pages.length === 1 ? '' : 's'}, current page #${editor.pageId}`);
  out.push('');
  // The file brief comes first: it says what the design is for and how to work on it.
  if (doc.context.trim()) {
    out.push('File context (brief):', doc.context.trim(), '');
  } else {
    out.push('File context: none yet (write a brief with the context tool once you know what the file is for).', '');
  }
  out.push('Pages and top-level layers:');
  for (const pid of pages) {
    const page = doc.nodes[pid];
    out.push(`- page ${quote(page.name)} #${pid}${pid === editor.pageId ? ' (current)' : ''}`);
    const kids = page.children;
    for (const c of kids.slice(0, 25)) out.push(`  - ${summary(doc, doc.nodes[c])}`);
    if (kids.length > 25) out.push(`  … ${kids.length - 25} more (use tree)`);
  }

  const sets = Object.values(doc.nodes).filter((n) => n.type === 'componentSet');
  const loose = listComponents(doc).filter((c) => !variantSet(doc, c.id));
  out.push('');
  if (!sets.length && !loose.length) out.push('Components: none');
  else {
    out.push('Components:');
    for (const c of [...sets, ...loose]) {
      const host = propHost(doc, c);
      const props = host.componentProps.map((p) => `${p.name}: ${p.type}=${JSON.stringify(p.defaultValue)}`);
      const lib = libraryOf(doc, c.id);
      const where = lib ? `from library ${quote(lib.name)}` : `on ${quote(getPageOf(doc, c.id)?.name ?? '?')}`;
      let line = `- ${c.type === 'componentSet' ? 'set' : 'component'} ${quote(c.name)} #${c.id} ${where}`;
      if (c.type === 'componentSet') {
        line += ` — variants ${variantAxes(doc, c.id)
          .map((axis) => `${axis}: ${[...new Set(variantsOf(doc, c.id).map((v) => v.variantProps[axis]))].join('|')}`)
          .join('; ')}`;
      }
      if (props.length) line += ` — props ${props.join(', ')}`;
      out.push(line);
    }
  }

  out.push('');
  out.push(`Variable modes: ${doc.modes.map((m) => m.name).join(', ')}`);
  if (!doc.variables.length) out.push('Variables: none');
  else {
    out.push('Variables:');
    for (const v of doc.variables) {
      out.push(`- $${v.name} (${v.type}) ${doc.modes.map((m) => `${m.name}=${JSON.stringify(variableValue(doc, v, m.id))}`).join(' ')}`);
    }
  }
  const styles = doc.styles ?? [];
  if (styles.length) out.push(`Styles: ${styles.map((s) => `${s.type} "${s.name}"`).join(', ')} (details: styles)`);

  out.push('');
  out.push(editor.selection.length ? `Selection: ${editor.selection.map((id) => summary(doc, doc.nodes[id])).join('\n  ')}` : 'Selection: none');
  if (editor.collab) {
    out.push('');
    out.push(`Live room ${editor.collab.fileId} (${editor.collab.status}). People here:`);
    if (!editor.collab.peers.length) out.push('- nobody else');
    for (const p of editor.collab.peers) {
      const sel = p.presence?.selection.filter((id) => doc.nodes[id]) ?? [];
      const page = p.presence?.pageId ? doc.nodes[p.presence.pageId]?.name : undefined;
      out.push(`- ${p.name}${page ? ` on ${quote(page)}` : ''}${sel.length ? ` selecting ${sel.map((id) => `${quote(doc.nodes[id].name)} #${id}`).join(', ')}` : ''}`);
    }
  }
  return out.join('\n');
}
