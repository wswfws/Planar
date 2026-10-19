import { hasOverrides, isInInstance, owningInstance, variantSet } from '../core/components';
import type { Editor } from '../core/editor';
import { exportSvg } from '../core/export';
import { nodesAt, selectionBounds } from '../core/geometry';
import { isAutoLayout } from '../core/layout';
import type { Vec } from '../core/math';
import { tidy, type MenuEntry } from './ContextMenu';
import { MOD } from './Toolbar';

const TYPE_LABEL: Record<string, string> = {
  frame: 'Frame',
  component: 'Component',
  instance: 'Instance',
  group: 'Group',
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  vector: 'Vector',
  text: 'Text',
};

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function copyToClipboard(editor: Editor, cut = false): void {
  const text = cut ? editor.cutSelection() : editor.copySelection();
  if (text) void writeClipboard(text);
}

/** Pastes from the editor's own clipboard, or the system clipboard if empty. */
export async function pasteFromClipboard(editor: Editor, at?: Vec): Promise<void> {
  let text = editor.clipboardText;
  if (!text) {
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = null;
    }
  }
  if (!editor.paste(text, at)) editor.notify('Nothing to paste — copy layers first');
}

async function copyAsSvg(editor: Editor): Promise<void> {
  const svg = exportSvg(editor.doc, editor.exportTargets());
  if (svg && (await writeClipboard(svg))) editor.notify('SVG copied to the clipboard');
  else editor.notify('Could not copy SVG');
}

/** Menu for right-clicking empty canvas. */
export function canvasMenu(editor: Editor, at: Vec, openVariables: () => void): MenuEntry[] {
  return tidy([
    { label: 'Paste here', shortcut: `${MOD}V`, action: () => void pasteFromClipboard(editor, at) },
    { label: 'Select all', shortcut: `${MOD}A`, action: () => editor.selectAll(), disabled: !editor.page.children.length },
    '-',
    { label: 'Zoom to fit', shortcut: 'Shift+1', action: () => editor.zoomToFit() },
    { label: 'Zoom to 100%', shortcut: 'Shift+0', action: () => editor.zoomTo(1) },
    '-',
    { label: 'Variables…', action: openVariables },
    { label: 'Export page as PNG', shortcut: `${MOD}Shift+E`, action: () => void editor.exportAs('png', 2), disabled: !editor.page.children.length },
  ]);
}

