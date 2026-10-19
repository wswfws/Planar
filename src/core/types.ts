import type { Vec } from './math';

export type NodeType = 'page' | 'frame' | 'group' | 'rectangle' | 'ellipse' | 'vector' | 'text';

export interface SolidPaint {
  type: 'solid';
  color: string;
  opacity: number;
  visible: boolean;
}

export interface ImagePaint {
  type: 'image';
  src: string;
  scaleMode: 'fill' | 'fit';
  opacity: number;
  visible: boolean;
}

export type Paint = SolidPaint | ImagePaint;

export type TextAlign = 'left' | 'center' | 'right';

export type LayoutMode = 'none' | 'horizontal' | 'vertical';
export type PrimaryAlign = 'start' | 'center' | 'end' | 'space-between';
export type CounterAlign = 'start' | 'center' | 'end';
export type Sizing = 'fixed' | 'hug' | 'fill';

/**
 * One flat node shape for every layer type. Fields that do not apply to a
 * type keep their defaults, which keeps editing code free of type narrowing.
 */
export interface SceneNode {
  id: string;
  type: NodeType;
  name: string;
  parentId: string | null;
  children: string[];

  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  locked: boolean;

  fills: Paint[];
  strokes: Paint[];
  strokeWidth: number;

  cornerRadius: number;
  clipContent: boolean;

  characters: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  textAlign: TextAlign;
  autoWidth: boolean;

  points: Vec[];
  closed: boolean;

  /** Auto layout (frames). */
  layoutMode: LayoutMode;
  itemSpacing: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  primaryAlign: PrimaryAlign;
  counterAlign: CounterAlign;
  /** How the layer is sized horizontally / vertically. */
  sizingH: Sizing;
  sizingV: Sizing;
  /** Child opts out of its parent's auto layout. */
  layoutAbsolute: boolean;
}

export interface PlanarDocument {
  format: 'planar';
  version: 1;
  name: string;
  pageIds: string[];
  nodes: Record<string, SceneNode>;
}

export const CONTAINER_TYPES: ReadonlySet<NodeType> = new Set(['page', 'frame', 'group']);

export function isContainer(node: SceneNode): boolean {
  return CONTAINER_TYPES.has(node.type);
}
