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
  - **Text**: a block of text with font family, size, weight, horizontal and
    vertical alignment and line height. Its box has one of three sizing
    modes:
    - *auto width* — width and height grow with the content (no wrapping);
    - *auto height* — fixed width, lines wrap, height grows with the content;
    - *fixed size* — width and height are set by the user; lines wrap and
      the content is placed at the top, middle or bottom of the box and may
      overflow it.
    Each line is as tall as font size × line height — or, with line height
    *Auto* (the default), as tall as the font's own ascent + descent — with
    the glyphs centred
    in the line the same way the browser lays out text, so the text looks
    the same while editing and on the canvas.
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
  a text layer horizontally switches it to *auto height*; resizing it
  vertically (or typing a height) switches it to *fixed size*.
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
| Ctrl/Cmd+Alt+K | Create component |
| Ctrl/Cmd+Alt+B | Detach instance |
| (context menu) | Combine as variants, Add variant |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y | Undo / redo |

Pasting or dropping an image file creates a rectangle with an image fill at
the image's natural size.

### Context menu

Right-clicking opens a context menu that lists only what applies to the
current situation, each with its keyboard shortcut so the shortcuts can be
learnt from it. Disabled entries are shown greyed out rather than hidden
when they are part of a group that otherwise applies.

- Right-clicking a layer that is not selected selects it first; right-clicking
  inside the current selection (including on a layer nested in a selected
  layer) keeps it. Right-clicking empty canvas clears
  the selection.
- **Empty canvas:** paste here (at the pointer), select all, zoom to fit,
  zoom to 100 %, variables, export page.
- **Selection:** copy, copy as SVG, cut, paste here, duplicate, delete;
  *Select layer* (submenu of every layer under the pointer, top-most first),
  select parent, select children; *Order* submenu (bring to front, forward,
  backward, send to back); group, frame selection, ungroup; add/remove auto
  layout; create component — or for instances: go to main component, reset
  changes, detach; show/hide, lock/unlock, rename; zoom to selection,
  export PNG.
- The same selection menu opens from a right-click on a row in the layer
  tree.
- The menu stays inside the window, opens submenus on hover or with the
  right arrow key, and is fully usable from the keyboard (arrows, Enter,
  Esc). It closes on Esc, on a click elsewhere, on scroll and when the window
  loses focus.
- Ctrl/Cmd+R renames the selected layer (in the layer tree).

## 6. Auto layout

A frame can arrange its children automatically in a row or a column.

- **Add / remove.** Shift+A on a frame without auto layout turns it on; on
  any other selection it wraps the selection in a new, unfilled auto-layout
  frame. The direction is guessed from how the layers are spread out, and the
  children are re-ordered to match their current position along that axis.
  Alt+Shift+A removes auto layout (layers stay where they are).
- **Settings** (per frame): direction (horizontal / vertical), spacing
  between items, padding on each side, alignment along the main axis (start,
  centre, end or *space between*) and across it (start, centre, end).
- **Sizing** (per layer, per axis):
  - *Fixed* — the size does not change by itself;
  - *Hug* — an auto-layout frame shrinks or grows to fit its content plus
    padding; for text, hug width means auto width and hug height means
    auto height;
  - *Fill* — a child of an auto-layout frame stretches to take the remaining
    space on the main axis (shared equally between fill items) or the full
    content box on the cross axis.
  Resizing a layer by hand on an axis switches that axis to *Fixed*.
- **Ignore auto layout.** A child can opt out; it then keeps a free position
  inside the frame.
- Hidden children take no space.
- Rotated children take the space of their rotated bounding box.
- **Re-ordering.** Dragging a child shows an insertion line; dropping inside
  an auto-layout frame inserts the layer at that position (this also moves
  layers in from elsewhere). Dropping outside takes it out of the frame.
  Arrow keys along the main axis move a child one place earlier or later.
- Child X/Y are controlled by the layout and are read-only in the panel.

## 7. Components and instances

- **Component.** A reusable frame-like layer (the *main component*).
  Ctrl/Cmd+Alt+K turns a selected frame into a component, or wraps any other
  selection in a new component. Components can be edited like frames.
- **Instance.** A linked copy of a component. Instances are created from the
  *Assets* tab (click to place at the centre of the view, or drag onto the
  canvas) or with *Create instance* in the properties of a component.
  Copying/duplicating an instance makes another instance of the same
  component. An instance cannot be placed inside its own component.
- **Propagation.** Every change to the main component (layers added, removed,
  re-ordered, restyled, resized) is reflected in all its instances
  immediately, on every page.
- **Overrides.** Inside an instance, layers can be selected (double-click to
  enter, as with groups) and their *appearance* changed: fills, strokes,
  opacity, visibility, corner radius, text content and text style, names and
  variable bindings. Each changed property becomes an override and no longer
  follows the component; everything else keeps following it. Layers inside
  an instance cannot be moved, resized, deleted, re-ordered or re-parented,
  and nothing can be dropped into an instance.
- The instance's own position, rotation, name, visibility, opacity and
  layout placement are its own. Resizing an instance overrides its size.
