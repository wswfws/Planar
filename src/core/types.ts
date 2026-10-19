import type { Vec } from './math';

export type NodeType = 'page' | 'frame' | 'component' | 'instance' | 'group' | 'rectangle' | 'ellipse' | 'vector' | 'text';

export interface SolidPaint {
  type: 'solid';
  color: string;
  opacity: number;
  visible: boolean;
  /** Colour variable this paint is bound to. */
  variableId?: string;
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
export type TextAlignVertical = 'top' | 'middle' | 'bottom';

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
  /** Height follows content (when not autoWidth); false = fixed size. */
  autoHeight: boolean;
  textAlignVertical: TextAlignVertical;

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

  /** Instance: the main component it follows. */
  componentId: string;
  /** Layer inside an instance: the component layer it mirrors. */
  sourceId: string;
  /** Instance layers: properties changed locally (not synced). */
  overrides: string[];
  /** Property name → variable id. */
  bindings: Record<string, string>;
  /** Variable mode chosen for this subtree ('' = inherit). */
  variableMode: string;
}

export type VariableType = 'color' | 'number' | 'string' | 'boolean';
export type VariableValue = string | number | boolean;

export interface Variable {
  id: string;
  name: string;
  type: VariableType;
  /** Mode id → value. */
  values: Record<string, VariableValue>;
}

export interface VariableMode {
  id: string;
  name: string;
}

export interface PlanarDocument {
  format: 'planar';
  version: 1;
  name: string;
  pageIds: string[];
  nodes: Record<string, SceneNode>;
  variables: Variable[];
  modes: VariableMode[];
}

export const CONTAINER_TYPES: ReadonlySet<NodeType> = new Set(['page', 'frame', 'component', 'instance', 'group']);

/** Frames, components and instances share frame behaviour. */
export function isFrameLike(node: SceneNode | null | undefined): boolean {
  return !!node && (node.type === 'frame' || node.type === 'component' || node.type === 'instance');
}

export function isContainer(node: SceneNode): boolean {
  return CONTAINER_TYPES.has(node.type);
}
