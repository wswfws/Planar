# `.planar.json` file format (version 1)

A Planar document is a single UTF-8 JSON object.

```jsonc
{
  "format": "planar",
  "version": 1,
  "name": "Untitled",
  "pageIds": ["page-id-1"],
  "modes": [{ "id": "m1", "name": "Light" }, { "id": "m2", "name": "Dark" }],
  "variables": [
    { "id": "v1", "name": "brand", "type": "color", "values": { "m1": "#5B5BD6", "m2": "#F2A65A" } }
  ],
  "nodes": {
    "page-id-1": { "id": "page-id-1", "type": "page", "name": "Page 1", "parentId": null, "children": ["n1"], ... },
    "n1": { "id": "n1", "type": "rectangle", "parentId": "page-id-1", ... }
  }
}
```

`nodes` is a flat map of every node by id. The tree is described by each
node's `parentId` and ordered `children` array (first child paints first,
i.e. is at the bottom). Pages are nodes of type `page` and are listed in
`pageIds`.

## Node fields

All nodes carry every field below; fields that do not apply to a type keep
their default value.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique id |
| `type` | `page` \| `frame` \| `component` \| `componentSet` \| `instance` \| `group` \| `rectangle` \| `ellipse` \| `vector` \| `text` | |
| `name` | string | Layer name |
| `parentId` | string \| null | Parent node (null for pages) |
| `children` | string[] | Child ids, bottom to top |
| `x`, `y` | number | Top-left of the unrotated box, in parent coordinates |
| `width`, `height` | number | Box size |
| `rotation` | number | Degrees, clockwise, around the box centre |
| `opacity` | number | 0–1 |
| `visible`, `locked` | boolean | |
| `fills`, `strokes` | Paint[] | Painted bottom to top |
| `strokeWidth` | number | Centred on the outline |
| `effects` | Effect[] | Shadows and blurs (below) |
| `cornerRadius` | number | Rectangles and frames |
| `clipContent` | boolean | Frames |
| `characters` | string | Text content |
| `fontFamily` | string | CSS font family |
| `fontSize` | number | px |
| `fontWeight` | number | 100–900 |
| `lineHeight` | number | Multiplier of font size; `0` = auto (font ascent + descent) |
| `textAlign` | `left` \| `center` \| `right` | |
| `autoWidth` | boolean | Text grows horizontally instead of wrapping |
| `autoHeight` | boolean | Text height follows its content (ignored when `autoWidth`) |
| `textAlignVertical` | `top` \| `middle` \| `bottom` | Placement of text in a taller box |
| `points` | {x, y}[] | Vector points, normalised to 0–1 of the box |
| `closed` | boolean | Vector is a closed polygon |
| `paths` | {d, fillRule}[] | Vector paths (SVG path data using M, L, C, Q, Z in absolute coordinates); when present, `points` is ignored |
| `pathBox` | {w, h} | Size of the box the path coordinates refer to; paths are scaled from it to `width` × `height` |
| `layoutMode` | `none` \| `horizontal` \| `vertical` | Frame auto layout direction |
| `itemSpacing` | number | Gap between auto-layout items |
| `paddingTop`, `paddingRight`, `paddingBottom`, `paddingLeft` | number | Auto-layout padding |
| `primaryAlign` | `start` \| `center` \| `end` \| `space-between` | Main-axis alignment |
| `counterAlign` | `start` \| `center` \| `end` | Cross-axis alignment |
| `sizingH`, `sizingV` | `fixed` \| `hug` \| `fill` | Horizontal / vertical sizing |
| `layoutAbsolute` | boolean | Child ignores its parent's auto layout |
| `layoutWrap` | boolean | Horizontal auto layout continues on new rows (not with a hug width) |
| `counterSpacing` | number | Space between wrapped rows |
| `constraintH` | `left`, `right`, `left-right`, `center`, `scale` | How the layer follows its parent frame's width when the frame is resized (outside auto layout) |
| `constraintV` | `top`, `bottom`, `top-bottom`, `center`, `scale` | The same for height |
| `componentId` | string | Instance: id of its main component |
| `sourceId` | string | Layer inside an instance: id of the component layer it mirrors |
| `overrides` | string[] | Instance layers: property names changed locally |
| `bindings` | {property: variableId} | Properties bound to variables |
| `variableMode` | string | Mode id used for this subtree (`""` = inherit) |
| `componentProps` | ComponentProp[] | Component: declared properties |
| `propBindings` | {property: propId} | `characters`, `visible` or `componentId` driven by a component property |
| `propValues` | {propId: value} | Instance: values set for its component's properties |
| `variantProps` | {property: value} | Variant component: its value for each variant property |
| `link` | {to, transition?} | Optional. Prototype: clicking the layer in Present mode goes to the top-level frame `to`; `transition` is `instant` (default), `slide` or `dissolve` |

Older files simply lack newer fields; readers fill in the defaults
(`none`, `10`, `0`, `start`, `start`, `fixed`, `false`, `""`, `""`, `[]`,
`{}`, `""`, `autoHeight: true`, `textAlignVertical: "top"`, `paths: []`, `pathBox: {w: 0, h: 0}`), an empty variable list and a single mode.

## Components and instances

An instance stores a full copy of its component's layers so it can be drawn
without the component. Each copied layer's `sourceId` names the component
layer it mirrors; properties listed in its `overrides` are kept, all others
are refreshed from the component whenever the document changes.

## Component properties

```jsonc
{ "id": "p1", "name": "Label", "type": "text", "defaultValue": "Button" }
{ "id": "p2", "name": "Show icon", "type": "boolean", "defaultValue": true }
{ "id": "p3", "name": "Icon", "type": "instance", "defaultValue": "<component id>" }
```

Component properties of variants are stored on their `componentSet`.
A bound layer resolves a property through its nearest enclosing instance
whose component (or that component's set) declares it (using that instance's `propValues`, else the
default), or through the main component itself (the default).

## Variables

`variables[].values` maps mode ids to values (`#RRGGBB` strings for
colours). Numeric/string/boolean properties are bound through `bindings`;
solid paints are bound through their own `variableId`. The stored property
values are the last resolved values, so files render correctly without
resolving variables.

For pages, `fills[0]` is the canvas background colour.

## Paint

```jsonc
{ "type": "solid", "color": "#RRGGBB", "opacity": 1, "visible": true, "variableId": "optional" }
{ "type": "image", "src": "data:image/png;base64,...", "scaleMode": "fill", "opacity": 1, "visible": true }
```

## Transform

The local transform of a node is

```
translate(x + width/2, y + height/2) · rotate(rotation) · translate(-width/2, -height/2)
```

and its world transform is the product of its ancestors' local transforms
followed by its own.

## Effects

`effects` is a list of shadows and blurs, each
`{type, visible, color, opacity, x, y, radius, spread}`:

| `type` | Uses | Painted |
|---|---|---|
| `drop-shadow` | `color` (`#RRGGBB`), `opacity`, `x`, `y`, `radius` (blur, like CSS `box-shadow`), `spread` | Under the layer, cast by its fills, strokes and text (a layer without fills: by its children) |
| `inner-shadow` | same | Inside the layer's shape, above its fills |
| `layer-blur` | `radius` | Blurs the layer and its contents (CSS `filter: blur(radius / 2)`) |
| `background-blur` | `radius` | Blurs what is behind the layer's shape (CSS `backdrop-filter: blur(radius / 2)`) |

Unknown types and invalid values are dropped or replaced by defaults when a file is opened.
