import {
  applyComponentProps,
  axisValues,
  pickVariant,
  propHost,
  switchComponent,
  variantAxes,
  variantName,
  variantSet,
  variantsOf,
  createInstanceNode,
  detachInstance,
  isInInstance,
  listComponents,
  markOverrides,
  owningInstance,
  propOwner,
  resetOverrides,
  syncInstances,
  tracksOverrides,
  wouldCycle,
} from './components';
import {
  cloneSubtree,
  createDocument,
  createNode,
  getAncestors,
  getNode,
  getPageOf,
  getParent,
  insertNode,
  insertSubtree,
  moveNode,
  newId,
  parseDocument,
  removeNode,
  uniquePageName,
} from './document';
import { downloadBlob, exportEach, exportPng, exportSvg, safeFilename } from './export';
import {
  fitGroups,
  fitToChildren,
  frameAt,
  localMatrix,
  parentWorldMatrix,
  placeNode,
  reparentKeepWorld,
  selectionBounds,
  topLevelSelection,
  worldBounds,
  worldCenter,
  worldMatrix,
  worldRotation,
} from './geometry';
import { applyAutoLayout, isAutoLayout, isLaidOut } from './layout';
import { apply, applyLinear, invert, rectCenter, rectFromPoints, rectsIntersect, type Rect, type Vec } from './math';
import { measureTextNode } from './text';
import { applyStyles, TEXT_STYLE_FIELDS, textStyleValues } from './styles';
import { importLibrary, libraryOf, removeLibrary, visiblePageIds, type LibrarySnapshot } from './library';
import type { ComponentProp, ComponentPropType, EffectStyle, PlanarDocument, SceneNode, TextStyle, VariableType } from './types';
import { coerce, defaultValue, resolveVariables, unbindVariable } from './variables';
import { applyOps, diffDocs, repairTree, type Op } from './ops';
import { insertSvg, parseSvg } from './svg';
import { createWelcomeDocument } from './welcome';

export type Tool = 'select' | 'hand' | 'frame' | 'rectangle' | 'ellipse' | 'line' | 'pen' | 'text' | 'comment';

export interface Viewport {
  /** Screen position of the world origin. */
  x: number;
  y: number;
  zoom: number;
}

export interface Guide {
  axis: 'x' | 'y';
  value: number;
}

export interface Overlay {
  marquee: Rect | null;
  guides: Guide[];
  pen: { points: Vec[]; cursor: Vec | null } | null;
  /** Auto-layout insertion marker while dragging (world space). */
  insertion: [Vec, Vec] | null;
}

/**
 * One undo step: the ops that revert it and the ops that redo it. Only the
 * layers the step changed are included, so undo never touches other
 * people's work in a shared document.
 */
interface HistoryEntry {
  undo: Op[];
  redo: Op[];
  selection: string[];
  pageId: string;
}

interface ClipboardData {
  planarClipboard: 1;
  nodes: Record<string, SceneNode>;
  roots: { id: string; center: Vec; rotation: number }[];
}

export type FileRole = 'owner' | 'editor' | 'viewer';

/** Someone else in a shared document. */
export interface RemotePeer {
  id: string;
  name: string;
  color: string;
  presence: { pageId: string; cursor: Vec | null; selection: string[] } | null;
}

/** State of the collaboration session, if any (set by the collab client). */
export interface CollabInfo {
  status: 'connecting' | 'connected' | 'reconnecting' | 'error';
  fileId: string;
  shareUrl: string;
  serverUrl: string;
  /** What this person may do in the file; null until the server answers. */
  role: FileRole | null;
  peers: RemotePeer[];
  error: string | null;
  leave: () => void;
}

export type ReorderKind = 'forward' | 'backward' | 'front' | 'back';
export type AlignKind = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

const STORAGE_KEY = 'planar:document';
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 256;

