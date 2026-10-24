import type { Vec } from './math';

export type NodeType = 'page' | 'frame' | 'component' | 'componentSet' | 'instance' | 'group' | 'rectangle' | 'ellipse' | 'vector' | 'text' | 'note';

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

export type EffectType = 'drop-shadow' | 'inner-shadow' | 'layer-blur' | 'background-blur';

/** A shadow or blur. Blurs use only radius; x, y, spread and colour apply to shadows. */
export interface Effect {
  type: EffectType;
  visible: boolean;
  color: string;
  opacity: number;
  x: number;
  y: number;
  radius: number;
  spread: number;
}

export type TextAlign = 'left' | 'center' | 'right';
export type TextAlignVertical = 'top' | 'middle' | 'bottom';

export type LayoutMode = 'none' | 'horizontal' | 'vertical' | 'grid';
export type PrimaryAlign = 'start' | 'center' | 'end' | 'space-between';
export type CounterAlign = 'start' | 'center' | 'end';
export type Sizing = 'fixed' | 'hug' | 'fill';
/** How a layer follows its parent frame when the frame is resized (outside auto layout). */
export type ConstraintH = 'left' | 'right' | 'left-right' | 'center' | 'scale';
export type ConstraintV = 'top' | 'bottom' | 'top-bottom' | 'center' | 'scale';

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
  /** Shadows and blurs, painted in list order. */
  effects: Effect[];

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
  /** Vector paths (normalised SVG path data); when present, points are ignored. */
  paths: VectorPath[];
  /** Size of the box path coordinates refer to (scaled to width × height). */
  pathBox: { w: number; h: number };

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
  /** Horizontal auto layout continues on new rows when items do not fit. */
  layoutWrap: boolean;
  /** Space between wrapped rows (and between grid rows). */
  counterSpacing: number;
  /** Grid layout: number of columns (at least 1). */
  gridColumns: number;
  /** Grid layout: number of rows; 0 = as many as the items need. */
  gridRows: number;
  /** Auto layout: strokes take up space (the frame's inside half, children's whole width). */
  strokesIncluded: boolean;
  /** Auto layout: the first item is drawn on top instead of the last. */
  reverseStacking: boolean;
  /** Resizing keeps the width-to-height ratio. */
  lockAspect: boolean;
  constraintH: ConstraintH;
  constraintV: ConstraintV;

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
  /** Text style the font settings come from ('' = none). */
  textStyleId: string;
  /** Effect style the effects come from ('' = none). */
  effectStyleId: string;

  /** Component: declared properties. */
  componentProps: ComponentProp[];
  /** 'characters' | 'visible' | 'componentId' → component property id. */
  propBindings: Record<string, string>;
  /** Instance: values chosen for its component's properties. */
  propValues: Record<string, string | boolean>;
  /** Variant component: its value for each variant property of its set. */
  variantProps: Record<string, string>;

  /** Prototype: clicking this layer in presentation goes to another screen (top-level frame). */
  link?: { to: string; transition?: 'instant' | 'slide' | 'dissolve' };
  /** Copied from a team library: the library file and the layer's id there. */
  library?: LibraryOrigin;
  /** Notes for people and agents about what this layer is for (markdown). */
  context: string;
  /** Annotation layers (type 'note'): what kind and its contents besides `characters`. */
  note?: NoteData;
}

export type NoteKind = 'sticky' | 'doc' | 'chat' | 'checklist' | 'callout';

