// Converts a file from the Figma REST API (GET /v1/files/:key?geometry=paths,
// fetched by the user with their own token) into a Planar document. Pure: no
// network and no DOM; images arrive as a map from imageRef to a data URL.
// Written from the public REST API reference; see docs/FIGMA_IMPORT.md.

import { createNode, newId } from '../core/document';
import { createNote } from '../core/notes';
import { pathGeometry } from '../core/paths';
import type { ConstraintH, ConstraintV, Effect, NodeType, Paint, PlanarDocument, SceneNode, Sizing, Style } from '../core/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type FNode = Record<string, any>;

export interface FigmaImportResult {
  doc: PlanarDocument;
  /** What was simplified or left out, as short readable lines. */
  report: string[];
  /** Image refs the document uses (fetch them with GET /v1/files/:key/images). */
  imageRefs: string[];
}

const hex2 = (v: number) =>
  Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, '0');
const hex = (c: { r: number; g: number; b: number } | undefined) => (c ? `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`.toUpperCase() : '#000000');
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const round = (v: number) => Math.round(v * 100) / 100;

const SKIPPED = new Set(['SHAPE_WITH_TEXT', 'CONNECTOR', 'WIDGET', 'EMBED', 'LINK_UNFURL', 'TABLE', 'TABLE_CELL', 'SLICE', 'CODE_BLOCK', 'STAMP', 'HIGHLIGHT', 'WASHI_TAPE']);
const VECTORS = new Set(['VECTOR', 'STAR', 'REGULAR_POLYGON', 'BOOLEAN_OPERATION', 'LINE']);
const H_CONSTRAINT: Record<string, ConstraintH> = { LEFT: 'left', RIGHT: 'right', CENTER: 'center', LEFT_RIGHT: 'left-right', SCALE: 'scale' };
const V_CONSTRAINT: Record<string, ConstraintV> = { TOP: 'top', BOTTOM: 'bottom', CENTER: 'center', TOP_BOTTOM: 'top-bottom', SCALE: 'scale' };
const ALIGN = { MIN: 'start', CENTER: 'center', MAX: 'end', SPACE_BETWEEN: 'space-between', BASELINE: 'start' } as const;

