# Importing Figma files

Planar can turn a Figma design file into a Planar file. It reads the JSON that
the public [Figma REST API](https://www.figma.com/developers/api) returns for
`GET /v1/files/:key?geometry=paths`; it never reads Figma's binary `.fig`
format. The converter (`src/import/figma.ts`) is written from the public API
reference only (see CLEAN_ROOM.md).

## How it works

- **From a link** (Files page → *Import from Figma…*): the user pastes a link
  to their file and their own personal access token. The browser calls
  `api.figma.com` directly (the API allows cross-origin requests), downloads
  image fills through `GET /v1/files/:key/images`, converts the file and sends
  only the finished Planar document to the Planar server. The token is not
  stored and never reaches the Planar server.
- **From a JSON file**: the user saves the API's answer themselves (the dialog
  shows a `curl` command) and uploads it; *Import…* also recognises such JSON.
  Images then arrive grey.

## What is converted

| Figma | Planar |
|---|---|
| Pages (`CANVAS`, background colour) | pages |
| `FRAME`, `SECTION`, `GROUP` | frames, groups |
| `COMPONENT`, `COMPONENT_SET` (variant names `Prop=Value, …`) | components and component sets with variants |
| `INSTANCE` of a component in the same file | instances; what differs from the main component is kept as overrides |
| `RECTANGLE`, `ELLIPSE` | rectangles, ellipses |
| `VECTOR`, `STAR`, `REGULAR_POLYGON`, `BOOLEAN_OPERATION`, `LINE` | vectors from `fillGeometry` (boolean operations are flattened) |
| `TEXT` | text (the first style of mixed text) |
| solid and image fills, strokes, corner radius, opacity, visibility | the same |
| drop / inner shadows, layer / background blur | effects |
| auto layout (direction, gap, padding, alignment, wrap, sizing) | auto layout |
| constraints | constraints |
| text and effect styles | text and effect styles |

Left out or simplified, and listed after the import: gradients (average
colour), other paint types, instances of components from other files (kept as
frames), component properties other than variants, arcs and rings, mixed
corner radii (largest), flips, justified text, FigJam objects, and variables
(the REST API returns them only on some plans).

## Responsibility

Planar is not affiliated with Figma. Using the Figma API is subject to Figma's
terms, including its Developer Terms and Acceptable Use Policy, which bind the
person whose token is used. Import only files you own or are allowed to copy.