export interface NoteMessage {
  id: string;
  author: string;
  text: string;
  /** Milliseconds since 1970. */
  at: number;
  /** Written by an AI agent. */
  agent?: boolean;
  /** Removed (kept so every copy of the chat forgets it). */
  deleted?: boolean;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

/**
 * Annotation contents. Sticky notes, descriptions (markdown) and callouts
 * keep their text in `characters`; a chat or checklist uses it as its title.
 */
export interface NoteData {
  kind: NoteKind;
  /** Who wrote a sticky note. */
  author?: string;
  messages?: NoteMessage[];
  items?: ChecklistItem[];
  /** Callout: the layer it points at. */
  targetId?: string;
}

/** Where something imported from a team library came from. */
export interface LibraryOrigin {
  fileId: string;
  /** Its id in the library file. */
  key: string;
}

/** A team library used by this document; its components live on a hidden page. */
export interface LibraryLink {
  fileId: string;
  name: string;
  /** Published version that was imported. */
  version: number;
  pageId: string;
}

export interface VectorPath {
  d: string;
  fillRule: 'nonzero' | 'evenodd';
}

export type ComponentPropType = 'text' | 'boolean' | 'instance';

export interface ComponentProp {
  id: string;
  name: string;
  type: ComponentPropType;
  /** Text, visibility, or a component id for instance swap. */
  defaultValue: string | boolean;
}

export type VariableType = 'color' | 'number' | 'string' | 'boolean';
export type VariableValue = string | number | boolean;

export interface Variable {
  id: string;
  name: string;
  type: VariableType;
  /** Mode id → value. */
  values: Record<string, VariableValue>;
  library?: LibraryOrigin;
}

export interface VariableMode {
  id: string;
  name: string;
}

/** A named text style: the font settings text layers share. */
export interface TextStyle {
  id: string;
  name: string;
  type: 'text';
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  library?: LibraryOrigin;
}

/** A named set of shadows and blurs. */
export interface EffectStyle {
  id: string;
  name: string;
  type: 'effect';
  effects: Effect[];
  library?: LibraryOrigin;
}

export type Style = TextStyle | EffectStyle;

/** HTTP methods the API requests tool can send. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type RequestBodyKind = 'none' | 'json' | 'text' | 'form';

/** A row of params, headers or form fields; unchecked rows are kept but not sent. */
export interface KeyValue {
  key: string;
  value: string;
  enabled: boolean;
}

/** An HTTP request as built in the API requests tool. */
export interface RequestSpec {
  method: HttpMethod;
  url: string;
  params: KeyValue[];
  headers: KeyValue[];
  bodyKind: RequestBodyKind;
  /** Raw body for json and text. */
  body: string;
  /** Fields of a form body (application/x-www-form-urlencoded). */
  form: KeyValue[];
}

export interface ResponseRecord {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  /** The body was longer than the limit and was cut. */
  truncated: boolean;
  /** Body size in bytes, before any cut. */
  size: number;
  /** Milliseconds from sending to the end of the body. */
  time: number;
}

/** A sent request and what came back, kept in the document. */
export interface SavedRequest {
  id: string;
  /** Optional name; the method and URL are shown otherwise. */
  name?: string;
  at: number;
  /** Who sent it. */
  author?: string;
  request: RequestSpec;
  response: ResponseRecord | null;
  /** Why there is no response (network error, CORS, refused by the proxy…). */
  error?: string;
  via: 'direct' | 'proxy';
}

export interface PlanarDocument {
  format: 'planar';
  version: 1;
  name: string;
  pageIds: string[];
  nodes: Record<string, SceneNode>;
  variables: Variable[];
  modes: VariableMode[];
  styles: Style[];
  /** Team libraries this document uses. */
  libraries: LibraryLink[];
  /** Brief for the whole file: goal, audience, rules (markdown). */
  context: string;
  /** History of the API requests tool: sent requests with their responses, newest first. */
  requests: SavedRequest[];
}

export const CONTAINER_TYPES: ReadonlySet<NodeType> = new Set(['page', 'frame', 'component', 'componentSet', 'instance', 'group']);

/** Frames, components and instances share frame behaviour. */
export function isFrameLike(node: SceneNode | null | undefined): boolean {
  return !!node && (node.type === 'frame' || node.type === 'component' || node.type === 'componentSet' || node.type === 'instance');
}

/** Children in painting order, bottom first ("first on top" auto layouts reverse it). */
export function paintOrder(node: SceneNode): string[] {
  return node.reverseStacking && isFrameLike(node) && node.layoutMode !== 'none' ? [...node.children].reverse() : node.children;
}

export function isContainer(node: SceneNode): boolean {
  return CONTAINER_TYPES.has(node.type);
}
