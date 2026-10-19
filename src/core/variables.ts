import { measureTextNode } from './text';
import type { PlanarDocument, SceneNode, Variable, VariableType, VariableValue } from './types';

/** Node properties that can be bound, and the variable type they take. */
export const BINDABLE: Record<string, VariableType> = {
  width: 'number',
  height: 'number',
  cornerRadius: 'number',
  strokeWidth: 'number',
  itemSpacing: 'number',
  paddingTop: 'number',
  paddingRight: 'number',
  paddingBottom: 'number',
  paddingLeft: 'number',
  fontSize: 'number',
  lineHeight: 'number',
  characters: 'string',
  visible: 'boolean',
};

const TEXT_LAYOUT = new Set(['width', 'fontSize', 'lineHeight', 'characters']);

export function defaultValue(type: VariableType): VariableValue {
  return type === 'color' ? '#7B7BF0' : type === 'number' ? 0 : type === 'string' ? 'Text' : true;
}

/** Coerces a raw value to a variable type (used for edits and loaded files). */
export function coerce(type: VariableType, value: unknown): VariableValue {
  switch (type) {
    case 'color': {
      const s = String(value ?? '');
      return /^#[0-9a-f]{6}$/i.test(s) ? s.toUpperCase() : '#000000';
    }
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    case 'string':
      return String(value ?? '');
    case 'boolean':
      return value === true || value === 'true';
  }
}

export function variableValue(doc: PlanarDocument, v: Variable, modeId: string): VariableValue {
  const raw = v.values[modeId] ?? v.values[doc.modes[0]?.id] ?? defaultValue(v.type);
  return coerce(v.type, raw);
}

/** Writes every bound property's current value into the document. */
export function resolveVariables(doc: PlanarDocument): void {
  if (!doc.variables.length) return;
  const vars = new Map(doc.variables.map((v) => [v.id, v]));
  const modeIds = new Set(doc.modes.map((m) => m.id));
  const fallback = doc.modes[0]?.id ?? '';

  const apply = (node: SceneNode, mode: string) => {
    let textChanged = false;
    for (const [field, vid] of Object.entries(node.bindings)) {
      const v = vars.get(vid);
      if (!v || BINDABLE[field] !== v.type) continue;
      const value = variableValue(doc, v, mode);
      const rec = node as unknown as Record<string, unknown>;
      if (rec[field] !== value) {
        rec[field] = field === 'fontSize' || field === 'lineHeight' ? Math.max(Number(value), field === 'fontSize' ? 1 : 0.1) : value;
        if (field === 'width' && node.type === 'text') node.autoWidth = false;
        if (TEXT_LAYOUT.has(field)) textChanged = true;
      }
    }
    for (const list of [node.fills, node.strokes]) {
      for (const p of list) {
        if (p.type !== 'solid' || !p.variableId) continue;
        const v = vars.get(p.variableId);
        if (v?.type === 'color') p.color = String(variableValue(doc, v, mode));
      }
    }
    if (textChanged && node.type === 'text') {
      const size = measureTextNode(node);
      if (node.autoWidth) node.width = size.width;
      node.height = size.height;
    }
  };

  const walk = (id: string, mode: string) => {
    const node = doc.nodes[id];
    if (!node) return;
    const m = node.variableMode && modeIds.has(node.variableMode) ? node.variableMode : mode;
    apply(node, m);
    for (const c of node.children) walk(c, m);
  };
  for (const pageId of doc.pageIds) walk(pageId, fallback);
}

/** Removes every binding to a variable (values stay as last resolved). */
export function unbindVariable(doc: PlanarDocument, variableId: string): void {
  for (const node of Object.values(doc.nodes)) {
    for (const [field, vid] of Object.entries(node.bindings)) if (vid === variableId) delete node.bindings[field];
    for (const list of [node.fills, node.strokes]) {
      for (const p of list) if (p.type === 'solid' && p.variableId === variableId) delete p.variableId;
    }
  }
}

/** The mode a node resolves variables with. */
export function effectiveMode(doc: PlanarDocument, id: string): string {
  const modeIds = new Set(doc.modes.map((m) => m.id));
  let cur: SceneNode | undefined = doc.nodes[id];
  while (cur) {
    if (cur.variableMode && modeIds.has(cur.variableMode)) return cur.variableMode;
    cur = cur.parentId ? doc.nodes[cur.parentId] : undefined;
  }
  return doc.modes[0]?.id ?? '';
}
