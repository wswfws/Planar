# Planar functional specification (v0.1)

This is the clean-room specification Planar is implemented from. It describes
observable behaviour only. See [`../CLEAN_ROOM.md`](../CLEAN_ROOM.md).

## 1. Document model

- A **document** has a name and an ordered list of **pages**.
- A page holds an ordered tree of **layers**. Later siblings paint on top of
  earlier ones.
- Layer types:
  - **Frame**: a rectangular container with fills, strokes, corner radius and
    an optional *clip content* flag. Frames can be nested.
  - **Group**: a container without its own paint whose bounds always fit its
    children. A group with no children is removed.
  - **Rectangle** (with corner radius), **Ellipse**.
  - **Vector**: a polyline or polygon (open or closed), also used for lines.
  - **Text**: a block of text with font family, size, weight, alignment and
    line height. It is either *auto width* (grows with content) or *fixed
    width* (wraps).
- Every layer has: name, position (x, y) relative to its parent container,
  width, height, rotation in degrees around its centre, opacity, visible flag,
  locked flag, a list of fills, a list of strokes and a stroke width.
- A paint is either a solid colour (hex + opacity) or an image (embedded data
  URL, *fill* or *fit* scaling). Each paint can be hidden.

## 2. Canvas and viewport

- Infinite canvas. Mouse wheel / trackpad scroll pans; Ctrl/Cmd + wheel or
  pinch zooms around the pointer. Zoom range 2 %–25 600 %.
- Holding Space, using the Hand tool (H) or dragging with the middle button
  pans.
- Shift+0 zoom to 100 %, Shift+1 zoom to fit all, Shift+2 zoom to selection,
  Ctrl/Cmd + `=` / `-` zoom in/out.
- Top-level frames display their name above the top-left corner; clicking the
  label selects the frame.

## 3. Tools

| Key | Tool | Behaviour |
| --- | --- | --- |
| V | Move | Select, move, resize, rotate |
| H | Hand | Pan |
| F | Frame | Drag to create a frame; click creates 100×100 |
| R | Rectangle | Drag to create; Shift keeps 1:1; Alt draws from centre |
| O | Ellipse | As rectangle |
| L | Line | Drag to create a line; Shift snaps to 45° |
| P | Pen | Click to add points; click the first point to close; Enter/Esc or double-click to finish |
| T | Text | Click to place a text layer and start typing |

After a shape is created the tool returns to Move and the new layer is
selected. A shape created over a frame becomes a child of the deepest frame
under the starting point.

## 4. Selection and transformation

- Click selects the top-most layer under the pointer. Shift-click toggles.
  Dragging on empty canvas draws a marquee that selects intersecting layers of
  the current level.
- Clicking inside a group selects the whole group; double-click enters the
  group and selects the child. Children of frames are selectable directly.
- Enter selects the children of the selection; Shift+Enter or Esc selects the
  parent; Esc on a top-level selection clears it.
- Dragging a selected layer moves it. Shift constrains to one axis. Alt-drag
  duplicates. Moving snaps edges and centres to other layers (5 screen px)
  and shows guide lines. Positions are rounded to whole pixels. Dropping a
  layer over a frame moves it into that frame; dropping outside moves it to
  the page (layers inside groups stay in their group).
- Eight resize handles. Shift keeps aspect ratio, Alt resizes from centre.
  Resizing a group scales its children; resizing a frame does not. Resizing
  a text layer makes it fixed width.
- Just outside each corner the pointer rotates the selection; Shift snaps to
  15° steps.
- Arrow keys nudge by 1 px, Shift+arrow by 10 px.
- The selection shows its size (W × H) under the bounding box.

## 5. Layer operations

| Shortcut | Action |
| --- | --- |
| Delete / Backspace | Delete |
| Ctrl/Cmd+C / X / V | Copy / cut / paste (also across tabs via the system clipboard) |
| Ctrl/Cmd+D | Duplicate (offset 10 px) |
| Ctrl/Cmd+A | Select all on the current level |
| Ctrl/Cmd+G | Group selection |
| Ctrl/Cmd+Shift+G | Ungroup (also unwraps a frame) |
| Ctrl/Cmd+Alt+G | Wrap selection in a new frame |
| Ctrl/Cmd+] / [ | Bring forward / send backward |
| Ctrl/Cmd+Shift+] / [ | Bring to front / send to back |
| Ctrl/Cmd+Shift+H | Show / hide |
| Ctrl/Cmd+Shift+L | Lock / unlock |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y | Undo / redo |

Pasting or dropping an image file creates a rectangle with an image fill at
the image's natural size.

## 6. Panels

- **Toolbar** (top): main menu (new, open, save, export, undo, redo),
  tools, editable document name, zoom menu.
- **Left sidebar**: page list (add, rename by double-click, delete when more
  than one) and a layer tree for the current page. The layer tree shows the
  top-most layer first, supports expand/collapse, multi-select, rename by
  double-click, visibility and lock toggles, and drag and drop to reorder or
  re-parent.
- **Right sidebar** (properties):
  - nothing selected: page background colour;
  - alignment (left, centre, right, top, middle, bottom) for two or more
    layers, or relative to the parent for one layer;
  - X, Y, W, H, rotation, corner radius, clip content;
  - opacity;
  - fills and strokes (add, remove, hide, colour, opacity, stroke width);
  - text settings (family, size, weight, line height, alignment, auto width);
  - export (PNG at 1×/2×/3× or SVG) for the selection, or for the whole page
    when nothing is selected.
- Numeric fields accept arithmetic (`100+20`, `50*2`) and can be scrubbed by
  dragging their label.

## 7. Files

- The document autosaves to browser storage and is restored on reload.
- *Save* downloads a `.planar.json` file; *Open* loads one.
  The format is documented in [`FILE_FORMAT.md`](FILE_FORMAT.md).
- Unknown or invalid files are rejected with a message; the current document
  is not changed.

## 8. Out of scope for v0.1 (roadmap)

Real-time collaboration, comments, components and instances, auto layout,
constraints, boolean operations, Bézier curve editing, gradients, effects
(shadows, blur), styles and variables, prototyping, plugins, version history.