/** Menu for a selection (canvas or layer tree). `at` enables "paste here" and "select layer". */
export function selectionMenu(editor: Editor, at?: Vec): MenuEntry[] {
  const { doc } = editor;
  const nodes = editor.selectedNodes;
  if (!nodes.length) return [];
  const single = nodes.length === 1 ? nodes[0] : null;
  const locked = nodes.some((n) => isInInstance(doc, n.id));
  const instance = single ? owningInstance(doc, single.id) : null;
  const allHidden = nodes.every((n) => !n.visible);
  const allLocked = nodes.every((n) => n.locked);
  const canUngroup = nodes.some((n) => (n.type === 'group' || n.type === 'frame') && !isInInstance(doc, n.id));
  const autoLayout = nodes.some((n) => isAutoLayout(n));
  const parentId = single?.parentId;
  const hasParent = !!parentId && parentId !== editor.pageId;

  const under = at ? nodesAt(doc, editor.pageId, at, 3 / editor.viewport.zoom) : [];
  const selectLayer: MenuEntry[] = under.slice(0, 15).map((id) => {
    const n = doc.nodes[id];
    return {
      label: n.name,
      hint: TYPE_LABEL[n.type],
      action: () => editor.select([id]),
      disabled: n.locked,
    };
  });

  const order: MenuEntry[] = [
    { label: 'Bring to front', shortcut: `${MOD}Shift+]`, action: () => editor.reorder('front') },
    { label: 'Bring forward', shortcut: `${MOD}]`, action: () => editor.reorder('forward') },
    { label: 'Send backward', shortcut: `${MOD}[`, action: () => editor.reorder('backward') },
    { label: 'Send to back', shortcut: `${MOD}Shift+[`, action: () => editor.reorder('back') },
  ];

  return tidy([
    { label: 'Copy', shortcut: `${MOD}C`, action: () => copyToClipboard(editor) },
    { label: 'Copy as SVG', action: () => void copyAsSvg(editor) },
    { label: 'Cut', shortcut: `${MOD}X`, action: () => copyToClipboard(editor, true), disabled: locked },
    at && { label: 'Paste here', shortcut: `${MOD}V`, action: () => void pasteFromClipboard(editor, at) },
    { label: 'Duplicate', shortcut: `${MOD}D`, action: () => editor.duplicateSelection(), disabled: locked },
    { label: 'Delete', shortcut: 'Del', action: () => editor.deleteSelection(), disabled: locked, danger: true },
    '-',
    selectLayer.length > 1 && { label: 'Select layer', submenu: selectLayer },
    { label: 'Select parent', shortcut: 'Shift+Enter', action: () => editor.selectParent(), disabled: !hasParent },
    { label: 'Select children', shortcut: 'Enter', action: () => editor.selectChildren(), disabled: !nodes.some((n) => n.children.length) },
    '-',
    { label: 'Order', submenu: order, disabled: locked },
    '-',
    { label: 'Group selection', shortcut: `${MOD}G`, action: () => editor.group(), disabled: locked },
    { label: 'Frame selection', shortcut: `${MOD}Alt+G`, action: () => editor.frameSelection(), disabled: locked },
    canUngroup && { label: 'Ungroup', shortcut: `${MOD}Shift+G`, action: () => editor.ungroup() },
    autoLayout
      ? { label: 'Remove auto layout', shortcut: 'Alt+Shift+A', action: () => editor.removeAutoLayout() }
      : { label: 'Add auto layout', shortcut: 'Shift+A', action: () => editor.addAutoLayout(), disabled: locked },
    '-',
    instance
      ? { label: 'Go to main component', action: () => editor.goToMainComponent(instance.id), disabled: !doc.nodes[instance.componentId] }
      : !nodes.every((n) => n.type === 'component') && { label: 'Create component', shortcut: `${MOD}Alt+K`, action: () => editor.createComponent(), disabled: locked },
    instance && hasOverrides(doc, instance.id) && { label: 'Reset all changes', action: () => editor.resetInstanceOverrides() },
    nodes.some((n) => n.type === 'instance') && { label: 'Detach instance', shortcut: `${MOD}Alt+B`, action: () => editor.detachInstances() },
    (single?.type === 'component' || single?.type === 'componentSet') && { label: 'Create instance', action: () => editor.instanceBeside(single.id) },
    nodes.length > 1 &&
      nodes.every((n) => n.type === 'component' && !variantSet(doc, n.id)) && { label: 'Combine as variants', action: () => editor.combineAsVariants() },
    single && (single.type === 'componentSet' || (single.type === 'component' && variantSet(doc, single.id))) && {
      label: 'Add variant',
      action: () => editor.addVariant(single.id),
    },
    '-',
    { label: allHidden ? 'Show' : 'Hide', shortcut: `${MOD}Shift+H`, action: () => editor.toggleVisible() },
    { label: allLocked ? 'Unlock' : 'Lock', shortcut: `${MOD}Shift+L`, action: () => editor.toggleLocked() },
    single && { label: 'Rename', shortcut: `${MOD}R`, action: () => editor.requestRename(single.id) },
    '-',
    { label: 'Zoom to selection', shortcut: 'Shift+2', action: () => editor.zoomToSelection() },
    {
      label: 'Export as PNG',
      shortcut: `${MOD}Shift+E`,
      action: () => void editor.exportAs('png', 2),
      disabled: !selectionBounds(doc, editor.selection),
    },
  ]);
}
