# `.planar.json` file format (version 1)

A Planar document is a single UTF-8 JSON object.

```jsonc
{
  "format": "planar",
  "version": 1,
  "name": "Untitled",
  "pageIds": ["page-id-1"],
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
| `type` | `page` \| `frame` \| `group` \| `rectangle` \| `ellipse` \| `vector` \| `text` | |
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
| `cornerRadius` | number | Rectangles and frames |
| `clipContent` | boolean | Frames |
| `characters` | string | Text content |
| `fontFamily` | string | CSS font family |
| `fontSize` | number | px |
| `fontWeight` | number | 100–900 |
| `lineHeight` | number | Multiplier of font size |
| `textAlign` | `left` \| `center` \| `right` | |
| `autoWidth` | boolean | Text grows horizontally instead of wrapping |
| `points` | {x, y}[] | Vector points, normalised to 0–1 of the box |
| `closed` | boolean | Vector is a closed polygon |

For pages, `fills[0]` is the canvas background colour.

## Paint

```jsonc
{ "type": "solid", "color": "#RRGGBB", "opacity": 1, "visible": true }
{ "type": "image", "src": "data:image/png;base64,...", "scaleMode": "fill", "opacity": 1, "visible": true }
```

## Transform

The local transform of a node is

```
translate(x + width/2, y + height/2) · rotate(rotation) · translate(-width/2, -height/2)
```

and its world transform is the product of its ancestors' local transforms
followed by its own.