- **Reset overrides** restores an instance to match its component.
- **Detach instance** (Ctrl/Cmd+Alt+B) turns an instance into a plain frame.
  Instances nested inside it stay linked to their own components.
- **Go to main component** selects the component, switching page if needed.
- If a main component is deleted, its instances keep their last appearance.
- Components and instances are marked with their own icons and a distinct
  colour in the layer tree and on the canvas.

### Component properties

A main component can declare **properties** — named inputs that each
instance sets for itself:

| Type | Drives | Default |
| --- | --- | --- |
| Text | the content of text layers | the text it was created from |
| Boolean | the visibility of layers | on |
| Instance swap | which component a nested instance shows | the nested instance's component |

- **Creating.** In the main component, select a layer inside it and use
  *Create property* next to the content, visibility or swap field (the
  property starts with the layer's current value), or add a property in the
  component's *Properties* section and bind layers to it afterwards. Several
  layers may share one property.
- **Main component.** Bound layers show the property's default. Editing a
  bound text in the main component (typing, or the panel) changes the
  default; so does toggling a bound layer's visibility.
- **Instances.** The *Properties* section of an instance lists every
  property of its component with a text box, a switch or a component picker.
  Typing into a bound text layer inside an instance, or toggling a bound
  layer's visibility there, sets the instance's property value instead of
  creating an override. Instances that never set a property follow the
  default.
- **Instance swap** offers every component except ones that would nest the
  component inside itself. Changes made inside a swapped nested instance are
  lost when it is swapped.
- Renaming a property or changing its default updates all instances at once.
  Deleting a property unbinds its layers and keeps their current values.
- Properties can be combined with variables; when both drive the same value,
  the variable wins.

### Variants

A **component set** groups related components — its **variants** — that
differ along one or more **variant properties** (for example *Type* =
Primary / Secondary and *Size* = Small / Large).

- **Combining.** Selecting two or more components that are not yet in a set
  and choosing *Combine as variants* wraps them in a component set. Each
  becomes a variant with a property *Property 1* whose value is its former
  name. Component properties of the combined components move to the set and
  are shared by all variants.
- **Variant names** are generated from their values (`Type=Primary,
  Size=Small`) and kept in sync.
- **Set panel:** list of variant properties (rename, remove, add — a new
  property starts as *Default* on every variant), *Add variant* (duplicates
  the last variant next to it with a new value) and the shared component
  properties.
- **Variant panel:** a value field for each variant property, plus the
  usual main-component actions.
- **Instances** of any variant show one selector per variant property,
  listing every value used in the set. Picking a value switches the instance
  to the variant matching all chosen values (or, if none matches exactly, the
  closest one with the picked value). Overrides on layers whose names match in
  the new variant are kept; component property values are kept because
  properties belong to the set.
- **Assets** list a set once; placing it creates an instance of its first
  variant. Instance-swap pickers list variants as *Set / Variant*.
- On the canvas a set is shown with a dashed outline in the component colour
  and its name label; its variants are selected like layers in a frame.
- Ungrouping or deleting a set follows the usual rules for frames.

## 8. Variables

- A document has a list of **variables**, each with a name, a type
  (*color*, *number*, *string* or *boolean*) and one value per **mode**
  (for example *Light* and *Dark*). There is always at least one mode.
- Variables are managed in the *Variables* dialog (toolbar button): add,
  rename, delete variables; add, rename, delete modes; edit values.
- **Binding.** Properties can be bound to a variable of a matching type:
  - colour → solid fills and strokes;
  - number → width, height, corner radius, stroke width, auto-layout spacing
    and padding, font size, line height;
  - string → text content;
  - boolean → visibility.
  A bound property shows the variable's name and always takes the variable's
  value. Editing the property by hand (or resizing on canvas) removes the
  binding. Deleting a variable removes its bindings and leaves the last
  values in place.
- **Modes.** Pages, frames, components and instances can choose a mode;
  layers inside use the nearest chosen mode, falling back to the first mode.
  Switching a frame from *Light* to *Dark* re-resolves every binding inside.

## 9. Panels

- **Toolbar** (top): main menu (new, open, save, export, undo, redo),
  tools, editable document name, zoom menu.
- **Left sidebar**: page list (add, rename by double-click, delete when more
  than one), an *Assets* tab listing components with thumbnails, and a layer tree for the current page. The layer tree shows the
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
  - text settings (family, size, weight, line height, horizontal and
    vertical alignment, sizing mode: auto width / auto height / fixed size);
  - export (PNG at 1×/2×/3× or SVG) for the selection, or for the whole page
    when nothing is selected.
- Numeric fields accept arithmetic (`100+20`, `50*2`) and can be scrubbed by
  dragging their label.

## 10. Files

- The document autosaves to browser storage and is restored on reload.
- *Save* downloads a `.planar.json` file; *Open* loads one.
  The format is documented in [`FILE_FORMAT.md`](FILE_FORMAT.md).
- Unknown or invalid files are rejected with a message; the current document
  is not changed.

## 11. Out of scope for v0.1 (roadmap)

Real-time collaboration, comments,
variable collections and aliases, wrapping auto layout,
constraints, boolean operations, Bézier curve editing, gradients, effects
(shadows, blur), styles, prototyping, plugins, version history.