/** Converts a GET /v1/files response; `images` maps imageRef → data URL (missing ones become grey). */
export function figmaToPlanar(file: FNode, images: Record<string, string> = {}): FigmaImportResult {
  if (!file || typeof file !== 'object' || !file.document || !Array.isArray(file.document.children)) {
    throw new Error('This is not a Figma file: expected the JSON of GET /v1/files/:key');
  }
  const counts = new Map<string, number>();
  const note = (what: string) => counts.set(what, (counts.get(what) ?? 0) + 1);
  const imageRefs = new Set<string>();

  // Pass 1: a Planar id for every Figma node, so references can point forward.
  const ids = new Map<string, string>();
  const walkIds = (n: FNode) => {
    ids.set(n.id, newId());
    for (const c of n.children ?? []) walkIds(c);
  };
  file.document.children.forEach(walkIds);
  const idOf = (figmaId: string | undefined) => (figmaId ? ids.get(figmaId) ?? '' : '');

  const nodes: Record<string, SceneNode> = {};
  const pageIds: string[] = [];
  const instanceLayers: SceneNode[] = [];

  // Styles: Figma styles become Planar text and effect styles (fill styles are not styles in Planar).
  const styles: Style[] = [];
  const styleIds = new Map<string, string>();
  const styleFrom = (n: FNode) => {
    for (const [kind, sid] of Object.entries((n.styles ?? {}) as Record<string, string>)) {
      const meta = file.styles?.[sid];
      if (!meta || styleIds.has(sid)) continue;
      if (kind === 'text' && n.type === 'TEXT' && n.style) {
        const s = n.style;
        const id = newId();
        styleIds.set(sid, id);
        styles.push({ id, name: String(meta.name ?? 'Text'), type: 'text', fontFamily: String(s.fontFamily ?? 'Inter'), fontSize: num(s.fontSize, 16), fontWeight: num(s.fontWeight, 400), lineHeight: lineHeight(s) });
      } else if (kind === 'effect') {
        const id = newId();
        styleIds.set(sid, id);
        styles.push({ id, name: String(meta.name ?? 'Effect'), type: 'effect', effects: effects(n.effects) });
      }
    }
  };

  function paints(list: FNode[] | undefined, what: 'fill' | 'stroke'): Paint[] {
    const out: Paint[] = [];
    for (const p of list ?? []) {
      const visible = p.visible !== false;
      const opacity = num(p.opacity, 1);
      if (p.type === 'SOLID') {
        out.push({ type: 'solid', color: hex(p.color), opacity: round(opacity * num(p.color?.a, 1)), visible });
      } else if (p.type === 'IMAGE') {
        if (p.imageRef) imageRefs.add(p.imageRef);
        const src = p.imageRef ? images[p.imageRef] : undefined;
        if (src) out.push({ type: 'image', src, scaleMode: p.scaleMode === 'FIT' ? 'fit' : 'fill', opacity, visible });
        else {
          note('images not downloaded (grey instead)');
          out.push({ type: 'solid', color: '#D9D9D9', opacity, visible });
        }
      } else if (typeof p.type === 'string' && p.type.startsWith('GRADIENT') && Array.isArray(p.gradientStops) && p.gradientStops.length) {
        // No gradients in Planar yet: the average colour stands in.
        const stops = p.gradientStops as { color: { r: number; g: number; b: number; a: number } }[];
        const avg = (k: 'r' | 'g' | 'b' | 'a') => stops.reduce((s, x) => s + num(x.color?.[k], k === 'a' ? 1 : 0), 0) / stops.length;
        note(`gradient ${what}s (average colour instead)`);
        out.push({ type: 'solid', color: hex({ r: avg('r'), g: avg('g'), b: avg('b') }), opacity: round(opacity * avg('a')), visible });
      } else if (p.type) {
        note(`${String(p.type).toLowerCase()} ${what}s`);
      }
    }
    return out;
  }

  function effects(list: FNode[] | undefined): Effect[] {
    const out: Effect[] = [];
    for (const e of list ?? []) {
      const base = { visible: e.visible !== false, color: hex(e.color), opacity: round(num(e.color?.a, 1)), x: num(e.offset?.x), y: num(e.offset?.y), radius: Math.max(0, num(e.radius)), spread: num(e.spread) };
      if (e.type === 'DROP_SHADOW') out.push({ type: 'drop-shadow', ...base });
      else if (e.type === 'INNER_SHADOW') out.push({ type: 'inner-shadow', ...base });
      else if (e.type === 'LAYER_BLUR') out.push({ type: 'layer-blur', ...base, x: 0, y: 0, spread: 0 });
      else if (e.type === 'BACKGROUND_BLUR') out.push({ type: 'background-blur', ...base, x: 0, y: 0, spread: 0 });
      else if (e.type) note(`${String(e.type).toLowerCase()} effects`);
    }
    return out;
  }

  function lineHeight(s: FNode): number {
    if (s.lineHeightUnit === 'INTRINSIC_%' || !num(s.lineHeightPx) || !num(s.fontSize)) return 0;
    return round(num(s.lineHeightPx) / num(s.fontSize));
  }

  /** Box, rotation and position in the parent's space. */
  function placement(n: FNode, parent: FNode | null): Pick<SceneNode, 'x' | 'y' | 'width' | 'height' | 'rotation'> {
    const box = n.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
    const w = num(n.size?.x, num(box.width));
    const h = num(n.size?.y, num(box.height));
    const m = n.relativeTransform;
    if (Array.isArray(m) && m.length === 2) {
      const [[a, c, tx], [b, d, ty]] = m as number[][];
      if (a * d - b * c < 0) note('flipped layers (shown unflipped)');
      const cx = tx + a * (w / 2) + c * (h / 2);
      const cy = ty + b * (w / 2) + d * (h / 2);
      const rot = (Math.atan2(b, a) * 180) / Math.PI;
      return { x: round(cx - w / 2), y: round(cy - h / 2), width: round(w), height: round(h), rotation: Math.abs(rot) < 0.01 ? 0 : round(rot) };
    }
    // Without geometry=paths there is no transform: use the bounding boxes.
    const pb = parent?.absoluteBoundingBox;
    return { x: round(num(box.x) - num(pb?.x)), y: round(num(box.y) - num(pb?.y)), width: round(num(box.width)), height: round(num(box.height)), rotation: 0 };
  }

  function sizing(n: FNode, parent: FNode | null, axis: 'H' | 'V'): Sizing {
    const explicit = axis === 'H' ? n.layoutSizingHorizontal : n.layoutSizingVertical;
    if (explicit === 'HUG') return 'hug';
    if (explicit === 'FILL') return 'fill';
    if (explicit === 'FIXED') return 'fixed';
    // Older files: derive from the auto-layout fields.
    const auto = n.layoutMode && n.layoutMode !== 'NONE';
    const main = n.layoutMode === 'HORIZONTAL' ? 'H' : 'V';
    if (auto && (axis === main ? n.primaryAxisSizingMode : n.counterAxisSizingMode) === 'AUTO') return 'hug';
    const pAuto = parent?.layoutMode && parent.layoutMode !== 'NONE';
    if (pAuto) {
      const pMain = parent!.layoutMode === 'HORIZONTAL' ? 'H' : 'V';
      if (axis === pMain && num(n.layoutGrow) > 0) return 'fill';
      if (axis !== pMain && n.layoutAlign === 'STRETCH') return 'fill';
    }
    return 'fixed';
  }

  function convert(n: FNode, parent: FNode | null, parentId: string, insideInstance: boolean): string | null {
    if (SKIPPED.has(n.type)) {
      note(`${String(n.type).toLowerCase().replace(/_/g, ' ')} layers`);
      return null;
    }
    styleFrom(n);
    let type: NodeType;
    switch (n.type) {
      case 'FRAME':
      case 'SECTION':
        type = 'frame';
        break;
      case 'GROUP':
        type = 'group';
        break;
      case 'COMPONENT':
        type = insideInstance ? 'frame' : 'component';
        break;
      case 'COMPONENT_SET':
        type = insideInstance ? 'frame' : 'componentSet';
        break;
      case 'INSTANCE':
        type = file.document && n.componentId && ids.has(n.componentId) ? 'instance' : 'frame';
        if (type === 'frame') note('instances of components from other files (kept as frames)');
        break;
      case 'RECTANGLE':
        type = 'rectangle';
        break;
      case 'ELLIPSE':
        type = 'ellipse';
        if (n.arcData && (num(n.arcData.endingAngle) - num(n.arcData.startingAngle) < 6.28 || num(n.arcData.innerRadius) > 0)) note('arcs and rings (full ellipses instead)');
        break;
      case 'TEXT':
        type = 'text';
        break;
      case 'STICKY':
        type = 'note';
        break;
      default:
        if (VECTORS.has(n.type)) type = 'vector';
        else {
          note(`${String(n.type).toLowerCase()} layers`);
          return null;
        }
    }
    const id = idOf(n.id);
    const node = createNode(type, { id, name: String(n.name ?? type), parentId, ...placement(n, parent) });
    node.visible = n.visible !== false;
    node.locked = n.locked === true;
    node.opacity = round(num(n.opacity, 1));
    node.fills = paints(n.fills, 'fill');
    node.strokes = paints(n.strokes, 'stroke');
    node.strokeWidth = node.strokes.length ? num(n.strokeWeight, 1) : node.type === 'vector' ? 0 : 1;
    node.effects = effects(n.effects);
    if (n.styles?.effect && styleIds.has(n.styles.effect)) node.effectStyleId = styleIds.get(n.styles.effect)!;
    if (typeof n.cornerRadius === 'number') node.cornerRadius = n.cornerRadius;
    else if (Array.isArray(n.rectangleCornerRadii)) {
      const r = n.rectangleCornerRadii as number[];
      node.cornerRadius = Math.max(...r);
      if (new Set(r).size > 1) note('different corner radii (largest used)');
    }
    if (type !== 'group' && type !== 'note') node.clipContent = n.clipsContent === true;
    if (type === 'note') {
      // FigJam sticky notes become sticky notes.
      const sticky = createNote('sticky', { id, name: node.name, parentId, x: node.x, y: node.y, width: node.width, height: node.height });
      if (node.fills[0]?.type === 'solid') sticky.fills = [node.fills[0]];
      sticky.characters = String(n.characters ?? '');
      if (n.authorName) sticky.note = { kind: 'sticky', author: String(n.authorName) };
      nodes[id] = sticky;
      return id;
    }
    if (n.constraints) {
      node.constraintH = H_CONSTRAINT[n.constraints.horizontal] ?? 'left';
      node.constraintV = V_CONSTRAINT[n.constraints.vertical] ?? 'top';
    }
    node.layoutAbsolute = n.layoutPositioning === 'ABSOLUTE';
    node.sizingH = sizing(n, parent, 'H');
    node.sizingV = sizing(n, parent, 'V');
    if (n.layoutMode === 'GRID') {
      node.layoutMode = 'grid';
      node.gridColumns = Math.max(1, Math.round(num(n.gridColumnCount, 1)));
      node.gridRows = Math.max(0, Math.round(num(n.gridRowCount, 0)));
      node.itemSpacing = num(n.gridColumnGap);
      node.counterSpacing = num(n.gridRowGap);
      node.paddingTop = num(n.paddingTop);
      node.paddingRight = num(n.paddingRight);
      node.paddingBottom = num(n.paddingBottom);
      node.paddingLeft = num(n.paddingLeft);
    }
    if (n.layoutMode && n.layoutMode !== 'NONE') {
      node.strokesIncluded = n.strokesIncludedInLayout === true;
      node.reverseStacking = n.itemReverseZIndex === true;
    }
    if (n.layoutMode === 'HORIZONTAL' || n.layoutMode === 'VERTICAL') {
      if (type === 'group') note('auto layout on groups');
      node.layoutMode = n.layoutMode === 'HORIZONTAL' ? 'horizontal' : 'vertical';
      node.itemSpacing = num(n.itemSpacing);
      node.paddingTop = num(n.paddingTop);
      node.paddingRight = num(n.paddingRight);
      node.paddingBottom = num(n.paddingBottom);
      node.paddingLeft = num(n.paddingLeft);
      node.primaryAlign = ALIGN[(n.primaryAxisAlignItems ?? 'MIN') as keyof typeof ALIGN] ?? 'start';
      const cross = ALIGN[(n.counterAxisAlignItems ?? 'MIN') as keyof typeof ALIGN] ?? 'start';
      node.counterAlign = cross === 'space-between' ? 'start' : cross;
      if (n.layoutWrap === 'WRAP') {
        node.layoutWrap = true;
        node.counterSpacing = num(n.counterAxisSpacing, node.itemSpacing);
      }
    }

    if (type === 'text') {
      const s = n.style ?? {};
      node.characters = String(n.characters ?? '');
      node.fontFamily = String(s.fontFamily ?? 'Inter');
      node.fontSize = num(s.fontSize, 16);
      node.fontWeight = num(s.fontWeight, 400);
      node.lineHeight = lineHeight(s);
      node.textAlign = s.textAlignHorizontal === 'CENTER' ? 'center' : s.textAlignHorizontal === 'RIGHT' ? 'right' : 'left';
      if (s.textAlignHorizontal === 'JUSTIFIED') note('justified text (left-aligned instead)');
      node.textAlignVertical = s.textAlignVertical === 'CENTER' ? 'middle' : s.textAlignVertical === 'BOTTOM' ? 'bottom' : 'top';
      node.autoWidth = s.textAutoResize === 'WIDTH_AND_HEIGHT';
      node.autoHeight = s.textAutoResize === 'HEIGHT' || s.textAutoResize === 'WIDTH_AND_HEIGHT';
      if (Array.isArray(n.characterStyleOverrides) && n.characterStyleOverrides.some((x: number) => x)) note('text with mixed styles (first style used)');
      if (n.styles?.text && styleIds.has(n.styles.text)) node.textStyleId = styleIds.get(n.styles.text)!;
      node.strokes = [];
    }

    if (type === 'vector') {
      const geometry = (n.fillGeometry?.length ? n.fillGeometry : n.strokeGeometry) as { path: string; windingRule?: string }[] | undefined;
      if (n.type === 'LINE' || !geometry?.length) {
        // A straight line, or no geometry (file fetched without geometry=paths): a line along the box.
        node.points = [
          { x: 0, y: 0 },
          { x: 1, y: n.type === 'LINE' ? 0 : 1 },
        ];
        node.height = n.type === 'LINE' ? 0 : node.height;
        if (n.type !== 'LINE') note('vectors without geometry (fetch with geometry=paths)');
      } else {
        try {
          const geo = pathGeometry(
            geometry.map((g) => g.path),
            { w: Math.max(node.width, 0.01), h: Math.max(node.height, 0.01) },
          );
          node.paths = geo.paths.map((p, i) => ({ ...p, fillRule: geometry[i]?.windingRule === 'EVENODD' ? 'evenodd' : 'nonzero' }));
          node.pathBox = { w: Math.max(node.width, 0.01), h: Math.max(node.height, 0.01) };
          // Only stroke geometry: it is the outline of the stroke, so fill it with the stroke paint.
          if (!n.fillGeometry?.length) {
            node.fills = node.strokes;
            node.strokes = [];
          }
        } catch {
          note('vectors with unreadable paths');
          return null;
        }
      }
      if (n.type === 'BOOLEAN_OPERATION') note('boolean operations (flattened to vectors)');
    }

    if (type === 'component' && parent?.type === 'COMPONENT_SET') {
      for (const part of String(n.name ?? '').split(',')) {
        const [k, v] = part.split('=').map((x) => x.trim());
        if (k && v !== undefined) node.variantProps[k] = v;
      }
    }
    // Component descriptions (in the file's components / componentSets maps) become their context.
    if (type === 'component' || type === 'componentSet') {
      const meta = (type === 'component' ? file.components : file.componentSets)?.[n.id];
      if (typeof meta?.description === 'string' && meta.description.trim()) node.context = meta.description.trim();
    }
    if (n.componentPropertyDefinitions && Object.keys(n.componentPropertyDefinitions).some((k) => n.componentPropertyDefinitions[k]?.type !== 'VARIANT')) {
      note('component properties (not imported)');
    }
    if (type === 'instance') node.componentId = idOf(n.componentId);
    if (insideInstance) {
      // "I1:2;3:4" — the last part is the layer of the main component it mirrors.
      const last = String(n.id).split(';').pop()!.replace(/^I/, '');
      const src = idOf(last);
      if (src) {
        node.sourceId = src;
        instanceLayers.push(node);
      }
    }

    nodes[id] = node;
    if (type !== 'vector' || n.type !== 'BOOLEAN_OPERATION') {
      for (const c of n.children ?? []) {
        const cid = convert(c, n, id, insideInstance || n.type === 'INSTANCE');
        if (cid) node.children.push(cid);
      }
    }
    if (type === 'instance') instanceLayers.push(node);
    return id;
  }

  for (const canvas of file.document.children as FNode[]) {
    if (canvas.type !== 'CANVAS') continue;
    const page = createNode('page', { id: idOf(canvas.id), name: String(canvas.name ?? 'Page'), width: 0, height: 0 });
    if (canvas.backgroundColor) page.fills = [{ type: 'solid', color: hex(canvas.backgroundColor), opacity: 1, visible: true }];
    nodes[page.id] = page;
    pageIds.push(page.id);
    for (const c of canvas.children ?? []) {
      const cid = convert(c, null, page.id, false);
      if (cid) page.children.push(cid);
    }
  }
  if (!pageIds.length) throw new Error('The Figma file has no pages');

  // Instances keep what differs from their main component as overrides, so
  // syncing with the component does not undo the imported look.
  const SKIP = new Set(['id', 'parentId', 'children', 'sourceId', 'overrides', 'library', 'context', 'componentId', 'x', 'y', 'type', 'name']);
  for (const layer of instanceLayers) {
    const src = layer.type === 'instance' && !layer.sourceId ? nodes[layer.componentId] : nodes[layer.sourceId];
    if (!src) continue;
    const keys = (Object.keys(layer) as (keyof SceneNode)[]).filter((k) => !SKIP.has(k) && JSON.stringify(layer[k]) !== JSON.stringify(src[k]));
    layer.overrides = [...new Set([...layer.overrides, ...keys])];
  }

  const report = [...counts.entries()].map(([what, n]) => `${n} × ${what}`);
  return {
    doc: { format: 'planar', version: 1, name: String(file.name ?? 'Imported from Figma'), pageIds, nodes, variables: [], modes: [{ id: newId(), name: 'Mode 1' }], styles, libraries: [], context: '' },
    report,
    imageRefs: [...imageRefs],
  };
}

/** The file key in a Figma link (https://www.figma.com/design/<key>/… or /file/<key>/…), or the key itself. */
export function figmaFileKey(link: string): string | null {
  const s = link.trim();
  const m = /figma\.com\/(?:design|file|proto|board)\/([A-Za-z0-9]+)/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9]{10,64}$/.test(s) ? s : null;
}
