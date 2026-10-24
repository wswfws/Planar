# `.planar.json` file format (version 1)

A Planar document is a single UTF-8 JSON object.

```jsonc
{
  "format": "planar",
  "version": 1,
  "name": "Untitled",
  "context": "Brief: what the file is for (markdown)",
  "requests": [],
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
| `type` | `page` \| `frame` \| `component` \| `componentSet` \| `instance` \| `group` \| `rectangle` \| `ellipse` \| `vector` \| `text` \| `note` | |
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
| `layoutMode` | `none` \| `horizontal` \| `vertical` \| `grid` | Frame auto layout: a row, a column or a grid |
| `itemSpacing` | number | Gap between auto-layout items |
| `paddingTop`, `paddingRight`, `paddingBottom`, `paddingLeft` | number | Auto-layout padding |
| `primaryAlign` | `start` \| `center` \| `end` \| `space-between` | Main-axis alignment |
| `counterAlign` | `start` \| `center` \| `end` | Cross-axis alignment |
| `sizingH`, `sizingV` | `fixed` \| `hug` \| `fill` | Horizontal / vertical sizing |
| `layoutAbsolute` | boolean | Child ignores its parent's auto layout |
| `layoutWrap` | boolean | Horizontal auto layout continues on new rows (not with a hug width) |
| `counterSpacing` | number | Space between wrapped rows and between grid rows (`itemSpacing` is the column gap in a grid) |
| `gridColumns` | number | Grid: columns, 1–100 (default 2). Items fill cells row by row; columns share the width equally, or fit their widest item when the frame hugs |
| `gridRows` | number | Grid: rows, 0–100; `0` = as many as the items need, each as tall as its tallest item; a set count shares a fixed height equally |
| `strokesIncluded` | boolean | Auto layout: strokes take up space — the frame's inner half of its stroke adds to the padding and each item's stroke to its size |
| `reverseStacking` | boolean | Auto layout: the first item is drawn (and picked) on top |
| `lockAspect` | boolean | Resizing keeps the width-to-height ratio |
| `constraintH` | `left`, `right`, `left-right`, `center`, `scale` | How the layer follows its parent frame's width when the frame is resized (outside auto layout) |
| `constraintV` | `top`, `bottom`, `top-bottom`, `center`, `scale` | The same for height |
| `textStyleId`, `effectStyleId` | string | Style the layer follows (`''` = none); see Styles |
| `componentId` | string | Instance: id of its main component |
| `sourceId` | string | Layer inside an instance: id of the component layer it mirrors |
| `overrides` | string[] | Instance layers: property names changed locally |
| `bindings` | {property: variableId} | Properties bound to variables |
| `variableMode` | string | Mode id used for this subtree (`""` = inherit) |
| `componentProps` | ComponentProp[] | Component: declared properties |
| `propBindings` | {property: propId} | `characters`, `visible` or `componentId` driven by a component property |
| `propValues` | {propId: value} | Instance: values set for its component's properties |
| `variantProps` | {property: value} | Variant component: its value for each variant property |
| `context` | string | Notes for people and agents about what the layer (or page) is for, in markdown, at most 20000 characters. Not copied from a component to its instances |
| `note` | NoteData | Optional; only on `note` layers. See Annotations |
| `link` | {to, transition?} | Optional. Prototype: clicking the layer in Present mode goes to the top-level frame `to`; `transition` is `instant` (default), `slide` or `dissolve` |

Older files simply lack newer fields; readers fill in the defaults
(`none`, `10`, `0`, `start`, `start`, `fixed`, `false`, `""`, `""`, `[]`,
`{}`, `""`, `autoHeight: true`, `textAlignVertical: "top"`, `paths: []`, `pathBox: {w: 0, h: 0}`), an empty variable list and a single mode.

## Context

The document's `context` is the brief for the whole file (goal, audience,
rules); each node's `context` holds notes about that layer. Both are plain
markdown and do not affect rendering. Tools read them from the broadest to
the most specific: file, page, enclosing layers, the main component (for an
instance, or the component layer an instance layer mirrors), then the layer.
Missing or non-string values become `""`.

## API request history

`requests` is the history of the API requests tool, newest first (at most 50):

```jsonc
{
  "id": "lq3k9x2a7b",
  "name": "Create item",            // optional
  "at": 1761300000000,              // when it was sent (ms)
  "author": "Ann",                  // optional
  "via": "proxy",                   // "direct" (from the browser) or "proxy" (through the server)
  "request": {
    "method": "POST", "url": "https://api.example.com/items",
    "params": [{ "key": "page", "value": "2", "enabled": true }],
    "headers": [{ "key": "Authorization", "value": "Bearer …", "enabled": true }],
    "bodyKind": "json",             // "none" | "json" | "text" | "form"
    "body": "{\"name\":\"Box\"}",
    "form": []
  },
  "response": {                     // null when the request failed
    "status": 201, "statusText": "Created", "headers": [["content-type", "application/json"]],
    "body": "…", "truncated": false, "size": 42, "time": 180
  },
  "error": "…"                      // optional: why there is no response
}
```

Response bodies are kept up to 100 KB (`truncated` tells when one was cut).
Missing or malformed entries are dropped; a file without `requests` has an
empty history.

## Annotations

Layers of type `note` are annotations for the team and AI agents: sticky
notes, text descriptions, chats, checklists and callouts. They are drawn on
the canvas (unless the viewer hides annotations) but left out of SVG/PNG/PDF
export, generated code and presentations, and never take part in auto
layout (`layoutAbsolute` is true). Their `note` field:

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `sticky` \| `doc` \| `chat` \| `checklist` \| `callout` | What the note is; unknown kinds read as `sticky` |
| `author` | string | Sticky note: who wrote it |
| `messages` | {id, author, text, at, agent?, deleted?}[] | Chat: messages in time order (`at` in ms since 1970), at most 500. A deleted message keeps its id with empty text |
| `items` | {id, text, done}[] | Checklist: items, at most 200 |
| `targetId` | string | Callout: the layer its arrow points at (`""` = none) |

`characters` holds the text of a sticky note, a description (markdown:
headings, lists, `- [ ]` tasks, quotes, code fences) or a callout, and the
title of a chat or checklist; `fills[0]` is the note's colour. When a chat
layer is replaced (by a remote change, undo or a newer copy), the messages of
both versions are merged by id and a deletion wins, so people writing at the
same moment keep each other's messages.

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

## Styles

The document's `styles` list holds named text and effect styles:

- `{id, name, type: "text", fontFamily, fontSize, fontWeight, lineHeight}`
- `{id, name, type: "effect", effects: Effect[]}`

A layer whose `textStyleId` / `effectStyleId` names a style takes those values from it whenever the document changes; editing one of them on the layer clears the id. A reference to a missing style is dropped. Names may use slashes for grouping (`Heading/H1`).

## Team libraries

`libraries` lists the team libraries the document uses: `{fileId, name, version, pageId}`. Each library's components live on its own page (`pageId`), which editors hide from the page list. Layers, variables and styles copied from a library carry `library: {fileId, key}` (`key` is their id in the library file), so an update replaces them in place and instances keep pointing at the same ids. Instances of library components are ordinary layers of the document.