function loadAutosave(): PlanarDocument | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    return raw ? parseDocument(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export class Editor {
  doc: PlanarDocument;
  pageId: string;
  selection: string[] = [];
  tool: Tool = 'select';
  viewport: Viewport = { x: 0, y: 0, zoom: 1 };
  canvasSize = { width: 800, height: 600 };
  editingTextId: string | null = null;
  hoverId: string | null = null;
  /** Show distances to the layer under the pointer (for developers; always on for viewers). */
  inspect = false;
  overlay: Overlay = { marquee: null, guides: [], pen: null, insertion: null };
  spaceDown = false;
  /** Shared-document session, when collaborating. */
  collab: CollabInfo | null = null;
  /** True when the document may only be looked at (view access to a shared file). */
  readOnly = false;
  /** Pointer position in world space (for presence). */
  pointer: Vec | null = null;
  private redrawListeners = new Set<() => void>();
  private pointerListeners = new Set<() => void>();
  /** Layers temporarily left out of auto layout (being dragged). */
  layoutSkip: Set<string> = new Set();
  message: string | null = null;
  version = 0;

  private listeners = new Set<() => void>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  /** Document as it was when the current transaction began. */
  private txBase: { doc: PlanarDocument; selection: string[]; pageId: string } | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private messageTimer: ReturnType<typeof setTimeout> | null = null;
  private pageViewports = new Map<string, Viewport>();
  private clipboard: string | null = null;
  private needsInitialFit: boolean;
  private autosave: boolean;

  constructor(doc?: PlanarDocument, options: { autosave?: boolean } = {}) {
    this.autosave = options.autosave ?? true;
    const restored = doc ?? (this.autosave ? loadAutosave() : null);
    this.doc = restored ?? (this.autosave ? createWelcomeDocument() : createDocument());
    this.pageId = this.doc.pageIds[0];
    this.needsInitialFit = true;
  }

  // ---------------------------------------------------------------- store

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  /** Canvas-only repaint (e.g. remote cursors) without re-rendering panels. */
  onRedraw = (fn: () => void): (() => void) => {
    this.redrawListeners.add(fn);
    return () => this.redrawListeners.delete(fn);
  };

  requestRedraw(): void {
    for (const fn of this.redrawListeners) fn();
  }

  onPointer = (fn: () => void): (() => void) => {
    this.pointerListeners.add(fn);
    return () => this.pointerListeners.delete(fn);
  };

  setPointer(p: Vec | null): void {
    this.pointer = p;
    for (const fn of this.pointerListeners) fn();
  }

  emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  get page(): SceneNode {
    return this.doc.nodes[this.pageId];
  }

  node(id: string): SceneNode | undefined {
    return this.doc.nodes[id];
  }

  get selectedNodes(): SceneNode[] {
    return this.selection.map((id) => this.doc.nodes[id]).filter(Boolean);
  }

  notify(message: string): void {
    this.message = message;
    if (this.messageTimer) clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => {
      this.message = null;
      this.emit();
    }, 2600);
    this.emit();
  }

  // ---------------------------------------------------------- transactions

  /** Applies history or remote ops and tidies up what depends on them. */
  private applyAndNormalize(ops: Op[]): void {
    applyOps(this.doc, ops);
    this.normalize();
    if (!this.doc.nodes[this.pageId]) this.pageId = this.doc.pageIds[0];
  }

  get inTransaction(): boolean {
    return this.txBase !== null;
  }

  begin(): void {
    if (!this.txBase) this.txBase = { doc: structuredClone(this.doc), selection: [...this.selection], pageId: this.pageId };
  }

  commit(): void {
    const base = this.txBase;
    this.txBase = null;
    if (!base) return;
    this.normalize();
    const redo = diffDocs(base.doc, this.doc);
    if (redo.length && this.readOnly) {
      // Safety net: some direct edit slipped past change(). Undo it.
      this.applyAndNormalize(diffDocs(this.doc, base.doc));
      this.emit();
      return;
    }
    if (redo.length) {
      this.undoStack.push({ undo: diffDocs(this.doc, base.doc), redo, selection: base.selection, pageId: base.pageId });
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
      this.scheduleSave();
    }
    this.emit();
  }

  cancel(): void {
    const base = this.txBase;
    this.txBase = null;
    if (base) {
      this.applyAndNormalize(diffDocs(this.doc, base.doc));
      this.selection = base.selection.filter((id) => this.doc.nodes[id]);
    }
    this.emit();
  }

  /**
   * Applies changes made by someone else. They bypass undo history; if a
   * local transaction is open, its starting point gets them too so they are
   * not recorded as local changes.
   */
  applyRemote(ops: Op[]): void {
    if (!ops.length) return;
    if (this.txBase) applyOps(this.txBase.doc, ops);
    this.applyAndNormalize(ops);
    this.emit();
  }

  /** Swaps in a document from elsewhere (e.g. a shared room), clearing history. */
  replaceDocument(doc: PlanarDocument, opts: { keepView?: boolean } = {}): void {
    this.finishTextEditing();
    this.txBase = null;
    this.doc = doc;
    repairTree(doc);
    this.pageId = doc.nodes[this.pageId] ? this.pageId : doc.pageIds[0];
    this.selection = this.selection.filter((id) => doc.nodes[id]);
    this.undoStack = [];
    this.redoStack = [];
    this.normalize();
    if (!opts.keepView) this.zoomToFit();
    this.emit();
  }

  /** Turns local autosave on or off (off while in a shared room). */
  setAutosave(on: boolean): void {
    this.autosave = on;
  }

  /** Runs a document mutation. Outside a transaction it is one undo step. */
  change(fn: (doc: PlanarDocument) => void): void {
    if (this.readOnly) {
      this.notify('View-only: you cannot edit this file');
      return;
    }
    const own = !this.txBase;
    if (own) this.begin();
    fn(this.doc);
    this.normalize();
    if (own) this.commit();
    else this.emit();
  }

  private normalize(): void {
    const { doc } = this;
    // Order matters: variables feed sizes, groups and layout feed the
    // components that instances copy, and instances then lay out themselves.
    resolveVariables(doc);
    applyStyles(doc);
    for (const p of doc.pageIds) fitGroups(doc, p);
    for (const p of doc.pageIds) applyAutoLayout(doc, p, this.layoutSkip);
    syncInstances(doc);
    // Swapping a nested instance needs one more sync to rebuild its layers.
    if (applyComponentProps(doc)) {
      syncInstances(doc);
      applyComponentProps(doc);
    }
    resolveVariables(doc);
    for (const p of doc.pageIds) applyAutoLayout(doc, p, this.layoutSkip);
    for (const p of doc.pageIds) fitGroups(doc, p);
    this.selection = this.selection.filter((id) => this.doc.nodes[id]);
    if (this.editingTextId && !this.doc.nodes[this.editingTextId]) this.editingTextId = null;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    this.finishTextEditing();
    const entry = this.undoStack.pop();
    if (!entry) return;
    const selection = [...this.selection];
    this.applyAndNormalize(entry.undo);
    this.redoStack.push({ ...entry, selection });
    this.selection = entry.selection.filter((id) => this.doc.nodes[id]);
    if (this.doc.nodes[entry.pageId]) this.pageId = entry.pageId;
    this.scheduleSave();
    this.emit();
  }

  redo(): void {
    this.finishTextEditing();
    const entry = this.redoStack.pop();
    if (!entry) return;
    const selection = [...this.selection];
    this.applyAndNormalize(entry.redo);
    this.undoStack.push({ ...entry, selection });
    this.selection = entry.selection.filter((id) => this.doc.nodes[id]);
    this.scheduleSave();
    this.emit();
  }

  private scheduleSave(): void {
    if (!this.autosave) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.doc));
      } catch {
        this.notify('Autosave failed: browser storage is full');
      }
    }, 400);
  }

  // ------------------------------------------------------------- selection

  select(ids: string[]): void {
    this.selection = ids.filter((id) => this.doc.nodes[id]);
    this.emit();
  }

  toggleSelect(id: string): void {
    this.select(this.selection.includes(id) ? this.selection.filter((s) => s !== id) : [...this.selection, id]);
  }

  /** The container whose children are the current selection level. */
  get selectionContext(): string {
    const first = this.selection[0];
    return (first && this.doc.nodes[first]?.parentId) || this.pageId;
  }

  selectAll(): void {
    const parent = this.doc.nodes[this.selectionContext];
    this.select(parent.children.filter((id) => this.doc.nodes[id].visible && !this.doc.nodes[id].locked));
  }

  selectChildren(): void {
    const ids = this.selectedNodes.flatMap((n) => n.children);
    if (ids.length) this.select(ids);
  }

  selectParent(): void {
    const parents = new Set(this.selectedNodes.map((n) => n.parentId).filter((p): p is string => !!p && p !== this.pageId));
    this.select(parents.size ? [...parents] : []);
  }

  /** Document order (bottom to top) index of every node in the page. */
  private zOrder(): Map<string, number> {
    const order = new Map<string, number>();
    const walk = (id: string) => {
      order.set(id, order.size);
      for (const c of this.doc.nodes[id]?.children ?? []) walk(c);
    };
    walk(this.pageId);
    return order;
  }

  private sortedTopSelection(): string[] {
    const order = this.zOrder();
    return topLevelSelection(this.doc, this.selection).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }

  // ------------------------------------------------------------ operations

  /** Top-level selection minus layers locked inside instances. */
  private editableSelection(): string[] {
    return topLevelSelection(this.doc, this.selection).filter((id) => !isInInstance(this.doc, id));
  }

  deleteSelection(): void {
    const ids = this.editableSelection();
    if (!ids.length) return;
    this.change((doc) => ids.forEach((id) => removeNode(doc, id)));
    this.select([]);
  }

  duplicateSelection(offset = 10): string[] {
    const ids = this.sortedTopSelection().filter((id) => !isInInstance(this.doc, id));
    const created: string[] = [];
    this.change((doc) => {
      for (const id of ids) {
        const parent = getParent(doc, id);
        if (!parent) continue;
        const nodes = cloneSubtree(doc.nodes, id);
        nodes[0].x += offset;
        nodes[0].y += offset;
        const root = insertSubtree(doc, nodes, parent.id, parent.children.indexOf(id) + 1);
        created.push(root.id);
      }
    });
    this.select(created);
    return created;
  }

  copySelection(): string | null {
    const ids = this.sortedTopSelection();
    if (!ids.length) return null;
    const nodes: Record<string, SceneNode> = {};
    const collect = (id: string) => {
      nodes[id] = structuredClone(this.doc.nodes[id]);
      this.doc.nodes[id].children.forEach(collect);
    };
    ids.forEach(collect);
    const data: ClipboardData = {
      planarClipboard: 1,
      nodes,
      roots: ids.map((id) => ({ id, center: worldCenter(this.doc, id), rotation: worldRotation(this.doc, id) })),
    };
    this.clipboard = JSON.stringify(data);
    return this.clipboard;
  }

  cutSelection(): string | null {
    const text = this.copySelection();
    this.deleteSelection();
    return text;
  }

  /** Text of the last copy made inside this editor. */
  get clipboardText(): string | null {
    return this.clipboard;
  }

  /** Asks the layer tree to start renaming a layer. */
  renameRequest: string | null = null;

  requestRename(id: string): void {
    if (this.readOnly) return;
    this.renameRequest = id;
    this.emit();
  }

  /** Pastes clipboard text; returns false when it is not Planar data. */
  paste(text: string | null = this.clipboard, at?: Vec): boolean {
    let data: ClipboardData;
    try {
      data = JSON.parse(text ?? '');
      if (data?.planarClipboard !== 1 || !data.nodes || !Array.isArray(data.roots)) return false;
    } catch {
      return false;
    }
    const sel = this.selectedNodes;
    const target =
      sel.length === 1 && (sel[0].type === 'frame' || sel[0].type === 'component') ? sel[0].id : sel.length ? sel[0].parentId ?? this.pageId : this.pageId;
    let pasteTarget = target;
    while (pasteTarget !== this.pageId && (this.doc.nodes[pasteTarget]?.type === 'instance' || isInInstance(this.doc, pasteTarget))) {
      pasteTarget = this.doc.nodes[pasteTarget]?.parentId ?? this.pageId;
    }
    const created: string[] = [];
    this.change((doc) => {
      for (const root of data.roots) {
        if (!data.nodes[root.id]) continue;
        const nodes = cloneSubtree(data.nodes, root.id);
        // Clipboard roots keep their links; an instance cannot land inside its own component.
        const parent = nodes[0].type === 'instance' && wouldCycle(doc, nodes[0].componentId, pasteTarget) ? this.pageId : pasteTarget;
        unlinkCopiedLayers(nodes);
        const node = insertSubtree(doc, nodes, parent);
        placeNode(doc, node.id, root.center, root.rotation);
        created.push(node.id);
      }
      // Paste at the pointer when asked, else keep the place but stay in view.
      const b = selectionBounds(doc, created);
      const view = this.visibleWorldRect();
      if (b && at) {
        const d = { x: Math.round(at.x - rectCenter(b).x), y: Math.round(at.y - rectCenter(b).y) };
        for (const id of created) this.translateWorld(id, d);
      } else if (b && !rectsIntersect(b, view)) {
        const d = { x: rectCenter(view).x - rectCenter(b).x, y: rectCenter(view).y - rectCenter(b).y };
        for (const id of created) this.translateWorld(id, d);
      }
    });
    this.select(created);
    return true;
  }

  /** Moves a node by a world-space delta. */
  translateWorld(id: string, delta: Vec): void {
    const node = getNode(this.doc, id);
    const d = applyLinear(invert(parentWorldMatrix(this.doc, id)), delta);
    node.x += d.x;
    node.y += d.y;
  }

  nudge(dx: number, dy: number): void {
    const ids = this.editableSelection();
    if (!ids.length) return;
    this.change((doc) => {
      for (const id of ids) {
        const node = doc.nodes[id];
        if (!isLaidOut(doc, node)) {
          this.translateWorld(id, { x: dx, y: dy });
          continue;
        }
        // Inside auto layout, arrows along the main axis re-order.
        const parent = doc.nodes[node.parentId!];
        const step = Math.sign(parent.layoutMode === 'horizontal' ? dx : dy);
        const i = parent.children.indexOf(id);
        const j = i + step;
        if (!step || j < 0 || j >= parent.children.length) continue;
        parent.children[i] = parent.children[j];
        parent.children[j] = id;
      }
    });
  }

  /** Turns on auto layout for a frame, or wraps the selection in one. */
  addAutoLayout(): void {
    const ids = this.sortedTopSelection();
    if (!ids.length) return;
    const single = ids.length === 1 ? this.doc.nodes[ids[0]] : null;
    this.begin();
    let frameId: string;
    if (single && (single.type === 'frame' || single.type === 'component') && single.layoutMode === 'none') {
      frameId = single.id;
    } else {
      this.frameSelection();
      frameId = this.selection[0];
      this.doc.nodes[frameId].fills = [];
    }
    this.change((doc) => enableAutoLayout(doc, frameId));
    this.selection = [frameId];
    this.commit();
  }

  removeAutoLayout(): void {
    const frames = this.selectedNodes.filter((n) => isAutoLayout(n));
    if (!frames.length) return;
    this.change((doc) => {
      for (const f of frames) {
        f.layoutMode = 'none';
        if (f.sizingH === 'hug') f.sizingH = 'fixed';
        if (f.sizingV === 'hug') f.sizingV = 'fixed';
        for (const c of f.children) {
          const child = doc.nodes[c];
          if (child.sizingH === 'fill') child.sizingH = 'fixed';
          if (child.sizingV === 'fill') child.sizingV = 'fixed';
        }
      }
    });
  }

  group(): void {
    const ids = this.sortedTopSelection().filter((id) => !isInInstance(this.doc, id));
    if (!ids.length) return;
    const top = ids[ids.length - 1];
    const parent = getParent(this.doc, top);
    if (!parent) return;
    let groupId = '';
    this.change((doc) => {
      const g = insertNode(doc, createNode('group', { width: 0, height: 0 }), parent.id, parent.children.indexOf(top) + 1);
      groupId = g.id;
      for (const id of ids) reparentKeepWorld(doc, id, g.id);
    });
    this.select([groupId]);
  }

  frameSelection(): void {
    const ids = this.sortedTopSelection().filter((id) => !isInInstance(this.doc, id));
    const b = selectionBounds(this.doc, ids);
    if (!ids.length || !b) return;
    const top = ids[ids.length - 1];
    const parent = getParent(this.doc, top);
    if (!parent) return;
    let frameId = '';
    this.change((doc) => {
      const f = insertNode(
        doc,
        createNode('frame', { width: b.width, height: b.height }),
        parent.id,
        parent.children.indexOf(top) + 1,
      );
      frameId = f.id;
      placeNode(doc, f.id, rectCenter(b), 0);
      for (const id of ids) reparentKeepWorld(doc, id, f.id);
    });
    this.select([frameId]);
  }

  ungroup(): void {
    const containers = this.selectedNodes.filter(
      (n) => (n.type === 'group' || n.type === 'frame' || n.type === 'componentSet') && !isInInstance(this.doc, n.id),
    );
    if (!containers.length) return;
    const released: string[] = [];
    this.change((doc) => {
      for (const c of containers) {
        const parent = getParent(doc, c.id);
        if (!parent) continue;
        let index = parent.children.indexOf(c.id);
        for (const child of [...c.children]) {
          // Variants leaving a set take a copy of the set's shared properties.
          if (c.type === 'componentSet' && doc.nodes[child].type === 'component') {
            doc.nodes[child].componentProps = structuredClone(c.componentProps);
          }
          reparentKeepWorld(doc, child, parent.id, ++index);
          released.push(child);
        }
        removeNode(doc, c.id);
      }
    });
    this.select(released);
  }

  reorder(kind: ReorderKind): void {
    const ids = this.sortedTopSelection().filter((id) => !isInInstance(this.doc, id));
    if (!ids.length) return;
    this.change((doc) => {
      const list = kind === 'forward' || kind === 'front' ? [...ids].reverse() : ids;
      for (const id of list) {
        const parent = getParent(doc, id);
        if (!parent) continue;
        const i = parent.children.indexOf(id);
        const n = parent.children.length;
        const to = kind === 'front' ? n - 1 : kind === 'back' ? 0 : kind === 'forward' ? Math.min(n - 1, i + 1) : Math.max(0, i - 1);
        if (to === i) continue;
        parent.children.splice(i, 1);
        parent.children.splice(to, 0, id);
      }
    });
  }

  align(kind: AlignKind): void {
    const ids = this.editableSelection();
    if (!ids.length) return;
    let target: Rect | null;
    if (ids.length === 1) {
      const parent = getParent(this.doc, ids[0]);
      if (!parent || parent.type === 'page') return;
      target = worldBounds(this.doc, parent.id);
    } else {
      target = selectionBounds(this.doc, ids);
    }
    if (!target) return;
    const t = target;
    this.change(() => {
      for (const id of ids) {
        const b = worldBounds(this.doc, id);
        const d = { x: 0, y: 0 };
        if (kind === 'left') d.x = t.x - b.x;
        if (kind === 'hcenter') d.x = t.x + t.width / 2 - (b.x + b.width / 2);
        if (kind === 'right') d.x = t.x + t.width - (b.x + b.width);
        if (kind === 'top') d.y = t.y - b.y;
        if (kind === 'vcenter') d.y = t.y + t.height / 2 - (b.y + b.height / 2);
        if (kind === 'bottom') d.y = t.y + t.height - (b.y + b.height);
        this.translateWorld(id, d);
      }
    });
  }

  /** Applies a patch (or mutator) to nodes and re-measures text. */
  updateNodes(ids: string[], patch: Partial<SceneNode> | ((node: SceneNode) => void)): void {
    this.change((doc) => {
      for (const id of ids) {
        const node = doc.nodes[id];
        if (!node) continue;
        const before = typeof patch === 'function' ? structuredClone(node) : null;
        if (typeof patch === 'function') patch(node);
        else Object.assign(node, patch);
        if (node.type === 'text') this.syncTextSize(node);
        const changed: (keyof SceneNode)[] = before
          ? (Object.keys(node) as (keyof SceneNode)[]).filter((k) => JSON.stringify(node[k]) !== JSON.stringify(before[k]))
          : (Object.keys(patch) as (keyof SceneNode)[]);
        // Edits to fields driven by a component property update the property.
        const routed = changed.filter((k) => (k === 'characters' || k === 'visible') && this.routePropEdit(node, k, node[k]));
        for (const k of routed) changed.splice(changed.indexOf(k), 1);
        // Editing a bound property by hand detaches it from its variable.
        const unbind = changed.filter((k) => k !== 'bindings' && k in node.bindings);
        if (unbind.length) node.bindings = Object.fromEntries(Object.entries(node.bindings).filter(([k]) => !unbind.includes(k as keyof SceneNode)));
        // Editing what a style sets by hand detaches the layer from the style.
        if (node.textStyleId && !changed.includes('textStyleId') && changed.some((k) => (TEXT_STYLE_FIELDS as readonly string[]).includes(k))) {
          node.textStyleId = '';
          changed.push('textStyleId');
        }
        if (node.effectStyleId && !changed.includes('effectStyleId') && changed.includes('effects')) {
          node.effectStyleId = '';
          changed.push('effectStyleId');
        }
        if (tracksOverrides(node)) {
          // Text sizes follow from content, so they are not overrides themselves.
          const derived = node.type === 'text' ? [...(node.autoWidth || node.autoHeight ? ['height'] : []), ...(node.autoWidth ? ['width'] : [])] : [];
          markOverrides(node, changed.filter((k) => !derived.includes(k) || (patch as Partial<SceneNode>)[k] !== undefined));
        }
      }
    });
  }

  /** Re-measures every text layer (after fonts load); not an undo step. */
  remeasureText(): void {
    let changed = false;
    for (const n of Object.values(this.doc.nodes)) {
      if (n.type !== 'text') continue;
      const { width, height } = n;
      this.syncTextSize(n);
      if (n.width !== width || n.height !== height) changed = true;
    }
    if (changed) {
      this.normalize();
      this.emit();
    }
  }

  syncTextSize(node: SceneNode): void {
    const size = measureTextNode(node);
    node.width = size.width;
    node.height = size.height;
  }

  rename(id: string, name: string): void {
    const trimmed = name.trim();
    if (trimmed) this.updateNodes([id], { name: trimmed });
  }

  toggleVisible(ids = this.selection): void {
    const nodes = ids.map((id) => this.doc.nodes[id]).filter(Boolean);
    if (!nodes.length) return;
    const visible = !nodes.every((n) => n.visible);
    this.updateNodes(ids, { visible });
  }

  toggleLocked(ids = this.selection): void {
    const nodes = ids.map((id) => this.doc.nodes[id]).filter(Boolean);
    if (!nodes.length) return;
    const locked = !nodes.every((n) => n.locked);
    this.updateNodes(ids, { locked });
    if (locked) this.select(this.selection.filter((id) => !ids.includes(id)));
  }

  /** Layer-panel drag and drop: moves nodes into parentId at index. */
  moveLayers(ids: string[], parentId: string, index: number): void {
    if (this.doc.nodes[parentId]?.type === 'instance' || isInInstance(this.doc, parentId)) return;
    const valid = topLevelSelection(this.doc, ids).filter(
      (id) =>
        id !== parentId &&
        !getAncestors(this.doc, parentId).some((a) => a.id === id) &&
        !isInInstance(this.doc, id) &&
        !(this.doc.nodes[id].type === 'instance' && wouldCycle(this.doc, this.doc.nodes[id].componentId, parentId)),
    );
    if (!valid.length) return;
    this.change((doc) => {
      let i = index;
      for (const id of valid) {
        const node = doc.nodes[id];
        if (node.parentId === parentId) {
          moveNode(doc, id, parentId, i);
          i = doc.nodes[parentId].children.indexOf(id) + 1;
        } else {
          reparentKeepWorld(doc, id, parentId, i);
          i++;
        }
      }
    });
  }

  // ------------------------------------------------------------- text

  startTextEditing(id: string): void {
    const node = this.doc.nodes[id];
    if (!node || node.type !== 'text' || node.locked || this.readOnly) return;
    this.begin();
    this.editingTextId = id;
    this.selection = [id];
    this.tool = 'select';
    this.emit();
  }

  setText(id: string, characters: string): void {
    const node = this.doc.nodes[id];
    if (!node) return;
    const derivedName = (text: string) => text.split('\n')[0].slice(0, 40) || 'Text';
    if (!node.sourceId && node.name === derivedName(node.characters)) node.name = derivedName(characters);
    node.characters = characters;
    if (node.bindings.characters) node.bindings = Object.fromEntries(Object.entries(node.bindings).filter(([k]) => k !== 'characters'));
    if (!this.routePropEdit(node, 'characters', characters)) markOverrides(node, ['characters']);
    this.syncTextSize(node);
    this.emit();
  }

  finishTextEditing(): void {
    const id = this.editingTextId;
    if (!id) return;
    this.editingTextId = null;
    const node = this.doc.nodes[id];
    if (node && !node.characters.trim() && !node.sourceId) {
      removeNode(this.doc, id);
      this.selection = this.selection.filter((s) => s !== id);
    }
    this.commit();
  }

  // ------------------------------------------------------------- tools

  setTool(tool: Tool): void {
    if (this.readOnly && tool !== 'select' && tool !== 'hand' && tool !== 'comment') return;
    if (tool === 'comment' && !this.collab) return;
    if (this.tool === 'pen' && tool !== 'pen') this.finishPen(false);
    this.finishTextEditing();
    this.tool = tool;
    this.overlay.pen = tool === 'pen' ? { points: [], cursor: null } : null;
    this.emit();
  }

  /** Creates a vector from the pen's points. */
  finishPen(close: boolean): void {
    const pen = this.overlay.pen;
    if (!pen) return;
    const pts = pen.points;
    this.overlay.pen = { points: [], cursor: null };
    if (pts.length >= 2) {
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const w = Math.max(...xs) - x;
      const h = Math.max(...ys) - y;
      const node = createNode('vector', {
        name: close ? 'Polygon' : pts.length === 2 ? 'Line' : 'Vector',
        x,
        y,
        width: w,
        height: h,
        closed: close && pts.length >= 3,
        fills: close && pts.length >= 3 ? [{ type: 'solid', color: '#d9d9d9', opacity: 1, visible: true }] : [],
        points: pts.map((p) => ({ x: w ? (p.x - x) / w : 0, y: h ? (p.y - y) / h : 0 })),
      });
      this.change((doc) => insertNode(doc, node, this.pageId));
      this.selection = [node.id];
      this.tool = 'select';
      this.overlay.pen = null;
    }
    this.emit();
  }

  /** Imports SVG markup as a frame of vector layers centred at `center`. */
  importSvg(markup: string, center: Vec, name?: string): string | null {
    let parsed;
    try {
      parsed = parseSvg(markup);
    } catch (e) {
      this.notify(`Could not import SVG: ${(e as Error).message}`);
      return null;
    }
    let id = '';
    this.change((doc) => {
      const frame = insertSvg(doc, this.pageId, parsed, { name });
      frame.x = Math.round(center.x - frame.width / 2);
      frame.y = Math.round(center.y - frame.height / 2);
      id = frame.id;
    });
    this.select([id]);
    if (!parsed.shapes.length) this.notify('The SVG had no shapes Planar can import');
    return id;
  }

  /** Inserts an image as a rectangle with an image fill. */
  placeImage(src: string, width: number, height: number, center: Vec): void {
    const maxSide = 2000;
    const s = Math.min(1, maxSide / Math.max(width, height));
    const node = createNode('rectangle', {
      name: 'Image',
      width: Math.round(width * s),
      height: Math.round(height * s),
      fills: [{ type: 'image', src, scaleMode: 'fill', opacity: 1, visible: true }],
    });
    node.x = Math.round(center.x - node.width / 2);
    node.y = Math.round(center.y - node.height / 2);
    this.change((doc) => insertNode(doc, node, this.pageId));
    this.select([node.id]);
  }


  // ------------------------------------------------------------- components

  /** Turns a frame into a component, or wraps the selection in a new one. */
  createComponent(): void {
    const ids = this.sortedTopSelection().filter((id) => !isInInstance(this.doc, id));
    if (!ids.length) return;
    const single = ids.length === 1 ? this.doc.nodes[ids[0]] : null;
    const count = listComponents(this.doc).length + 1;
    if (single && single.type === 'frame') {
      this.change(() => {
        single.type = 'component';
      });
      this.select([single.id]);
      return;
    }
    this.begin();
    this.selection = ids;
    this.frameSelection();
    const comp = this.doc.nodes[this.selection[0]];
    this.change(() => {
      comp.type = 'component';
      comp.name = `Component ${count}`;
      comp.fills = [];
    });
    this.commit();
  }

  /** Places an instance of a component; returns its id. */
  createInstance(componentOrSetId: string, center?: Vec): string | null {
    const target = this.doc.nodes[componentOrSetId];
    const componentId = target?.type === 'componentSet' ? variantsOf(this.doc, target.id)[0]?.id ?? '' : componentOrSetId;
    const comp = this.doc.nodes[componentId];
    if (!comp || comp.type !== 'component') return null;
    const at = center ?? this.screenToWorld({ x: this.canvasSize.width / 2, y: this.canvasSize.height / 2 });
    let parentId = frameAt(this.doc, this.pageId, at, new Set());
    if (wouldCycle(this.doc, componentId, parentId)) parentId = this.pageId;
    const inst = createInstanceNode(this.doc, componentId);
    const local = apply(invert(worldMatrix(this.doc, parentId)), at);
    inst.x = Math.round(local.x - inst.width / 2);
    inst.y = Math.round(local.y - inst.height / 2);
    this.change((doc) => insertNode(doc, inst, parentId));
    this.select([inst.id]);
    return inst.id;
  }

  /** Creates an instance next to a main component. */
  instanceBeside(componentId: string): void {
    // For a set, place beside the set and use its first variant.
    const comp = this.doc.nodes[componentId];
    if (!comp) return;
    const b = worldBounds(this.doc, componentId);
    const page = getPageOf(this.doc, componentId);
    if (page && page.id !== this.pageId) this.setPage(page.id);
    this.createInstance(componentId, { x: b.x + b.width * 1.5 + 40, y: b.y + b.height / 2 });
  }

  detachInstances(): void {
    const instances = this.selectedNodes.filter((n) => n.type === 'instance');
    if (!instances.length) return;
    this.change((doc) => instances.forEach((n) => detachInstance(doc, n.id)));
  }

  resetInstanceOverrides(): void {
    const instances = this.selectedNodes.map((n) => owningInstance(this.doc, n.id)).filter((n): n is SceneNode => !!n);
    if (!instances.length) return;
    this.change((doc) => instances.forEach((n) => resetOverrides(doc, n.id)));
  }

  goToMainComponent(instanceId: string): void {
    const comp = this.doc.nodes[this.doc.nodes[instanceId]?.componentId];
    if (!comp) {
      this.notify('The main component was deleted');
      return;
    }
    // Library components live in their own file.
    const lib = libraryOf(this.doc, comp.id);
    if (lib) {
      if (typeof window !== 'undefined') window.open(`/file/${encodeURIComponent(lib.fileId)}`, '_blank', 'noopener');
      return;
    }
    const page = getPageOf(this.doc, comp.id);
    if (page) this.setPage(page.id);
    this.select([comp.id]);
    this.zoomToRect(worldBounds(this.doc, comp.id), 1);
  }



  // ------------------------------------------------------------- variants

  /** Wraps two or more loose components in a component set. */
  combineAsVariants(): void {
    const comps = this.sortedTopSelection()
      .map((id) => this.doc.nodes[id])
      .filter((n) => n.type === 'component' && !variantSet(this.doc, n.id) && !isInInstance(this.doc, n.id));
    if (comps.length < 2) {
      this.notify('Select two or more components to combine');
      return;
    }
    const parentId = comps[comps.length - 1].parentId!;
    const parent = this.doc.nodes[parentId];
    const b = selectionBounds(this.doc, comps.map((c) => c.id))!;
    const set = createNode('componentSet', { name: comps[0].name.split(/[=,/]/)[0].trim() || 'Component set', width: b.width, height: b.height });
    this.change((doc) => {
      insertNode(doc, set, parentId, parent.children.indexOf(comps[comps.length - 1].id) + 1);
      placeNode(doc, set.id, rectCenter(b), 0);
      const props: ComponentProp[] = [];
      const used = new Set<string>();
      for (const c of comps) {
        reparentKeepWorld(doc, c.id, set.id);
        if (!Object.keys(c.variantProps).length) {
          // Values must tell variants apart, so repeated names get a number.
          let value = c.name;
          for (let n = 2; used.has(value); n++) value = `${c.name} ${n}`;
          used.add(value);
          c.variantProps = { 'Property 1': value };
        }
        c.name = variantName(c.variantProps);
        for (const p of c.componentProps) if (!props.some((q) => q.id === p.id)) props.push(p);
        c.componentProps = [];
      }
      set.componentProps = props;
      fitToChildren(doc, set, 20);
    });
    this.select([set.id]);
  }

  /** Duplicates the last variant of a set next to it with a new value. */
  addVariant(setOrVariantId: string): void {
    const node = this.doc.nodes[setOrVariantId];
    const set = node?.type === 'componentSet' ? node : variantSet(this.doc, setOrVariantId);
    if (!set) return;
    const variants = variantsOf(this.doc, set.id);
    const last = node?.type === 'component' ? node : variants[variants.length - 1];
    if (!last) return;
    const axes = variantAxes(this.doc, set.id);
    let createdId = '';
    this.change((doc) => {
      const nodes = cloneSubtree(doc.nodes, last.id);
      const copy = nodes[0];
      const props = { ...last.variantProps };
      const axis = axes[0] ?? 'Property 1';
      const used = new Set(axisValues(doc, set.id, axis));
      let n = used.size + 1;
      while (used.has(`Variant ${n}`)) n++;
      props[axis] = `Variant ${n}`;
      copy.variantProps = props;
      copy.name = variantName(props);
      copy.x = last.x + last.width + 20;
      insertSubtree(doc, nodes, set.id, set.children.indexOf(last.id) + 1);
      fitToChildren(doc, doc.nodes[set.id], 20);
      createdId = copy.id;
    });
    this.select([createdId]);
  }

  setVariantValue(variantId: string, axis: string, value: string): void {
    const v = value.trim();
    if (!v) return;
    this.change((doc) => {
      const n = doc.nodes[variantId];
      if (!n) return;
      n.variantProps = { ...n.variantProps, [axis]: v };
      n.name = variantName(n.variantProps);
    });
  }

  renameVariantAxis(setId: string, from: string, to: string): void {
    const name = to.trim();
    if (!name || name === from || variantAxes(this.doc, setId).includes(name)) return;
    this.change((doc) => {
      for (const v of variantsOf(doc, setId)) {
        v.variantProps = Object.fromEntries(Object.entries(v.variantProps).map(([k, val]) => [k === from ? name : k, val]));
        v.name = variantName(v.variantProps);
      }
    });
  }

  addVariantAxis(setId: string): void {
    const axes = variantAxes(this.doc, setId);
    let n = axes.length + 1;
    while (axes.includes(`Property ${n}`)) n++;
    this.change((doc) => {
      for (const v of variantsOf(doc, setId)) {
        v.variantProps = { ...v.variantProps, [`Property ${n}`]: 'Default' };
        v.name = variantName(v.variantProps);
      }
    });
  }

  removeVariantAxis(setId: string, axis: string): void {
    this.change((doc) => {
      for (const v of variantsOf(doc, setId)) {
        const { [axis]: _gone, ...rest } = v.variantProps;
        v.variantProps = rest;
        v.name = variantName(rest) || v.name;
      }
    });
  }

  /** Switches instances to the variant with `axis` = `value`. */
  setInstanceVariant(instanceIds: string[], axis: string, value: string): void {
    this.change((doc) => {
      for (const id of instanceIds) {
        const inst = doc.nodes[id];
        const set = inst?.type === 'instance' ? variantSet(doc, inst.componentId) : null;
        if (!set) continue;
        const wanted = { ...doc.nodes[inst.componentId].variantProps, [axis]: value };
        const target = pickVariant(doc, set.id, wanted, axis);
        if (target) switchComponent(doc, id, target.id);
      }
    });
  }

  // ------------------------------------------------------------- component properties

  /**
   * Adds a property to a component. With `bind`, the property starts from
   * that layer's current value and the layer is bound to it.
   */
  addComponentProp(componentId: string, type: ComponentPropType, bind?: { nodeId: string; field: string }): string | null {
    const target = this.doc.nodes[componentId];
    if (!target || (target.type !== 'component' && target.type !== 'componentSet')) return null;
    const comp = target.type === 'component' ? propHost(this.doc, target) : target;
    componentId = comp.id;
    const node = bind ? this.doc.nodes[bind.nodeId] : null;
    const id = newId();
    const count = comp.componentProps.filter((p) => p.type === type).length + 1;
    const base = type === 'text' ? 'Text' : type === 'boolean' ? 'Show' : 'Instance';
    const defaultValue =
      type === 'text'
        ? node?.characters ?? 'Text'
        : type === 'boolean'
          ? node?.visible ?? true
          : node?.componentId || listComponents(this.doc).find((c) => c.id !== componentId)?.id || '';
    const name = node && type !== 'text' ? `${base} ${node.name}` : node && type === 'text' ? node.name : `${base} ${count}`;
    this.change((doc) => {
      doc.nodes[componentId].componentProps = [...doc.nodes[componentId].componentProps, { id, name, type, defaultValue }];
      if (bind) {
        const target = doc.nodes[bind.nodeId];
        target.propBindings = { ...target.propBindings, [bind.field]: id };
      }
    });
    return id;
  }

  updateComponentProp(componentId: string, propId: string, patch: Partial<Pick<ComponentProp, 'name' | 'defaultValue'>>): void {
    this.change((doc) => {
      const comp = doc.nodes[componentId];
      if (!comp) return;
      comp.componentProps = comp.componentProps.map((p) => {
        if (p.id !== propId) return p;
        const next = { ...p, ...patch };
        if (patch.name !== undefined) next.name = patch.name.trim() || p.name;
        return next;
      });
    });
  }

  deleteComponentProp(componentId: string, propId: string): void {
    this.change((doc) => {
      const comp = doc.nodes[componentId];
      if (!comp) return;
      comp.componentProps = comp.componentProps.filter((p) => p.id !== propId);
      for (const n of Object.values(doc.nodes)) {
        if (Object.values(n.propBindings).includes(propId)) {
          n.propBindings = Object.fromEntries(Object.entries(n.propBindings).filter(([, v]) => v !== propId));
        }
        if (propId in n.propValues) {
          const { [propId]: _gone, ...rest } = n.propValues;
          n.propValues = rest;
        }
      }
    });
  }

  /** Binds a layer field (characters / visible / componentId) to a property, or unbinds. */
  bindComponentProp(nodeId: string, field: string, propId: string | null): void {
    this.change((doc) => {
      const node = doc.nodes[nodeId];
      if (!node) return;
      if (propId) node.propBindings = { ...node.propBindings, [field]: propId };
      else node.propBindings = Object.fromEntries(Object.entries(node.propBindings).filter(([k]) => k !== field));
    });
  }

  setInstanceProp(instanceIds: string[], propId: string, value: string | boolean): void {
    this.change((doc) => {
      for (const id of instanceIds) {
        const inst = doc.nodes[id];
        if (inst?.type === 'instance') {
          inst.propValues = { ...inst.propValues, [propId]: value };
          markOverrides(inst, ['propValues']);
        }
      }
    });
  }

  /**
   * An edit to a property-bound field goes to the property instead: the
   * instance's value inside an instance, the default in a main component.
   * Returns true when it was handled that way.
   */
  private routePropEdit(node: SceneNode, field: string, value: unknown): boolean {
    const propId = node.propBindings[field];
    if (!propId) return false;
    const found = propOwner(this.doc, node.id, propId);
    if (!found) return false;
    const v = found.prop.type === 'boolean' ? value !== false : String(value);
    if (found.owner.type === 'instance') {
      found.owner.propValues = { ...found.owner.propValues, [propId]: v };
      markOverrides(found.owner, ['propValues']);
    } else {
      found.host.componentProps = found.host.componentProps.map((p) => (p.id === propId ? { ...p, defaultValue: v } : p));
    }
    return true;
  }

  // ------------------------------------------------------------- variables

  addVariable(type: VariableType): string {
    const id = newId();
    const n = this.doc.variables.filter((v) => v.type === type).length + 1;
    const value = defaultValue(type);
    this.change((doc) => {
      doc.variables.push({
        id,
        name: `${type}-${n}`,
        type,
        values: Object.fromEntries(doc.modes.map((m) => [m.id, value])),
      });
    });
    return id;
  }

  renameVariable(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.change((doc) => {
      const v = doc.variables.find((x) => x.id === id);
      if (v) v.name = trimmed;
    });
  }

  setVariableValue(id: string, modeId: string, value: unknown): void {
    this.change((doc) => {
      const v = doc.variables.find((x) => x.id === id);
      if (v) v.values[modeId] = coerce(v.type, value);
    });
  }

  deleteVariable(id: string): void {
    this.change((doc) => {
      unbindVariable(doc, id);
      doc.variables = doc.variables.filter((v) => v.id !== id);
    });
  }

  /** A new text style from a layer's font settings; the layer then uses it. Returns its id. */
  createTextStyle(name: string, fromId: string): string | null {
    const from = this.doc.nodes[fromId];
    const trimmed = name.trim();
    if (!from || !trimmed) return null;
    const id = newId();
    this.change((doc) => {
      doc.styles.push({ id, name: trimmed, type: 'text', ...textStyleValues(from) });
      for (const n of this.selection.map((s) => doc.nodes[s])) if (n?.type === 'text') n.textStyleId = id;
      doc.nodes[fromId].textStyleId = id;
    });
    return id;
  }

  /** A new effect style from a layer's effects; the selected layers then use it. Returns its id. */
  createEffectStyle(name: string, fromId: string): string | null {
    const from = this.doc.nodes[fromId];
    const trimmed = name.trim();
    if (!from || !trimmed) return null;
    const id = newId();
    this.change((doc) => {
      doc.styles.push({ id, name: trimmed, type: 'effect', effects: structuredClone(from.effects) });
      for (const n of [fromId, ...this.selection].map((s) => doc.nodes[s])) if (n && n.type !== 'page') n.effectStyleId = id;
    });
    return id;
  }

  /** Applies a style to layers ('' detaches them, keeping their current values). */
  applyStyle(ids: string[], kind: 'text' | 'effect', styleId: string): void {
    const field = kind === 'text' ? 'textStyleId' : 'effectStyleId';
    this.updateNodes(ids, (n) => {
      if (kind === 'text' && n.type !== 'text') return;
      n[field] = styleId;
      if (styleId && kind === 'text') {
        // A style wins over variables bound to the same fields.
        n.bindings = Object.fromEntries(Object.entries(n.bindings).filter(([k]) => !(TEXT_STYLE_FIELDS as readonly string[]).includes(k)));
      }
    });
  }

  /** Changes a style's values (every layer using it follows) or its name. */
  updateStyle(id: string, patch: Partial<Omit<TextStyle, 'id' | 'type'>> | Partial<Omit<EffectStyle, 'id' | 'type'>>): void {
    this.change((doc) => {
      const s = doc.styles.find((x) => x.id === id);
      if (!s) return;
      Object.assign(s, structuredClone(patch));
      s.name = s.name.trim() || 'Style';
    });
  }

  /** Deletes a style; layers keep its values but no longer follow it. */
  deleteStyle(id: string): void {
    this.change((doc) => {
      doc.styles = doc.styles.filter((s) => s.id !== id);
      for (const n of Object.values(doc.nodes)) {
        if (n.textStyleId === id) n.textStyleId = '';
        if (n.effectStyleId === id) n.effectStyleId = '';
      }
    });
  }

  /** Imports a team library, or brings an imported one up to date. */
  useLibrary(snapshot: LibrarySnapshot): void {
    if (snapshot.fileId === this.collab?.fileId) {
      this.notify('A file cannot use itself as a library');
      return;
    }
    this.change((doc) => void importLibrary(doc, snapshot));
  }

  /** Stops using a team library; its instances keep their look as ordinary layers. */
  removeLibrary(fileId: string): void {
    const link = this.doc.libraries.find((l) => l.fileId === fileId);
    if (link && this.pageId === link.pageId) this.setPage(visiblePageIds(this.doc)[0]);
    this.change((doc) => removeLibrary(doc, fileId));
  }

  addMode(): void {
    this.change((doc) => {
      const mode = { id: newId(), name: `Mode ${doc.modes.length + 1}` };
      const from = doc.modes[doc.modes.length - 1]?.id;
      doc.modes.push(mode);
      for (const v of doc.variables) v.values[mode.id] = from && from in v.values ? v.values[from] : defaultValue(v.type);
    });
  }

  renameMode(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.change((doc) => {
      const m = doc.modes.find((x) => x.id === id);
      if (m) m.name = trimmed;
    });
  }

  deleteMode(id: string): void {
    if (this.doc.modes.length <= 1) return;
    this.change((doc) => {
      doc.modes = doc.modes.filter((m) => m.id !== id);
      for (const v of doc.variables) delete v.values[id];
      for (const n of Object.values(doc.nodes)) if (n.variableMode === id) n.variableMode = '';
    });
  }

  /** Binds (or unbinds with null) a node property to a variable. */
  bindField(ids: string[], field: string, variableId: string | null): void {
    this.change((doc) => {
      for (const id of ids) {
        const node = doc.nodes[id];
        if (!node) continue;
        if (variableId) {
          node.bindings = { ...node.bindings, [field]: variableId };
          if (field === 'width') node.sizingH = 'fixed';
          if (field === 'height') node.sizingV = 'fixed';
        } else {
          const { [field]: _removed, ...rest } = node.bindings;
          node.bindings = rest;
        }
        markOverrides(node, ['bindings', field]);
      }
    });
  }

  /** Binds (or unbinds) a solid fill/stroke colour to a colour variable. */
  bindPaint(ids: string[], list: 'fills' | 'strokes', index: number, variableId: string | null): void {
    this.change((doc) => {
      for (const id of ids) {
        const node = doc.nodes[id];
        const paint = node?.[list][index];
        if (!paint || paint.type !== 'solid') continue;
        node[list] = node[list].map((p, i) => {
          if (i !== index || p.type !== 'solid') return p;
          const { variableId: _old, ...rest } = p;
          return variableId ? { ...rest, variableId } : rest;
        });
        markOverrides(node, [list]);
      }
    });
  }

  setVariableMode(ids: string[], modeId: string): void {
    this.updateNodes(ids, { variableMode: modeId });
  }

  // ------------------------------------------------------------- pages

  setPage(id: string): void {
    if (!this.doc.nodes[id] || id === this.pageId) return;
    this.finishTextEditing();
    this.pageViewports.set(this.pageId, { ...this.viewport });
    this.pageId = id;
    this.selection = [];
    const vp = this.pageViewports.get(id);
    if (vp) this.viewport = vp;
    else this.zoomToFit();
    this.emit();
  }

  addPage(name?: string): string {
    const page = createNode('page', { name: name?.trim() || uniquePageName(this.doc), width: 0, height: 0 });
    this.change((doc) => {
      doc.nodes[page.id] = page;
      doc.pageIds.push(page.id);
    });
    this.setPage(page.id);
    return page.id;
  }

  renamePage(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.change((doc) => {
      doc.nodes[id].name = trimmed;
    });
  }

  deletePage(id: string): void {
    const pages = visiblePageIds(this.doc);
    if (pages.length <= 1 || !pages.includes(id)) return;
    const i = pages.indexOf(id);
    const next = pages[i === 0 ? 1 : i - 1];
    if (id === this.pageId) this.setPage(next);
    this.change((doc) => removeNode(doc, id));
  }

  /** Sets the brief for the whole file. */
  setDocumentContext(text: string): void {
    if (text === this.doc.context) return;
    this.change((doc) => {
      doc.context = text;
    });
  }

  renameDocument(name: string): void {
    const trimmed = name.trim();
    if (!trimmed || trimmed === this.doc.name) return;
    this.change((doc) => {
      doc.name = trimmed;
    });
  }

  // ------------------------------------------------------------- viewport

  screenToWorld(p: Vec): Vec {
    return { x: (p.x - this.viewport.x) / this.viewport.zoom, y: (p.y - this.viewport.y) / this.viewport.zoom };
  }

  worldToScreen(p: Vec): Vec {
    return { x: p.x * this.viewport.zoom + this.viewport.x, y: p.y * this.viewport.zoom + this.viewport.y };
  }

  visibleWorldRect(): Rect {
    const tl = this.screenToWorld({ x: 0, y: 0 });
    return { x: tl.x, y: tl.y, width: this.canvasSize.width / this.viewport.zoom, height: this.canvasSize.height / this.viewport.zoom };
  }

  setCanvasSize(width: number, height: number): void {
    this.canvasSize = { width, height };
    if (this.needsInitialFit && width > 0 && height > 0) {
      this.needsInitialFit = false;
      this.zoomToFit();
    }
    this.emit();
  }

  panBy(dx: number, dy: number): void {
    this.viewport = { ...this.viewport, x: this.viewport.x + dx, y: this.viewport.y + dy };
    this.emit();
  }

  zoomAt(screen: Vec, zoom: number): void {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    const world = this.screenToWorld(screen);
    this.viewport = { zoom: z, x: screen.x - world.x * z, y: screen.y - world.y * z };
    this.emit();
  }

  zoomBy(factor: number): void {
    this.zoomAt({ x: this.canvasSize.width / 2, y: this.canvasSize.height / 2 }, this.viewport.zoom * factor);
  }

  zoomTo(zoom: number): void {
    this.zoomAt({ x: this.canvasSize.width / 2, y: this.canvasSize.height / 2 }, zoom);
  }

  zoomToRect(r: Rect | null, maxZoom = 1): void {
    const { width: cw, height: ch } = this.canvasSize;
    if (!r) {
      this.viewport = { x: cw / 2, y: ch / 2, zoom: 1 };
      this.emit();
      return;
    }
    const pad = 64;
    const zoom = Math.min(
      maxZoom,
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min((cw - pad * 2) / Math.max(r.width, 1), (ch - pad * 2) / Math.max(r.height, 1))),
    );
    const c = rectCenter(r);
    this.viewport = { zoom, x: cw / 2 - c.x * zoom, y: ch / 2 - c.y * zoom };
    this.emit();
  }

  zoomToFit(): void {
    this.zoomToRect(selectionBounds(this.doc, this.page.children), 1);
  }

  zoomToSelection(): void {
    if (this.selection.length) this.zoomToRect(selectionBounds(this.doc, this.selection), MAX_ZOOM);
  }

  // ------------------------------------------------------------- files

  newDocument(): void {
    this.loadDocument(createDocument());
  }

  loadDocument(doc: PlanarDocument): void {
    this.finishTextEditing();
    this.doc = doc;
    this.pageId = doc.pageIds[0];
    this.selection = [];
    this.undoStack = [];
    this.redoStack = [];
    this.pageViewports.clear();
    this.zoomToFit();
    this.scheduleSave();
    this.emit();
  }

  openFile(text: string): void {
    try {
      this.loadDocument(parseDocument(JSON.parse(text)));
    } catch (e) {
      this.notify(`Could not open file: ${(e as Error).message}`);
    }
  }

  saveFile(): void {
    const blob = new Blob([JSON.stringify(this.doc, null, 1)], { type: 'application/json' });
    downloadBlob(blob, `${safeFilename(this.doc.name)}.planar.json`);
  }

  /** Ids that an export covers: the selection, or the whole page. */
  exportTargets(): string[] {
    const ids = topLevelSelection(this.doc, this.selection);
    return ids.length ? ids : this.page.children.filter((id) => this.doc.nodes[id].visible);
  }

  /**
   * Downloads the selection (or every screen of the page). `each` makes one file per layer in a ZIP;
   * a PDF always has one page per layer.
   */
  async exportAs(format: 'png' | 'svg' | 'pdf', scale = 1, each = false): Promise<void> {
    const ids = this.exportTargets();
    if (!ids.length) {
      this.notify('Nothing to export');
      return;
    }
    if (format === 'pdf' || (each && ids.length > 1)) {
      const out = await exportEach(this.doc, ids, format, scale, ids.length === 1 ? this.doc.nodes[ids[0]].name : this.page.name);
      if (out) downloadBlob(out.blob, out.filename);
      else this.notify('Nothing to export');
      return;
    }
    const base = safeFilename(ids.length === 1 ? this.doc.nodes[ids[0]].name : this.page.name);
    if (format === 'svg') {
      const svg = exportSvg(this.doc, ids);
      if (svg) downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${base}.svg`);
    } else {
      const blob = await exportPng(this.doc, ids, scale);
      if (blob) downloadBlob(blob, `${base}${scale !== 1 ? `@${scale}x` : ''}.png`);
    }
  }
}

/**
 * Enables auto layout on a frame, guessing direction, order, spacing and
 * padding from where its children currently are so nothing jumps.
 */
export function enableAutoLayout(doc: PlanarDocument, frameId: string): void {
  const f = doc.nodes[frameId];
  const kids = f.children.map((id) => doc.nodes[id]).filter((n) => n.visible && !n.layoutAbsolute);
  const boxes = new Map(
    kids.map((k) => {
      const m = localMatrix(k);
      const corners = [
        { x: 0, y: 0 },
        { x: k.width, y: 0 },
        { x: k.width, y: k.height },
        { x: 0, y: k.height },
      ].map((p) => apply(m, p));
      return [k.id, rectFromPoints(corners)] as const;
    }),
  );
  const centers = kids.map((k) => rectCenter(boxes.get(k.id)!));
  const spread = (vals: number[]) => (vals.length ? Math.max(...vals) - Math.min(...vals) : 0);
  const horizontal = spread(centers.map((c) => c.x)) >= spread(centers.map((c) => c.y));
  const key = (id: string) => {
    const b = boxes.get(id);
    return b ? (horizontal ? b.x + b.width / 2 : b.y + b.height / 2) : Infinity;
  };
  f.children.sort((a, b) => key(a) - key(b));

  const sorted = f.children.map((id) => boxes.get(id)).filter((b): b is NonNullable<typeof b> => !!b);
  let gap = 10;
  if (sorted.length > 1) {
    let sum = 0;
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1];
      const b = sorted[i];
      sum += horizontal ? b.x - (a.x + a.width) : b.y - (a.y + a.height);
    }
    gap = Math.max(0, Math.round(sum / (sorted.length - 1)));
  }
  const content = sorted.length ? rectFromPoints(sorted.flatMap((b) => [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y + b.height }])) : null;
  f.layoutMode = horizontal ? 'horizontal' : 'vertical';
  f.itemSpacing = gap;
  f.primaryAlign = 'start';
  f.counterAlign = 'start';
  f.paddingLeft = content ? Math.max(0, Math.round(content.x)) : 10;
  f.paddingTop = content ? Math.max(0, Math.round(content.y)) : 10;
  f.paddingRight = content ? Math.max(0, Math.round(f.width - content.x - content.width)) : 10;
  f.paddingBottom = content ? Math.max(0, Math.round(f.height - content.y - content.height)) : 10;
  f.sizingH = kids.length ? 'hug' : 'fixed';
  f.sizingV = kids.length ? 'hug' : 'fixed';
}

/**
 * Layers copied out of an instance become ordinary layers; instances inside
 * the copy (and their contents) keep their links.
 */
function unlinkCopiedLayers(nodes: SceneNode[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const walk = (n: SceneNode) => {
    if (n.type === 'instance') {
      n.sourceId = '';
      return;
    }
    n.sourceId = '';
    n.overrides = [];
    for (const c of n.children) {
      const child = byId.get(c);
      if (child) walk(child);
    }
  };
  walk(nodes[0]);
}
